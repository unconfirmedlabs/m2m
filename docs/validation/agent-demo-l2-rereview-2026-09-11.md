# Astra H01–H06 correction re-review — 2026-09-11

Status: original six owner regressions pass; **return only the residual H02/H03
groups below**. No broader host audit, live model/chain/Iroh/Fly action or changing
L1 review was performed.

## Frozen boundary

| scripts/ file | SHA-256 |
| --- | --- |
| agent-demo-server.ts | 77c667e10660c9e23b2d7863b28c973d4dcc229b0eb2ed568977965503aec036 |
| agent-demo-evidence.ts | 253049c2ce379b4d174a80f58f00fb81d803341cc8b5c3019d3b385989164143 |
| test-agent-demo-http-recovery.ts | 1e70953b864efce2dbb8ddbfd6b1c433f9634c901b807d6581a93d8c0e55cded |
| agent-demo-projection.ts | b0d0b516858aa87931b0aa0f769da4794b661c809f0650a8776a37103cc364f9 |
| agent-demo-provider-client.ts | 9b203f0b31c490daf79566fac6c0cab11024aa7ccec40401394b33b85c4e791f |

All matched before and after the bounded probes. The old HTTP test remains
faa349f99aae5cfa1cf689043092bb320527ec8cad7d9b0f8766b97b3153e7f6.

Executed successfully:

```sh
npx tsx scripts/test-agent-demo-http-recovery.ts
npx tsx scripts/test-agent-demo-projection.ts
npx tsx scripts/test-agent-demo-provider-client.ts
```

The complete H01–H06 regression source and changed server/evidence paths were
inspected. These are actual local HTTP/projection tests with explicit fixture
runtime handles, not actual economic or live model evidence.

## Narrow accepted corrections

- H01: provider boot now uses its own source; owner test serves all three private
  observer routes and rejects public/control access.
- H02 original disclosure: top-level/nested private sentinel input is rejected
  with a fixed error. The ordinary empty-receipt evidence positive passes.
  Independent signed-credit/checkpoint evidence also passes.
- H03 original 300-small-record case and reconnect from 256 now return the full
  contiguous sequence. The owner append check occurs before a new stream,
  not during an actively backpressured replay; do not label it the latter.
- H04 original poisoned-source task is denied with zero submit; protective
  spending pause still reaches submit.
- H05 subscribe-before-replay buffering captures the final-page microtask append
  once; owner reopen preserves sequence 2. The test's start helper still passes
  createProjection:true on that reopen, so it is not evidence of ordinary
  production create:false bootstrap.
- H06 ordinary active SSE close completes without waiting for viewer disconnect.

These accept the named original variants, not full F08–F11 or all surrounding
boundary cases.

## H03 residual — bounded history over 256 KiB never begins streaming

The new streamEvents builds every replay frame into queued before calling flush.
For a valid durable replay larger than MAX_SSE_BUFFER_BYTES, queueFrame calls
stop while zero frames have been written. This applies even to an immediately
reading client; it is not a slow-client backpressure event.

Independent actual HTTP input: 300 contiguous coordinator model_text records,
each text = "TEST FIXTURE " plus 1024 ASCII x characters. This is well below the
source/projection limits and each text is individually valid.

Observed:

```json
{"case":"H03 bounded history over queue allowance","status":200,"eventCount":0,"streamBytes":0,"live":false}
```

Required: pace replay production through a bounded writer while allowing live
append buffering/dedupe, instead of enqueueing the entire retained history before
the first flush. Do not raise/remove the cap or silently skip history. Assert
all 300 larger records once, exact reconnect cursor, an append during replay, and
a stalled client stays bounded without blocking canonical publication.

The same overflow path calls stop before the heartbeat is created, then later
installs a timer despite closed=true. The local test process remained alive after
both app.close calls and needed termination of its exact owned process. Prevent
post-stop timer/subscription creation and include this overflow-close variant
in cleanup assertions. No unrelated process was stopped.

## H02 residual — valid terminal receipts rejected; requested channel not bound

The new sanitizer accepts the actual fixture signed credit and checkpoint
history but rejects an otherwise valid signed native terminal response envelope:

```json
{"case":"H02 signed credit checkpoint positive","accepted":true}
{"case":"H02 valid signed terminal receipt","accepted":false,"error":"invalid_evidence"}
```

terminalReceipt synthesizes an AgentPublicEvent ID as '01'.repeat(32). Source IDs
are canonical positive decimal u64 values, not 64-hex IDs; this artificial record
can never pass the frozen validator. Use its actual public receipt validation
boundary, or a structurally valid internal validation wrapper; do not weaken the
canonical source ID rule. Include nonempty signed terminal receipt positives,
not only empty arrays, with nested extra-private-field negatives. This local
envelope is generated with the public fixture provider transport key and actual
Envelope signing codec; it is not a real delivered/settled exchange claim.

Separately, the route gives sanitizeDemoEvidence no expected channel and never
compares the result to the requested path. A fixture runtime returning the valid
known channel for a different requested address produces:

```json
{"case":"H02 evidence request channel binding","status":200,"channelMatchesRequest":false,"returnedFixtureChannel":true}
```

Required: enforce the exact requested channel before serialization, with a fixed
failure and no mismatched evidence response. Preserve nested signature structure
and existing historical signing-authority/rotation semantics; this is not a
request to infer cryptographic validity or current-key equality from JSON.

## Executable bounded local reproduction

The driver exports existing fixture helpers from an in-memory transpilation of
the owner regression file without running its main, and calls the actual server,
projection and evidence sanitizer. Every key/value is synthetic test data;
production files/tests are unchanged. Because the reproduced overflow leaks a
timer, the outer timeout bounds this demonstration; its output precedes timeout.

```sh
timeout 15s node --import tsx --input-type=module <<'JS'
import {readFileSync,mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {transform} from 'esbuild';import {sanitizeDemoEvidence} from './scripts/agent-demo-evidence.ts';import {Envelope,utf8} from './scripts/native-peer.ts';import {Ed25519Keypair} from '@mysten/sui/keypairs/ed25519';
let src=readFileSync('scripts/test-agent-demo-http-recovery.ts','utf8');src=src.slice(0,src.indexOf('\nawait h01ProviderBoot();'));src=src.replaceAll(/(['"])(\.\.?\/[^'"]+)\.js\1/g,(_,q,path)=>q+pathToFileURL(resolve('scripts',path+'.ts')).href+q);src+='\nexport {makeRuntime,start,event,fixture};';
const t=await import('data:text/javascript;base64,'+Buffer.from((await transform(src,{loader:'ts',format:'esm',target:'node22'})).code).toString('base64'));const f=t.fixture;const token='11'.repeat(32);
{
const rt=t.makeRuntime({events:Array.from({length:300},(_,i)=>t.event(i+1,'TEST FIXTURE '+('x'.repeat(1024))))});const root=mkdtempSync(join(tmpdir(),'m2m-h03-replay-review-'));const{app,port}=await t.start(rt,root);const r=await fetch('http://127.0.0.1:'+port+'/api/v1/events',{headers:{Authorization:'Bearer '+token,'Last-Event-ID':f.pins.conversation+':0'}});const text=await r.text();console.log(JSON.stringify({case:'H03 bounded history over queue allowance',status:r.status,eventCount:[...text.matchAll(/^id: /gm)].length,streamBytes:text.length,live:text.includes('"state":"live"')}));await app.close();
}
{
const c=f.snapshot.channels[0];const rt=t.makeRuntime();const value={version:1,conversation:f.pins.conversation,channel:c.channel,offer:c.offer,policy:c.policy,credits:[c.signed_credit],checkpoints:[c.checkpoint],terminal_receipts:[],economy:c};
let emptyError;try{sanitizeDemoEvidence(value,f.pins,rt,'localnet')}catch(e){emptyError=e.message}console.log(JSON.stringify({case:'H02 signed credit checkpoint positive',accepted:!emptyError,error:emptyError}));
const correlation=Array(32).fill(8);const result={version:2,op_id:'66'.repeat(32),type:'turn_terminal',receipt:f.receipt};const message={purpose:utf8('m2m/core/message/v1'),sender:f.pins.agents.provider,recipient:f.pins.agents.buyer,generation:'1',id:Array(32).fill(7),correlation,created_ms:'500',expires_ms:'600',kind:'message.receipt',payload:utf8(JSON.stringify({session:Array(32).fill(9),message_id:correlation,commitment:Array(32).fill(6),state:'completed',result:utf8(JSON.stringify(result))}))};
const key=Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(4));const envelope={message,signature:Array.from(await key.sign(Envelope.serialize(message).toBytes()))};let receiptError;try{sanitizeDemoEvidence({...value,terminal_receipts:[envelope]},f.pins,rt,'localnet')}catch(e){receiptError=e.message}console.log(JSON.stringify({case:'H02 valid signed terminal receipt',accepted:!receiptError,error:receiptError}));
rt.evidence=async()=>value;const root=mkdtempSync(join(tmpdir(),'m2m-h02-channel-review-'));const{app,port}=await t.start(rt,root);const requested='0x'+'99'.repeat(32);const r=await fetch('http://127.0.0.1:'+port+'/api/v1/evidence/'+requested,{headers:{Authorization:'Bearer '+token}});const body=await r.json();console.log(JSON.stringify({case:'H02 evidence request channel binding',status:r.status,channelMatchesRequest:body.channel===requested,returnedFixtureChannel:body.channel===value.channel}));await app.close();
}
JS
```

Stop this correction tranche here. Root is separately connecting the real
lifecycle/UI/image. The source-page snapshot/publication proof, full economic
history, live profile gate and actual investor workflow remain their existing
integration/live acceptance gates, not claims established by these local tests.
