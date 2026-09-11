# Reduced live demo — independent Astra review, 2026-09-11

**Verdict: returned for correction.** The current implementation is not accepted
for local implementation review. RD-0–RD-4 have no fresh live evidence, and RD-5
is not passed by this review. Several failures are locally reproducible without
credentials, funding, or a live model.

Reviewed against `AGENTS.md`, `NORTH_STAR.md`, `POSITIONING.md`, the authoritative
`REDUCED_LIVE_DEMO.md`, the implementation validation record, and the current
tracked diff from HEAD plus all six pre-existing untracked files. Scope includes
runtime/server, all three reduced modules, setup/export, evidence/harness,
component and test changes, UI, packaging, and direction/runbook documentation.
Relevant unchanged dependencies were inspected at the affected seams. This is a
verification report, not a replacement design or protocol specification.

Review checkpoint: 2026-09-11T13:35:42Z; HEAD
`0f765c4a4944215656a5a8c7b123343b0c7902c2`; Node 22.23.2. Implementation sources
were not edited. Tests generated ignored build artifacts and private temporary
fixtures; only this review document is added. No commit, push, protected credential
read, live inference, testnet mutation, or Fly action was performed. Shell checks
used the approved escalation after the sandbox failed to start with
`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`.

## Findings, ordered by severity

### RDA-01 — P1: fabricated R14 summaries enable arbitrary unreviewed profiles

Affected: `scripts/agent-runtime.ts:178–231`, especially `assertResponsesLiveEvidence`
and `openAgentWorker`; `scripts/test-reduced-demo.ts:64–76`;
`scripts/test-responses-live.ts:132–153,177–207,276–312,380–386`.

The production gate accepts counts/booleans and three distinct arbitrary sentinel
strings. It requires no source/lockfile hashes, accepted review identity, effective
limits, profile fingerprint, transcript commitments, response/call/result IDs,
predecessor chain, or bounded-time observation. The computed runtime fingerprint
is explicitly discarded rather than compared to evidence. File mode 0600 establishes
neither a reviewed implementation nor actual isolation evidence.

Reproduced through **the actual production factory**, without dependency injection:
a hand-written summary with sentinel attempts `['a','b','c']`, a deliberately fake
API key, and a profile named `unreviewed-profile` registering `shell` successfully
opened a `ResponsesWorker`. No API request or shell dispatch was made. This proves
admission bypass, not execution of a forbidden tool. The added reduced test itself
asserts acceptance of fabricated evidence.

The live harness's new call-to-response map improves the predecessor comparison,
but does not meet the remaining RD-0 obligations. `probe_sentinel` is an allowed
registered callback which returns a hard-coded rejection; `rejectedDispatchCount`
counts those successful callback invocations. The file starts with three false
sentinel booleans and reading it merely checks they remain false. This is not an
observed rejection of an unregistered tool at the production dispatch boundary.
The retained summary also omits the new call/result/predecessor correlations.

Required correction: preserve fail-closed production admission until accepted
current-source/profile/limits evidence is bound to the runtime and meaningful
allowed/disallowed dispatch observations are retained and checked. A corrected
local factory regression must reject this exact fabricated artifact and an
unreviewed profile. RD-0 remains unverified regardless of parser/test success.

### RDA-02 — P1: init can overwrite surviving provider economic state

Affected: `scripts/reduced-demo-init.ts:19–34`.

The claimed “nonempty root” rejection checks only five filenames. It does not
check `host.json`, worker/web/client/streaming journals, transaction journals, or
other retained artifacts. If the five checked files are absent but a provider
`host.json` survives, init writes a fresh host journal with empty quotes, channels,
and operations over the old file. Treating stat errors as absence also does not
establish a safe empty directory.

Reproduced with an orphan provider `host.json` containing a retained channel:
`initializeReducedDemoState` returned success and replaced `channels` with `[]`.
The reproduction uses a synthetic host record; overwriting happens independently
of its contents. This is a reachable destructive reinitialization boundary, not
an automatic-crash-recovery feature being requested.

Required correction: reject any ambiguous/nonempty role root before writes,
except explicitly harmless lock machinery; never overwrite surviving host or
settlement state. Add a retained-artifact negative test through the initializer.

### RDA-03 — P1: the promised two-process local operator path is not runnable

Affected: `scripts/reduced-live-demo.ts:8–19`, `scripts/reduced-demo-init.ts:41–45`,
`scripts/agent-demo-server.ts:129–167,570–572`,
`scripts/agent-demo-export.ts:21,60–73`, `deploy/agent-demo/README.md:83–111`.

Both CLI modes require exactly `/data/m2m/host.json`. Host validation fixes both
roles' state root to `/data/m2m`, projection to `/data/m2m/projection`, UI to
`/app/ui`, coordinator listener to `0.0.0.0:8080`, provider listener to
`fly-local-6pn:8081`, and public origin to HTTPS. Export additionally requires
`.internal` and `.fly.dev` hostname shapes. A pair of ordinary native processes
cannot select two private roots/configs and loopback listeners as specified.
They would also share one projection location under the fixed path. Mount
namespaces, containers, Fly DNS, and a TLS reverse proxy are not the authorized
first-demo prerequisites.

Reproduced by calling the production `readDemoHostConfig` on a protected temporary
file: the Fly-shaped coordinator config passes without a model credential; each
of a private local state root, `127.0.0.1` listener, checkout UI directory, and
`http://127.0.0.1:8080` public origin fails with `invalid_host_config`. The CLI's
literal-path rejection is explicit before the parser is reached.

Required correction: make the reduced production entrypoint accept the specified
local topology with distinct protected roots, valid loopback auth/origin handling,
and a built UI path. Exercise serialized configs and the compiled/source CLI,
including init then serve; constructing typed config objects is insufficient.

### RDA-04 — P1: successful init does not initialize the mandatory HTTP projection

Affected: `scripts/reduced-demo-init.ts:27–35`,
`scripts/agent-demo-server.ts:300,605–617`; dependency
`scripts/agent-demo-projection.ts:85–105`.

Init creates role journals but neither `projection.json` nor its initialization
marker. Production serve unconditionally opens HTTP with `createProjection:false`.
Even with all identity/provider inputs available, a fresh initialized role fails
that stage with `journal_missing`, shuts down the runtime, and serves the blocked
backend. Export does not create the projection either. This is independent of
RDA-03's path restrictions.

Reproduced: call the initializer successfully in a fresh private temporary root,
then call the exact `DemoProjection.open` configuration used by serve with
`create:false`; it rejects `journal_missing`. The added test stops at checking
manifest/runtime files and never reaches this required reopen.

Required correction: include projection creation in the explicit initialization
contract and verify the complete first init/serve/reopen sequence for both roles.

### RDA-05 — P1: actual post-close economy cannot pass the public snapshot contract

Affected: `scripts/agent-demo-runtime.ts:357–369,478–480`; dependencies
`scripts/agent-service-client.ts:503–535`, `scripts/agent-coordinator.ts:415–425,457–469`,
`scripts/agent-demo-event-contract.ts:414–449`.

After exact close, `BudgetLedger.observe` intentionally clears the active channel,
authorized units, delivered units, and current redeemed amount while retaining
terminal accounting separately. `selectedEconomy` instead takes historical
`reserved_mist` and `redeemed_mist` from that now-cleared active snapshot. It emits
nonzero signed authorization with zero reserved value and `redeemed_mist:null`,
even though the independently read channel has a known redeemed amount and zero
funds. The public validator rejects this shape. The actual backend cannot show
the required close/refund view merely because isolated accounting fixtures pass.

Reproduced by extracting the unchanged current `selectedEconomy` function and
feeding its real post-terminal budget shape plus an observed closed channel. It
emitted `status:'closed', signed_authorized_mist:'38', reserved_mist:'0',
redeemed_mist:null, locked_mist:'0'`; `validateDemoSnapshot` rejected
`invalid_snapshot`. All signatures/data in this check are existing local fixtures;
it is not an onchain close execution.

Additionally, this function labels a frozen engine `closed` before checking the
observed chain status. Receiving final signed consent freezes the engine before
settlement confirmation. The UI amount helper conservatively retains exposure,
but the runtime label still conflates final consent with confirmed settlement.

Required correction: retain historical signed/reserved evidence independently of
active budget reset, source confirmed paid value from terminal observations, and
keep pending/unknown settlement explicit. Add an actual runtime→HTTP snapshot and
evidence regression through successful close and uncertain close, then prove RD-4
with a separate read-only testnet verifier.

### RDA-06 — P1: paced SSE cutover strands a real event

Affected: `scripts/agent-demo-server.ts:513–520,541–554`.

After draining `buffered`, the code queues the live marker and awaits `flush()`
while `replaying` is still true. An event arriving during that await is appended
to `buffered`. After flush, the code sets `replaying=false` and never drains that
last buffer. Strictly, the array is not cleared at line 553; it is stranded, and
cleanup later clears it. The next event skips the expected sequence and closes
the stream. Without a next event, the UI can remain connected but missing the
last update. This requires only one cutover event, not deferred large history.

Reproduced against the extracted **current streamEvents function**, with a fake
ServerResponse imposing backpressure on the live marker. Publishing sequence 1
during that write produced no `agent_event` frame; publishing sequence 2 afterward
closed the response on the sequence gap. Output contained only replaying/live
markers. The source/projection events remain durable, so a later reconnect can
recover them; this does not make the ordinary reconnect cutover correct.

Required correction: make the transition atomic with respect to the subscription,
or drain everything captured during marker flush before completing cutover.
Retain this exact backpressure/tail-event regression, or use the specified bounded
cursor-polling alternative.

### RDA-07 — P2: durable uncertainty, request exhaustion, and closed state do not disable submission

Affected: `scripts/reduced-demo-supervisor.ts:95–128`,
`scripts/agent-demo-runtime.ts:343–351,554–566`,
`ui/agent-demo/src/App.tsx:195–200,219`.

After an uncertain run finishes, `activeTask` becomes null. On reopen a retained
`running` task also has null active IDs, and supervisor status reports `idle`
unless a task was explicitly marked uncertain. Runtime status ignores the
supervisor's state; `availableControls` advertises `task` whenever there is a peer,
selected channel, supervisor, no pause, and no activeTask. It checks neither
uncertainty, request exhaustion, nor terminal channel state. The UI trusts those
controls. A retained running journal reproduced status
`{activeTask:null,activeRequest:null,state:'idle'}`.

The lower supervisor/client checks prevent a new paid request in these states;
this finding does not assert duplicate funding or successful excess dispatch.
But the required visible stop is missing. Also, resubmitting an uncertain control's
same ID returns its old record at runtime line 566; it never reaches the explicit
supervisor retry tested by `test-reduced-demo.ts`. The direct supervisor test is
not evidence of operator retry through production HTTP.

Required correction: derive admission/status from durable uncertainty, request
count, and observed channel state; distinguish exact completed replay from a new
request. Test those states through runtime and HTTP, including restart and same-ID
uncertain reconciliation behavior. Controlled completed replay should retain zero
external effects; uncertain work must not silently become a new request.

### RDA-08 — P2: reduced entrypoint admits different prices and increased caps

Affected: `scripts/agent-demo-server.ts:107–116`,
`scripts/agent-demo-runtime.ts:101–115`,
`deploy/agent-demo/image-smoke.mjs:18–23`.

Only the new request count is fixed to two. The reduced production parser still
accepts nonzero input fees, arbitrary output rates/denominators, and values above
the frozen deposit/total/per-turn/exposure caps. The image smoke continues to use
the old `[2,3]/1000` policy and a 1,000,000-MIST deposit. Reproduced parser acceptance
of those rates, that deposit, and a 2,000,000-MIST total cap. Conversely, its exact
`max_requests === 2` rejects lowering that limit, though the spec permits lower
operator limits before opening.

Generic service configurability should remain. Required correction: enforce the
accepted reduced profile at its application entry boundary, with the specified
prices and non-increasing demo limits; update the operator examples and add
serialized-config regressions. This is a scope/terms validation defect, not a
request to change the generic payment codec.

## Validation results and limits

Commands below were run during this independent pass. Passing fixture tests do
not establish live gates or production-entrypoint success.

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run reduced-demo-tests` | PASS, but its fabricated evidence positive and direct unvalidated config objects miss RDA-01/03/04 |
| `npm run agent-runtime-tests` | **FAIL**, reproduced on repeat: transport and basic worker assertions pass, then `ResponsesWorkerError: worker_lock` at `responses-worker.ts:215`, called from `test-responses-worker.ts:419` in child pending/prepared recovery |
| `npm run agent-runtime-integration-tests` | PASS, injected coordinator/worker seam |
| `npm run agent-demo-boot-tests` | PASS; real local native bridge/unpaid echo, separate roots, fixture chain and worker; no `readDemoHostConfig`/production init/serve positive |
| `npm run agent-demo-host-tests` | PASS |
| `npx tsx scripts/test-agent-demo-http-recovery.ts` | PASS; does not schedule an event during the final live-marker flush |
| `npx tsx scripts/test-agent-demo-setup.ts` | PASS; fixture setup, export acceptance explicitly remains pending |
| `npm run agent-demo-build` | PASS; server/operator ESM and UI assets emitted |
| `npm run agent-demo-production-boundary-tests` | PASS; production UI negative-backend and artifact checks, not successful production boot |
| `npm run agent-demo-economic-fixture-tests` | PASS; signed credit/Ack/checkpoint, UTF-8 and replay fixture |
| `npm run agent-demo-event-contract-tests` | PASS |
| `npm run agent-demo-ui-contract-tests` | PASS; includes conservative unknown-settlement exposure |
| `npm run agent-demo-vectors` | PASS |
| `npm run vectors` and `npm run channel-vectors` | PASS; independent byte/hash/signature/tamper checks |
| `npm run agent-services-tests` | PASS; legacy denial and offline paid conversation/replay/close fixtures |
| `git diff --check` | PASS before review creation |
| Four focused reproductions retained below | All observed the stated failures |

The repeated worker-lock failure means the implementation report's blanket local
PASS cannot be independently confirmed on this checkout/environment. The failing
child recovery test and lock implementation are outside this diff; causation is
not attributed to the reduced changes without further investigation. A clean
controlled restart is narrower than arbitrary process-crash recovery, but this
required regression still needs a explained/reproduced resolution. Later suites
were run separately after the failure rather than treated as executed by a stopped
`&&` chain. No full native suite, Docker image execution, or live browser/payment
run is claimed by this pass.

## What passes by inspection and bounded evidence

- Coordinator separation is implemented: strict serialized coordinator config
  rejects a `model_api_key_file`; production forwards no model credential to that
  role, calls no coordinator worker factory, and role export writes `model.key`
  only to the provider. The temporary parser reproduction confirms both the
  no-key positive and explicit-key negative. Ambient process environment was not
  audited as an operator deployment artifact.
- Provider construction reads the search credential, opens the web profile and
  worker gate, then opens host/Iroh listener. The coordinator obtains a matching
  locator and completes signed unpaid echo before funding. Missing evidence fails
  closed, but fabricated evidence defeats the intended assurance (RDA-01). Merely
  reading API key files does not validate current API access.
- Production boot uses fresh `NativeNames.resolve` for both exact leaves and
  validates the parent/qualified Agent/key/controller snapshot. Own private key
  public values are compared and transport/economic equality rejected.
  `NativePeer` refreshes Agent authority on reception and rejects generation/key
  changes. These are meaningful checks, not fresh testnet/SuiNS acceptance. Alias
  freshness is a boot snapshot; no continuous alias re-resolution was demonstrated.
- Normal supervisor execution persists the exact ID/prompt before dispatch, rejects
  conflicting prompts and a third new ID, and delegates payment/replay to the
  existing client. The real client's retained terminal-receipt path returns before
  new external work. Runtime duplicate controls return their durable record.
  Controlled two-process paid restart and retained live model predecessor remain
  unproved; direct supervisor tests call the mock port again on replay.
- The one retained opening nonce, funding journal, channel binding and client
  offer-hash checks are preserved. No new replacement-channel path is added.
  The exact-close client checks a final signed checkpoint and terminal state/value;
  RDA-05 concerns composition into the real public view, not a changed Move ABI.
- H02's synthetic source event ID is now a valid decimal and the route supplies
  the requested channel to the sanitizer. Native signing/envelope structures are
  unchanged. Existing host/event tests pass; a successful live signed terminal
  evidence download is still required.
- Setup now requires the independent initialization marker and exact submitted
  journal, refusing old/ambiguous setup instead of silently recovering it. Legacy
  wire/codecs and economic rights are not migrated by this diff. The new reduced
  initializer's destructive orphan case is separately outstanding (RDA-02).
- Build includes both operator modules and the supervisor and preserves module
  main guards. Docker allowlists include the new files; the actual build passes.
  `build-inputs.json` records the server graph, omitting the extra operator inputs
  appended for compilation; do not use that manifest alone as complete source
  provenance for the new CLI. Positive packaging tests must execute that CLI.

## RD verdict

| Gate | Independent status |
|---|---|
| RD-0 | UNVERIFIED; production evidence admission is defective (RDA-01); no fresh live isolation/continuation record |
| RD-1 | UNVERIFIED; local entry/initialization blockers; no fresh testnet names/authority/two-process evidence |
| RD-2 | UNVERIFIED; no live research/search/fetch/citation/credit sequence or independently reconstructed run |
| RD-3 | UNVERIFIED; no actual between-turn live process exit/reopen/follow-up; durable state/UI gaps remain |
| RD-4 | UNVERIFIED; close projection and SSE failures; no real backend browser plus independent exact testnet close |
| RD-5 | NOT PASSED; this review returns the implementation for correction and no RD-0–4 live bundle exists |

Correct the bounded local defects and validate the real operator entrypoint before
requesting local acceptance again. Then attach fresh RD-0–4 evidence at the exact
reviewed source/profile hashes. This does not add Fly, a second LLM, a new protocol,
or expanded live failure demonstrations to the authoritative scope.

## Reproduction sources

The following scripts were executed from the repository using Node and its local
`tsx`/`esbuild` dependencies. They use temporary synthetic state, never production
secrets or network requests. Save each block under `/tmp` and run the indicated
command. The first isolates the actual SSE function; the close check isolates the
actual runtime projection. They are focused reproductions, not full production
end-to-end acceptance.

### sse: `node /tmp/m2m-astra-sse.mjs`

```js
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import assert from 'node:assert/strict';
const require=createRequire('/home/bl/unconfirmedlabs/m2m/package.json');
const {transformSync}=require('esbuild');
const source=readFileSync('/home/bl/unconfirmedlabs/m2m/scripts/agent-demo-server.ts','utf8');
const block=source.slice(source.indexOf('  const streamEvents = async'),source.indexOf('  const serveStatic = async'));
let listener; let water='0'; const frames=[]; let ended=false;
const response=new EventEmitter(); response.writableEnded=false; response.writeHead=()=>{};
response.end=()=>{ended=true;response.writableEnded=true;};
response.write=frame=>{const text=frame.toString(); frames.push(text); if(text.includes('"state":"live"')) {water='1'; listener({sequence:'1'}); setImmediate(()=>response.emit('drain')); return false;} return true;};
const projection={highWater:()=>water,replay:()=>[],subscribe:fn=>{listener=fn;return()=>{};}};
const code=transformSync(block+'\nreturn streamEvents;', {loader:'ts',target:'node22'}).code;
const fn=new Function('projection','options','auth','parseLastEventId','sseFrame','MAX_SSE_BUFFER_BYTES','activeStreams',code)(projection,{runtime:{conversation:'test'}},{admitSse:()=>({release(){}})},()=> '0',(name,data)=>Buffer.from(name+':'+JSON.stringify(data)),256*1024,new Set());
const request=new EventEmitter(); await fn(request,response,{});
assert(!frames.some(x=>x.startsWith('agent_event')));
console.log('After live flush: event 1 was published but no agent_event frame was sent.');
water='2'; listener({sequence:'2'}); assert(ended);
console.log('Publishing event 2 closes the stream on projection_gap.');
console.log(JSON.stringify(frames));
```

### boundaries: `node --import tsx /tmp/m2m-astra-boundaries.mjs`

```js
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {initializeReducedDemoState} from '/home/bl/unconfirmedlabs/m2m/scripts/reduced-demo-init.ts';
import {readDemoHostConfig} from '/home/bl/unconfirmedlabs/m2m/scripts/agent-demo-server.ts';
import {DemoProjection} from '/home/bl/unconfirmedlabs/m2m/scripts/agent-demo-projection.ts';
import {openAgentWorker,responsesLimits} from '/home/bl/unconfirmedlabs/m2m/scripts/agent-runtime.ts';
const root=await mkdtemp('/tmp/m2m-astra-boundaries-');
const h=x=>x.repeat(64), a=x=>'0x'+h(x);
const ref=x=>({network:[...Buffer.from('testnet')],package_id:a('1'),domain:a('2'),agent:a(x)});
const service={version:1,budget:{max_total_mist:'100000',max_channel_deposit_mist:'100000',max_turn_mist:'40000',max_outstanding_mist:'1024',max_requests:2,deadline_ms:'4102444800000',output_tranche_bytes:256},deposit_mist:'100000',price:{input_rate:'0',output_rate:'1',denominator:'1'},allowed_hosts:['example.com']};
const descriptor={version:1,kind:'responses-tools-v1',model:'gpt-5.6-luna',reasoning:'xhigh'};
const cfg={version:1,role:'coordinator',state_dir:'/data/m2m',conversation:h('a'),network:'testnet',config:service,runtime:descriptor,agents:{buyer:ref('3'),provider:ref('4')},projection_state_dir:'/data/m2m/projection',static_dir:'/app/ui',bind_host:'0.0.0.0',port:8080,provider_base_url:'http://provider.internal:8081',public_origin:'https://demo.fly.dev',wallet_file:'/data/m2m/wallet',viewer_token_file:'/data/m2m/viewer',operator_token_file:'/data/m2m/operator',observer_token_file:'/data/m2m/observer'};
async function parse(c){const p=join(root,'host.json');await writeFile(p,JSON.stringify(c),{mode:0o600});return readDemoHostConfig(p);}
try {
 await parse(cfg); console.log('Fly-shaped config without coordinator model key: accepted');
 await assert.rejects(parse({...cfg,model_api_key_file:'/data/m2m/model.key'}),/invalid_host_config/);console.log('Coordinator model-key field: rejected');
 for(const patch of [{state_dir:root,projection_state_dir:join(root,'projection')},{bind_host:'127.0.0.1'},{static_dir:'/home/bl/unconfirmedlabs/m2m/ui/agent-demo/dist'},{public_origin:'http://127.0.0.1:8080'}]) {await assert.rejects(parse({...cfg,...patch}),/invalid_host_config/);console.log('Local config rejected:',Object.keys(patch).join(','));}
 await parse({...cfg,config:{...service,price:{input_rate:'2',output_rate:'3',denominator:'1000'},deposit_mist:'1000000',budget:{...service.budget,max_total_mist:'2000000',max_channel_deposit_mist:'1000000'}}});console.log('Non-reduced price and raised deposit/caps: accepted');
 const local={...cfg,state_dir:root,projection_state_dir:join(root,'projection')};
 const init=await initializeReducedDemoState(local);
 await assert.rejects(DemoProjection.open({stateDir:local.projection_state_dir,create:false,conversation:cfg.conversation,pins:{conversation:cfg.conversation,configuration_hash:init.configuration_hash,config:service,agents:cfg.agents}}),/journal_missing/);console.log('Projection reopen after successful initializer: journal_missing');
 const summary={state:'completed',creates:2,userCreateCount:1,continuationCreateCount:1,callbackCount:1,markerObservedInOutput:true,userCreatePreviousResponseIdPresent:true,prohibitedToolsSubmitted:0,rejectedDispatchCount:3,sentinelState:{filesystem:false,process:false,network:false},sentinelAttempts:['a','b','c']};
 const evidence=join(root,'fake-evidence.json'); await writeFile(evidence,JSON.stringify({version:1,runtime:descriptor.kind,model:descriptor.model,effort:descriptor.reasoning,initial:summary,restart:summary}),{mode:0o600});
 const worker=await openAgentWorker({descriptor,stateDir:join(root,'worker'),create:true,apiKey:'not-a-real-credential',evidenceFile:evidence,limits:responsesLimits('provider'),profile:{id:'unreviewed-profile',baseInstructions:'unreviewed',developerInstructions:'unreviewed',tools:[{name:'shell',description:'unreviewed shell tool',inputSchema:{type:'object',properties:{},required:[],additionalProperties:false}}],maxToolCalls:1,maxToolResultBytes:64,recoverableTools:[],handleTool:async()=>({success:true,text:'unused'})}});
 console.log('Production worker opened with fabricated summary, fake key and unreviewed shell profile; zero model/API calls'); await worker.shutdown();
} finally {await rm(root,{recursive:true,force:true});}
```

### state: `node --import tsx /tmp/m2m-astra-state.mjs`

```js
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {initializeReducedDemoState} from '/home/bl/unconfirmedlabs/m2m/scripts/reduced-demo-init.ts';
import {DeterministicDemoSupervisor} from '/home/bl/unconfirmedlabs/m2m/scripts/reduced-demo-supervisor.ts';
const root=await mkdtemp('/tmp/m2m-astra-state-'); const id='a'.repeat(64), hash='b'.repeat(64);
try {
 const cfg={role:'provider',state_dir:root,conversation:id,agents:{buyer:{},provider:{}},config:{version:1,budget:{max_requests:2},deposit_mist:'100000',price:{input_rate:'0',output_rate:'1',denominator:'1'},allowed_hosts:['example.com']}};
 const roleRoot=join(root,'agent-services',id,'provider');await mkdir(roleRoot,{recursive:true,mode:0o700});
 await writeFile(join(roleRoot,'host.json'),JSON.stringify({retained:'do-not-overwrite',channels:['old-channel']}),{mode:0o600});
 await initializeReducedDemoState(cfg);
 const host=JSON.parse(await readFile(join(roleRoot,'host.json'),'utf8'));assert.deepEqual(host.channels,[]);console.log('Initializer overwrote orphan provider host.json with an empty channels journal');
 await mkdir(join(root,'supervisor'),{mode:0o700});
 await writeFile(join(root,'supervisor','supervisor.json'),JSON.stringify({version:1,conversation:id,configuration_hash:hash,tasks:[{id:'c'.repeat(64),prompt:'retained in flight',state:'running',outcome:null,updated_at_ms:'1'}]}),{mode:0o600});
 const sup=await DeterministicDemoSupervisor.open({stateDir:root,create:false,conversation:id,configurationHash:hash,config:cfg.config,port:{execute(){throw Error('must not dispatch')},cancel:async()=>({confirmed:false})}});
 assert.equal(sup.status().state,'idle'); console.log('Supervisor reopens durable running task as',JSON.stringify(sup.status()));
} finally {await rm(root,{recursive:true,force:true});}
```

### close: `node --import tsx /tmp/m2m-astra-close.mjs`

```js
import {readFileSync} from 'node:fs';
import {transformSync} from '/home/bl/unconfirmedlabs/m2m/node_modules/esbuild/lib/main.js';
import {createPublicSessionFixture} from '/home/bl/unconfirmedlabs/m2m/tests/agent-demo/public-session.ts';
import {validateDemoSnapshot} from '/home/bl/unconfirmedlabs/m2m/scripts/agent-demo-event-contract.ts';
import {price} from '/home/bl/unconfirmedlabs/m2m/scripts/streaming-codec.ts';
const f=createPublicSessionFixture(), c=f.snapshot.channels[0];
const src=readFileSync('/home/bl/unconfirmedlabs/m2m/scripts/agent-demo-runtime.ts','utf8');
const code=transformSync(src.slice(src.indexOf('  function selectedEconomy()'),src.indexOf('  function publicStatus()'))+'\nreturn selectedEconomy();',{loader:'ts',target:'node22'}).code;
const budget={...c.budget,channel:null,authorized_mist:'0',delivered_mist:'0',redeemed_mist:'0',outstanding_mist:'0',settled_prior_mist:c.delivered_mist,remaining_mist:String(BigInt(c.budget.limits.max_total_mist)-BigInt(c.delivered_mist))};
const run=new Function('engine','budget','latestEngine','observedChannel','price','clone','openingTransaction','terminalTransaction','clock',code);
const values=run({snapshot:()=>({frozen:true,binding:{channel:c.channel,offer:c.offer,policy:c.policy}})},{snapshot:()=>budget},()=>({credit:c.signed_credit,checkpoint:c.checkpoint,units:c.delivered_units}),{status:1,funds:'0',redeemed_amount:c.delivered_mist},price,structuredClone,c.opening,{state:'confirmed',digest:c.opening.digest,gas:null},{nowMs:()=>Date.now()});
console.log(JSON.stringify({status:values[0].status,redeemed_mist:values[0].redeemed_mist,reserved_mist:values[0].reserved_mist,signed_authorized_mist:values[0].signed_authorized_mist,locked_mist:values[0].locked_mist}));
try {validateDemoSnapshot({...f.snapshot,channels:values},f.pins);console.log('unexpected acceptance');process.exitCode=1;}catch(e){console.log('Actual selectedEconomy output after terminal budget reset rejected:',e.message);}
```

## Reviewed source hashes

The seven implementation hashes below match the implementation record; the
failures therefore apply to its stated checkpoint, not later edits.

```text
90746afe990f08fbf01020e6df46962e0f17a79465f3d349d6bc34bcbe45108e  scripts/reduced-demo-supervisor.ts
d680ad4ad46c51f2c31f74f78751fe19f031609dd24d9337b048267e2a4ccc9f  scripts/reduced-demo-init.ts
2defd4cf8df9a34486e171d93c0d67117f43549711fad3b37c3a6f17e729c891  scripts/reduced-live-demo.ts
f8fdb633b344ba6b7af819e5a5933c283d6b1230960343d5732a5e1ab748b4b7  scripts/agent-demo-runtime.ts
3ccd4c5a853d3d7ed244aefe2265198985b7a44a0cc87555187895f147c5e5fb  scripts/agent-demo-server.ts
10a13d9e8402a0aca98cf9dfb916cbb65057c25cbd662d37a5f0e27bb87cea45  scripts/agent-runtime.ts
b20b10e49f7e2bc6c9b8de1e280d61ae251d305aaaf44211bd053a10a0f3da2f  scripts/test-responses-live.ts
b7589843d9f104aa09ea25dd3286865197def1c14589667aaea3aae982b19339  package-lock.json
```
