/** Public, deterministic synthetic wire corpus. This script never resolves a chain or starts Codex. */
import assert from 'node:assert/strict';
import { readFile,writeFile,mkdir,mkdtemp,readdir } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { bcs } from '@mysten/sui/bcs';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Envelope,NativeInbox,commitment,verify,strictJson,select,type SignedEnvelope } from './native-peer.js';
import { type Authorization,type AgentRef } from './native-chain.js';
import { ResearchService,requestHash,STREAMING_KIND,STREAMING_FEATURE,type ResearchRequest,type ResearchWorker } from './native-research.js';
import { type WorkRequest,type RequestRecord } from './codex-worker.js';
import { StreamingEngine } from './streaming-engine.js';
import { streamingFixture } from './test-streaming-fixtures.js';
import { utf8,hash,hex,equal,purpose,METHOD,makePolicy,policyHash,makeCredit,creditHash,checkpointHash,
  signStatement,validateSigned,statementBytes,price,type OfferData,type CreditData,type CheckpointData,type AckData,type StatementKind,type Statement,type SignedData } from './streaming-codec.js';

const ROOT=resolve(import.meta.dirname,'..');
const OUT=join(ROOT,'examples/messages/native-streaming');
const SCHEMA=join(ROOT,'schemas/native-streaming-v1.schema.json');
const NOW=1800000000000n;
const bytes=()=>bcs.vector(bcs.u8());
const Session=bcs.struct('Session',{purpose:bytes(),hello:Envelope,welcome:Envelope});
type Json=Record<string,any>;
// Keep byte vectors on one line so the decoded examples remain readable.
const json=(v:unknown)=>JSON.stringify(v,null,2).replace(/\[\n\s*(?:[0-9]+|"(?:[^"\\]|\\.)*")(?:,\n\s*(?:[0-9]+|"(?:[^"\\]|\\.)*"))*\n\s*\]/g,
  text=>JSON.stringify(JSON.parse(text)))+'\n';
const ref=(name:string)=>({$ref:`#/$defs/${name}`});
const object=(properties:Json,optional:string[]=[])=>({type:'object',additionalProperties:false,
  required:Object.keys(properties).filter(k=>!optional.includes(k)),properties});
function integerPattern(){
  const max='18446744073709551615',parts=['0','[1-9][0-9]{0,18}',max];
  for(let i=1;i<max.length;i++)if(max[i]!=='0'){
    const digit=Number(max[i])-1,tail=max.length-i-1;
    parts.push(max.slice(0,i)+(digit===0?'0':`[0-${digit}]`)+(tail?`[0-9]{${tail}}`:''));
  }
  return `^(?:${parts.join('|')})$`;
}
function schema(){
  const defs:Json={
    Byte:{type:'integer',minimum:0,maximum:255},
    Bytes:{type:'array',items:ref('Byte'),maxItems:65536},
    Bytes32:{type:'array',items:ref('Byte'),minItems:32,maxItems:32},
    Signature:{type:'array',items:ref('Byte'),minItems:64,maxItems:64},
    Address:{type:'string',pattern:'^0x[0-9a-f]{64}$'},
    U64:{type:'string',pattern:integerPattern()},
    Counters:{type:'array',items:ref('U64'),minItems:1,maxItems:8},
    Network:{type:'array',items:ref('Byte'),minItems:1,maxItems:64},
    Unit:{type:'array',minItems:1,maxItems:64,items:{anyOf:[{type:'integer',minimum:97,maximum:122},{type:'integer',minimum:48,maximum:57},{enum:[46,95,47,45]}]}},
  };
  defs.Policy=object({purpose:{const:purpose('policy')},version:{const:1},units:{type:'array',items:ref('Unit'),minItems:1,maxItems:8,uniqueItems:true},
    rates:ref('Counters'),denominator:{allOf:[ref('U64'),{not:{const:'0'}}]}});
  const prefix=(kind:StatementKind)=>({purpose:{const:purpose(kind)},method:{const:utf8(METHOD)},version:{const:1},network:ref('Network'),
    package_id:ref('Address'),deployment:ref('Address'),buyer:ref('Address'),provider:ref('Address')});
  const positive={allOf:[ref('U64'),{not:{const:'0'}}]};
  defs.Offer=object({...prefix('offer'),buyer_key:ref('Bytes32'),provider_key:ref('Bytes32'),refund:ref('Address'),payee:ref('Address'),opening_nonce:ref('Bytes32'),policy_hash:ref('Bytes32'),
    deposit:positive,offer_expires_ms:ref('U64'),work_deadline_ms:ref('U64'),claim_deadline_ms:ref('U64')});
  defs.Credit=object({...prefix('credit'),channel:ref('Address'),offer_hash:ref('Bytes32'),sequence:positive,request_sequence:positive,request_hash:ref('Bytes32'),previous_checkpoint:ref('Bytes32'),units:ref('Counters'),cumulative_amount:ref('U64')});
  defs.Ack=object({...prefix('ack'),channel:ref('Address'),offer_hash:ref('Bytes32'),credit_hash:ref('Bytes32'),sequence:positive});
  defs.Checkpoint=object({...prefix('checkpoint'),channel:ref('Address'),offer_hash:ref('Bytes32'),credit_hash:ref('Bytes32'),sequence:positive,request_sequence:positive,
    request_hash:ref('Bytes32'),previous_checkpoint:ref('Bytes32'),units:ref('Counters'),cumulative_amount:ref('U64'),output_hash:ref('Bytes32'),final:{type:'boolean'}});
  for(const type of ['Offer','Credit','Ack','Checkpoint'])defs[`Signed${type}`]=object({payload:ref(type),signature:ref('Signature')});
  defs.ResearchRequest=object({version:{const:1},conversation:{type:'string',pattern:'^[0-9a-f]{64}$'},request:{type:'string',pattern:'^[0-9a-f]{64}$'},sequence:{const:'1'},prompt:{type:'string',maxLength:16384}});
  defs.TokenUsage=object(Object.fromEntries(['totalTokens','inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens'].map(n=>[n,{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER}])));
  const commands:Json={
    OfferCommand:object({op:{const:'offer'},nonce:ref('Bytes32')}),
    FundedCommand:object({op:{const:'funded'},channel:ref('Address')}),
    CreditCommand:object({op:{const:'credit'},request:ref('ResearchRequest'),credit:ref('SignedCredit')}),
    StartCommand:object({op:{const:'start'},request_hash:ref('Bytes32')}),
    PollCommand:object({op:{const:'poll'},request_hash:ref('Bytes32'),after_output:ref('U64')}),
    CancelCommand:object({op:{const:'cancel'},request_hash:ref('Bytes32')}),
  };
  Object.assign(defs,commands);defs.Command={oneOf:Object.keys(commands).map(ref)};
  const state={enum:['prepared','launching','running','completed','failed','cancelled','uncertain']};
  const usage={anyOf:[{type:'null'},ref('TokenUsage')]};
  const responses:Json={
    OfferResponse:object({type:{const:'offer'},offer:ref('SignedOffer'),policy:ref('Policy')}),
    FundedResponse:object({type:{const:'funded'},channel:ref('Address')}),
    AckResponse:object({type:{const:'ack'},ack:ref('SignedAck')}),
    StartedResponse:object({type:{const:'started'}}),
    DeliveryResponse:object({type:{const:'delivery'},checkpoint:ref('SignedCheckpoint'),output:ref('Bytes'),upstream_usage:usage,worker_state:state},['upstream_usage','worker_state']),
    WaitingResponse:object({type:{const:'waiting'},reason:{enum:[...state.enum,'credit_exhausted']},upstream_usage:usage},['upstream_usage']),
    CancellationResponse:object({type:{const:'cancellation_requested'},confirmed:{type:'boolean'}}),
  };
  Object.assign(defs,responses);defs.Response={oneOf:Object.keys(responses).map(ref)};
  defs.ExtensionBody=object({session:ref('Bytes32'),content:ref('Bytes')});
  return {$schema:'https://json-schema.org/draft/2020-12/schema',$id:'https://m2m.unconfirmedlabs.com/schemas/native-streaming-v1.schema.json',
    title:'Experimental native streaming v1 decoded command, response, and economic statement',
    description:'Validate signed outer envelopes separately with native-core-v1.schema.json. Decode envelope payload and extension content or receipt result as strict UTF-8 JSON. Runtime checks signatures, exact BCS, UTF-8 byte limits, policy dimensions/prices, deadlines, references, and state transitions.',
    oneOf:[ref('Command'),ref('Response'),ref('Policy'),...['Offer','Credit','Ack','Checkpoint'].map(n=>ref(`Signed${n}`))],$defs:defs};
}

interface WireVector {name:string;branch:string;kind:string;file:string;body_file:string;content_file?:string;expected:'accept'|'reject';
  rejection?:string;public_key:number[];bcs_hex:string;hash_hex:string;response_to?:string}
async function build(){
  const f=await streamingFixture(),temporary=await mkdtemp(join(tmpdir(),'m2m-public-streaming-corpus-'));
  const buyerTransport=Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(3));
  const providerTransport=Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(4));
  const agent=(id:string):AgentRef=>({network:f.offer.payload.network,package_id:f.offer.payload.package_id,domain:f.offer.payload.deployment,agent:id});
  const buyer=agent(f.offer.payload.buyer),provider=agent(f.offer.payload.provider);
  const authorization=(agent:AgentRef,transport:Ed25519Keypair,economic:Ed25519Keypair,controller:string):Authorization=>({agent,controller,
    transport_key:Array.from(transport.getPublicKey().toRawBytes()),economic_key:Array.from(economic.getPublicKey().toRawBytes()),generation:'0',read_at_ms:NOW.toString(),valid_until_ms:(NOW+30000n).toString()});
  const buyerAuth=authorization(buyer,buyerTransport,f.buyer,f.offer.payload.refund),providerAuth=authorization(provider,providerTransport,f.provider,f.offer.payload.payee);
  const policy=makePolicy(['input_utf8_bytes','output_utf8_bytes'],['1','2'],'8');
  const terms:OfferData={...f.offer.payload,policy_hash:policyHash(policy),deposit:'100000',offer_expires_ms:String(NOW+120000n),work_deadline_ms:String(NOW+600000n),claim_deadline_ms:String(NOW+1200000n)};
  const offer=await signStatement('offer',terms,f.provider),binding={offer,policy,channel:f.channel};
  const request:ResearchRequest={version:1,conversation:'11'.repeat(32),request:'12'.repeat(32),sequence:'1',prompt:'Explain signed credit windows.'};
  const digest=requestHash(f.channel,request),input=String(Buffer.byteLength(request.prompt));
  const files=new Map<string,string>(),vectors:WireVector[]=[],signedByName=new Map<string,SignedEnvelope>();
  let session:number[]=[];
  const sign=async(name:string,role:'buyer'|'provider',kind:string,body:unknown,correlation:number[]|null=null,id?:number[])=>{
    const m={purpose:utf8('m2m/core/message/v1'),sender:role==='buyer'?buyer:provider,recipient:role==='buyer'?provider:buyer,generation:'0',
      id:id??hash(utf8(`m2m/public-native-streaming/${name}/v1`)),correlation,created_ms:NOW.toString(),expires_ms:String(NOW+30000n),kind,payload:utf8(JSON.stringify(body))};
    const key=role==='buyer'?buyerTransport:providerTransport;
    return {message:m,signature:Array.from(await key.sign(Envelope.serialize(m).toBytes()))};
  };
  const add=async(name:string,branch:string,signed:SignedEnvelope,expected:'accept'|'reject'='accept',rejection?:string,responseTo?:string)=>{
    const role=signed.message.sender.agent===buyer.agent?'buyer':'provider',auth=role==='buyer'?buyerAuth:providerAuth;
    if(rejection==='core_signature')await assert.rejects(()=>verify(signed,auth,signed.message.recipient,auth.transport_key,NOW+1n));
    else await verify(signed,auth,signed.message.recipient,auth.transport_key,NOW+1n);
    const body=strictJson(signed.message.payload),file=`${name}.json`,bodyFile=`${name}.body.json`;
    files.set(file,json(signed));files.set(bodyFile,json(body));
    let contentFile:string|undefined;
    if(signed.message.kind===STREAMING_KIND){contentFile=`${name}.content.json`;files.set(contentFile,json(strictJson(body.content)))}
    if(signed.message.kind==='message.receipt'&&body.result!==null){contentFile=`${name}.content.json`;files.set(contentFile,json(strictJson(body.result)))}
    const encoded=Envelope.serialize(signed.message).toBytes();
    vectors.push({name,branch,kind:signed.message.kind,file,body_file:bodyFile,...(contentFile?{content_file:contentFile}:{}),expected,...(rejection?{rejection}:{}),
      public_key:auth.transport_key,bcs_hex:hex(encoded),hash_hex:hex(hash(encoded)),...(responseTo?{response_to:responseTo}:{})});
    signedByName.set(name,signed);return signed;
  };
  const hello=await add('00-hello','main',await sign('hello','buyer','core.hello',{challenge:hash(utf8('buyer fixture challenge')),required:[STREAMING_FEATURE],optional:[]}));
  const welcome=await add('01-welcome','main',await sign('welcome','provider','core.welcome',{hello_hash:hash(Envelope.serialize(hello.message).toBytes()),challenge:hash(utf8('provider fixture challenge')),
    required:[STREAMING_FEATURE],optional:[],selected:[STREAMING_FEATURE]},hello.message.id));
  session=hash(Session.serialize({purpose:utf8('m2m/core/session/v1'),hello:hello.message,welcome:welcome.message}).toBytes());
  const confirm=await add('02-confirm','main',await sign('confirm','buyer','core.confirm',{session},welcome.message.id));
  await add('03-ready','main',await sign('ready','provider','core.ready',{session},confirm.message.id));
  const pair=async(name:string,command:Json,response:Json,branch='main')=>{
    const req=await add(`${name}.request`,branch,await sign(`${name}.request`,'buyer',STREAMING_KIND,{session,content:utf8(JSON.stringify(command))}));
    const receipt={session,message_id:req.message.id,commitment:commitment(req.message),state:'completed',result:utf8(JSON.stringify(response))};
    await add(`${name}.response`,branch,await sign(`${name}.response`,'provider','message.receipt',receipt,req.message.id),'accept',undefined,`${name}.request`);
    return req;
  };
  await pair('10-offer',{op:'offer',nonce:terms.opening_nonce},{type:'offer',offer,policy});
  await pair('11-funded',{op:'funded',channel:f.channel},{type:'funded',channel:f.channel});
  class PublicWorker implements ResearchWorker {
    private record?:RequestRecord;
    async run(r:WorkRequest){
      if(!this.record){const text='Credit windows keep delivery within a signed unit budget.';
        this.record={...r,commitment:'public-fixture',submittedInputHash:'public-fixture',clientUserMessageId:'public-fixture',state:'completed',threadId:'public-fixture-thread',turnId:'public-fixture-turn',knownTurnIds:[],
          startedAt:Number(NOW),deadline:Number(NOW+60000n),baselineUsage:null,upstreamUsage:null,usageObserved:false,producedUtf8Bytes:Buffer.byteLength(text),items:{output:text},
          events:[{index:0,observedAt:Number(NOW),requestId:r.requestId,type:'content',itemId:'output',delta:text,producedUtf8Bytes:Buffer.byteLength(text)}]};
      }return structuredClone(this.record);
    }
    status(){return this.record?structuredClone(this.record):undefined}
    async reconcile(){return this.status()}
    async cancel(){if(this.record)this.record.state='cancelled';return this.status()}
  }
  const engines=async(branch:string)=>{
    const buyerEngine=await StreamingEngine.open(join(temporary,branch,'buyer.json'),'buyer',binding,f.buyer);
    const providerEngine=await StreamingEngine.open(join(temporary,branch,'provider.json'),'provider',binding,f.provider);
    const svc=await ResearchService.open(join(temporary,branch,'service.json'),providerEngine,new PublicWorker());
    return {buyerEngine,providerEngine,svc};
  };
  const main=await engines('main');
  const command=async(cmd:Json)=>strictJson(await main.svc.command(utf8(JSON.stringify(cmd))));
  const c1=await main.buyerEngine.authorize('1',digest,[input,'32']);
  const c1cmd={op:'credit',request,credit:c1},a1=await command(c1cmd);
  const original=await pair('12-credit',c1cmd,a1);await main.buyerEngine.receiveAck(a1.ack);
  await pair('13-start',{op:'start',request_hash:digest},await command({op:'start',request_hash:digest}));
  const first=await command({op:'poll',request_hash:digest,after_output:'0'});
  await pair('14-delivery',{op:'poll',request_hash:digest,after_output:'0'},first);await main.buyerEngine.receiveCheckpoint(first.checkpoint,Uint8Array.from(first.output));
  const waiting=await command({op:'poll',request_hash:digest,after_output:'32'});
  assert.equal(waiting.reason,'credit_exhausted');await pair('15-exhausted',{op:'poll',request_hash:digest,after_output:'32'},waiting);
  const c2=await main.buyerEngine.authorize('1',digest,[input,'128']);
  const c2cmd={op:'credit',request,credit:c2},a2=await command(c2cmd);
  await pair('16-renew',c2cmd,a2);await main.buyerEngine.receiveAck(a2.ack);
  const final=await command({op:'poll',request_hash:digest,after_output:'32'});
  assert.equal(final.checkpoint.payload.final,true);await pair('17-final',{op:'poll',request_hash:digest,after_output:'32'},final);
  await main.buyerEngine.receiveCheckpoint(final.checkpoint,Uint8Array.from(final.output));
  // The core inbox returns its saved result for an identical logical message ID.
  const inbox=await NativeInbox.open(join(temporary,'core-inbox'));
  let dispatches=0;const once=await inbox.dispatch(original.message,async()=>{dispatches++;return utf8(JSON.stringify(a1))});
  const retry=await inbox.dispatch(original.message,async()=>{dispatches++;throw Error('must not redispatch')});
  assert.deepEqual(retry,once);assert.equal(dispatches,1);
  await add('20-identical-credit-replay.request','replay',original);
  await add('20-identical-credit-replay.response','replay',await sign('20-identical-credit-replay.response','provider','message.receipt',
    {session,message_id:original.message.id,commitment:retry.commitment,state:retry.state,result:retry.result},original.message.id),'accept',undefined,'20-identical-credit-replay.request');
  const replay=await command({op:'poll',request_hash:digest,after_output:'0'});
  assert.deepEqual(replay.checkpoint,first.checkpoint);await pair('21-final-frozen-output-replay',{op:'poll',request_hash:digest,after_output:'0'},replay,'replay');
  // Alternative history: the same offered channel is cancelled BEFORE backend start.
  const cancel=await engines('cancel-before-start');
  const cancelCredit=await cancel.buyerEngine.authorize('1',digest,[input,'32']);
  const ca=strictJson(await cancel.svc.command(utf8(JSON.stringify({op:'credit',request,credit:cancelCredit}))));await cancel.buyerEngine.receiveAck(ca.ack);
  const cancelled=strictJson(await cancel.svc.command(utf8(JSON.stringify({op:'cancel',request_hash:digest}))));
  await pair('30-cancel-before-start',{op:'cancel',request_hash:digest},cancelled,'cancel-before-start');
  const zero=strictJson(await cancel.svc.command(utf8(JSON.stringify({op:'poll',request_hash:digest,after_output:'0'}))));
  assert.equal(zero.checkpoint.payload.cumulative_amount,'0');assert.deepEqual(zero.checkpoint.payload.units,['0','0']);
  await pair('31-cancelled-final',{op:'poll',request_hash:digest,after_output:'0'},zero,'cancel-before-start');
  // These failures have valid framing/schema; they must fail cryptographic/state checks.
  const badCredit=structuredClone(c1);badCredit.payload.units[1]='33';
  assert.throws(()=>validateSigned('credit',badCredit,terms.buyer_key),/signature/);
  await add('40-economic-signature-tamper.request','negative',await sign('40-economic-signature-tamper','buyer',STREAMING_KIND,{session,content:utf8(JSON.stringify({op:'credit',request,credit:badCredit}))}),'reject','economic_signature');
  const badCore=structuredClone(original);badCore.signature[0]^=1;
  await add('41-core-signature-tamper.request','negative',badCore,'reject','core_signature');
  const conflicting=await sign('42-core-conflicting-replay','buyer',STREAMING_KIND,{session,content:utf8(JSON.stringify({op:'poll',request_hash:digest,after_output:'0'}))},null,original.message.id);
  await assert.rejects(()=>inbox.dispatch(conflicting.message,async()=>[]),/message_conflict/);
  await add('42-core-conflicting-replay.request','negative',conflicting,'reject','message_conflict');
  const c3=await signStatement('credit',makeCredit(terms,f.channel,'3','1',digest,checkpointHash(final.checkpoint.payload),[input,'256'],policy),f.buyer);
  await assert.rejects(()=>main.providerEngine.acceptCredit(c3),/frozen/);
  await add('43-credit-after-final.request','negative',await sign('43-credit-after-final','buyer',STREAMING_KIND,{session,content:utf8(JSON.stringify({op:'credit',request,credit:c3}))}),'reject','frozen');
  await inbox.close();
  const helloBody=strictJson(hello.message.payload),welcomeBody=strictJson(welcome.message.payload);
  assert.deepEqual(select(helloBody,welcomeBody),welcomeBody.selected);
  assert.deepEqual(welcomeBody.hello_hash,hash(Envelope.serialize(hello.message).toBytes()));
  assert.deepEqual(strictJson(confirm.message.payload).session,session);
  assert.deepEqual(strictJson(signedByName.get('03-ready')!.message.payload).session,session);
  for(const vector of vectors)if(vector.response_to){
    const response=signedByName.get(vector.name)!,request=signedByName.get(vector.response_to)!;
    const body=strictJson(response.message.payload);
    assert.deepEqual(response.message.correlation,request.message.id);
    assert.deepEqual(body.message_id,request.message.id);assert.deepEqual(body.commitment,commitment(request.message));
    assert.deepEqual(body.session,session);
  }
  const economics:Record<string,{kind:StatementKind;signed:SignedData<Statement>}>={offer:{kind:'offer',signed:offer},credit_initial:{kind:'credit',signed:c1},ack_initial:{kind:'ack',signed:a1.ack},
    checkpoint_first:{kind:'checkpoint',signed:first.checkpoint},credit_renewal:{kind:'credit',signed:c2},ack_renewal:{kind:'ack',signed:a2.ack},
    checkpoint_final:{kind:'checkpoint',signed:final.checkpoint},checkpoint_cancelled_alternative:{kind:'checkpoint',signed:zero.checkpoint}};
  const economicVectors=Object.fromEntries(Object.entries(economics).map(([name,{kind,signed}])=>{
    const key=kind==='credit'?terms.buyer_key:terms.provider_key;validateSigned(kind,signed,key);
    return [name,{kind,signed,public_key:key,bcs_hex:hex(statementBytes(kind,signed.payload)),hash_hex:hex(hash(statementBytes(kind,signed.payload)))}];
  }));
  files.set('economic-statements.json',json({version:1,statements:economicVectors}));
  files.set('vectors.json',json({version:1,status:'synthetic-public-fixtures-not-live-chain-evidence',now_ms:NOW.toString(),
    network:'test-vector',feature:STREAMING_FEATURE,session,authorizations:{buyer:buyerAuth,provider:providerAuth},
    branches:{main:'00 through 17, in order',replay:'20/21 repeat previously persisted state after the main provider final checkpoint',
      'cancel-before-start':'Alternative fork immediately after 12-credit; does not coexist with main 13-start through 17-final',negative:'Independent expected rejection cases; never dispatch into the accepted main history'},messages:vectors}));
  files.set('settlement-witness.json',json({status:'not_submitted',wire_message:false,method:METHOD,channel:f.channel,
    buyer_credit:c2,provider_final_checkpoint:final.checkpoint,expected_exact_amount:price(policy,final.checkpoint.payload.units),
    expected_residual_refund:String(BigInt(terms.deposit)-BigInt(final.checkpoint.payload.cumulative_amount)),
    note:'Canonical inputs for channel::close_exact; no transaction digest or fabricated chain result.'}));
  return {files,vectors,schema:schema()};
}

const corpus=await build();
// Independent JSON Schema implementation checks the generated corpus before writing or comparing.
const core=JSON.parse(await readFile(join(ROOT,'schemas/native-core-v1.schema.json'),'utf8'));
const schemaChecks=[...corpus.vectors.map(v=>({signed:JSON.parse(corpus.files.get(v.file)!),body:JSON.parse(corpus.files.get(v.body_file)!),
  content:v.content_file?JSON.parse(corpus.files.get(v.content_file)!):null,kind:v.kind})),];
execFileSync('python3',['-c',`
import json,sys
from jsonschema import Draft202012Validator
data=json.load(sys.stdin); core=data['core']; streaming=data['streaming']
Draft202012Validator.check_schema(core); Draft202012Validator.check_schema(streaming)
wire=Draft202012Validator(core); decoded=Draft202012Validator(streaming)
bodies={'core.hello':'Hello','core.welcome':'Welcome','core.confirm':'SessionBody','core.ready':'SessionBody','message.receipt':'ReceiptBody'}
for item in data['checks']:
    wire.validate(item['signed'])
    Draft202012Validator(core['$defs'][bodies.get(item['kind'],'ExtensionBody')]).validate(item['body'])
    if item['content'] is not None: decoded.validate(item['content'])
u64=Draft202012Validator({'$ref':'#/$defs/U64','$defs':streaming['$defs']})
for valid in ['0','1','9999999999999999999','18446744073709551615']: u64.validate(valid)
for invalid in ['18446744073709551616','99999999999999999999','01','-1',1]: assert not u64.is_valid(invalid)
sample=next(x['content'] for x in data['checks'] if x['content'] and x['content'].get('op')=='credit')
assert not decoded.is_valid(dict(sample,extra=True))
bad=json.loads(json.dumps(sample));bad['credit']['payload']['sequence']='18446744073709551616';assert not decoded.is_valid(bad)
`],{input:JSON.stringify({core,streaming:corpus.schema,checks:schemaChecks}),maxBuffer:1024*1024});
if(process.argv.includes('--check')){
  assert.equal(await readFile(SCHEMA,'utf8'),json(corpus.schema),'streaming schema drift; regenerate corpus');
  for(const [name,contents]of corpus.files)assert.equal(await readFile(join(OUT,name),'utf8'),contents,`${name} fixture drift`);
  const existing=(await readdir(OUT)).filter(n=>n.endsWith('.json')).sort();assert.deepEqual(existing,[...corpus.files.keys()].sort(),'unexpected/missing corpus JSON files');
}else{
  if(process.argv.slice(2).some(a=>a!=='--write'))throw Error('Usage: native-streaming-examples.ts [--write|--check]');
  await mkdir(OUT,{recursive:true});for(const [name,contents]of corpus.files)await writeFile(join(OUT,name),contents);
  await writeFile(SCHEMA,json(corpus.schema));
}
console.log(`PASS native streaming corpus: ${corpus.vectors.length} signed core envelopes, every economic statement, exact u64 schema, real engine/service flow and replay/tamper/exhaustion/cancellation branches`);
