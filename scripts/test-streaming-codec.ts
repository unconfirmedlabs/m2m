import assert from 'node:assert/strict';
import { createPublicKey,verify } from 'node:crypto';
import { streamingFixture } from './test-streaming-fixtures.js';
import {Policy,Offer,Credit,Ack,Checkpoint,price,makePolicy,U64_MAX,U128_MAX,validatePolicy,validateOffer,validateCredit,validateSigned,
  hash,hex,statementBytes,policyHash,makeCheckpoint,makeCredit,signStatement,utf8,type Statement,type StatementKind} from './streaming-codec.js';

// A second encoder uses only Node Buffer primitives; no @mysten BCS schemas.
const cat=(parts:Uint8Array[])=>Buffer.concat(parts);
const len=(n:number)=>{const out:number[]=[];do{const byte=n&127;n>>>=7;out.push(byte|(n?128:0))}while(n);return Buffer.from(out)};
const bytes=(b:number[])=>cat([len(b.length),Buffer.from(b)]);
const address=(a:string)=>Buffer.from(a.slice(2),'hex');
const integer=(v:string)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(v));return b};
const units=(v:string[])=>cat([len(v.length),...v.map(integer)]);
function independent(kind:StatementKind,v:Statement):Uint8Array {
  const p=cat([bytes(v.purpose),bytes(v.method),Buffer.from([v.version]),bytes(v.network),address(v.package_id),address(v.deployment),address(v.buyer),address(v.provider)]);
  switch(kind) {
    case 'offer':{const o=v as typeof Offer.$inferType;return cat([p,bytes(o.buyer_key),bytes(o.provider_key),address(o.refund),address(o.payee),bytes(o.opening_nonce),bytes(o.policy_hash),... [o.deposit,o.offer_expires_ms,o.work_deadline_ms,o.claim_deadline_ms].map(integer)])}
    case 'credit':{const c=v as typeof Credit.$inferType;return cat([p,address(c.channel),bytes(c.offer_hash),integer(c.sequence),integer(c.request_sequence),bytes(c.request_hash),bytes(c.previous_checkpoint),units(c.units),integer(c.cumulative_amount)])}
    case 'ack':{const a=v as typeof Ack.$inferType;return cat([p,address(a.channel),bytes(a.offer_hash),bytes(a.credit_hash),integer(a.sequence)])}
    case 'checkpoint':{const c=v as typeof Checkpoint.$inferType;return cat([p,address(c.channel),bytes(c.offer_hash),bytes(c.credit_hash),integer(c.sequence),integer(c.request_sequence),bytes(c.request_hash),bytes(c.previous_checkpoint),units(c.units),integer(c.cumulative_amount),bytes(c.output_hash),Buffer.from([c.final?1:0])])}
  }
}

const f=await streamingFixture();
for(const kind of ['offer','credit','ack','checkpoint'] as const) {
  const s=f[kind];const key=kind==='credit'?f.offer.payload.buyer_key:f.offer.payload.provider_key;
  assert.equal(hex(independent(kind,s.payload)),hex(statementBytes(kind,s.payload)),`${kind} independent BCS mismatch`);
  validateSigned(kind,s,key);
  const bad=structuredClone(s);bad.signature[0]^=1;assert.throws(()=>validateSigned(kind,bad,key),/signature/);
  const wrongDomain=structuredClone(s);wrongDomain.payload.network=utf8('another-network');assert.throws(()=>validateSigned(kind,wrongDomain,key),/signature/);
  assert.throws(()=>validateSigned(kind,s,key===f.offer.payload.buyer_key?f.offer.payload.provider_key:f.offer.payload.buyer_key),/signature/);
  const pub=createPublicKey({key:cat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(key)]),format:'der',type:'spki'});
  assert(verify(null,independent(kind,s.payload),pub,Buffer.from(s.signature)));
}
const independentPolicy=cat([bytes(f.policy.purpose),Buffer.from([1]),len(f.policy.units.length),...f.policy.units.map(bytes),units(f.policy.rates),integer(f.policy.denominator)]);
assert.equal(hex(independentPolicy),hex(Policy.serialize(f.policy).toBytes()));
assert.equal(hex(hash(independentPolicy)),hex(policyHash(f.policy)));
assert.equal(price(makePolicy(['bytes/v1'],['2'],'3'),['1']),'1');
assert.equal(price(makePolicy(['bytes/v1'],['2'],'3'),['3']),'2');
assert.equal(price(makePolicy(['records/v1'],['17'],'1'),['4']),'68');
assert.equal(price(makePolicy(['input/v1','output/v1','cache/v1'],['3','7','0'],'10'),['1','1','999']),'1');
assert.equal(price(f.policy,['4','25']),'8');
assert.equal(price(f.policy,['10','100']),'27');
assert.equal(price(makePolicy(['x/v1'],[String(U64_MAX)],String(U64_MAX)),[String(U64_MAX)]),String(U64_MAX));
assert.throws(()=>price(makePolicy(['x/v1'],['2'],'1'),[String(U64_MAX)]),/u64 price overflow/);
assert.throws(()=>price(makePolicy(['x/v1','y/v1'],[String(U64_MAX),String(U64_MAX)],String(U64_MAX)),[String(U64_MAX),String(U64_MAX)]),/u128 price overflow/);
assert.throws(()=>makePolicy(['x/v1','x/v1'],['1','1'],'1'),/duplicate/);
assert.throws(()=>makePolicy(['X/v1'],['1'],'1'),/units/);
assert.equal(price(makePolicy(['x/v1'],['0'],'1'),['100']),'0');
assert.throws(()=>makePolicy(['x/v1'],['1'],'0'),/denominator/);
assert.throws(()=>makePolicy(['x/v1'],[Number.MAX_SAFE_INTEGER+1],'1'),/safe integers/);
assert.throws(()=>makePolicy(Array(9).fill('x/v1'),Array(9).fill('1'),'1'),/dimensions/);
assert.throws(()=>validatePolicy({...f.policy,version:2}),/unsupported/);
assert.throws(()=>validatePolicy({...f.policy,extra:true}),/fields/);
assert.throws(()=>validateOffer({...f.offer.payload,deposit:'012000'}),/u64/);
assert.throws(()=>validateCredit({...f.credit.payload,sequence:1}),/u64/);
assert.throws(()=>makeCheckpoint(f.offer.payload,f.credit.payload,f.policy,['11','100'],hash([])),/exhausted/);
assert.throws(()=>makeCredit(f.offer.payload,f.channel,'1','1',f.requestHash,Array(32).fill(0),['18446744073709551615','100'],f.policy),/deposit/);
const changed=structuredClone(f.credit);changed.payload.units[0]='11';assert.throws(()=>validateSigned('credit',changed,f.offer.payload.buyer_key),/signature/);
assert(U128_MAX>U64_MAX);
if(process.argv.includes('--print-vectors')) {
  console.log(JSON.stringify({policy_hash:hex(policyHash(f.policy)),request_hash:hex(f.requestHash),output_hash:hex(hash(f.output)),
    ...Object.fromEntries((['offer','credit','checkpoint'] as const).map(k=>[k,{hash:hex(hash(statementBytes(k,f[k].payload))),signature:hex(f[k].signature)}]))},null,2));
}
console.log('PASS streaming codec: independent BCS, Ed25519 domains/tampering, bytes/records/multi-counter pricing, rounding, and overflow');
