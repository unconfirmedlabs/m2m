# Astra L1 first-run and initialization review — 2026-09-11

Status: **incomplete first-connected-run boundary; return the named corrections
below**. This is a bounded FD-04–07 / initialization-export completion handoff, not
a new architecture, full lifecycle audit or paid/live acceptance.

Frozen source scripts/agent-demo-runtime.ts:
89d892e5fe28a33a351eac18ade9cb925c4544e5f476ee68f5b3685f2c0a65df.
Frozen test scripts/test-agent-demo-runtime.ts:
ec78907a03b8297c5dd162c59d2ee1a3c236018327273c5ee3bea56f96710bef.
Both hashes matched before and after review.

Executed owner test: `npx tsx scripts/test-agent-demo-runtime.ts`, passed. It uses
explicit fixture inference/chain ports and MemoryBridge in a shared state root.
It exercises real NativePeer messages, but MemoryBridge is not Iroh. Its success
line calling this "unpaid Iroh reconnect" overstates that test. F06/F07 full
settlement is explicitly absent.

## L01 — coordinator never writes the validated private locator ticket

start validates the remote endpoint and compares its key to the initially read
provider authorization, then starts connect with ticketFile (around lines
387–396). No code saves remote.endpoint to that file. Only the provider listener
writes a ticket, on its own machine.

Independent fresh coordinator test reaches the actual bridgeFactory boundary
with ticketExists:false. The fixture deliberately throws before any network
work, and the control fails runtime_error. This confirms the missing input;
it is not a claim that the test exercised real Iroh.

Required: after complete locator and fresh pinned authorization verification,
atomically save the exact bounded bridge EndpointAddr serde value to the
coordinator's own private ticket before connect. Compare the complete provider
AgentRef, not only its agent object ID. Do not copy the provider state root or
private key, accept arbitrary operator HTTP paths, or rely on a shared directory.

Acceptance: root's separate-root real-bridge test must start an unpaid connection
with only each role's own private keys, then disconnect/reconnect from its own
retained state, with zero model/funding/settlement callbacks. Changed locator key,
qualified AgentRef or configuration must fail before writing/connecting.

Root has now checked in the permanent expected-success regression
`scripts/test-agent-demo-boot-contract.ts`, using the actual release
native-bridge with relay disabled in its injected loopback harness, separate
roots, fixture chain/worker and no funding. Root reports the current source
fails ticket startup with transport_closed / ticketPresent:false / connect1,
and initialized-before-start reopen with journal_missing / connect0. Those
results strengthen L01/L02; they are real local Iroh boundary evidence, not live
inference/Sui settlement. This reviewer did not rerun root's bridge test.

## L02 — initialize/restart before first start permanently loses lazy create mode

budgetCreate, coordinatorCreate and workerCreate inherit the process-wide
options.create. Successful initial open leaves the coordinator components lazy.
After shutdown/reopen with create:false, the first start opens a never-created
BudgetLedger with create:false and fails journal_missing.

Independent actual lifecycle output:

```json
{"probe":"initialize_only","workerCalls":0,"funds":0,"aliasState":"verified"}
{"probe":"reopen_before_first_start","state":"failed","code":"journal_missing","workerCalls":0,"bridgeCalls":0}
```

The same global create assumption also reaches deferred exchange/channel/client
components. The fix must distinguish a genuinely never-initialized component
from loss of an initialized component; do not change every reopen to create:true.

Required: persist per-component initialized/location state before/with component
creation, and derive each constructor's create mode from that durable state.
Alternatively, the explicit initialization step can initialize required empty
components up front without model, connection or economic effects. Preserve
fresh-conversation migration and initialized-file-loss rejection.

Acceptance: init→shutdown→ordinary create:false→first start succeeds; first fund
after a pre-funding restart uses the correct component create mode; losing any
already-initialized component rejects before model/signing/funding. Cover crashes
before and after each initialization marker/result with original IDs retained.

## L03 — role/Agent exclusion is conversation-scoped, and shutdown ignores uncertainty

Only root/conversation/role/runtime.lock is acquired. Independent test opens a
second coordinator conversation under the same state root and same Agent while
the first handle is still alive: opened:true. The existing standalone
agent-services runner instead takes the local identity's .agent-services.lock.

Required: restore one live writer per local role/Agent across conversations and
compatibly exclude the existing standalone runner. Keep component locks too.

Related inspected FD-06 cleanup problem: cleanup catches coordinator/worker
shutdown rejection and still closes budget/events/runtime lock. That contradicts
the already accepted uncertain-shutdown contract. Do not release enclosing
authority/state locks while a handler/save can still mutate their state. This
cleanup variant was read, not independently delayed-handler fault-probed in this
bounded first-run tranche.

Acceptance: a second same-Agent conversation and standalone composition are
rejected while the owner is live; genuine quiescent close permits reopen. A
held handler with rejected shutdown keeps owning locks until quiescence/process
termination, rather than reporting successful cleanup after swallowing the error.

## L04 — verified names/current local authority are not established

The source never imports/calls NativeNames. It directly resolves the supplied
AgentRefs, yet identity() hardcodes local.nozomi.sui / research.nozomi.sui and
alias_state:verified. No parent/name resolution snapshot is retained. The local
fixture already returns verified despite performing no naming operation.

Required existing path: on testnet use NativeNames.resolve(exactLeaf,pinnedRef),
which checks parent registration, leaf target, qualified AgentRef and current
authorization; retain its public snapshot. Follow the frozen stale-after-prior-
verification rule on unavailable aliases. Never fabricate a verified alias on
loopback fixtures or before that operation.

Before first admission, match the local transport and economic public keys to
its fresh Agent authorization, enforce distinct keys and controller wallet
ownership for the buyer, and prevent provider possession of buyer/name-owner
private keys through the explicit role export. The existing StreamingChain.fund
already checks the live funding controller/key agreement for a new opening;
preserve that check rather than duplicate a different payment rule.

Acceptance: exact names/controller/key positives and wrong parent/target/key/
expired authority negatives before worker/connect/funding admission, using
controlled existing NativeNames/NativeChain boundaries. No public provisioning
or real wallet read belongs in implementation tests.

## L05 — immutable runtime/component/test provenance is absent from the manifest

The exact manifest stores role, conversation, AgentRefs, service config and its
hash only. Runtime descriptor, full profile/limits fingerprint, worker locations,
component initialization records and test_dependencies_used are absent.
readSafeManifest therefore cannot compare them on reopen. roleStatus also emits
a descriptor-only hash before a profile is constructed and a different
profile/limits hash afterward; that is not the required pinned profile identity.

Required: freeze the existing runtime descriptor and actual role profile/limits
fingerprint with persistent component locations and explicit test provenance.
Validate before effects, reject every reopen mismatch or missing initialized
record, and reject injected-test state in the production path. Coordinate any
neutral type changes with root; no alternate runtime or fixture CLI is authorized.

Acceptance: changed descriptor/instructions/tool schema/recoverable tools/numeric
limits/component location/test provenance fail on reopen; unchanged manifest
preserves budgets/deadlines/IDs and the same truthful profile fingerprint.

## Exact remaining initialization/export completion scope

Do not mark FD-04–07/F02/F14a complete merely because openDemoRuntime exists.
The implementation owner reports no init/export CLI yet. Root's production
host intentionally opens create:false, so there must be an explicit operator
workflow that prepares both roles before image startup.

Complete only the frozen operations, with root owning package/deployment wiring:

1. Consume the separately verified native setup result and explicit conversation/
   runtime/service pins. Never provision names, rotate controllers, fund or close
   from init, export, server boot or a browser request.
2. Export to two explicit fresh protected roots: shared public chain/identity/name
   pins, each role's own economic and Iroh keys; buyer controller key only on
   coordinator; no parent-name wallet or private counterpart keys. Define exact
   overwrite/refusal and loss/reopen behavior; do not silently migrate legacy or
   fixture state.
3. Initialize immutable runtime/component manifests, source journals and the
   coordinator projection under the same pins used by L1/L2. Make the ordinary
   production create:false boot work after init even if no start/fund occurred.
4. Wire an explicit operator command/documented entrypoint and deterministic
   machine-readable fixed-code outcome through root. No production --fixture,
   gate override, ambient credential fallback or hidden automatic refueling.
5. Test this actual CLI→export→init→create:false path, not only a projection of
   intended copied fields or a parallel unused helper. Assert no forbidden key
   sentinel, no economic/model effects during initialization, repeated-command
   behavior, separate-root real Iroh first connection, and initialized loss
   rejection.

The current source is also not the promised thin adapter/refactor of the old
runAgentServices CLI. Root should explicitly coordinate that integration while
preserving existing standalone behavior, not silently promote the new parallel
composition as complete.

## Independent first-run probe

This exports existing fixture helpers from a memory-only transpilation of the
owner test (without running its main), then invokes the actual lifecycle. All
keys are freshly generated test keys; placeholder model credential paths do not
exist; chain/worker/bridge are explicitly injected localnet ports. No real
credentials, public RPC or network bridge is used.

```sh
node --import tsx --input-type=module <<'JS'
import {readFileSync,existsSync,mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {transform} from 'esbuild';import {openDemoRuntime} from './scripts/agent-demo-runtime.ts';
let source=readFileSync('./scripts/test-agent-demo-runtime.ts','utf8').replace(/void main\(\)\.catch\(error => \{ console\.error\(error\); process\.exitCode = 1; \}\);/,'');
source=source.replaceAll(/(['"])\.\/([^'"]+)\.js\1/g,(_,q,name)=>q+pathToFileURL(resolve('scripts',name+'.ts')).href+q).replace("'@mysten/sui/keypairs/ed25519'",JSON.stringify(import.meta.resolve('@mysten/sui/keypairs/ed25519')));
source+='\nexport {setup,deps,worker,config,descriptor,conversation,agents};';
const t=await import('data:text/javascript;base64,'+Buffer.from((await transform(source,{loader:'ts',format:'esm',target:'node22'})).code).toString('base64'));
const root=mkdtempSync(join(tmpdir(),'m2m-l1-first-review-'));const f=await t.setup(root);let workerCalls=0,bridgeCalls=0;const dep=t.deps(f.chain,async()=>{workerCalls++;return t.worker()},args=>{bridgeCalls++;console.log(JSON.stringify({probe:'first_connect_ticket',ticketExists:existsSync(args.ticketFile)}));throw new Error('FIXTURE_STOP_BEFORE_NETWORK')});
const base={role:'coordinator',stateDir:root,conversation:t.conversation,config:t.config,runtime:t.descriptor,network:'localnet',agents:t.agents,modelApiKeyFile:join(root,'nonexistent-test-key'),dependencies:dep};
const h=await openDemoRuntime({...base,create:true});const pins=h.status().configuration_hash;const locator=async()=>({version:1,conversation:t.conversation,provider:t.agents.provider,configuration_hash:pins,endpoint:{id:Buffer.from(f.providerAuth.transport_key).toString('hex'),addrs:[]}});
console.log(JSON.stringify({probe:'initialize_only',workerCalls,funds:f.fundTracker.calls,aliasState:h.identities().provider.alias_state}));await h.shutdown();
const reopened=await openDemoRuntime({...base,create:false,providerLocator:locator});const result=await reopened.submit({version:1,id:'aa'.repeat(32),command:{op:'start'}});console.log(JSON.stringify({probe:'reopen_before_first_start',state:result.state,code:result.code,workerCalls,bridgeCalls}));await reopened.shutdown();
const root2=mkdtempSync(join(tmpdir(),'m2m-l1-ticket-review-'));const f2=await t.setup(root2);const base2={...base,stateDir:root2,dependencies:t.deps(f2.chain,async()=>t.worker(),args=>{console.log(JSON.stringify({probe:'first_connect_ticket',ticketExists:existsSync(args.ticketFile)}));throw new Error('FIXTURE_STOP_BEFORE_NETWORK')})};
const a=await openDemoRuntime({...base2,create:true,providerLocator:async()=>({...await locator(),endpoint:{id:Buffer.from(f2.providerAuth.transport_key).toString('hex'),addrs:[]}})});
const started=await a.submit({version:1,id:'bb'.repeat(32),command:{op:'start'}});console.log(JSON.stringify({probe:'fresh_first_start',state:started.state,code:started.code}));let b,error;try{b=await openDemoRuntime({...base2,conversation:'22'.repeat(32),create:true})}catch(e){error=e.message}console.log(JSON.stringify({probe:'same_agent_second_conversation',opened:!!b,error}));if(b)await b.shutdown();await a.shutdown();
JS
```

Full paid turn/settlement, funding recovery, new-channel history, public event
schema/provenance, per-transition publication fence and complete concurrent
control behavior remain existing F03–F07/F09–F11 work; this bounded review did
not accept them or expand into a new design. Root is separately composing the
real bridge test and image/UI. Fix these first-run blockers before treating
a running HTTP login page as a connected demo.
