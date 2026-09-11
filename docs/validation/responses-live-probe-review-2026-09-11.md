# NR09 correction and R14 harness review — 2026-09-11

Status: **return three specific reproduced defects before running the billable
probe**. The original paced NR09 regression now passes. R14 remains unaccepted
and the production factory remains gated. No live model call, credential read,
wallet, payment, public RPC or deployment was performed.

## Frozen hashes and scope

All six hashes matched before and after this bounded review:

| scripts/ file | SHA-256 |
| --- | --- |
| agent-runtime.ts | a3967367c1636451af3cdd205762215a5ff440c3fb89a13b3e55f13ecce79943 |
| responses-transport.ts | 8e65f40d1d6881400a33bc1de218e0a6eabe7d349cef57f7dc11a4dbea4c20c3 |
| responses-worker.ts | 325bfdc20c2db37f7c9e3d6a6441cc9a9a58071c1ee901b7e7be73513fd601b4 |
| test-responses-transport.ts | 371d842353c710bd580e63f5ca905301756e61789c8b901da8e115c9cf7b3797 |
| test-responses-worker.ts | 66921e3e1acecf135d40876d77bab1f39386dd11176b736d15c06828179c5bb4 |
| test-responses-live.ts | 0a6f1285674128a0b2650bd96d71806caee80fe481cd5a6fbb4f279f8b217f82 |

Read the live harness completely, its worker flag wiring, the changed transport
boundary/permanent regression, relevant frozen R14 requirements and existing
NR09 return. This does not reopen the general worker audit.

Executed successfully:

```sh
npm run agent-runtime-tests
npm run agent-runtime-integration-tests
```

These remain fixture/process-boundary evidence. The live flag was not invoked.

## T01 — NR09 paced fix passes; coalesced equivalent still fails

Production HTTP changes correctly remove the finite-body cumulative bound for
SSE. The new owner test and independent original reproduction both accept eight
15-byte frames under maxResponseBytes 60, charging all 120 bytes.

However, writing those identical eight frames together in one HTTP body chunk
fails at the transport's queuedBytes > maxResponseBytes check (around line 335),
before SseDecoder sees any frame:

```json
{"mode":"paced","events":[0,1,2,3,4,5,6,7],"charged":120}
{"mode":"coalesced","events":[],"charged":120,"error":"response_body_limit"}
```

Required regression: both delivery layouts produce exactly eight events and
120 charged bytes; an oversized individual SSE event and oversized finite JSON
body still fail. The queue must remain bounded, but an OS/network chunk boundary
must not become a semantic SSE event boundary. Split/feed bounded chunks or use
a separately justified bounded queue; do not remove total worker byte accounting
or accept unlimited buffering. This is a demonstrated lower-limit contract
failure, not a claim that every default 1-MiB live configuration hits it.

Exact executable local reproduction, from the repository root:

```sh
node --import tsx --input-type=module <<'JS'
import http from 'node:http'; import https from 'node:https';
import {OpenAIResponsesTransport} from './scripts/responses-transport.ts';
let mode='paced';
const server=http.createServer((q,r)=>{r.writeHead(200,{'content-type':'text/event-stream'});const frames=Array.from({length:8},(_,i)=>'data: '+JSON.stringify({n:i})+'\n\n');if(mode==='coalesced'){r.end(frames.join(''));return}let i=0;const timer=setInterval(()=>{r.write(frames[i++]);if(i===8){clearInterval(timer);r.end()}},5);r.on('close',()=>clearInterval(timer))});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const original=https.request;https.request=(o,cb)=>http.request({...o,protocol:'http:',hostname:'127.0.0.1',port:server.address().port,agent:false},cb);
try{for(mode of ['paced','coalesced']){const transport=new OpenAIResponsesTransport({apiKey:'EXPLICIT_TEST_FIXTURE',maxRequestBytes:4096,maxResponseBytes:60,requestTimeoutMs:500,streamIdleTimeoutMs:500});let charged=0,events=[],error;try{for await(const e of await transport.create({model:'fixture'},{clientRequestId:'fixture',signal:new AbortController().signal,chargeReceivedBytes:async n=>{charged+=n}}))events.push(e.n)}catch(e){error=e.code}finally{transport.close()}console.log(JSON.stringify({mode,events,charged,error}))}}finally{https.request=original;await new Promise(r=>server.close(r))}
JS
```

## P01 — completed replay makes the following new task conversation_busy

The exact requested R14 sequence fails in the real worker before the harness's
follow-up assertions: complete initial request, shut down, reopen, replay the
completed original with no effects, then submit the follow-up.

In responses-worker.ts execute around line 1047, an existing completed record
gets conversation.activeRequest assigned before its already-terminal loop is
skipped. It returns completed without clearing that assignment. run then rejects
a different request as conversation_busy.

Independent production-worker/production-HTTP local result:

```json
{"stage":"initial","creates":2,"callbackCount":1,"state":"completed","retrieves":0}
{"stage":"restart_same_process_local_probe","error":"conversation_busy","followupRequests":0}
```

The local probe reopens the actual journal and directly calls the real
restartPhase function in the same process; it does not claim to have executed
the live child process. The checked-in child calls this same function, so the
failure lies on its actual intended path.

Required: terminal replay must not reserve a conversation. Assert zero
POST/GET/resume/callbacks for exact completed replay, then a distinct new request
immediately succeeds using the retained predecessor. Add durable reopen coverage
and preserve the previous accepted uncertain-request busy behavior. Do not clear
an actually unresolved request merely to make this positive pass.

## P02 — R14 rejects the second create required by its own tool round trip

restartPhase requires followupCreates === 1; continuePhase requires creates === 1;
the parent also requires restart.creates === 1. Each phase simultaneously
requires a fresh callback result in final model text.

The real loop requires the tool-call response plus a new response carrying its
function_call_output. The independent local actual-HTTP probe completes that
round trip, then the unmodified continuePhase rejects it:

```json
{"stage":"explicit_continue","error":"live_probe_continue_predecessor_missing","creates":2,"firstPrevious":"fixture-response-2","secondInputType":"function_call_output"}
```

Required: keep completed replay at zero effects; allow the expected bounded
two-or-more creates for a new real tool loop, distinguish the initial user-input
create from its tool-result continuations, and correlate the exact call/output
and predecessor identities. Do not weaken this to "some POST happened."

The initial path already proves more than schema reflection: its marker is
generated inside the actual host callback after receiving a function call, and
the harness checks that marker in returned model text. The local fixture probe
validates this plumbing, not the behavior of a real model.

## Additional R14 evidence limits found in the same code inspection

These are static missing proof obligations, not additional adversarial matrices:

- The follow-up prompt requests the old marker, but the harness only asserts
  its new callback marker in output. It must also assert the retained old marker
  is returned without supplying that marker in the follow-up input.
- previousResponseIdPresent is one boolean updated by any request, including
  the same-task function-call continuation. It does not assert the first new
  task request references the prior task's terminal response. Record/check that
  exact relationship separately; hashes/counts can keep public evidence bounded.
- prohibitedToolsSubmitted scans submitted tool schema names only after requiring
  the sole name probe_status, so it is necessarily zero. Sentinel JSON is written
  once with three false values, and nothing connects those booleans to filesystem,
  process or network observation. The prompt says to "consider" these operations
  and then not dispatch them. This is not the required controlled prohibited-tool
  attempt/rejected-dispatch evidence. Preserve registered-only tools; make the
  scoped benign attempts and actual observation/rejection evidence meaningful.
  Do not call an untouched JSON file or a model refusal an isolation proof.

The checked-in child does use a distinct process and checks zero create/retrieve/
resume/callbacks before its follow-up. That is a useful intended boundary, but
P01 prevents completing it today; the retained-context checks above remain
necessary after P01/P02 are corrected.

## Local harness reproduction for P01/P02

This reads the frozen live test, transpiles a memory-only copy with its existing
phase functions additionally exported, and calls them unchanged. Imports resolve
to the actual repository production worker/HTTP implementation. HTTPS requests
are redirected only within this process to a loopback fixture server. No source
or owner-test file is edited, no real key is read, and the fresh callback markers
are generated by the real probe callback. Synthetic server output is explicitly
not model evidence. The temporary state is created and journaled by the real
worker/probe routines.

```sh
node --import tsx --input-type=module <<'JS'
import http from 'node:http';import https from 'node:https';import {readFileSync,mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {transform} from 'esbuild';
let code=readFileSync('./scripts/test-responses-live.ts','utf8').replaceAll(/(['"])\.\/([^'"]+)\.js\1/g,(_,q,name)=>q+pathToFileURL(resolve('scripts',name+'.ts')).href+q);
code+='\nexport { runInitial, restartPhase, continuePhase, writeSentinel, safeEvidence };';
const mod=await import('data:text/javascript;base64,'+Buffer.from((await transform(code,{loader:'ts',format:'esm',target:'node22'})).code).toString('base64'));
const requests=[];const snapshots=new Map();let n=0;
const server=http.createServer(async(q,r)=>{let text='';for await(const p of q)text+=p;
if(q.method==='GET'){r.writeHead(200,{'content-type':'application/json'});r.end(JSON.stringify(snapshots.get(q.url.split('/').at(-1))));return}
const body=JSON.parse(text);requests.push(body);const id='fixture-response-'+(++n);const execution={id,model:body.model,reasoning:body.reasoning,instructions:body.instructions,tools:body.tools,tool_choice:body.tool_choice,parallel_tool_calls:body.parallel_tool_calls,background:body.background,store:body.store,truncation:body.truncation,max_output_tokens:body.max_output_tokens,previous_response_id:body.previous_response_id??null};
const result=body.input?.find(i=>i.type==='function_call_output');const marker=result?JSON.parse(JSON.parse(result.output).text).marker:null;
const output=result?[{type:'message',id:'message-'+n,role:'assistant',status:'completed',content:[{type:'output_text',text:marker,annotations:[],logprobs:[]}]}]:[{type:'function_call',id:'function-'+n,call_id:'call-'+n,name:'probe_status',arguments:'{}',status:'completed'}];
const snapshot={...execution,status:'completed',output,usage:{input_tokens:4,output_tokens:3,total_tokens:7,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:1}}};snapshots.set(id,snapshot);
const events=[{type:'response.created',sequence_number:0,response:{...execution,status:'in_progress',output:[]}},{type:'response.completed',sequence_number:1,response:snapshot}];
r.writeHead(200,{'content-type':'text/event-stream'});r.end(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const original=https.request;https.request=(o,cb)=>http.request({...o,protocol:'http:',hostname:'127.0.0.1',port:server.address().port,agent:false},cb);
const state=mkdtempSync(join(tmpdir(),'m2m-r14-local-review-'));mod.writeSentinel(state);
try{const initial=await mod.runInitial(state,'EXPLICIT_TEST_FIXTURE');console.log(JSON.stringify({stage:'initial',summary:initial.evidence.initial,requests:requests.length}));
process.env.M2M_RESPONSES_PROBE_STATE_DIR=state;mod.safeEvidence(initial.evidence);const before=requests.length;let error;try{await mod.restartPhase(state,'EXPLICIT_TEST_FIXTURE',initial.marker)}catch(e){error=e.code??e.message}
console.log(JSON.stringify({stage:'restart_same_process_local_probe',error,followupRequests:requests.length-before,firstFollowupPrevious:requests[before]?.previous_response_id,initialLastId:'fixture-response-2',secondFollowupInputType:requests[before+1]?.input?.[0]?.type}));const beforeContinue=requests.length;let continueError;try{await mod.continuePhase(state,'EXPLICIT_TEST_FIXTURE')}catch(e){continueError=e.code??e.message}console.log(JSON.stringify({stage:'explicit_continue',error:continueError,creates:requests.length-beforeContinue,firstPrevious:requests[beforeContinue]?.previous_response_id,secondInputType:requests[beforeContinue+1]?.input?.[0]?.type}));
}finally{https.request=original;await new Promise(r=>server.close(r))}
JS
```

## Bounded billable behavior and remaining live gate

The actual harness constructs ResponsesWorker with a wrapper around
OpenAIResponsesTransport, not a fake transport or alternate inference endpoint.
Production factory gating is unchanged; only this isolated opt-in path bypasses
the gate. It uses the provider limits: 120-second request duration, 4096 output
tokens per response, at most 32 responses / 131072 reserved output tokens per
request, 16 MiB received bytes and four allowed callbacks. The restart child has
a 180-second process timeout. An explicit continue invocation adds a new bounded
request to the retained conversation; it is not a zero-cost status operation.
These are technical caps, not a verified dollar ceiling or live run result.

Credential input is a protected explicit API-key file, not Codex OAuth. The
model receives only the probe schema/instructions and synthetic status markers,
not wallets, payment objects or economic/Iroh keys. Evidence stores counts,
token/byte summaries and hashes, not the API key or model output body. A failed
or timed-out live attempt must retain its private journal for reconciliation;
do not retry with a new directory automatically.

OpenAI Docs was used to check the API assumptions on 2026-09-11:
[function calling](https://developers.openai.com/api/docs/guides/function-calling)
documents submitting function_call_output in a subsequent model request;
[conversation state](https://developers.openai.com/api/docs/guides/conversation-state)
documents previous_response_id chaining;
[GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
lists xhigh support. These support the API shape/lineage assertions, not access
to the user's account or a successful live probe.

Freeze this narrow correction tranche. Keep prior accepted worker fault cases
intact, add the failing permanent regressions first, and leave live/R14 approval
closed until the corrected actual probe and its evidence are independently
reviewed.

## New-hash T01/P01/P02 correction re-review — 2026-09-11

Frozen transport fb5ee7e16fc3f12ce5da1776849b71231711ed3300e00ee96c19478a5ffa0378;
worker c8a38e7b8447dc696376b7c8147facd2fd2a57c4e8c849a74dac2f90b772156c;
live harness f009f483b1b3fac0a3d30c76cb17e26a7c9cdd79b866e80007ee8bb19aa5f42a;
worker test 0643bb9059e511e58a3a2e4bf94b9e44a7a556ae319aedf57e97bc03a47e4333;
transport test b4322344b18a9cee701477f39bc237ec24e8aec140a6e43042305954f63250a6.
All remained unchanged through the exact probes.

T01 **passes**: independent paced and coalesced eight-frame HTTP variants both
produce IDs 0–7 and charge 120 bytes. The queue now has a distinct bounded floor;
the per-event parser and finite-body limits remain. Owner permanent coalesced
regression is present.

P01 **passes the requested seam**: the actual worker reopens, replays its completed
initial task with zero HTTP/callbacks, then admits the new follow-up. The new
terminal early-return avoids reserving activeRequest. Existing uncertainty/busy
rules remain; no broader recovery behavior is newly accepted here.

P02 **still fails**, now due to wrong lineage comparison rather than a one-create
limit. The first function_call_output request is compared to the FINAL response
ID (`knownTurnIds.at(-1)`) in restartPhase and continuePhase. It must reference
the response that generated that exact tool call, not its eventual final answer.

Independent loopback production-worker/production-HTTP probe with the new actual
profile (three rejected sentinel callbacks and one fresh status callback) gives:

```json
{"stage":"initial","state":"completed","creates":5,"userCreateCount":1,"continuationCreateCount":4,"callbackCount":1,"rejectedDispatchCount":3}
{"stage":"restart_same_process_local_probe","error":"live_probe_predecessor_missing","followupRequests":5,"firstFollowupPrevious":"fixture-response-5"}
{"stage":"explicit_continue","error":"live_probe_continue_predecessor_missing","creates":5,"firstPrevious":"fixture-response-10"}
```

For the follow-up, the first continuation references fixture-response-6; the
terminal response is fixture-response-10. Both are correct and intentionally
unequal. Required permanent regression: drive the actual five-response chain;
assert the first user create references the prior task's terminal response,
each continuation references its own generating response/call ID, old replay
creates nothing, and both old/fresh markers are verified without supplying the
old marker in the new prompt. Preserve exact replay and bounded callback counts.

The new probe now actually invokes three registered rejection callbacks and
checks the old marker in follow-up output, improving those earlier static gaps.
This proves controlled callback rejection plumbing only; the untouched sentinel
file alone is still not proof against arbitrary built-in tool execution. Actual
live R14/child evidence and production enablement remain pending.

Owner suite: first run hit worker_lock in the existing childPendingAndPreparedRecovery
at test line 419; an immediate complete rerun passed. The root seam command also
passed. The observed first failure is retained here, not silently reported as an
unconditional all-green first run; this bounded check did not expand into its
timing cause.

Exact local reproduction driver (extracts the prior executable probes above and
adapts only the loopback fixture server to the new four-callback test profile):

```sh
node --input-type=module <<'JS'
import {readFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';
const text=readFileSync('docs/validation/responses-live-probe-review-2026-09-11.md','utf8');
const blocks=[...text.matchAll(/node --import tsx --input-type=module <<'JS'\n([\s\S]*?)\nJS/g)].map(x=>x[1]);
let nr=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',blocks[0]],{encoding:'utf8',timeout:10000});process.stdout.write(nr.stdout);process.stderr.write(nr.stderr);
let code=blocks[1].replace("const snapshots=new Map();let n=0;","const snapshots=new Map();const stages=new Map();let n=0;");
const start=code.indexOf("const result=body.input");
const end=code.indexOf("const snapshot=",start);
code=code.slice(0,start)+`
const inputResult=body.input?.find(i=>i.type==='function_call_output');
const prev=stages.get(body.previous_response_id);
const phase=inputResult?(prev?.phase??0)+1:0;
let marker=inputResult?(prev?.marker??null):null;
const oldMarker=inputResult?(prev?.oldMarker??null):(prev?.marker??null);
if(inputResult&&phase===4)marker=JSON.parse(JSON.parse(inputResult.output).text).marker;
stages.set(id,{phase,marker,oldMarker});
const operations=['filesystem_write','process_exec','network_fetch'];
const output=phase<4?[{type:'function_call',id:'function-'+n,call_id:'call-'+n,name:phase<3?'probe_sentinel':'probe_status',arguments:phase<3?JSON.stringify({operation:operations[phase]}):'{}',status:'completed'}]:[{type:'message',id:'message-'+n,role:'assistant',status:'completed',content:[{type:'output_text',text:[oldMarker,marker].filter(Boolean).join(' '),annotations:[],logprobs:[]}]}];
`+code.slice(end);
code=code.replaceAll("'fixture-response-2'","'fixture-response-5'");
const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',code],{encoding:'utf8',timeout:10000});process.stdout.write(result.stdout);process.stderr.write(result.stderr);if(result.status!==0)process.exitCode=1;
JS
```

OpenAI Docs was rechecked for the function-call-output/previous-response lineage
on this date. The [official function calling guide](https://developers.openai.com/api/docs/guides/function-calling)
and [Responses creation reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
support the request-chain distinction; no real model call was made. Return only
this remaining P02 correction before the opt-in live run.
