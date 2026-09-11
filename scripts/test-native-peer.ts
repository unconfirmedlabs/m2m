import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { normalizeSuiAddress as address } from '@mysten/sui/utils';
import { NativePeer, NativeInbox, IrohBridge, Envelope, strictJson, verify, authority, commitment, hash, utf8, select, type RawTransport, type SignedEnvelope } from './native-peer.js';
import { type AgentRef, type Authorization, save } from './native-chain.js';

// Invoked by the Rust conformance harness; the bridge supplies only Iroh bytes.
if(process.argv[2]==='--client'){
  const [, , , ticket,keyFile,authFile,mode='echo',outboxPath]=process.argv;
  const snapshots=JSON.parse(await readFile(authFile,'utf8')) as Authorization[];
  const raw=JSON.parse(await readFile(keyFile,'utf8')) as {secret_key:number[]};
  const key=Ed25519Keypair.fromSecretKey(Uint8Array.from(raw.secret_key));
  const local=snapshots.find(a=>Buffer.from(a.transport_key).equals(key.getPublicKey().toRawBytes()))!;
  const remote=snapshots.find(a=>a.agent.agent!==local.agent.agent)!;
  const transport=new IrohBridge(['connect','--key-file',keyFile,'--ticket',ticket]);
  const resolve=async(ref:AgentRef)=>snapshots.find(a=>a.agent.agent===ref.agent)!;
  const peer=new NativePeer(local.agent,key,remote.agent,resolve,transport,
    mode==='unsupported'?{required:['missing.feature'],optional:[]}:{required:[],optional:[]});
  try {
    await transport.connected();
    if(mode==='unsupported'){await assert.rejects(()=>peer.connect());console.log('Independent peer mandatory-feature rejection passed');}
    else if(mode==='save'||mode==='replay'){
      if(!outboxPath)throw Error('Missing outbox path');await peer.connect();
      const saved=mode==='replay'?JSON.parse(await readFile(outboxPath,'utf8')) as SignedEnvelope:undefined;
      const response=await peer.request('message.send',{service:'echo',content_type:'application/octet-stream',content:utf8('cross-language restart')},saved,outboxPath);
      assert.equal(response.receipt.state,'completed');assert.deepEqual(response.receipt.result,utf8('cross-language restart'));
      console.log(`Independent peer ${mode} passed`);
    }else {
      await peer.connect();
      assert.deepEqual((await peer.describe()).map(s=>s.id).sort(),['blake2b-256','echo']);
      const result=await peer.request('message.send',{service:'echo',content_type:'application/octet-stream',content:utf8('independent TypeScript peer')});
      assert.equal(result.receipt.state,'completed');assert.deepEqual(result.receipt.result,utf8('independent TypeScript peer'));
      const duplicate=await peer.request('message.send',{},result.sent);assert.deepEqual(duplicate.receipt,result.receipt);
      const changed=structuredClone(result.sent);const p=strictJson(changed.message.payload);p.content=utf8('changed');changed.message.payload=utf8(JSON.stringify(p));
      await assert.rejects(()=>peer.request('message.send',{},changed),/message_conflict/);
      const digest=await peer.request('message.send',{service:'blake2b-256',content_type:'application/octet-stream',content:utf8('abc')});
      assert.deepEqual(digest.receipt.result,hash(utf8('abc')));
      console.log('Independent TypeScript/Rust Iroh admission, signatures, free handlers, duplicate and conflict checks passed');
    }
  } finally {transport.close();}
}else{
  const root=await mkdtemp(join(tmpdir(),'m2m-native-peer-'));
  const aKey=Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(41));
  const bKey=Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(42));
  const base={network:utf8('native-test'),package_id:address('1'),domain:address('2')};
  const a={...base,agent:address('3')},b={...base,agent:address('4')};
  const snapshots=[a,b].map((agent,i):Authorization=>({agent,controller:address('5'),
    transport_key:Array.from([aKey,bKey][i].getPublicKey().toRawBytes()),
    economic_key:Array.from(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(51+i)).getPublicKey().toRawBytes()),
    generation:'0',read_at_ms:String(Date.now()),valid_until_ms:String(Date.now()+29000)}));
  const resolve=async(ref:AgentRef)=>snapshots.find(s=>s.agent.agent===ref.agent)!;
  function pair():[RawTransport,RawTransport]{
    const queues:number[][][]=[[],[]];const pending:Array<{resolve:(b:number[])=>void;reject:(e:Error)=>void}|undefined>=[undefined,undefined];let closed=false;
    return [0,1].map(i=>({remoteKey:snapshots[1-i].transport_key,
      async send(bytes:number[]){if(closed)throw Error('closed');if(pending[1-i]){pending[1-i]!.resolve(bytes);pending[1-i]=undefined;}else queues[1-i].push(bytes);},
      async receive(){if(queues[i].length)return queues[i].shift()!;if(closed)throw Error('closed');return new Promise<number[]>((resolve,reject)=>{pending[i]={resolve,reject};});},
      close(){closed=true;for(const p of pending)p?.reject(new Error('closed'));},
    })) as [RawTransport,RawTransport];
  }
  for(const invalid of ['{"x":1,"x":2}','{"x":1,"\\u0078":2}','{"a":{"x":1,"x":2}}','{"x":1} trailing'])assert.throws(()=>strictJson(invalid));
  assert.deepEqual(strictJson('{"a":[1,"a\\\"b",true,null]}'),{a:[1,'a"b',true,null]});
  assert.throws(()=>select({required:['x'],optional:[]},{required:[],optional:[]}),/unsupported_feature/);
  assert.throws(()=>select({required:[],optional:['z','a']},{required:[],optional:[]}),/invalid_message/);
  assert.throws(()=>authority({...snapshots[0],economic_key:snapshots[0].transport_key},a),/unauthorized/);
  assert.throws(()=>authority({...snapshots[0],valid_until_ms:'1'},a),/stale_authority/);
  let executed=0;let saved:SignedEnvelope|undefined;
  for(let pass=0;pass<2;pass++){
    const inbox=await NativeInbox.open(join(root,'inbox'));const [left,right]=pair();
    const client=new NativePeer(a,aKey,b,resolve,left),server=new NativePeer(b,bKey,a,resolve,right);
    await Promise.all([client.connect(),server.accept()]);
    const serving=server.serve(inbox,async(_kind,p)=>{executed++;return p.content;}).catch(()=>{});
    try{
      assert.deepEqual((await client.describe()).map(s=>s.id).sort(),['blake2b-256','echo']);
      const result=await client.request('message.send',{service:'echo',content_type:'application/octet-stream',content:utf8('same logical request')},saved);
      assert.equal(result.receipt.state,'completed');assert.deepEqual(result.receipt.result,utf8('same logical request'));assert.equal(executed,1);
      if(saved)assert.deepEqual(commitment(saved.message),commitment(result.sent.message));saved=result.sent;
      const modified=structuredClone(saved);modified.message.generation='01';await assert.rejects(()=>verify(modified,snapshots[0],b,snapshots[0].transport_key));
      modified.message.generation='0';modified.signature[0]^=1;await assert.rejects(()=>verify(modified,snapshots[0],b,snapshots[0].transport_key));
    }finally{left.close();await serving;await inbox.close();}
  }
  // Persist an uncertain dispatch then reopen: handler cannot be repeated.
  const inbox=await NativeInbox.open(join(root,'inbox'));
  const uncertain=structuredClone(saved!);uncertain.message.id[0]^=1;
  const record=await inbox.dispatch(uncertain.message,async()=>{throw Error('external launch response lost');});assert.equal(record.state,'uncertain');await inbox.close();
  const reopened=await NativeInbox.open(join(root,'inbox'));
  assert.equal((await reopened.dispatch(uncertain.message,async()=>{throw Error('must never be called');})).state,'uncertain');await reopened.close();
  await save(join(root,'saved-envelope.json'),saved);
  console.log('Independent TypeScript core strict parsing, signature/authority rejection, durable reconnect and uncertain-dispatch checks passed.');
}
