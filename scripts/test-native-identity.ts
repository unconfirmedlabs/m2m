import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress as addr } from '@mysten/sui/utils';
import { NativeChain, checkRpcScope, readKey, save, TESTNET_RPC, type NativeConfig } from './native-chain.js';
import { PARENT_NFT, assertPinned, leafName, validateLeaf } from './native-names.js';

const config: NativeConfig = {network:'testnet',rpc_url:TESTNET_RPC,chain_id:'testnet-fixture',package_id:addr('1'),domain:addr('2')};
checkRpcScope(config);
for (const rpc_url of ['https://fullnode.mainnet.sui.io:443','https://fullnode.testnet.sui.io.evil.example','https://key@fullnode.testnet.sui.io','https://fullnode.testnet.sui.io/?key=secret']) {
  assert.throws(()=>checkRpcScope({...config,rpc_url}));
}
assert.throws(()=>checkRpcScope({...config,network:'mainnet' as never}));
assert.throws(()=>checkRpcScope({...config,network:'localnet'}));
assert.throws(()=>checkRpcScope({...config,chain_id:''}));
checkRpcScope({...config,network:'localnet',rpc_url:'http://127.0.0.1:9000'});
const parent = {name:'nozomi.sui',registration:PARENT_NFT,owner:addr('3'),expires_ms:'1000'};
const leaf = {nft_id:PARENT_NFT,expiration_timestamp_ms:'0',target_address:addr('4'),data:[]};
assert.equal(leafName('local.nozomi.sui'),'local.nozomi.sui');
assert.equal(validateLeaf('local.nozomi.sui',leaf,parent,999n),addr('4'));
assert.throws(()=>validateLeaf('local.nozomi.sui',leaf,parent,1000n),/invalid_parent/);
assert.throws(()=>validateLeaf('local.nozomi.sui',{...leaf,nft_id:addr('5')},parent,999n),/invalid_leaf_parent/);
assert.throws(()=>validateLeaf('local.nozomi.sui',{...leaf,expiration_timestamp_ms:'1000'},parent,999n));
assert.throws(()=>validateLeaf('local.nozomi.sui',{...leaf,target_address:null},parent,999n));
assert.throws(()=>leafName('research.nozomi.sui.evil.sui'));
assert.throws(()=>leafName('nested.local.nozomi.sui'));
const chain = new NativeChain(config);
const ref = chain.reference(addr('4'));
assertPinned(ref,{...ref});
assert.throws(()=>assertPinned({...ref,agent:addr('5')},ref),/identity_changed/);
assert.throws(()=>assertPinned({...ref,network:[1]},ref),/identity_changed/);

// A lost submit response must reuse the exact signed bytes; changed operation,
// signer, or network cannot inherit an old transaction's success.
const directory = await mkdtemp(join(tmpdir(),'m2m-native-journal-'));
const journal = join(directory,'attempt.json');
const signer = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(12));
const keyFile = join(directory,'public-test-key.json');
for (const value of [{secret_key:Array(32).fill(12)},{secretKey:signer.getSecretKey()}]) {
  await save(keyFile,value); assert.equal((await readKey(keyFile)).toSuiAddress(),signer.toSuiAddress());
}
for (const value of [{secret_key:Array(31).fill(12)},{secret_key:Array(32).fill(256)},{secret_key:'do-not-echo-me'},{secretKey:signer.getSecretKey(),secret_key:Array(32).fill(12)}]) {
  await save(keyFile,value); await assert.rejects(()=>readKey(keyFile),{message:'Unable to read native Ed25519 key file'});
}
let calls = 0; let built = 0;
const submitted: string[] = [];
const fakeClient = {
  core:{getChainIdentifier:async()=>({chainIdentifier:config.chain_id})},
  ledgerService:{getServiceInfo:async()=>({response:{chain:'testnet'}})},
  executeTransaction:async({transaction}:{transaction:Uint8Array})=>{
    submitted.push(Buffer.from(transaction).toString('base64')); calls++;
    if (calls === 1) throw new Error('Lost RPC response');
    return {$kind:'Transaction',Transaction:{status:{success:true},digest:'fixture-digest',
      effects:{gasUsed:{},changedObjects:[]},objectTypes:{},balanceChanges:[]}};
  },
  waitForTransaction:async()=>({}),
};
Object.assign(chain,{client:fakeClient});
const tx = {
  setSender:()=>{},setGasBudgetIfNotSet:()=>{},
  build:async()=>{built++;return new Uint8Array([1,2,3]);},getDigest:async()=> 'fixture-digest',
} as unknown as Transaction;
await assert.rejects(()=>chain.execute(tx,signer,journal,'register:fixture'),/Lost RPC response/);
const attempt = JSON.parse(await readFile(journal,'utf8'));
assert.equal(attempt.state,'submitted');
await assert.rejects(()=>chain.execute(tx,signer,journal,'register:different'),/mismatch/);
await chain.execute(tx,signer,journal,'register:fixture');
assert.equal(built,1); assert.equal(calls,2); assert.equal(submitted[0],submitted[1]);
await chain.execute(tx,signer,journal,'register:fixture');
assert.equal(calls,2);
await assert.rejects(()=>chain.execute(tx,Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(13)),journal,'register:fixture'),/mismatch/);
fakeClient.ledgerService.getServiceInfo = async()=>({response:{chain:'mainnet'}});
await assert.rejects(()=>chain.execute(tx,signer,journal,'register:fixture'),/outside/);
assert.equal(calls,2);
console.log('Native RPC scope, SuiNS lifecycle/pinning, and uncertain-transaction recovery checks passed.');
