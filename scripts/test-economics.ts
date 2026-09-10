import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Chain, key, save, type ChainConfig } from './chain.js';
import { Quote, Acceptance, acceptance, utf8, hash, type QuoteData } from './codec.js';

const root = resolve(process.argv[2] ?? '.m2m/local');
const config: ChainConfig = JSON.parse(await readFile(`${root}/chain.json`, 'utf8'));
assert.equal(config.network, 'localnet', 'Adversarial transactions are restricted to localnet');
const chain = new Chain(config); await chain.validate();
const buyerOwner = await key(`${root}/buyer-controller.json`);
const providerOwner = await key(`${root}/provider-controller.json`);
const gas = await key(`${root}/provider-gas.json`);
let buyerKey = Ed25519Keypair.generate(); let providerKey = Ed25519Keypair.generate();
const buyer = (await chain.register(Array.from(buyerKey.getPublicKey().toRawBytes()),buyerOwner)).agent;
const provider = (await chain.register(Array.from(providerKey.getPublicKey().toRawBytes()),providerOwner)).agent;
const resultHash = hash(await readFile('fixtures/hello.txt'));
const requestHash = hash(Uint8Array.from([...utf8('m2m/fixture.get/v1\0'),...resultHash]));
const results: {test:string; passed:boolean}[] = [];
async function test(name: string, work: () => Promise<void>) {
  await work(); results.push({test:name,passed:true}); console.log(`PASS ${name}`);
}
async function reject(code: number, work: () => Promise<unknown>) {
  await assert.rejects(work, error => {
    assert(error instanceof Error);
    // The SDK may reject in transaction-resolution simulation before submission.
    // Require the precise Move abort; RPC/coin/signing errors must fail the test.
    const structured = (error as Error & { executionError?: {
      $kind: string; MoveAbort?: { abortCode:string; location?:{package?:string;module?:string} };
    } }).executionError;
    if (structured) {
      assert.equal(structured.$kind, 'MoveAbort', error.message);
      assert.equal(structured.MoveAbort?.abortCode, String(code), error.message);
      assert.equal(structured.MoveAbort?.location?.package, config.package_id);
      assert.equal(structured.MoveAbort?.location?.module, 'exchange');
    } else {
      const value = JSON.parse(error.message);
      assert.equal(value.$kind, 'MoveAbort', error.message);
      assert.equal(value.MoveAbort?.abortCode, String(code), error.message);
    }
    return true;
  });
}
async function quote(overrides: Partial<QuoteData> = {}): Promise<QuoteData> {
  const b=await chain.agent(buyer), p=await chain.agent(provider), now=BigInt(await chain.clock());
  return {
    purpose:utf8('m2m/quote/v1'),network:utf8(config.chain_id),package_id:config.package_id,deployment:config.deployment,
    buyer,provider,buyer_key:b.endpoint_key,provider_key:p.endpoint_key,refund:b.controller,payee:p.controller,
    nonce:b.next_nonce,request_hash:Array.from(requestHash),result_hash:Array.from(resultHash),amount:'1000',
    quote_expires_ms:String(now+60_000n),deadline_ms:String(now+120_000n),...overrides,
  };
}
const signQuote = async (q: QuoteData) => Array.from(await providerKey.sign(Quote.serialize(q).toBytes()));
const signAcceptance = async (q: QuoteData, id: string, changed = false) => {
  const a=acceptance(id,q);
  if (changed) a.result_hash[0] ^= 1;
  return {a,sig:Array.from(await buyerKey.sign(Acceptance.serialize(a).toBytes()))};
};

await test('forged quote rejected', async()=>{
  const q=await quote(); await reject(3,()=>chain.fund(q,new Array(64).fill(0),buyerOwner));
});
await test('changed price rejected', async()=>{
  const q=await quote(), sig=await signQuote(q); q.amount='1001';
  await reject(3,()=>chain.fund(q,sig,buyerOwner));
});
await test('changed request commitment rejected', async()=>{
  const q=await quote(), sig=await signQuote(q); q.request_hash[0] ^= 1;
  await reject(3,()=>chain.fund(q,sig,buyerOwner));
});
await test('quote cannot redirect the fixed payee', async()=>{
  const q=await quote({payee:buyerOwner.toSuiAddress()}), sig=await signQuote(q);
  await reject(3,()=>chain.fund(q,sig,buyerOwner));
});
await test('wrong network signature rejected', async()=>{
  const q=await quote({network:utf8('wrong-network')}), sig=await signQuote(q);
  await reject(3,()=>chain.fund(q,sig,buyerOwner));
});
await test('expired quote rejected', async()=>{
  const now=BigInt(await chain.clock()); const q=await quote({quote_expires_ms:String(now-1n)});
  const sig=await signQuote(q); await reject(4,()=>chain.fund(q,sig,buyerOwner));
});
await test('controller required for funding', async()=>{
  const q=await quote(),sig=await signQuote(q); await reject(0,()=>chain.fund(q,sig,providerOwner));
});
const q=await quote(), qs=await signQuote(q);
const funded=await chain.fund(q,qs,buyerOwner); const id=funded.escrow;
assert.equal((await chain.escrow(id)).funds,'1000');
await test('funding replay cannot create a second escrow',async()=>{
  await reject(6,()=>chain.fund(q,qs,buyerOwner));
  assert.equal(await chain.lookup(buyer,q.nonce),id);
  assert.equal((await chain.agent(buyer)).next_nonce,String(BigInt(q.nonce)+1n));
});
await test('forged acceptance rejected',async()=>{
  await reject(3,()=>chain.settle(id,q.result_hash,new Array(64).fill(0),gas));
});
await test('acceptance cannot cross escrow IDs',async()=>{
  const {sig}=await signAcceptance(q,config.deployment);
  await reject(3,()=>chain.settle(id,q.result_hash,sig,gas));
});
await test('valid signature cannot accept another result',async()=>{
  const {a,sig}=await signAcceptance(q,id,true);
  await reject(9,()=>chain.settle(id,a.result_hash,sig,gas));
});
await test('refund cannot run early',async()=>{ await reject(8,()=>chain.refund(id,gas)); });
const pending=await quote(), pendingSignature=await signQuote(pending);
await test('endpoint rotation invalidates unfunded quotes',async()=>{
  providerKey=Ed25519Keypair.generate();
  await chain.rotate(provider,Array.from(providerKey.getPublicKey().toRawBytes()),providerOwner);
  await reject(3,()=>chain.fund(pending,pendingSignature,buyerOwner));
});
const signed=await signAcceptance(q,id);
await test('funded key snapshot survives rotation; fixed payee receives exactly price',async()=>{
  buyerKey=Ed25519Keypair.generate();
  await chain.rotate(buyer,Array.from(buyerKey.getPublicKey().toRawBytes()),buyerOwner);
  const before=BigInt((await chain.client.getBalance({owner:q.payee})).balance.balance);
  await chain.settle(id,q.result_hash,signed.sig,gas);
  const e=await chain.escrow(id),after=BigInt((await chain.client.getBalance({owner:q.payee})).balance.balance);
  assert.equal(e.status,1); assert.equal(e.funds,'0'); assert(e.terminal_digest);
  assert.equal(after-before,1000n);
});
await test('settlement replay cannot pay twice',async()=>{ await reject(7,()=>chain.settle(id,q.result_hash,signed.sig,gas)); });
await test('settled escrow cannot refund',async()=>{ await reject(7,()=>chain.refund(id,gas)); });
await test('expired escrow refunds exact deposit to buyer and cannot settle',async()=>{
  const now=BigInt(await chain.clock());
  const q2=await quote({quote_expires_ms:String(now+5_000n),deadline_ms:String(now+6_000n)});
  const sig=await signQuote(q2),r=await chain.fund(q2,sig,buyerOwner);
  while(BigInt(await chain.clock())<BigInt(q2.deadline_ms)) await new Promise(r=>setTimeout(r,500));
  const before=BigInt((await chain.client.getBalance({owner:q2.refund})).balance.balance);
  const receipt=await signAcceptance(q2,r.escrow);
  await reject(4,()=>chain.settle(r.escrow,q2.result_hash,receipt.sig,gas));
  await chain.refund(r.escrow,gas);
  const e=await chain.escrow(r.escrow),after=BigInt((await chain.client.getBalance({owner:q2.refund})).balance.balance);
  assert.equal(e.status,2); assert.equal(e.funds,'0'); assert.equal(after-before,1000n);
  await reject(7,()=>chain.refund(r.escrow,gas));
  await reject(7,()=>chain.settle(r.escrow,q2.result_hash,receipt.sig,gas));
});
await save(`${root}/economics-results.json`,{network:config.network,package_id:config.package_id,results});
console.log(`${results.length} signed live-network economic checks passed.`);
