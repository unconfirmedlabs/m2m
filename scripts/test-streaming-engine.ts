import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamingEngine } from './streaming-engine.js';
import { streamingFixture } from './test-streaming-fixtures.js';
import { hash,utf8,equal,signStatement,makeCredit,makePolicy,policyHash,type OfferData } from './streaming-codec.js';

const dir=await mkdtemp(join(tmpdir(),'m2m-streaming-test-'));
const f=await streamingFixture();
const binding={offer:f.offer,policy:f.policy,channel:f.channel};
let buyer=await StreamingEngine.open(join(dir,'buyer.json'),'buyer',binding,f.buyer);
let provider=await StreamingEngine.open(join(dir,'provider.json'),'provider',binding,f.provider);
const credit=await buyer.authorize('1',f.requestHash,['10','100']);
assert.equal(JSON.parse(await readFile(join(dir,'buyer.json'),'utf8')).records[0].credit.signature.length,64);
assert.equal((await stat(join(dir,'buyer.json'))).mode&0o777,0o600);
await assert.rejects(()=>buyer.authorize('1',f.requestHash,['20','100']),/recover/);
await assert.rejects(()=>provider.deliver(['1','1'],Uint8Array.of(1)),/acknowledged/);
const ack=await provider.acceptCredit(credit);
assert.deepEqual(await provider.acceptCredit(credit),ack);
assert.equal(provider.snapshot().records.length,1);
const tampered=structuredClone(credit);tampered.payload.units[0]='11';
await assert.rejects(()=>provider.acceptCredit(tampered),/signature/);
const conflicting=await signStatement('credit',{...credit.payload,units:['11','100'],cumulative_amount:'28'},f.buyer);
await assert.rejects(()=>provider.acceptCredit(conflicting),/conflicting/);
await buyer.receiveAck(ack);await buyer.receiveAck(ack);
await assert.rejects(()=>provider.deliver(['11','100'],Uint8Array.of(1)),/exhausted/);
const bytes=Uint8Array.from(utf8('first delivery'));
const cp1=await provider.deliver(['4','25'],bytes);
assert.equal(JSON.parse(await readFile(join(dir,'provider.json'),'utf8')).records[0].deliveries.length,1);
await assert.rejects(()=>buyer.receiveCheckpoint(cp1,Uint8Array.of(3)),/output commitment/);
await buyer.receiveCheckpoint(cp1,bytes);await buyer.receiveCheckpoint(cp1,bytes);
assert.equal(buyer.snapshot().records[0].deliveries.length,1);
assert.equal(cp1.payload.cumulative_amount,'8');
// Multiple increments under the same credit use cumulative rounding, not incremental charges.
const second=Uint8Array.from(utf8('second delivery'));
const cp2=await provider.deliver(['5','26'],second);await buyer.receiveCheckpoint(cp2,second);
assert.equal(cp2.payload.cumulative_amount,'9');
await assert.rejects(()=>provider.deliver(['4','27'],second),/nonmonotonic/);

// Crash after provider saved delivery but before the buyer observed it: replay saved bytes/signature.
const lostBytes=Uint8Array.from(utf8('persisted before disconnect'));
const lost=await provider.deliver(['6','30'],lostBytes);
provider=await StreamingEngine.open(join(dir,'provider.json'),'provider',binding,f.provider);
buyer=await StreamingEngine.open(join(dir,'buyer.json'),'buyer',binding,f.buyer);
const stale=await signStatement('credit',makeCredit(f.offer.payload,f.channel,'2','1',f.requestHash,hash(utf8('wrong checkpoint')),['20','200'],f.policy),f.buyer);
await assert.rejects(()=>provider.acceptCredit(stale),/checkpoint mismatch/);
const recovered=provider.replay()[0].deliveries.at(-1)!;
assert.deepEqual(recovered.checkpoint,lost);
await buyer.receiveCheckpoint(recovered.checkpoint,Buffer.from(recovered.output_base64,'base64'));
const credit2=await buyer.authorize('1',f.requestHash,['20','200']);
const ack2=await provider.acceptCredit(credit2);await buyer.receiveAck(ack2);
assert.equal(credit2.payload.sequence,'2');assert.equal(credit2.payload.request_sequence,'1');
const cp3=await provider.deliver(['11','120'],second);await buyer.receiveCheckpoint(cp3,second);
await assert.rejects(()=>buyer.authorize('2',hash(utf8('second request')),['30','300']),/active request/);
await buyer.completeRequest('1');await provider.completeRequest('1');
await assert.rejects(()=>buyer.authorize('2',f.requestHash,['30','300']),/reused/);
const credit3=await buyer.authorize('2',hash(utf8('second request')),['30','300']);
await buyer.receiveAck(await provider.acceptCredit(credit3));
assert.equal(credit3.payload.sequence,'3');assert.equal(credit3.payload.request_sequence,'2');
// The provider freezes consent before exposing its exact close. The buyer signs nothing new.
const final=await provider.deliver(['15','160'],second,{final:true});
await buyer.receiveCheckpoint(final,second);
await assert.rejects(()=>provider.deliver(['16','161'],second),/frozen/);
await assert.rejects(()=>buyer.authorize('2',credit3.payload.request_hash,['40','400']),/frozen/);
assert.deepEqual(await provider.acceptCredit(credit),ack,'old exact credit can still replay after close');
buyer=await StreamingEngine.open(join(dir,'buyer.json'),'buyer',binding,f.buyer);
provider=await StreamingEngine.open(join(dir,'provider.json'),'provider',binding,f.provider);
assert(buyer.snapshot().frozen&&provider.snapshot().frozen);
assert.equal(buyer.snapshot().records.length,3);
assert.deepEqual(buyer.snapshot().records,provider.snapshot().records);
await buyer.receiveCheckpoint(cp1,bytes);
assert.equal(buyer.snapshot().records[0].deliveries.length,3);
await assert.rejects(()=>StreamingEngine.open(join(dir,'buyer.json'),'provider',binding,f.provider),/binding mismatch/);
const corrupted=buyer.snapshot();corrupted.records[0].deliveries[0].output_base64='AAAA';
await writeFile(join(dir,'corrupt.json'),JSON.stringify(corrupted));
await assert.rejects(()=>StreamingEngine.open(join(dir,'corrupt.json'),'buyer',binding,f.buyer),/corrupt checkpoint/);

// Free policy representation, acknowledgement, exact close, and records service share the engine.
for(const [name,policy,ceilings,delivered] of [
  ['bytes',makePolicy(['bytes/v1'],['2'],'3'),['20'],['7']],
  ['records',makePolicy(['records/v1'],['17'],'1'),['5'],['3']],
  ['free',makePolicy(['bytes/v1'],['0'],'1'),['20'],['7']],
] as const) {
  const offer:OfferData={...f.offer.payload,policy_hash:policyHash(policy)};
  const b={offer:await signStatement('offer',offer,f.provider),policy,channel:f.channel};
  const buy=await StreamingEngine.open(join(dir,`${name}-buyer.json`),'buyer',b,f.buyer);
  const pro=await StreamingEngine.open(join(dir,`${name}-provider.json`),'provider',b,f.provider);
  const c=await buy.authorize('1',f.requestHash,[...ceilings]);await buy.receiveAck(await pro.acceptCredit(c));
  const cp=await pro.deliver([...delivered],bytes,{final:true});await buy.receiveCheckpoint(cp,bytes);
  assert.equal(cp.payload.cumulative_amount,name==='records'?'51':name==='bytes'?'5':'0');
}
console.log('PASS streaming engine: credit gating, request/payment replay, cumulative checkpoints, durable restart, exact close consent, two services and free policy');
