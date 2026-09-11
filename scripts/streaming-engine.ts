import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  type SignedData,type OfferData,type CreditData,type AckData,type CheckpointData,type PolicyData,
  makeCredit,makeAck,makeCheckpoint,signStatement,validateSigned,validatePolicy,policyHash,
  creditHash,checkpointHash,offerHash,hash,equal,within,ZERO_HASH,statementBytes,price,u64,byteArray,
} from './streaming-codec.js';

export interface StreamingBinding {offer:SignedData<OfferData>;policy:PolicyData;channel:string}
export interface DeliveryRecord {checkpoint:SignedData<CheckpointData>;output_base64:string}
export interface CreditRecord {credit:SignedData<CreditData>;ack?:SignedData<AckData>;deliveries:DeliveryRecord[]}
export interface StreamingState {
  version:1;role:'buyer'|'provider';binding:StreamingBinding;frozen:boolean;
  completed_request_sequence:string;records:CreditRecord[];
}
type Signer={sign(bytes:Uint8Array):Promise<Uint8Array>};

/** Caller must hold an exclusive process lock and reconcile current chain state before new activity. */
export class StreamingEngine {
  private queue:Promise<unknown>=Promise.resolve();
  private storageFailed=false;
  private constructor(readonly path:string,private state:StreamingState,private signer:Signer) {}

  static async open(path:string,role:'buyer'|'provider',binding:StreamingBinding,signer:Signer):Promise<StreamingEngine> {
    validateSigned<OfferData>('offer',binding.offer,binding.offer.payload.provider_key);
    validatePolicy(binding.policy);
    if(!equal(policyHash(binding.policy),binding.offer.payload.policy_hash))throw new Error('policy commitment mismatch');
    if(!/^0x[0-9a-f]{64}$/.test(binding.channel))throw new Error('invalid channel');
    let state:StreamingState;
    try {
      state=JSON.parse(await readFile(path,'utf8')) as StreamingState;
      if(state.version!==1||state.role!==role||state.binding.channel!==binding.channel||
        !equal(offerHash(state.binding.offer.payload),offerHash(binding.offer.payload))||
        !equal(policyHash(state.binding.policy),policyHash(binding.policy)))throw new Error('journal binding mismatch');
      validateJournal(state);
    } catch(error) {
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      state={version:1,role,binding,frozen:false,completed_request_sequence:'0',records:[]};
      await persist(path,state);
    }
    return new StreamingEngine(path,structuredClone(state),signer);
  }

  snapshot():StreamingState{return structuredClone(this.state)}
  replay():CreditRecord[]{return structuredClone(this.state.records)}
  private serial<T>(fn:()=>Promise<T>):Promise<T> {
    const pending=this.queue.then(()=>{if(this.storageFailed)throw new Error('storage outcome uncertain; reopen and reconcile journal');return fn()});
    this.queue=pending.catch(()=>{});return pending;
  }
  private async commit(next:StreamingState) {
    try {await persist(this.path,next);this.state=next}
    catch(error){this.storageFailed=true;throw error}
  }
  private role(role:'buyer'|'provider') {if(this.state.role!==role)throw new Error(`requires ${role} role`)}
  private active() {if(this.state.frozen)throw new Error('channel is frozen')}
  private last():CreditRecord|undefined {return this.state.records.at(-1)}
  private latestCheckpoint():CheckpointData|undefined {
    for(let i=this.state.records.length-1;i>=0;i--){const d=this.state.records[i].deliveries.at(-1);if(d)return d.checkpoint.payload}
    return undefined;
  }
  private delivered():string[]{return this.latestCheckpoint()?.units??this.state.binding.policy.rates.map(()=> '0')}
  private previousHash():number[]{const c=this.latestCheckpoint();return c?checkpointHash(c):ZERO_HASH}
  private assertRequest(sequence:string,requestHash:number[]) {
    u64(sequence);byteArray(requestHash,32);
    const last=this.last()?.credit.payload;
    if(!last){if(sequence!=='1')throw new Error('first request sequence must be one');return}
    if(sequence===last.request_sequence) {
      if(BigInt(sequence)<=BigInt(this.state.completed_request_sequence)||!equal(requestHash,last.request_hash))throw new Error('request replay or conflict');
    } else {
      if(BigInt(sequence)!==BigInt(last.request_sequence)+1n||last.request_sequence!==this.state.completed_request_sequence)throw new Error('request sequence gap or active request');
      if(this.state.records.some(r=>equal(r.credit.payload.request_hash,requestHash)))throw new Error('request hash reused');
    }
  }

  /** Persist prepayment authorization before returning bytes the caller may transmit. */
  authorize(requestSequence:string,requestHash:number[],ceilings:string[]):Promise<SignedData<CreditData>> {
    return this.serial(async()=>{
      this.role('buyer');this.active();this.assertRequest(requestSequence,requestHash);
      const last=this.last();
      if(last&&(!last.ack||last.deliveries.length===0))throw new Error('recover pending acknowledgement/checkpoint before renewal');
      if(!within(this.delivered(),ceilings)||(last&&!within(last.credit.payload.units,ceilings)))throw new Error('nonmonotonic credit');
      const {offer,policy,channel}=this.state.binding;
      const payload=makeCredit(offer.payload,channel,String(BigInt(last?.credit.payload.sequence??'0')+1n),requestSequence,requestHash,this.previousHash(),ceilings,policy);
      const signed=await signStatement('credit',payload,this.signer);
      validateSigned('credit',signed,offer.payload.buyer_key);
      const next=this.snapshot();next.records.push({credit:signed,deliveries:[]});await this.commit(next);return structuredClone(signed);
    });
  }

  /** Validate and save the exact credit and Ack atomically before acknowledging delivery authority. */
  acceptCredit(signed:SignedData<CreditData>):Promise<SignedData<AckData>> {
    return this.serial(async()=>{
      this.role('provider');
      const {offer,policy,channel}=this.state.binding;
      const c=validateSigned<CreditData>('credit',signed,offer.payload.buyer_key).payload;
      const old=this.state.records.find(r=>r.credit.payload.sequence===c.sequence);
      if(old){if(!equal(creditHash(old.credit.payload),creditHash(c)))throw new Error('conflicting credit replay');return structuredClone(old.ack!)}
      this.active();this.assertRequest(c.request_sequence,c.request_hash);
      const last=this.last();
      if(last&&last.deliveries.length===0)throw new Error('pending delivery must be reconciled');
      const expected=makeCredit(offer.payload,channel,String(BigInt(last?.credit.payload.sequence??'0')+1n),c.request_sequence,c.request_hash,this.previousHash(),c.units,policy);
      if(!equal(creditHash(expected),creditHash(c)))throw new Error('credit binding, sequence, or checkpoint mismatch');
      if(!within(this.delivered(),c.units)||(last&&!within(last.credit.payload.units,c.units)))throw new Error('nonmonotonic credit');
      const ack=await signStatement('ack',makeAck(offer.payload,c),this.signer);
      validateSigned('ack',ack,offer.payload.provider_key);
      const next=this.snapshot();next.records.push({credit:structuredClone(signed),ack,deliveries:[]});await this.commit(next);return structuredClone(ack);
    });
  }

  receiveAck(signed:SignedData<AckData>):Promise<void> {
    return this.serial(async()=>{
      this.role('buyer');const o=this.state.binding.offer.payload;
      const a=validateSigned<AckData>('ack',signed,o.provider_key).payload;
      const index=this.state.records.findIndex(r=>r.credit.payload.sequence===a.sequence);
      if(index<0)throw new Error('ack has no issued credit');
      const r=this.state.records[index];
      if(!equal(hash(statementBytes('ack',makeAck(o,r.credit.payload))),hash(statementBytes('ack',a))))throw new Error('ack binding mismatch');
      if(r.ack)return;
      const next=this.snapshot();next.records[index].ack=structuredClone(signed);await this.commit(next);
    });
  }

  /** Cumulative service counters; all output is saved before the caller can send it. */
  deliver(units:string[],output:Uint8Array,options:{final?:boolean}={}):Promise<SignedData<CheckpointData>> {
    return this.serial(async()=>{
      this.role('provider');this.active();const r=this.last();
      if(!r?.ack)throw new Error('no acknowledged credit');
      if(!within(this.delivered(),units)||!within(units,r.credit.payload.units))throw new Error('nonmonotonic usage or exhausted credit');
      if(equal(units,this.delivered())&&!options.final)throw new Error('delivery must advance a unit counter');
      const {offer,policy}=this.state.binding;
      const cp=await signStatement('checkpoint',makeCheckpoint(offer.payload,r.credit.payload,policy,units,hash(output),options.final??false),this.signer);
      validateSigned('checkpoint',cp,offer.payload.provider_key);
      const next=this.snapshot();next.records.at(-1)!.deliveries.push({checkpoint:cp,output_base64:Buffer.from(output).toString('base64')});
      if(cp.payload.final)next.frozen=true;
      await this.commit(next);return structuredClone(cp);
    });
  }

  receiveCheckpoint(signed:SignedData<CheckpointData>,output:Uint8Array):Promise<void> {
    return this.serial(async()=>{
      this.role('buyer');const {offer,policy}=this.state.binding;
      const cp=validateSigned<CheckpointData>('checkpoint',signed,offer.payload.provider_key).payload;
      if(!equal(cp.output_hash,hash(output)))throw new Error('output commitment mismatch');
      for(const r of this.state.records)if(r.deliveries.some(d=>equal(checkpointHash(d.checkpoint.payload),checkpointHash(cp))))return;
      this.active();const r=this.last();
      if(!r?.ack)throw new Error('checkpoint requires persisted acknowledgement');
      const expected=makeCheckpoint(offer.payload,r.credit.payload,policy,cp.units,hash(output),cp.final);
      if(!equal(checkpointHash(cp),checkpointHash(expected)))throw new Error('checkpoint binding mismatch');
      if(!within(this.delivered(),cp.units)||(equal(this.delivered(),cp.units)&&!cp.final))throw new Error('nonmonotonic checkpoint');
      const next=this.snapshot();next.records.at(-1)!.deliveries.push({checkpoint:structuredClone(signed),output_base64:Buffer.from(output).toString('base64')});
      if(cp.final)next.frozen=true;
      await this.commit(next);
    });
  }

  /** Application request lifecycle marker; has no settlement or subjective acceptance meaning. */
  completeRequest(requestSequence:string):Promise<void> {
    return this.serial(async()=>{
      const last=this.last();u64(requestSequence);
      if(!last||last.credit.payload.request_sequence!==requestSequence||last.deliveries.length===0)throw new Error('request has no durable checkpoint');
      const next=this.snapshot();next.completed_request_sequence=requestSequence;await this.commit(next);
    });
  }
}

async function persist(path:string,state:StreamingState) {
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const tmp=`${path}.${randomBytes(12).toString('hex')}.tmp`;
  const handle=await open(tmp,'wx',0o600);
  try{await handle.writeFile(JSON.stringify(state)+'\n','utf8');await handle.sync()}finally{await handle.close()}
  await rename(tmp,path);
  const directory=await open(dirname(path),'r');try{await directory.sync()}finally{await directory.close()}
}

function validateJournal(state:StreamingState) {
  const {offer,policy,channel}=state.binding;
  validateSigned('offer',offer,offer.payload.provider_key);validatePolicy(policy);
  if(!Array.isArray(state.records)||typeof state.frozen!=='boolean')throw new Error('corrupt journal');
  u64(state.completed_request_sequence);
  let previous=ZERO_HASH;let delivered=policy.rates.map(()=> '0');let last:CreditData|undefined;let frozen=false;
  for(let index=0;index<state.records.length;index++) {
    const record=state.records[index];
    if(frozen)throw new Error('journal continued after final checkpoint');
    if(index>0&&state.records[index-1].deliveries.length===0)throw new Error('journal renewed before checkpoint');
    const c=validateSigned<CreditData>('credit',record.credit,offer.payload.buyer_key).payload;
    const expected=makeCredit(offer.payload,channel,String(BigInt(last?.sequence??'0')+1n),c.request_sequence,c.request_hash,previous,c.units,policy);
    if(!equal(creditHash(expected),creditHash(c))||!within(delivered,c.units)||(last&&!within(last.units,c.units)))throw new Error('corrupt credit chain');
    if(!last&&c.request_sequence!=='1')throw new Error('corrupt request sequence');
    if(last&&(BigInt(c.request_sequence)<BigInt(last.request_sequence)||BigInt(c.request_sequence)>BigInt(last.request_sequence)+1n||
      (c.request_sequence===last.request_sequence&&!equal(c.request_hash,last.request_hash))))throw new Error('corrupt request chain');
    if(last&&last.request_sequence!==c.request_sequence&&state.records.slice(0,index).some(r=>equal(r.credit.payload.request_hash,c.request_hash)))throw new Error('journal reused request commitment');
    if(record.ack) {
      const a=validateSigned<AckData>('ack',record.ack,offer.payload.provider_key).payload;
      if(!equal(hash(statementBytes('ack',makeAck(offer.payload,c))),hash(statementBytes('ack',a))))throw new Error('corrupt ack');
    } else if(state.role==='provider'||record.deliveries.length>0)throw new Error('missing durable ack');
    if(!Array.isArray(record.deliveries))throw new Error('corrupt deliveries');
    for(const delivery of record.deliveries) {
      if(frozen)throw new Error('delivery after final checkpoint');
      const cp=validateSigned<CheckpointData>('checkpoint',delivery.checkpoint,offer.payload.provider_key).payload;
      const output=Buffer.from(delivery.output_base64,'base64');
      if(output.toString('base64')!==delivery.output_base64)throw new Error('corrupt output encoding');
      const expectedCp=makeCheckpoint(offer.payload,c,policy,cp.units,hash(output),cp.final);
      if(!equal(checkpointHash(expectedCp),checkpointHash(cp))||!within(delivered,cp.units)||cp.cumulative_amount!==price(policy,cp.units)||
        (equal(delivered,cp.units)&&!cp.final))throw new Error('corrupt checkpoint chain');
      delivered=cp.units;previous=checkpointHash(cp);frozen=cp.final;
    }
    last=c;
  }
  if(frozen!==state.frozen||BigInt(state.completed_request_sequence)>BigInt(last?.request_sequence??'0'))throw new Error('corrupt terminal/request state');
}
