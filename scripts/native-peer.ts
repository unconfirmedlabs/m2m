/** Independent TypeScript core implementation; Iroh bridge only moves raw frames. */
import { bcs } from '@mysten/sui/bcs';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, stat } from 'node:fs/promises';
import { type AgentRef, type Authorization, readOptional, save } from './native-chain.js';
import { NativeLock } from './native-lock.js';

const bytes = () => bcs.vector(bcs.u8());
const Ref = bcs.struct('AgentRef',{network:bytes(),package_id:bcs.Address,domain:bcs.Address,agent:bcs.Address});
export const Envelope = bcs.struct('Envelope',{purpose:bytes(),sender:Ref,recipient:Ref,generation:bcs.u64(),
  id:bytes(),correlation:bcs.option(bytes()),created_ms:bcs.u64(),expires_ms:bcs.u64(),kind:bcs.string(),payload:bytes()});
const Logical = bcs.struct('Logical',{purpose:bytes(),sender:Ref,recipient:Ref,id:bytes(),correlation:bcs.option(bytes()),
  created_ms:bcs.u64(),expires_ms:bcs.u64(),kind:bcs.string(),payload:bytes()});
const Transcript = bcs.struct('Transcript',{purpose:bytes(),hello:Envelope,welcome:Envelope});
type Message = typeof Envelope.$inferType;
export interface SignedEnvelope {message:Message;signature:number[]}
export const utf8 = (s:string)=>Array.from(Buffer.from(s));
export const hash = (value:Uint8Array|number[])=>Array.from(blake2b(Uint8Array.from(value),{dkLen:32}));
const equal = (a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const id = ()=>Array.from(randomBytes(32));
const fail = (code:string):never=>{throw new Error(code);};
function exact(value:any, fields:string[]) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || !equal(Object.keys(value).sort(),fields.slice().sort())) fail('invalid_message');
}
function byteArray(value:unknown,length?:number): asserts value is number[] {
  if (!Array.isArray(value) || (length !== undefined && value.length!==length) || value.some(n=>!Number.isInteger(n)||n<0||n>255)) fail('invalid_message');
}
function decimal(value:unknown):bigint {
  if (typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value)||value.length>20||BigInt(value)>18446744073709551615n) fail('invalid_message');
  return BigInt(value as string);
}
function reference(value:AgentRef) {
  exact(value,['network','package_id','domain','agent']); byteArray(value.network);
  if (!value.network.length||value.network.length>64) fail('invalid_message');
  new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(value.network));
  for(const field of ['package_id','domain','agent'] as const) if(!/^0x[0-9a-f]{64}$/.test(value[field])) fail('invalid_message');
}
function sameRef(a:AgentRef,b:AgentRef) {return a.agent===b.agent&&a.domain===b.domain&&a.package_id===b.package_id&&equal(a.network,b.network);}

/** Reject duplicate keys (including escaped spellings) before JSON.parse loses them. */
export function strictJson(input:number[]|Uint8Array|string):any {
  const text=typeof input==='string'?input:new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(input));
  if (Buffer.byteLength(text)>1_048_576) fail('invalid_message');
  let cursor=0;
  const ws=()=>{while(/[\x20\t\r\n]/.test(text[cursor]??'!'))cursor++;};
  const string=()=>{
    const start=cursor++;let escaped=false;
    while(cursor<text.length){const c=text[cursor++];if(c==='"'&&!escaped)return JSON.parse(text.slice(start,cursor));if(c==='\\'&&!escaped)escaped=true;else escaped=false;}
    return fail('invalid_message');
  };
  const scan=(depth:number):void=>{
    if(depth>32)fail('invalid_message');ws();const c=text[cursor];
    if(c==='{'){cursor++;ws();const keys=new Set<string>();if(text[cursor]==='}'){cursor++;return;}
      for(;;){ws();if(text[cursor]!=='"')fail('invalid_message');const key=string();if(keys.has(key))fail('invalid_message: duplicate key');keys.add(key);ws();if(text[cursor++]!==':')fail('invalid_message');scan(depth+1);ws();const end=text[cursor++];if(end==='}')return;if(end!==',')fail('invalid_message');}}
    if(c==='['){cursor++;ws();if(text[cursor]===']'){cursor++;return;}for(;;){scan(depth+1);ws();const end=text[cursor++];if(end===']')return;if(end!==',')fail('invalid_message');}}
    if(c==='"'){string();return;}
    const start=cursor;while(cursor<text.length&&!/[\x20\t\r\n,\]}]/.test(text[cursor]))cursor++;if(cursor===start)fail('invalid_message');JSON.parse(text.slice(start,cursor));
  };
  scan(0);ws();if(cursor!==text.length)fail('invalid_message');return JSON.parse(text);
}
function validate(message:Message,now=BigInt(Date.now())) {
  exact(message,['purpose','sender','recipient','generation','id','correlation','created_ms','expires_ms','kind','payload']);
  reference(message.sender);reference(message.recipient);byteArray(message.purpose);byteArray(message.id,32);
  if(message.correlation!==null)byteArray(message.correlation,32);byteArray(message.payload);
  if(!equal(message.purpose,utf8('m2m/core/message/v1'))||typeof message.kind!=='string'||!/^[\x00-\x7f]{1,128}$/.test(message.kind)||message.payload.length>65536)fail('invalid_message');
  decimal(message.generation);const created=decimal(message.created_ms),expires=decimal(message.expires_ms);
  if(created>now||expires<=now||expires<=created||expires-created>86400000n)fail('expired');
}
export function authority(auth:Authorization,ref:AgentRef,now=BigInt(Date.now())) {
  exact(auth,['agent','controller','transport_key','economic_key','generation','read_at_ms','valid_until_ms']);reference(auth.agent);
  byteArray(auth.transport_key,32);byteArray(auth.economic_key,32);decimal(auth.generation);
  for(const key of [auth.transport_key,auth.economic_key]){const point=ed25519.Point.fromBytes(Uint8Array.from(key),false);
    if(point.isSmallOrder()||!point.isTorsionFree()||!equal(Array.from(point.toBytes()),key))fail('unauthorized');}
  if(!sameRef(auth.agent,ref)||equal(auth.transport_key,auth.economic_key)||!/^0x[0-9a-f]{64}$/.test(auth.controller))fail('unauthorized');
  const read=decimal(auth.read_at_ms),until=decimal(auth.valid_until_ms);
  if(read>now||now>=until||until-read>30000n||now-read>30000n)fail('stale_authority');
}
export async function verify(signed:SignedEnvelope,auth:Authorization,recipient:AgentRef,remoteKey:number[],now=BigInt(Date.now())) {
  exact(signed,['message','signature']);byteArray(signed.signature,64);validate(signed.message,now);authority(auth,signed.message.sender,now);
  if(!sameRef(signed.message.recipient,recipient)||signed.message.generation!==auth.generation||!equal(auth.transport_key,remoteKey))fail('unauthorized');
  const pk=Uint8Array.from(auth.transport_key),sig=Uint8Array.from(signed.signature);
  const r=ed25519.Point.fromBytes(sig.slice(0,32),false);
  if(r.isSmallOrder()||!r.isTorsionFree()||!Buffer.from(r.toBytes()).equals(Buffer.from(sig.slice(0,32)))||
    !ed25519.verify(sig,Envelope.serialize(signed.message).toBytes(),pk,{zip215:false}))fail('unauthorized');
}
export function commitment(message:Message):number[] {
  const p=strictJson(message.payload);let payload:Uint8Array;
  if(message.kind==='message.send') {exact(p,['session','service','content_type','content']);byteArray(p.content);payload=bcs.struct('Body',{service:bcs.string(),content_type:bcs.string(),content:bytes()}).serialize(p).toBytes();}
  else if(message.kind==='agent.describe'){exact(p,['session']);payload=new Uint8Array();}
  else if(message.kind.startsWith('extension.')){exact(p,['session','content']);byteArray(p.content);payload=bytes().serialize(p.content).toBytes();}
  else return fail('invalid_message');
  return hash(Logical.serialize({...message,purpose:utf8('m2m/core/logical/v1'),payload:Array.from(payload)}).toBytes());
}
export interface Features {required:string[];optional:string[]}
function featureList(list:unknown): asserts list is string[] {
  if(!Array.isArray(list)||list.length>16||list.some((f,i)=>typeof f!=='string'||!/^[a-z0-9._/-]{1,96}$/.test(f)||(i>0&&list[i-1]>=f)))fail('invalid_message');
}
export function select(a:Features,b:Features) {
  for(const f of [a,b]){featureList(f.required);featureList(f.optional);if(f.required.some(s=>f.optional.includes(s)))fail('invalid_message');}
  const aa=[...a.required,...a.optional],bb=[...b.required,...b.optional];const selected=aa.filter(f=>bb.includes(f)).sort();
  if([...a.required,...b.required].some(f=>!selected.includes(f)))fail('unsupported_feature');return selected;
}
export interface RawTransport {remoteKey:number[];send(bytes:number[]):Promise<void>;receive():Promise<number[]>;close():void}

/** A child bridge knows Iroh, framing, and key files; no m2m envelope semantics. */
export class IrohBridge implements RawTransport {
  remoteKey:number[]=[];private queue:any[]=[];private wake?:()=>void;private ended=false;
  readonly child:ChildProcessWithoutNullStreams;
  constructor(args:string[],binary=process.env.M2M_NATIVE_BRIDGE??'target/debug/native-bridge') {
    this.child=spawn(binary,args,{stdio:['pipe','pipe','pipe']});
    this.child.stderr.resume(); // Never forward accidental key/path/backend diagnostics.
    createInterface({input:this.child.stdout}).on('line',line=>{try{this.queue.push(strictJson(line));}catch{this.ended=true;}this.wake?.();});
    this.child.on('error',()=>{this.ended=true;this.wake?.();});this.child.on('exit',()=>{this.ended=true;this.wake?.();});
  }
  async event():Promise<any>{
    while(!this.queue.length){if(this.ended)fail('transport_closed');await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{this.wake=undefined;reject(new Error('transport_timeout'));},180000);
      this.wake=()=>{clearTimeout(timer);this.wake=undefined;resolve();};});}
    return this.queue.shift();
  }
  async connected(){for(;;){const event=await this.event();if(event.event==='connected'){byteArray(event.remote_key,32);this.remoteKey=event.remote_key;return;}}}
  async send(bytes:number[]){await new Promise<void>((resolve,reject)=>this.child.stdin.write(JSON.stringify({command:'send',bytes})+'\n',error=>error?reject(error):resolve()));}
  async receive(){for(;;){const event=await this.event();if(event.event==='frame'){byteArray(event.bytes);return event.bytes;}if(event.event==='error')fail('transport_error');}}
  close(){this.child.stdin.end();this.child.kill('SIGTERM');}
}

export type Resolver=(ref:AgentRef)=>Promise<Authorization>;
export class NativePeer {
  session:number[]=[];selected:string[]=[];private local!:Authorization;private remote!:Authorization;
  constructor(readonly agent:AgentRef,readonly key:Ed25519Keypair,readonly peer:AgentRef,readonly resolve:Resolver,
    readonly transport:RawTransport,readonly features:Features={required:[],optional:[]}){}
  private async refresh(initial=false){
    const [local,remote]=await Promise.all([this.resolve(this.agent),this.resolve(this.peer)]);authority(local,this.agent);authority(remote,this.peer);
    if(!equal(local.transport_key,Array.from(this.key.getPublicKey().toRawBytes()))||!equal(remote.transport_key,this.transport.remoteKey))fail('unauthorized');
    if(!initial&&(local.generation!==this.local.generation||remote.generation!==this.remote.generation))fail('unauthorized: reconnect required');
    this.local=local;this.remote=remote;
  }
  async sign(kind:string,payload:unknown,correlation:number[]|null=null):Promise<SignedEnvelope>{
    const now=BigInt(Date.now());const message:Message={purpose:utf8('m2m/core/message/v1'),sender:this.agent,recipient:this.peer,
      generation:this.local.generation,id:id(),correlation,created_ms:now.toString(),expires_ms:(now+30000n).toString(),kind,payload:utf8(JSON.stringify(payload))};
    validate(message);return {message,signature:Array.from(await this.key.sign(Envelope.serialize(message).toBytes()))};
  }
  async send(message:SignedEnvelope){await this.transport.send(utf8(JSON.stringify(message)));}
  async receive(kind?:string,correlation?:number[]|null):Promise<SignedEnvelope>{
    const signed=strictJson(await this.transport.receive()) as SignedEnvelope;await this.refresh();
    await verify(signed,this.remote,this.agent,this.transport.remoteKey);
    if((kind&&signed.message.kind!==kind)||(correlation!==undefined&&!equal(correlation,signed.message.correlation)))fail('invalid_message');
    return signed;
  }
  async connect(){
    await this.refresh(true);select(this.features,this.features);
    const hello=await this.sign('core.hello',{challenge:id(),...this.features});await this.send(hello);
    const welcome=await this.receive('core.welcome',hello.message.id);const p=strictJson(welcome.message.payload);
    exact(p,['hello_hash','challenge','required','optional','selected']);byteArray(p.challenge,32);
    if(!equal(p.hello_hash,hash(Envelope.serialize(hello.message).toBytes())))fail('invalid_message');
    this.selected=select(this.features,p);if(!equal(this.selected,p.selected))fail('unsupported_feature');
    this.session=hash(Transcript.serialize({purpose:utf8('m2m/core/session/v1'),hello:hello.message,welcome:welcome.message}).toBytes());
    const confirm=await this.sign('core.confirm',{session:this.session},welcome.message.id);await this.send(confirm);
    const ready=strictJson((await this.receive('core.ready',confirm.message.id)).message.payload);exact(ready,['session']);if(!equal(ready.session,this.session))fail('invalid_message');
  }
  async accept(){
    await this.refresh(true);const hello=await this.receive('core.hello',null);const h=strictJson(hello.message.payload);
    exact(h,['challenge','required','optional']);byteArray(h.challenge,32);
    try{this.selected=select(this.features,h);}catch(error){await this.send(await this.sign('core.error',{session:null,code:'unsupported_feature',detail:'mandatory feature not supported'},hello.message.id));throw error;}
    const welcome=await this.sign('core.welcome',{hello_hash:hash(Envelope.serialize(hello.message).toBytes()),challenge:id(),...this.features,selected:this.selected},hello.message.id);
    await this.send(welcome);this.session=hash(Transcript.serialize({purpose:utf8('m2m/core/session/v1'),hello:hello.message,welcome:welcome.message}).toBytes());
    const confirm=await this.receive('core.confirm',welcome.message.id);const c=strictJson(confirm.message.payload);exact(c,['session']);if(!equal(c.session,this.session))fail('invalid_message');
    await this.send(await this.sign('core.ready',{session:this.session},confirm.message.id));
  }
  async request(kind:string,fields:Record<string,unknown>,saved?:SignedEnvelope,outboxPath?:string) {
    await this.refresh();let message:SignedEnvelope;
    if(saved){
      if(!sameRef(saved.message.sender,this.agent)||!sameRef(saved.message.recipient,this.peer)||saved.message.kind!==kind)fail('unauthorized');
      const payload=strictJson(saved.message.payload);payload.session=this.session;
      const m={...saved.message,generation:this.local.generation,payload:utf8(JSON.stringify(payload))};
      message={message:m,signature:Array.from(await this.key.sign(Envelope.serialize(m).toBytes()))};
    }else message=await this.sign(kind,{session:this.session,...fields});
    await verify(message,this.local,this.peer,this.local.transport_key);
    if(outboxPath){const prior=await readOptional<SignedEnvelope>(outboxPath);if(prior&&!equal(commitment(prior.message),commitment(message.message)))fail('message_conflict');await save(outboxPath,message);}
    await this.send(message);
    const response=await this.receive(undefined,message.message.id),body=strictJson(response.message.payload);
    if(!equal(body.session,this.session))fail('invalid_message');
    if(response.message.kind==='core.error'){exact(body,['session','code','detail']);
      if(!['invalid_message','unauthorized','stale_authority','unsupported_feature','message_conflict','expired','overloaded','unknown_service','uncertain_dispatch','storage_failure','internal'].includes(body.code))fail('invalid_message');fail(body.code);}
    if(response.message.kind!=='message.receipt')fail('invalid_message');
    exact(body,['session','message_id','commitment','state','result']);
    if(!equal(body.message_id,message.message.id)||!equal(body.commitment,commitment(message.message))||!['accepted','dispatching','completed','uncertain'].includes(body.state))fail('invalid_message');
    if(body.result!==null)byteArray(body.result);
    // Retain verified provider proof for applications with durable terminal receipts.
    // This is an additive local API field; no envelope or signed bytes change.
    return {sent:message,receipt:body,response};
  }
  async describe():Promise<Array<{id:string;description:string;input_media_type:string;output_media_type:string}>>{
    await this.refresh();const message=await this.sign('agent.describe',{session:this.session});await this.send(message);
    const response=await this.receive('agent.description',message.message.id),body=strictJson(response.message.payload);
    exact(body,['session','services']);if(!equal(body.session,this.session)||!Array.isArray(body.services)||body.services.length>32)fail('invalid_message');
    for(const service of body.services){exact(service,['id','description','input_media_type','output_media_type']);
      if(Object.values(service).some(v=>typeof v!=='string'||v.length>1024))fail('invalid_message');}
    return body.services;
  }
  async serve(inbox:NativeInbox,handler:(kind:string,body:any,message:Message)=>Promise<number[]>) {
    for(;;){const signed=await this.receive();const m=signed.message,p=strictJson(m.payload);
      if(!equal(p.session,this.session))fail('invalid_message');
      if(m.kind==='agent.describe'){
        exact(p,['session']);const services=[
          {id:'echo',description:'Return supplied bytes',input_media_type:'application/octet-stream',output_media_type:'application/octet-stream'},
          {id:'blake2b-256',description:'Hash supplied bytes',input_media_type:'application/octet-stream',output_media_type:'application/octet-stream'},
        ];
        await this.send(await this.sign('agent.description',{session:this.session,services},m.id));continue;
      }
      if(m.kind==='message.send'){exact(p,['session','service','content_type','content']);if(typeof p.service!=='string'||p.service.length>128||typeof p.content_type!=='string'||p.content_type.length>128)fail('invalid_message');byteArray(p.content);}
      else if(m.kind.startsWith('extension.')){exact(p,['session','content']);byteArray(p.content);if(!this.selected.includes(m.kind.slice('extension.'.length)))fail('unsupported_feature');}
      else fail('invalid_message');
      try{const record=await inbox.dispatch(m,()=>handler(m.kind,p,m));
        await this.send(await this.sign('message.receipt',{session:this.session,message_id:m.id,commitment:record.commitment,state:record.state,result:record.result},m.id));
      }catch(error){const allowed=['message_conflict','overloaded','unknown_service'];const code=allowed.includes((error as Error).message)?(error as Error).message:'storage_failure';
        await this.send(await this.sign('core.error',{session:this.session,code,detail:code},m.id));}
    }
  }
}

interface InboxRecord {commitment:number[];state:'accepted'|'dispatching'|'completed'|'uncertain';result:number[]|null}
export class NativeInbox {
  private poisoned=false;
  private constructor(readonly path:string,private records:Record<string,InboxRecord>,private lock:NativeLock){}
  static async open(path:string){await mkdir(path,{recursive:true,mode:0o700});const lock=await NativeLock.acquire(`${path}/.lock`);
    try {const size=await stat(`${path}/inbox.json`).then(s=>s.size,e=>{if(e.code==='ENOENT')return 0;throw e;});if(size>16*1024*1024)fail('storage_failure');
      const existing=await readOptional<{version:number;records:Record<string,InboxRecord>}>(`${path}/inbox.json`);
      if(!existing&&await readOptional(`${path}/initialized.json`))fail('storage_failure');
      if(existing&&(existing.version!==1||!existing.records||Array.isArray(existing.records)))fail('storage_failure');
      if(existing)for(const [key,record] of Object.entries(existing.records)){
        if(!/^[0-9a-f]{64}:[0-9a-f]{64}$/.test(key))fail('storage_failure');exact(record,['commitment','state','result']);byteArray(record.commitment,32);
        if(!['accepted','dispatching','completed','uncertain'].includes(record.state))fail('storage_failure');
        if(record.result!==null){byteArray(record.result);if(record.result.length>65536)fail('storage_failure');}
        if((record.state==='completed')!==(record.result!==null))fail('storage_failure');
      }
      const inbox=new NativeInbox(path,existing?.records??{},lock);await inbox.persist();await save(`${path}/initialized.json`,{version:1});return inbox;
    }catch(error){await lock.close();throw error;}}
  private async persist(){if(this.poisoned)fail('storage_failure');try{if(Object.keys(this.records).length>1024||Buffer.byteLength(JSON.stringify({version:1,records:this.records},null,2))>16*1024*1024)fail('storage_failure');await save(`${this.path}/inbox.json`,{version:1,records:this.records});}catch(error){this.poisoned=true;throw error;}}
  async dispatch(message:Message,handler:()=>Promise<number[]>):Promise<InboxRecord>{
    if(this.poisoned)fail('storage_failure');const key=Buffer.from(hash(Ref.serialize(message.sender).toBytes())).toString('hex')+':'+Buffer.from(message.id).toString('hex');
    const digest=commitment(message),prior=this.records[key];
    if(prior){if(!equal(prior.commitment,digest))fail('message_conflict');return prior;}
    if(Object.keys(this.records).length>=1024||Buffer.byteLength(JSON.stringify({version:1,records:this.records},null,2))+1000000>16*1024*1024)fail('overloaded');
    const record:InboxRecord={commitment:digest,state:'accepted',result:null};this.records[key]=record;await this.persist();
    record.state='dispatching';await this.persist();
    try{const result=await handler();byteArray(result);if(result.length>65536)fail('overloaded');record.result=result;record.state='completed';}
    catch{record.state='uncertain';}
    await this.persist();return record;
  }
  async close(){await this.lock.close();}
}
