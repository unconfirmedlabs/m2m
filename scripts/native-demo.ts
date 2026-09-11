import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { toBase58 } from '@mysten/sui/utils';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { NativeChain, readOptional, readKey, save, type NativeConfig } from './native-chain.js';
import { NativeNames } from './native-names.js';
import { StreamingChain } from './native-streaming-chain.js';
import { NativePeer, NativeInbox, IrohBridge, strictJson, type SignedEnvelope } from './native-peer.js';
import { StreamingEngine, type StreamingBinding } from './streaming-engine.js';
import { makePolicy, policyHash, purpose, METHOD, utf8, hash, equal, signStatement, offerHash, checkpointHash, type OfferData, type SignedData, type ChannelData } from './streaming-codec.js';
import { ResearchService, requestHash, STREAMING_FEATURE, STREAMING_KIND, type ResearchRequest, type ResearchWorker } from './native-research.js';
import { CodexWorker, type RequestRecord, type WorkRequest } from './codex-worker.js';
import { NativeLock } from './native-lock.js';

const {values}=parseArgs({options:{state:{type:'string',default:'.m2m/native-testnet'},session:{type:'string',default:'demo'},
  wallet:{type:'string'},provider:{type:'boolean',default:false},fixture:{type:'boolean',default:false},'request-file':{type:'string'},fault:{type:'string'}}});
if(values.fault&&!['after-delivery','after-close'].includes(values.fault))throw Error('Unsupported fault injection');
if(!/^[a-zA-Z0-9_-]{1,64}$/.test(values.session!))throw Error('Invalid session ID');
const state=resolve(values.state!),run=join(state,'runs',values.session!);
const config=await readOptional<NativeConfig>(join(state,'chain.json'));if(!config)throw Error('Run native-setup first');
const chain=new StreamingChain(config);await chain.validate();
const local=await readOptional<{agent:string}>(join(state,'local/identity.json'));
const research=await readOptional<{agent:string}>(join(state,'research/identity.json'));
if(!local||!research)throw Error('Missing Agent identities');
const localRef=chain.reference(local.agent),researchRef=chain.reference(research.agent);
if(config.network==='testnet'){
  const names=new NativeNames(chain);
  await Promise.all([names.resolve('local.nozomi.sui',localRef),names.resolve('research.nozomi.sui',researchRef)]);
}
const side=values.provider?'provider':'buyer',sideDir=join(run,side);
await mkdir(sideDir,{recursive:true,mode:0o700});
const processLock=await NativeLock.acquire(join(sideDir,'.process.lock'));
let bridge:IrohBridge|undefined,worker:CodexWorker|undefined,inbox:NativeInbox|undefined,providerProcess:ReturnType<typeof spawn>|undefined;
process.once('SIGTERM',()=>{bridge?.close();worker?.close();});
function settlementResult(engine:StreamingEngine,ch:ChannelData,digest:string,exhausted:boolean){
  const records=engine.replay(),last=records.at(-1),final=last?.deliveries.at(-1)?.checkpoint;
  if(!last||!final?.payload.final||ch.status!==1||ch.funds!=='0'||ch.redeemed_amount!==final.payload.cumulative_amount||
    !equal(ch.close_hash,checkpointHash(final.payload)))throw Error('Exact settlement mismatch');
  const delivered=records.flatMap(r=>r.deliveries).reduce((n,d)=>n+Buffer.from(d.output_base64,'base64').length,0);
  return {network:config!.network,adapter:values.fixture?'deterministic-fixture':'codex-gpt-5.6-luna-xhigh',channel:ch.id,
    free_messaging:true,credit_exhaustion_checked:exhausted,credits:records.length,output_bytes:delivered,
    authorized_amount:last.credit.payload.cumulative_amount,delivered_amount:final.payload.cumulative_amount,redeemed_amount:ch.redeemed_amount,
    residual_refund:String(BigInt(ch.offer.deposit)-BigInt(ch.redeemed_amount)),deposit:ch.offer.deposit,settlement_digest:digest};
}

/** Deterministic integration fixture; explicitly not Codex evidence. */
class FixtureWorker implements ResearchWorker {
  private record?:RequestRecord;
  constructor(private path:string){}
  async run(request:WorkRequest){
    this.record=await readOptional<RequestRecord>(this.path);
    if(!this.record){const now=Date.now(),text='Bounded streaming response. '.repeat(16);
      this.record={...request,commitment:'fixture',submittedInputHash:'fixture',clientUserMessageId:'fixture',state:'completed',threadId:'fixture-thread',turnId:'fixture-turn',knownTurnIds:[],
        startedAt:now,deadline:now+60000,baselineUsage:null,upstreamUsage:null,usageObserved:false,producedUtf8Bytes:Buffer.byteLength(text),items:{fixture:text},
        events:[{index:0,observedAt:now,requestId:request.requestId,type:'content',itemId:'fixture',delta:text,producedUtf8Bytes:Buffer.byteLength(text)}]};
      await save(this.path,this.record);
    }return structuredClone(this.record);
  }
  status(){return this.record?structuredClone(this.record):undefined;}
  async reconcile(){this.record=await readOptional<RequestRecord>(this.path);return this.status();}
  async cancel(){return this.status();}
}
try{
  if(values.provider){
    const transport=await readKey(join(state,'research/transport.json')),economic=await readKey(join(state,'research/economic.json'));
    inbox=await NativeInbox.open(join(sideDir,'inbox'));
    bridge=new IrohBridge(['listen','--key-file',join(state,'research/iroh-key.json'),'--ticket',join(run,'ticket.json')]);
    const listening=await bridge.event();if(listening.event!=='listening')throw Error('Provider bridge failed');
    console.log(JSON.stringify({event:'provider_ready'}));await bridge.connected();
    const peer=new NativePeer(researchRef,transport,localRef,r=>chain.resolve(r),bridge,{required:[STREAMING_FEATURE],optional:[]});await peer.accept();
    let service:ResearchService|undefined;
    const ensureService=async()=>{
      if(service)return service;
      const binding=await readOptional<StreamingBinding>(join(sideDir,'binding.json'));if(!binding)throw Error('channel_not_funded');
      const ch=await chain.channel(binding.channel);if(!equal(offerHash(ch.offer),offerHash(binding.offer.payload)))throw Error('channel_mismatch');
      const engine=await StreamingEngine.open(join(sideDir,'stream.json'),'provider',binding,economic);
      let workerLocation=await readOptional<{path:string}>(join(sideDir,'worker-location.json'));
      if(!values.fixture&&!workerLocation){workerLocation={path:await mkdtemp(join(tmpdir(),'m2m-research-worker-'))};await save(join(sideDir,'worker-location.json'),workerLocation);}
      const backend:ResearchWorker=values.fixture?new FixtureWorker(join(sideDir,'fixture.json')):
        (worker=await CodexWorker.open({stateDir:workerLocation!.path,authFile:process.env.M2M_CODEX_AUTH_FILE,maxDurationMs:60000,maxOutputBytes:16384}));
      service=await ResearchService.open(join(sideDir,'service.json'),engine,backend);return service;
    };
    await peer.serve(inbox,async(kind,body)=>{
      if(kind==='message.send'){
        if(body.service==='echo')return body.content;
        if(body.service==='blake2b-256')return hash(body.content);
        throw Error('unknown_service');
      }
      const cmd=strictJson(body.content);
      if(cmd.op==='offer'){
        if(Object.keys(cmd).sort().join(',')!=='nonce,op')throw Error('invalid_offer_request');
        if(!Array.isArray(cmd.nonce)||cmd.nonce.length!==32||cmd.nonce.some((n:unknown)=>!Number.isInteger(n)||Number(n)<0||Number(n)>255))throw Error('invalid_nonce');
        let quote=await readOptional<{offer:SignedData<OfferData>;policy:ReturnType<typeof makePolicy>}>(join(sideDir,'offer.json'));
        if(quote){if(!equal(quote.offer.payload.opening_nonce,cmd.nonce))throw Error('offer_conflict');}
        else{
          const [a,b,now]=await Promise.all([chain.resolve(localRef),chain.resolve(researchRef),chain.clock()]);
          const policy=makePolicy(['input_utf8_bytes','output_utf8_bytes'],['1','2'],'8');
          const payload:OfferData={purpose:purpose('offer'),method:utf8(METHOD),version:1,network:localRef.network,package_id:config.package_id,deployment:config.domain,
            buyer:local.agent,provider:research.agent,buyer_key:a.economic_key,provider_key:b.economic_key,refund:a.controller,payee:b.controller,
            opening_nonce:cmd.nonce,policy_hash:policyHash(policy),deposit:'100000',offer_expires_ms:String(now+120000n),work_deadline_ms:String(now+600000n),claim_deadline_ms:String(now+1200000n)};
          quote={offer:await signStatement('offer',payload,economic),policy};await save(join(sideDir,'offer.json'),quote);
        }return utf8(JSON.stringify({type:'offer',...quote}));
      }
      if(cmd.op==='funded'){
        if(Object.keys(cmd).sort().join(',')!=='channel,op')throw Error('invalid_funding_notice');
        const quote=await readOptional<{offer:SignedData<OfferData>;policy:ReturnType<typeof makePolicy>}>(join(sideDir,'offer.json'));if(!quote)throw Error('unknown_offer');
        const ch=await chain.channel(cmd.channel);
        if(ch.status!==0||!equal(offerHash(ch.offer),offerHash(quote.offer.payload)))throw Error('funded_terms_mismatch');
        const binding={...quote,channel:ch.id};await save(join(sideDir,'binding.json'),binding);await ensureService();
        return utf8(JSON.stringify({type:'funded',channel:ch.id}));
      }
      const svc=await ensureService(),binding=svc.engine.snapshot().binding,ch=await chain.channel(binding.channel),now=await chain.clock();
      const saved=svc.cached(body.content);if(saved)return saved;
      if(ch.status!==0||now>=BigInt(ch.offer.work_deadline_ms))throw Error('channel_not_open_for_work');
      return svc.command(body.content);
    });
  }else{
    if(!values.wallet)throw Error('--wallet is required for localnet/testnet funding');
    const wallet=await readKey(resolve(values.wallet));
    const existingBinding=await readOptional<StreamingBinding>(join(sideDir,'binding.json'));
    const existingChannel=existingBinding?await chain.channel(existingBinding.channel):undefined;
    if(existingChannel&&existingChannel.status!==0){
      if(existingChannel.status!==1)throw Error('Channel was refunded; inspect the existing agreement');
      const engine=await StreamingEngine.open(join(sideDir,'stream.json'),'buyer',existingBinding!,await readKey(join(state,'local/economic.json')));
      const evidence=await readOptional<{credit_exhaustion_checked:boolean}>(join(sideDir,'validation.json'));
      const result=settlementResult(engine,existingChannel,toBase58(Uint8Array.from(existingChannel.terminal_tx)),evidence?.credit_exhaustion_checked??false);
      await save(join(sideDir,'result.json'),result);console.log(JSON.stringify({...result,recovered:true}));
    }
    else{
      let request=await readOptional<ResearchRequest>(join(sideDir,'request.json'));
      if(!request){request=values['request-file']?await readOptional<ResearchRequest>(resolve(values['request-file'])):
        {version:1,conversation:randomBytes(32).toString('hex'),request:randomBytes(32).toString('hex'),sequence:'1',
          prompt:'Explain in roughly 120 words how a cumulative prepaid channel can gate a streamed response. Do not use tools.'};
        if(!request)throw Error('Missing request input');await save(join(sideDir,'request.json'),request);}
      const args=['scripts/native-demo.ts','--state',state,'--session',values.session!,'--provider',...(values.fixture?['--fixture']:[])];
      providerProcess=spawn('node',['--import','tsx',...args],{stdio:['ignore','pipe','pipe'],env:process.env});
      providerProcess.stderr?.resume();
      await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Provider startup timed out')),30000);
        providerProcess!.once('exit',()=>{clearTimeout(timer);reject(Error('Provider exited before admission'));});
        providerProcess!.stdout?.once('data',()=>{clearTimeout(timer);resolve();});});
      bridge=new IrohBridge(['connect','--key-file',join(state,'local/iroh-key.json'),'--ticket',join(run,'ticket.json')]);await bridge.connected();
      const peer=new NativePeer(localRef,await readKey(join(state,'local/transport.json')),researchRef,r=>chain.resolve(r),bridge,{required:[STREAMING_FEATURE],optional:[]});await peer.connect();
      const free=await peer.request('message.send',{service:'echo',content_type:'application/octet-stream',content:utf8('unpaid before funding')});
      if(!equal(free.receipt.result,utf8('unpaid before funding')))throw Error('Free echo failed');
      const operation=async(command:any)=>{
        const pendingPath=join(sideDir,'pending.json');let pending=await readOptional<{command:any;signed:SignedEnvelope}|null>(pendingPath);
        if(pending&&!equal(pending.command,command))throw Error('Pending operation must be reconciled before a different command');
        if(!['offer','funded','credit','start','poll','cancel'].includes(command.op))throw Error('Operation has no idempotent recovery contract');
        for(let attempt=0;attempt<2;attempt++){
          // Research v1 recovers by economic nonce/request/credit/cursor identity.
          // An expired core ID is never redefined; use a new, correlated attempt.
          if(!pending||BigInt(pending.signed.message.expires_ms)<=BigInt(Date.now())){
            pending={command,signed:await peer.sign(STREAMING_KIND,{session:peer.session,content:utf8(JSON.stringify(command))},pending?.signed.message.id??null)};await save(pendingPath,pending);}
          const response=await peer.request(STREAMING_KIND,{},pending.signed);
          if(response.receipt.state==='completed'&&response.receipt.result!==null){const data=strictJson(response.receipt.result);await save(pendingPath,null);return data;}
          const previous=pending.signed.message.id;
          pending={command,signed:await peer.sign(STREAMING_KIND,{session:peer.session,content:utf8(JSON.stringify(command))},previous)};await save(pendingPath,pending);
        }
        throw Error('Extension reconciliation uncertain; inspect provider journal');
      };
      // Complete the interrupted application transition before traversing setup.
      const interrupted=await readOptional<{command:any;signed:SignedEnvelope}|null>(join(sideDir,'pending.json'));
      if(interrupted){const response=await operation(interrupted.command);
        if(interrupted.command.op==='offer')await save(join(sideDir,'offer.json'),response);
        if(['credit','poll'].includes(interrupted.command.op)){
          const binding=await readOptional<StreamingBinding>(join(sideDir,'binding.json'));if(!binding)throw Error('Missing interrupted channel binding');
          const engine=await StreamingEngine.open(join(sideDir,'stream.json'),'buyer',binding,await readKey(join(state,'local/economic.json')));
          if(response.type==='ack')await engine.receiveAck(response.ack);
          if(response.type==='delivery')await engine.receiveCheckpoint(response.checkpoint,Uint8Array.from(response.output));
        }
      }
      let nonce=await readOptional<number[]>(join(sideDir,'nonce.json'));if(!nonce){nonce=Array.from(randomBytes(32));await save(join(sideDir,'nonce.json'),nonce);}
      let quote=await readOptional<{offer:SignedData<OfferData>;policy:ReturnType<typeof makePolicy>}>(join(sideDir,'offer.json'));
      if(!quote){quote=await operation({op:'offer',nonce});await save(join(sideDir,'offer.json'),quote);}
      if(!quote)throw Error('Offer missing');
      const policy=makePolicy(['input_utf8_bytes','output_utf8_bytes'],['1','2'],'8');
      if(!equal(policyHash(quote.policy),policyHash(policy))||quote.offer.payload.deposit!=='100000')throw Error('Quoted price exceeds demo policy');
      const channel=await chain.fund(quote.offer,quote.policy,wallet,join(sideDir,'fund.tx.json'));
      const binding={offer:quote.offer,policy:quote.policy,channel};await save(join(sideDir,'binding.json'),binding);
      await operation({op:'funded',channel});
      const engine=await StreamingEngine.open(join(sideDir,'stream.json'),'buyer',binding,await readKey(join(state,'local/economic.json')));
      const digest=requestHash(channel,request),input=String(Buffer.byteLength(request.prompt));
      const initial=engine.replay().at(-1)?.credit??await engine.authorize('1',digest,[input,'128']);
      if(!engine.replay().at(-1)?.ack)await engine.receiveAck((await operation({op:'credit',request,credit:initial})).ack);
      await operation({op:'start',request_hash:digest});
      const started=Date.now();let exhaustedChecked=(await readOptional<{credit_exhaustion_checked:boolean}>(join(sideDir,'validation.json')))?.credit_exhaustion_checked??false;
      while(!engine.snapshot().frozen){
        if(Date.now()-started>120000)throw Error('Demo deadline exceeded; resume the existing session');
        const records=engine.replay(),latest=records.at(-1)!,last=records.flatMap(r=>r.deliveries).at(-1)?.checkpoint;
        const output=last?.payload.units[1]??'0';
        const response=await operation({op:'poll',request_hash:digest,after_output:output});
        if(response.type==='delivery'){
          await engine.receiveCheckpoint(response.checkpoint,Uint8Array.from(response.output));
          if(values.fault==='after-delivery')throw Error('injected_after_durable_delivery');
        }else if(response.type==='waiting'){
          if(response.reason==='credit_exhausted'){
            if(output!==latest.credit.payload.units[1])throw Error('Unexpected credit boundary');
            exhaustedChecked=true;
            await save(join(sideDir,'validation.json'),{credit_exhaustion_checked:true});
            const credit=await engine.authorize('1',digest,[input,String(BigInt(output)+128n)]);
            await engine.receiveAck((await operation({op:'credit',request,credit})).ack);
          }else await new Promise(r=>setTimeout(r,100));
        }
        else throw Error('Unexpected streaming response');
      }
      const records=engine.replay(),last=records.at(-1)!,final=last.deliveries.at(-1)!.checkpoint;
      const closed=await chain.closeExact(last.credit,final,wallet,join(sideDir,'close.tx.json'));const ch=await chain.channel(channel);
      if(values.fault==='after-close')throw Error('injected_after_chain_close');
      const result=settlementResult(engine,ch,closed.digest,exhaustedChecked);
      await save(join(sideDir,'result.json'),result);console.log(JSON.stringify(result));
    }
  }
}finally{
  bridge?.close();worker?.close();if(inbox)await inbox.close();
  if(providerProcess&&providerProcess.exitCode===null){
    providerProcess.kill('SIGTERM');
    await new Promise<void>(done=>{const timer=setTimeout(()=>{providerProcess?.kill('SIGKILL');done();},5000);
      providerProcess!.once('exit',()=>{clearTimeout(timer);done();});});
  }
  await processLock.close();
}
