import { bcs } from '@mysten/sui/bcs';
import { blake2b } from '@noble/hashes/blake2.js';
import { createPublicKey, verify as nodeVerify } from 'node:crypto';

const bytes = () => bcs.vector(bcs.u8());
const counters = () => bcs.vector(bcs.u64());
const P = {purpose:bytes(),method:bytes(),version:bcs.u8(),network:bytes(),
  package_id:bcs.Address,deployment:bcs.Address,buyer:bcs.Address,provider:bcs.Address};
export const Policy = bcs.struct('Policy', {purpose:bytes(),version:bcs.u8(),units:bcs.vector(bytes()),rates:counters(),denominator:bcs.u64()});
export const Offer = bcs.struct('Offer', {...P,buyer_key:bytes(),provider_key:bytes(),refund:bcs.Address,payee:bcs.Address,
  opening_nonce:bytes(),policy_hash:bytes(),deposit:bcs.u64(),offer_expires_ms:bcs.u64(),work_deadline_ms:bcs.u64(),claim_deadline_ms:bcs.u64()});
export const Credit = bcs.struct('Credit', {...P,channel:bcs.Address,offer_hash:bytes(),sequence:bcs.u64(),request_sequence:bcs.u64(),
  request_hash:bytes(),previous_checkpoint:bytes(),units:counters(),cumulative_amount:bcs.u64()});
export const Ack = bcs.struct('Ack', {...P,channel:bcs.Address,offer_hash:bytes(),credit_hash:bytes(),sequence:bcs.u64()});
export const Checkpoint = bcs.struct('Checkpoint', {...P,channel:bcs.Address,offer_hash:bytes(),credit_hash:bytes(),sequence:bcs.u64(),
  request_sequence:bcs.u64(),request_hash:bytes(),previous_checkpoint:bytes(),units:counters(),cumulative_amount:bcs.u64(),output_hash:bytes(),final:bcs.bool()});
export const Domain = bcs.struct('Domain',{id:bcs.Address,network:bytes(),package_id:bcs.Address});
export const Agent = bcs.struct('Agent',{id:bcs.Address,deployment:bcs.Address,controller:bcs.Address,transport_key:bytes(),economic_key:bytes(),generation:bcs.u64(),expires_ms:bcs.u64()});
export const Channel = bcs.struct('Channel',{id:bcs.Address,offer:Offer,policy:Policy,funds:bcs.u64(),redeemed_amount:bcs.u64(),redeemed_sequence:bcs.u64(),
  redeemed_units:counters(),status:bcs.u8(),terminal_tx:bytes(),close_hash:bytes()});
export const PricingPolicy = bcs.struct('PricingPolicy',{id:bcs.Address,policy:Policy});
export const OpeningKey = bcs.struct('OpeningKey',{nonce:bytes()});
export type PolicyData = typeof Policy.$inferType;
export type OfferData = typeof Offer.$inferType;
export type CreditData = typeof Credit.$inferType;
export type AckData = typeof Ack.$inferType;
export type CheckpointData = typeof Checkpoint.$inferType;
export type DomainData = typeof Domain.$inferType;
export type AgentData = typeof Agent.$inferType;
export type ChannelData = typeof Channel.$inferType;
export interface SignedData<T> {payload:T;signature:number[]}
export type Statement = OfferData | CreditData | AckData | CheckpointData;
export type StatementKind = 'offer'|'credit'|'ack'|'checkpoint';
export const METHOD = 'sui.streaming.v1';
export const VERSION = 1;
export const utf8 = (s:string):number[] => Array.from(new TextEncoder().encode(s));
export const hash = (v:Uint8Array|number[]):number[] => Array.from(blake2b(Uint8Array.from(v),{dkLen:32}));
export const hex = (v:Uint8Array|number[]):string => Buffer.from(v).toString('hex');
export const ZERO_HASH = Array<number>(32).fill(0);
export const equal = (a:unknown,b:unknown):boolean => JSON.stringify(a) === JSON.stringify(b);
export const U64_MAX = (1n<<64n)-1n;
export const U128_MAX = (1n<<128n)-1n;
export const purpose = (kind:StatementKind|'policy') => utf8(`m2m/streaming/${kind}/v1`);

function record(v:unknown):Record<string,unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('expected object');
  return v as Record<string,unknown>;
}
export function exactKeys(v:unknown,keys:readonly string[]):Record<string,unknown> {
  const r=record(v); const actual=Object.keys(r).sort();
  if (!equal(actual,[...keys].sort())) throw new Error('unknown or missing fields');
  return r;
}
export function u64(v:unknown):string {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v) || BigInt(v)>U64_MAX) throw new Error('invalid canonical u64');
  return v;
}
export function byteArray(v:unknown,length?:number):number[] {
  if (!Array.isArray(v) || v.some(n=>!Number.isInteger(n)||n<0||n>255) || (length!==undefined && v.length!==length)) throw new Error('invalid bytes');
  return v;
}
function address(v:unknown):string {
  if (typeof v !== 'string' || !/^0x[0-9a-f]{64}$/.test(v)) throw new Error('noncanonical address');
  return v;
}
function quantities(v:unknown):string[] {
  if (!Array.isArray(v)||v.length<1||v.length>8) throw new Error('invalid unit dimensions');
  return v.map(u64);
}
export function validatePolicy(v:unknown):PolicyData {
  const r=exactKeys(v,['purpose','version','units','rates','denominator']);
  if (!equal(byteArray(r.purpose),purpose('policy'))||r.version!==1) throw new Error('unsupported policy');
  const rates=quantities(r.rates); const denominator=u64(r.denominator);
  if (denominator==='0') throw new Error('invalid policy denominator');
  if (!Array.isArray(r.units)||r.units.length!==rates.length) throw new Error('unit/rate dimensions differ');
  const names=r.units.map(n=>Buffer.from(byteArray(n)).toString('ascii'));
  r.units.forEach(n=>{const a=byteArray(n);if(a.some(v=>v>127))throw new Error('unit must be ASCII')});
  if (names.some(n=>!/^[a-z0-9._/-]{1,64}$/.test(n))||new Set(names).size!==names.length) throw new Error('invalid/duplicate units');
  return v as PolicyData;
}
export function makePolicy(units:string[],rates:(bigint|string|number)[],denominator:bigint|string|number):PolicyData {
  const decimal=(n:bigint|string|number)=>{
    if(typeof n==='number'&&!Number.isSafeInteger(n))throw new Error('numeric policy values must be safe integers; use decimal strings');
    return String(n);
  };
  return validatePolicy({purpose:purpose('policy'),version:1,units:units.map(utf8),rates:rates.map(decimal),denominator:decimal(denominator)});
}
export function price(policy:PolicyData,units:readonly string[]):string {
  validatePolicy(policy); quantities(units);
  if (units.length!==policy.rates.length) throw new Error('unit/rate dimensions differ');
  let total=0n;
  for(let i=0;i<units.length;i++) {total+=BigInt(u64(units[i]))*BigInt(policy.rates[i]);if(total>U128_MAX)throw new Error('u128 price overflow')}
  const denominator=BigInt(policy.denominator);const amount=total/denominator+(total%denominator===0n?0n:1n);
  if(amount>U64_MAX)throw new Error('u64 price overflow');
  return String(amount);
}
export function within(units:readonly string[],ceilings:readonly string[]):boolean {
  return units.length===ceilings.length && units.every((n,i)=>BigInt(u64(n))<=BigInt(u64(ceilings[i])));
}
export function policyHash(p:PolicyData):number[] {validatePolicy(p);return hash(Policy.serialize(p).toBytes())}

const suffix:Record<StatementKind,string[]>={
  offer:['buyer_key','provider_key','refund','payee','opening_nonce','policy_hash','deposit','offer_expires_ms','work_deadline_ms','claim_deadline_ms'],
  credit:['channel','offer_hash','sequence','request_sequence','request_hash','previous_checkpoint','units','cumulative_amount'],
  ack:['channel','offer_hash','credit_hash','sequence'],
  checkpoint:['channel','offer_hash','credit_hash','sequence','request_sequence','request_hash','previous_checkpoint','units','cumulative_amount','output_hash','final'],
};
export function validateStatement(kind:StatementKind,v:unknown):Statement {
  const r=exactKeys(v,[...Object.keys(P),...suffix[kind]]);
  if(!equal(byteArray(r.purpose),purpose(kind))||!equal(byteArray(r.method),utf8(METHOD))||r.version!==1)throw new Error('unsupported statement purpose/method/version');
  const network=byteArray(r.network);if(network.length<1||network.length>64)throw new Error('invalid network');
  // Fatal UTF-8 decoding prevents two displays of the same network from authorizing different bytes.
  new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(network));
  for(const k of ['package_id','deployment','buyer','provider'])address(r[k]);
  if(r.buyer===r.provider)throw new Error('parties must differ');
  for(const k of suffix[kind]) {
    if(['buyer_key','provider_key','opening_nonce','policy_hash','offer_hash','credit_hash','request_hash','previous_checkpoint','output_hash'].includes(k))byteArray(r[k],32);
    else if(['refund','payee','channel'].includes(k))address(r[k]);
    else if(k==='units')quantities(r[k]);
    else if(k==='final'){if(typeof r[k]!=='boolean')throw new Error('invalid final')}
    else u64(r[k]);
  }
  if(kind==='offer') {
    if(r.deposit==='0')throw new Error('zero deposit');
    const e=BigInt(r.offer_expires_ms as string),w=BigInt(r.work_deadline_ms as string),c=BigInt(r.claim_deadline_ms as string);
    if(!(e<w&&w<c&&c-w>=10_000n))throw new Error('invalid deadlines');
  } else {
    if(r.sequence==='0'||r.request_sequence==='0')throw new Error('zero sequence');
  }
  return v as Statement;
}
export const validateOffer=(v:unknown):OfferData=>validateStatement('offer',v) as OfferData;
export const validateCredit=(v:unknown):CreditData=>validateStatement('credit',v) as CreditData;
export const validateAck=(v:unknown):AckData=>validateStatement('ack',v) as AckData;
export const validateCheckpoint=(v:unknown):CheckpointData=>validateStatement('checkpoint',v) as CheckpointData;
export function statementBytes(kind:StatementKind,v:Statement):Uint8Array {
  validateStatement(kind,v);
  switch(kind) {
    case 'offer':return Offer.serialize(v as OfferData).toBytes();
    case 'credit':return Credit.serialize(v as CreditData).toBytes();
    case 'ack':return Ack.serialize(v as AckData).toBytes();
    case 'checkpoint':return Checkpoint.serialize(v as CheckpointData).toBytes();
  }
}
export const offerHash=(v:OfferData)=>hash(statementBytes('offer',v));
export const creditHash=(v:CreditData)=>hash(statementBytes('credit',v));
export const checkpointHash=(v:CheckpointData)=>hash(statementBytes('checkpoint',v));
export function validateSigned<T extends Statement>(kind:StatementKind,value:unknown,key:number[]):SignedData<T> {
  const r=exactKeys(value,['payload','signature']);const signature=byteArray(r.signature,64);byteArray(key,32);
  const payload=validateStatement(kind,r.payload) as T;
  const pub=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(key)]),format:'der',type:'spki'});
  if(!nodeVerify(null,statementBytes(kind,payload),pub,Buffer.from(signature)))throw new Error('invalid economic signature');
  return value as SignedData<T>;
}
export async function signStatement<T extends Statement>(kind:StatementKind,payload:T,signer:{sign(bytes:Uint8Array):Promise<Uint8Array>}):Promise<SignedData<T>> {
  return {payload,signature:Array.from(await signer.sign(statementBytes(kind,payload)))};
}
export function prefix(o:OfferData,kind:StatementKind) {
  return {purpose:purpose(kind),method:o.method,version:o.version,network:o.network,package_id:o.package_id,deployment:o.deployment,buyer:o.buyer,provider:o.provider};
}
export function makeCredit(o:OfferData,channel:string,sequence:string,request_sequence:string,request_hash:number[],previous_checkpoint:number[],units:string[],policy:PolicyData):CreditData {
  if(!equal(o.policy_hash,policyHash(policy)))throw new Error('wrong policy');
  const value=validateCredit({...prefix(o,'credit'),channel,offer_hash:offerHash(o),sequence,request_sequence,request_hash,previous_checkpoint,units,cumulative_amount:price(policy,units)});
  if(BigInt(value.cumulative_amount)>BigInt(o.deposit))throw new Error('deposit exceeded');
  return value;
}
export function makeAck(o:OfferData,c:CreditData):AckData {
  return validateAck({...prefix(o,'ack'),channel:c.channel,offer_hash:offerHash(o),credit_hash:creditHash(c),sequence:c.sequence});
}
export function makeCheckpoint(o:OfferData,c:CreditData,policy:PolicyData,units:string[],output_hash:number[],final=false):CheckpointData {
  if(!equal(o.policy_hash,policyHash(policy))||!within(units,c.units))throw new Error('wrong policy or exhausted credit');
  return validateCheckpoint({...prefix(o,'checkpoint'),channel:c.channel,offer_hash:offerHash(o),credit_hash:creditHash(c),sequence:c.sequence,
    request_sequence:c.request_sequence,request_hash:c.request_hash,previous_checkpoint:c.previous_checkpoint,units,cumulative_amount:price(policy,units),output_hash,final});
}
