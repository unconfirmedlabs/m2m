# Fly agent demo: implementation assignments and acceptance

Status: concrete implementation plan, 2026-09-11. Requirements are
[FD-01–24](FLY_AGENT_DEMO_SPEC.md); existing AS requirements remain in force
except where FD explicitly extends hosting/control behavior. This is a build
plan, not evidence that any deployment or live test passed. The user selected
Astra `xhigh` specification → Luna `xhigh` implementation → Astra `xhigh` review.

## 1. Freeze these boundaries before implementation

Root owns `scripts/demo-types.ts`, package/lockfile wiring and integration. It
creates the shared types first and sends the same committed interface text to
each implementation agent. Module owners may add internal helpers; changing a
shared interface requires root coordination before editing consumers. Existing
Move/Rust economic/core code is outside all three slices. The runtime adapter
assignment in AGENT_RUNTIME_IMPLEMENTATION owns its new adapter files only.

Use existing `AgentRef`, `AgentServiceConfig`, `BudgetSnapshot`, `AgentPublicEvent`,
`SignedData`, `OfferData`, `CreditData`, `CheckpointData`, `PolicyData` and
`AgentRuntimeDescriptor` with type-only imports. Avoid a runtime import of Node
code from the UI. Fixed constants/strict JSON schema definitions needed by the
browser may live in this neutral module; filesystem/crypto/network code may not.
All IDs/amounts in JSON are strings; no JSON BigInts.

```ts
export type MachineRole = 'coordinator' | 'provider';
export type ID = string;          // exactly 64 lowercase hex, no 0x
export type Address = string;     // exactly 0x + 64 lowercase hex
export type U64 = string;         // existing canonical decimal encoding
export type SourceCursor = Record<'coordinator' | 'research' | 'host', U64>;

export type DemoCommand =
  | { op: 'start' }
  | { op: 'fund'; configuration_hash: ID; previous_channel: Address | null }
  | { op: 'task'; prompt: string }
  | { op: 'cancel'; task: ID }
  | { op: 'spending'; paused: boolean }
  | { op: 'disconnect' }
  | { op: 'reconnect' }
  | { op: 'close'; channel: Address }
  | { op: 'refund'; channel: Address };
export interface DemoControl {
  version: 1;
  id: ID;
  command: DemoCommand;
}
export interface DemoControlRecord {
  version: 1;
  id: ID;
  command: DemoCommand;
  state: 'accepted' | 'running' | 'completed' | 'failed' | 'uncertain';
  code: string | null;             // fixed allowlisted code
  accepted_at_ms: U64;
  updated_at_ms: U64;
  task: ID | null;
  channel: Address | null;
}
export interface DemoConnection {
  desired: 'online' | 'offline';
  state: 'disconnected' | 'connecting' | 'connected' | 'recovering' | 'failed';
  generation: U64;                // local successful transport generation
  path: 'direct' | 'relay' | 'unknown';
  changed_at_ms: U64;
  code: string | null;
}
export interface DemoIdentity {
  name: 'local.nozomi.sui' | 'research.nozomi.sui';
  agent: AgentRef;
  controller: Address;
  transport_key: number[];        // public only
  economic_key: number[];         // public only; distinct
  generation: U64;
  authority_checked_at_ms: U64;
  alias_state: 'verified' | 'stale' | 'changed';
}
export interface DemoRoleStatus {
  version: 1;
  role: MachineRole;
  conversation: ID;
  phase: 'initializing' | 'ready' | 'active' | 'recovering' |
    'degraded' | 'blocked' | 'stopping';
  code: string | null;
  runtime: AgentRuntimeDescriptor;
  profile_fingerprint: ID;
  configuration_hash: ID;
  active_task: ID | null;
  active_request: ID | null;
  spending_paused: boolean;
  waiting_for_credit: boolean;
  connection: DemoConnection;
  cursor: SourceCursor;
}
export interface DemoEconomy {
  channel: Address;
  status: 'open' | 'closed' | 'refunded' | 'unknown';
  offer: SignedData<OfferData>;
  policy: PolicyData;
  signed_credit: SignedData<CreditData> | null;
  checkpoint: SignedData<CheckpointData> | null;
  budget: BudgetSnapshot;
  delivered_units: [U64, U64];
  delivered_mist: U64;
  signed_authorized_mist: U64;
  reserved_mist: U64;             // retain historical maximum after settlement
  outstanding_mist: U64;          // active exposure; zero on confirmed terminal
  reserved_exposure_mist: U64;    // active exposure; zero on confirmed terminal
  redeemed_mist: U64 | null;
  locked_mist: U64 | null;
  refunded_mist: U64 | null;
  observed_at_ms: U64 | null;
  opening: DemoTransaction;
  terminal: DemoTransaction | null;
}
export interface DemoTransaction {
  state: 'pending' | 'confirmed' | 'failed' | 'unknown';
  digest: string | null;           // validated Sui transaction digest
  gas: {
    computation_cost: U64;
    storage_cost: U64;
    storage_rebate: U64;
    non_refundable_storage_fee: U64;
  } | null;
}
export interface DemoSnapshot {
  version: 1;
  conversation: ID;
  mode: 'live';
  network: 'testnet' | 'localnet'; // localnet only in explicit local harness
  configuration_hash: ID;
  config: AgentServiceConfig;     // public immutable rates/bounds/hosts only
  identities: { coordinator: DemoIdentity; provider: DemoIdentity };
  roles: { coordinator: DemoRoleStatus; provider: DemoRoleStatus | null };
  provider_observed_at_ms: U64 | null;
  selected_channel: Address | null;
  channels: DemoEconomy[];
  projection_sequence: U64;
  available_controls: DemoCommand['op'][];
}
export interface DemoSessionResponse {
  version: 1;
  access: 'viewer' | 'operator';
  snapshot: DemoSnapshot;
}
export interface SourcedEvent { source: MachineRole; event: AgentPublicEvent }
export interface DemoEvent extends SourcedEvent {
  version: 1;
  sequence: U64;
}
export interface SourceEventPage {
  version: 1;
  conversation: ID;
  source: MachineRole;
  events: AgentPublicEvent[];
  high_water: SourceCursor;
  has_more: boolean;
}
export interface DemoRuntimeHandle {
  readonly role: MachineRole;
  readonly conversation: ID;
  publication(): DemoPublication;
  status(): DemoRoleStatus;
  selectedChannel(): Address | null;
  availableControls(): DemoCommand['op'][];
  // Coordinator only; private/provider HTTP never exposes this method.
  submit(control: DemoControl): Promise<DemoControlRecord>;
  control(id: ID): DemoControlRecord | undefined;
  events(after: SourceCursor, limit?: number): SourceEventPage;
  subscribe(listener: (event: AgentPublicEvent) => void): () => void;
  // Strict public-only records; never arbitrary file reads.
  economy(): DemoEconomy[];
  identities(): { coordinator: DemoIdentity; provider: DemoIdentity };
  evidence(channel: Address): Promise<DemoEvidence>;
  locator(): DemoLocator | null;
  shutdown(): Promise<void>;
}
export type DemoPublication =
  | { version:1; state:'ready'; cursor:SourceCursor; code:null }
  | { version:1; state:'pending'; cursor:SourceCursor; code:'publication_pending' }
  | { version:1; state:'failed'; cursor:SourceCursor; code:'publication_failed' };
export interface DemoLocator {
  version: 1;
  conversation: ID;
  provider: AgentRef;
  configuration_hash: ID;
  endpoint: {
    id: ID; // raw public endpoint key as 64 lowercase hex
    addrs: Array<{ Relay: string } | { Ip: string }>;
  };
}
export interface DemoEvidence {
  version: 1;
  conversation: ID;
  channel: Address;
  offer: SignedData<OfferData>;
  policy: PolicyData;
  credits: SignedData<CreditData>[];
  checkpoints: SignedData<CheckpointData>[];
  // Exact public core envelopes only for retained terminal receipts.
  terminal_receipts: SignedEnvelope[];
  economy: DemoEconomy;
}
```

`DemoSnapshot` cannot be fabricated while identity/runtime preflight is blocked.
In that case session/status return a bounded 503 `{version:1,code,role,phase}`;
the UI can display the gate without invented names, balances or readiness.
Provider unavailable after prior validation preserves its last verified identity
and role snapshot with the old observation time; no inferred online state.

`DemoLocator.endpoint` uses the actual pinned `iroh-base` 1.2.0 serde shape,
checked in `endpoint_addr.rs`, `key.rs` and `relay_url.rs` on 2026-09-11:
`EndpointAddr {id,addrs}`, externally tagged `Relay`/`Ip` variants, a lowercase
hex public key, URL string and SocketAddr string. The native bridge writes this
shape already. The demo admits at most 32 unique addresses, bounds JSON to
8 KiB, and rejects the unused `Custom` variant, unknown fields and malformed
addresses. Relay strings must be credential-free HTTPS URLs on port 443 without
query/fragment; Ip strings must parse as a numeric IPv4 or bracketed IPv6 socket
address with a valid nonzero port. Fly-private addresses are valid Iroh targets,
not web-fetch allowlist exceptions. Verify `id` against fresh pinned provider
transport authorization before saving the private ticket. Publish a serde
fixture/negative vector. Do not accept ticket paths or arbitrary HTTP fetch
targets from controls or use this locator as a model-accessible network tool.

## 2. Luna L1 — lifecycle, persistent control and credit gating

Own only:

- `scripts/agent-services.ts`.
- New `scripts/agent-demo-runtime.ts`.
- Narrowly additive methods/options in `scripts/agent-service-client.ts` and
  `scripts/agent-service-exchange.ts`.
- Required additive public-event emission in `scripts/agent-coordinator.ts` and
  `scripts/agent-events.ts`; coordinate any shared event type edits with root.
- New `scripts/test-agent-demo-runtime.ts`,
  `scripts/test-agent-spending-pause.ts`, and integration-only updates to
  `scripts/test-agent-services.ts` / `scripts/test-agent-client-cancellation.ts`.

Do not own model API transport/worker internals, HTTP/auth/projection, browser
files, Fly deployment, package metadata, Move, or Rust. Read the actual current
`runAgentServices`, client, exchange, coordinator, source event and chain code
before refactoring. Preserve all original ordinary tests and old runtime gates.

Exact export from `agent-demo-runtime.ts`:

```ts
export async function openDemoRuntime(options: {
  role: MachineRole;
  stateDir: string;
  conversation: ID;
  create: boolean;
  config: AgentServiceConfig;
  runtime: AgentRuntimeDescriptor;
  network: 'testnet' | 'localnet';
  agents: { buyer: AgentRef; provider: AgentRef };
  // All paths originate in protected operator config, never HTTP bodies.
  walletFile?: string;
  modelApiKeyFile: string;
  searchApiKeyFile?: string;
  providerLocator?: () => Promise<DemoLocator>;
  // Explicit test-only dependency object; never CLI or production config.
  dependencies?: DemoRuntimeTestDependencies;
}): Promise<DemoRuntimeHandle>;
```

Root exports the following exact type-only dependencies from `demo-types.ts`.
These names are a test-construction seam, not another runtime selector. Import
`NativeConfig`, `StreamingChain`, `RawTransport`, `BoundedWebTools`, `AgentWorker`,
`AgentProfile` and `ResponsesLimits` as types from their existing owning modules.
No callback accepts `any`, opaque records, or model/search secret values or
credential paths. The bridge factory receives only explicit test operational-key
and ticket paths selected by the protected runtime composition.

```ts
export type DemoBridgeEvent =
  | { event: 'listening'; endpoint: DemoLocator['endpoint'] }
  | { event: 'connected'; remote_key: number[] }
  | { event: 'frame'; bytes: number[] }
  | { event: 'error'; message: 'transport closed' };
export interface DemoBridge extends RawTransport {
  event(): Promise<DemoBridgeEvent>;
  connected(): Promise<void>;
}
export interface DemoHostClock {
  nowMs(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}
export interface DemoRuntimeTestDependencies {
  workerFactory(options: {
    role: MachineRole;
    descriptor: AgentRuntimeDescriptor;
    stateDir: string;
    create: boolean;
    profile: AgentProfile;
    limits: ResponsesLimits;
  }): Promise<AgentWorker>;
  webToolsFactory(options: {
    stateDir: string;
    create: boolean;
    allowedHosts: string[];
  }): Promise<Pick<BoundedWebTools, 'profile' | 'sources' | 'close'>>;
  chainFactory?(config: NativeConfig): StreamingChain;
  bridgeFactory?(options: {
    mode: 'listen' | 'connect';
    keyFile: string;
    ticketFile: string;
    relay: boolean;
  }): DemoBridge;
  clock?: DemoHostClock;
  pollMs?: number;
}
```

Contract and defaults:

- Injection is accepted only for explicitly selected loopback localnet, validated
  by existing RPC scope checks before constructing a factory. Production
  `agent-demo-server` never accepts/forwards `dependencies`; its strict config,
  CLI and environment parsing have no field enabling it. Test manifests retain
  `test_dependencies_used:true` and the real production path refuses to reopen
  them. Never describe their output as live model evidence.
- Both fixture factories are required in an injected object. The provider calls
  `webToolsFactory` first, wraps its actual returned profile with the same public
  tool instrumentation as production, then calls `workerFactory` with that
  profile. The coordinator calls only `workerFactory` with the exact profile
  supplied by `AgentCoordinator.open`; it never invokes the web factory. No
  factory failure falls through to a real worker, Brave, another runtime or an
  ambient credential lookup. Model/search secret files are not read on this
  explicit test path; pass a nonexistent placeholder for the otherwise-required
  `modelApiKeyFile` when calling `openDemoRuntime` from its test harness.
- `stateDir` is the persistent component path selected by the runtime; `create`
  comes from that component's initialized manifest marker. An injected factory
  must honor reopen checks and persistent worker/source state; it cannot turn a
  missing initialized record into an empty fixture. `BoundedWebTools.open`
  currently has no `create` argument: a fixture wrapper validates the passed
  marker rule before delegating to its existing bounded constructor. An ordinary
  lifecycle fixture can return an explicit no-network profile/source adapter;
  web semantics tests use the real bounded tools with their existing controlled
  search/HTTP inputs. The fixture worker must preserve `uncertain:true` and
  asynchronous shutdown contracts just like the live worker.
- Absent `chainFactory` means exactly `new StreamingChain(config)`, followed by
  the same `validate`, `resolve`, `clock`, opening/channel and transaction paths.
  Its existing constructor accepts `NativeConfig`; no alternate RPC defaults or
  payee are added. Offline tests supply a `StreamingChain` subclass overriding
  the concrete exercised methods and failing unexpected network methods. The
  handle never injects a replacement payment engine, budget ledger, NativePeer,
  signer or key reader; those stay real. The localnet integration can omit this
  override and use actual preconfigured chain state and locally generated keys.
- Absent `bridgeFactory` means `new IrohBridge([mode,'--key-file',keyFile,
  '--ticket',ticketFile,...(relay ? ['--relay'] : [])])`. The host selects these
  fixed arguments; there is no arbitrary executable/argument factory. The real
  bridge structurally satisfies `DemoBridge`; validate its consumed event at
  runtime because existing `event()` decoding is permissive. Endpoint events
  use the pinned serde shape above. Byte/key arrays retain the existing frame
  and 32-byte-key checks. `connected()` sets `remoteKey` before returning;
  `close()` is idempotent and unblocks pending event/receive calls. An injected
  memory bridge must obey the same ordering/closure semantics; native-core
  authentication/signing above it remains unchanged.
- Absent `clock` means `Date.now` and an abortable timer; absent `pollMs` means
  750 ms, matching current buyer polling. Test overrides require an integer
  `pollMs` in 1–5000 and a finite nonnegative safe-integer `nowMs`. Aborted sleeps
  reject promptly, including an already-aborted signal; remove timer/listener
  on settlement. This clock controls only new demo lifecycle timestamps,
  reconnect backoff and pause-wait scheduling. Existing NativePeer signature
  freshness, BudgetLedger/model deadlines and Sui Clock remain their existing
  authorities; no global Date override or claim of virtualizing the protocol.
  Test deadline races through the concrete relevant layer's existing clock or
  real bounded time, not by assuming this supervisor clock rewrites it.
- Real Iroh/localnet tests inject fixture inference/source composition only,
  omit chain and bridge overrides, and retain original operation/economic
  state. Ordinary offline tests explicitly provide both chain and bridge
  overrides to avoid accidental loopback RPC/child-process traffic. Tests assert
  that choosing injected factories never reads ambient model/search secrets.

Production defaults remain exactly one path: `openAgentWorker` through its live
acceptance gate; `BoundedWebTools.open` with `BraveSearchBackend` using only the
configured private credential; `StreamingChain`; and `IrohBridge`. The provider
web wrapper retains its source ledger and exposes only approved citation metadata.

Reuse the adapter exports without copying its model loop:

```ts
openAgentWorker({ descriptor, stateDir, create, profile, apiKeyFile, limits });
agentRuntimeFingerprint(descriptor, profile, limits);
```

The adapter contract and original AS profile define all API token/output/tool
and duration bounds; include them in the fingerprint. Model API token usage/cost
remains a separate diagnostic and is never converted into byte-priced MIST.
Changing tasks or observed budget does not change fixed system/tool fingerprints.

Refactoring obligations:

1. Extract transport/worker/application composition once. The existing CLI calls
   that composition, preserving existing test-harness injection and old local
   behavior where required; the **demo handle** boots without implicit funding.
   Document any additive CLI `--runtime` and protected key-file inputs through
   root; no `--fixture`, `--unsafe`, gate override or automatic backend switch.
2. The local [component initialization contract](AGENT_DEMO_COMPONENTS_SPEC.md)
   defines lazy creation and interrupted-result recovery independently of the
   process-wide create flag. Create/version manifests before side effects; keep
   every initialized-file check. Put worker paths on the explicit protected state root. Keep only local
   private keys on a role machine; both public identity files/config may exist.
   Existing shared-state tests must continue to work without requiring production
   machines to share a filesystem.
3. Implement the durable control journal and task/control mapping. Accept task
   commands promptly; their control record remains running until the real
   coordinator result is terminal or uncertain. Cancel/pause/status must work
   during active model/network awaits. A task duplicate reuses the same prompt,
   worker/request IDs and economic operations. An accepted command with missing
   initialized journal fails closed.
4. Split connect/unpaid validation, explicit funding, request execution and
   explicit close/refund. Persist verified offer/nonce before funding intent.
   Reuse `StreamingChain` methods and their existing signed-transaction journals;
   terminal digest/gas projections contain no saved transaction signatures/keys.
   Poll fresh chain state at a bounded cadence (5 seconds while funded or a
   transaction is pending), with a checked observation timestamp. GET never
   initiates transactions. Unknown RPC state disables new signing/admission.
5. Add a small durable spending gate at the client signing boundary. Preferred
   client option is `withCreditAdmission<T>(requestId, action):Promise<T>`, where
   `action` contains signing-intent persistence and `engine.authorize`, plus
   `waitForSpending(signal):Promise<void>` for blocked new credit. Both consult
   the same durable pause/cancel state. Budget reservations still occur first;
   after any awaited guard, check cancellation and pause again. Lock only the
   signing transition, never an entire research execution/network call. Signals,
   deadline and cancellation wake waiters. Retained signed credit replays add
   no fresh authority and bypass only the *new-signature* wait.
6. Add a safe exchange peer-replacement/reconnect seam. It cannot discard a
   pending operation, overwrite retained envelopes or run two exchange sends at
   once. Close old bridge, settle its failed send/receive await, reauthenticate
   and then recover the saved application command before fresh traffic. Either
   add serialized `replacePeer(peer):Promise<void>` to the existing exchange or
   wrap it in a bounded reconnecting transport owner; choose one, document it,
   and prove same-operation replay. Do not copy the exchange state machine.
7. Recovery resumes only saved work/known model response state. Provider listener
   restarts on ordinary idle timeout using its same endpoint and worker. Bound
   its retries; publish disconnected/recovering/failed honestly. Explicit desired
   offline state survives restart. A reconnect does not cancel or resume spending.
8. Emit the strict additional public records below, plus existing AS events.
   Emit signed authorization as soon as its engine record exists, even if peer
   Ack is uncertain. Right-panel research text comes from verified delivery;
   never publish model buffers directly. Replay missing public events from
   canonical retained evidence with stable publication identities; do not assign
   another public ID to an already published credit/checkpoint/task delta.
   Replace the current `AgentCoordinator.event()` catch-and-ignore behavior
   for the demo's required durable sink: failed persistence blocks admission
   and leaves a recoverable publication intent. Propagate a fixed storage/
   projection error, not raw exception text, and do not recursively call the
   failed sink while trying to report its error. Unit-test a sink failure after
   a real retained delivery and prove restart imports it exactly once.
9. Root first lands the adapter's shared `uncertain?:true` tool-result change
   and `AgentWorker.shutdown?()` contract, then transfers coordinator ownership
   to L1. Preserve `uncertain:true` for unresolved paid callbacks. Await worker
   shutdown in coordinator/provider/runner cleanup before releasing nested and
   role locks. A stalled callback leaves shutdown uncertain; elapsed grace is
   not proof that async state mutation ceased.

Additional event `data` schemas (exact keys, using the shared validators):

| Type | Data |
|---|---|
| `runtime` | `{status:DemoRoleStatus}`; its cursor is the pre-append high water, not a recursive future event |
| `connection` | `{connection:DemoConnection,actor:"operator"|"host"}` |
| `control` | `{control:DemoControlRecord}` |
| `funding` | `{channel:Address|null,opening_nonce:ID,deposit_mist:U64,transaction:DemoTransaction}` |
| `authorization` | `{channel:Address,credit:SignedData<CreditData>,actor:"host"}` |
| `chain_observation` | `{channel:Address,status:"open"|"closed"|"refunded",redeemed_mist:U64,locked_mist:U64,refunded_mist:U64|null,observed_at_ms:U64,terminal:DemoTransaction|null}` |

For existing event variants, replace open-ended copying with a strict schema
matching actual emitters: public text, known tool request/result fields,
TurnReceipt, verified delivery checkpoint/output and BudgetSnapshot. Preserve
the distinction between a provider `tool_result` summary and a coordinator
research-tool result, which may contain bounded delivered text and receipt.
Reject unexpected fields; do not silently drop an extra secret field and claim
that arbitrary journal publication is safe. Root/L2 may supply the neutral
validator helper to avoid duplicate schemas; agree ownership before edits.

## 3. Luna L2 — authenticated host, projection and Fly artifacts

Own only:

- `scripts/agent-demo-server.ts` (production entrypoint and HTTP host).
- `scripts/agent-demo-projection.ts` (sanitization, merge, snapshot reducer/SSE).
- `scripts/agent-demo-auth.ts` and `scripts/agent-demo-provider-client.ts`.
- `scripts/test-agent-demo-http.ts`, `scripts/test-agent-demo-projection.ts`.
- `deploy/agent-demo/Dockerfile`, `.dockerignore`, role Fly TOML templates,
  `deployment.example.json`, and operator README.

No lifecycle/client/model/UI edits. Root owns final real deployment and evidence.
Use the frozen handle and injected explicit test handle for local server tests.
Test injection is a constructor-only test arrangement, not a production flag.

Exact primary exports:

```ts
export class DemoProjection {
  static open(options: {
    stateDir: string; create: boolean; conversation: ID;
    pins: DemoValidationPins;
  }): Promise<DemoProjection>;
  ingest(input: SourcedEvent): Promise<DemoEvent | null>;
  replay(after: U64, limit?: number): DemoEvent[];
  cursor(source: MachineRole): SourceCursor;
  highWater(): U64;
  subscribe(listener: (event: DemoEvent) => void): () => void;
  close(): Promise<void>;
}
export async function openDemoHttp(options: {
  runtime: DemoRuntimeHandle;
  config: AgentServiceConfig;
  projectionStateDir: string;
  createProjection: boolean;
  publicOrigin?: string;           // required coordinator HTTPS origin
  bindHost: string;
  port: number;
  viewerToken?: string;            // coordinator only; never logged
  operatorToken?: string;          // coordinator only
  observerToken: string;           // private role-read token
  providerBaseUrl?: string;        // exact configured Fly private host:port
  staticDir?: string;              // fixed built UI asset root
}): Promise<{ server: import('node:http').Server; close(): Promise<void> }>;
```

Finite body responses have `{version:1,...}` with exact route schema. Failures
are `{version:1,code:string}`. HTTP mappings: malformed/cursor 400; missing/bad
token 401; insufficient role/origin 403; unknown path/ID 404; conflict/not-ready
predicate 409; oversized body 413; rate/client cap 429; readiness/upstream 503.
No original exception text appears in body, stdout, stderr or Fly logs.

`DemoProjection` owns one initialized journal, single writer, schema/version,
original source record equality and per-source-role contiguity checks. Write it
atomically before SSE publication. The reducer is deterministic: signed credit
replaces the latest signed ceiling, verified checkpoint replaces delivered
counters, and trusted coordinator chain observation replaces confirmed balances.
It must not use provider host records to confirm coordinator chain state.
After an independently confirmed terminal chain observation with empty funds,
set active `outstanding_mist` and `reserved_exposure_mist` to zero while retaining
historical signed/reserved maxima, checkpoints and actual paid/refund values.
Until then use `max(signed - delivered, 0)` and `max(reserved - delivered, 0)`;
neither pending close nor RPC failure clears exposure. For example signed 900,
reserved 900 and delivered/paid 850 leaves 50 exposure before close confirmation,
then zero active exposure after confirmed close, with historical authorization
still 900 and actual payment still 850. This corrects the earlier FD-19 draft's
unconditional difference formula; no wire/ABI change is involved.
Its required `pins` are the validated complete `DemoValidationPins`, not merely
a caller-supplied configuration hash. Require conversation equality, persist
canonical pin values with the initialized journal, reject every reopen mismatch
or missing initialized pin state, and validate retained entries under the same
pins before replay. Import the shared pure validator; no injectable arbitrary
validator or mutable runtime handle belongs in the projection constructor.
Bridge stream/history loading without gaps: subscribe to source, capture replay
high water, ingest replay and buffered events under one serialized dedupe queue.
Provider polling resumes from stored source cursors, drains `has_more` with
bounded batches and stops on mismatch. On startup import saved local/provider
records before advertising a complete projection.

Status/snapshot consistency: capture the snapshot and its projection high water
under the projection ingestion queue. If runtime evidence is ahead of the source
projection after recovery, catch up first or report recovering; do not issue a
high water that causes the browser to miss a referenced event. Return the full
bounded channel history; an API restart cannot reset it. Browser text can be
rebuilt from retained events, while the snapshot initializes current accounting.

The queue alone does not fence L1 writers: current engine/budget/coordinator
state can advance before its event append. Use the explicit producer-side
publication protocol below, coordinated after Astra's source inspection on
2026-09-11. This is a required implementation refinement, not measured evidence.

### L1 committed public view and per-transition publication fence

The handle's synchronous `publication()` returns `DemoPublication`. `status()`,
`economy()`, `identities()`, `selectedChannel()` and `availableControls()` return
detached copies from one committed public view at that fence cursor, never live
mutable engine/coordinator state. Selection is the exact committed coordinator
history selection; available controls are its committed host predicates, not
L2's latest-array or wall-clock guess. Provider has no operator controls and
returns `[]` and null for these two coordinator-only view fields.

For each short public-state transition:

1. Mark publication pending synchronously before changing canonical public state.
   Reserve bounded recovery/publication headroom and persist the exact recoverable
   publication intent before the effect it describes.
2. Save the canonical result, construct and validate its exact public records,
   and append them durably with retained source IDs. Preserve the existing
   signed statement bytes and economic operation IDs.
3. Advance the committed public view and its cursor together, clear the retained
   intent, and mark ready. Every getter must describe that same committed cut.
4. Failure remains pending/failed and blocks new-effect admission. Restart
   reconciles the original canonical operation and publishes its exact evidence
   once; it must not reset the journal, allocate replacement economic work, or
   report in-memory success after a durable sink failure.

Do not hold this fence across a whole model turn, web fetch, transport connection
or peer acknowledgement wait. Publish a saved signed authorization/reservation
before awaiting its Ack; publish each verified delivery independently; publish
task/control/connection phases as separate bounded transitions. Previously
committed evidence remains streamable while an external dependency waits. Safety
controls keep their specified durable behavior, rather than all controls being
stranded behind the long-running task's publication flag.

This fence is internal state, not another HTTP endpoint or a model-visible tool.
The two fixed codes `publication_pending` and `publication_failed` are explicit
shared HostCode additions. Lifecycle/HTTP readiness may return them without raw
errors, paths or private state. A pending fence is not proof of cancelled work.

### L2 exact snapshot read protocol

Catch up replay outside the final snapshot section. Inside the serialized
projection ingestion queue, with no await between getter reads:

1. Require the local publication fence to be ready; capture its cursor and all
   cloned committed view fields.
2. Require exact component-by-component equality of that cursor and
   `projection.cursor('coordinator')`; less-than is insufficient. Pending,
   failed or source/projection mismatch triggers bounded catch-up/retry or 503,
   never a fabricated complete snapshot.
3. Capture `projection.highWater()` and provider state materialized from
   accepted provider records at that same projection cut. Never insert a newer
   separately sampled provider status into an older snapshot sequence.
4. Copy/persist the immutable snapshot for that S before exposing it. No provider
   poll, runtime update or awaited socket operation may interleave those reads.

Opening bindings can be preloaded as immutable evidence, but become visible in
the projection only at the corresponding accepted funding cut. Snapshot fields,
including selection and available controls, cannot be omitted from the fence's
coherence argument. This protocol complements, not replaces, source dedupe and
the snapshot-S/history-zero browser protocol in AGENT_DEMO_EVENTS_SPEC.

Required real-boundary tests: pause after canonical checkpoint/budget save but
before event append (no future money at old S, no new task); hold L2 import after
source append (catch-up or 503); hold peer Ack after saved credit (authorization
still observable and safety controls usable); fail source save after an effect
then restart (one retained publication); interleave reconnect/refresh/S+1 (no
mixed snapshot or missed cursor); mutate each saved pin or delete initialized
pins (reject before ingestion/SSE). Do not replace these with a test of an unused
parallel helper or a publication flag around fixture-only state.

SSE implementation must handle partial network writes/backpressure, socket close,
abort, auth expiry and bounded per-client buffers. Start replay + live subscription
atomically under the append queue and never hold that queue waiting for a slow
socket. Use `Content-Type: text/event-stream`, `Cache-Control: no-store`, no body
compression, 15-second comments and the exact FD-17 IDs. Set headers before first
frame only after cursor/auth validation. Return 409 for future cursor rather
than an empty indefinite subscription. A provider link failure becomes stale
observation state; it cannot silently reset provider cursor to zero or fabricate
new events.

Token/config files are read by production bootstrap from exact private paths
with generic fixed failures and required permissions. The observer client pins
the exact internal base URL, denies redirects, enforces response size/time limits
and verifies conversation/source/configuration. It sends only the observer token.
Do not inherit model web-fetch URL rules into this intentional private link;
equally, do not allow model tools to use this private client.

Serve only files in the built asset allowlist/root; reject traversal, symlinks
escaping it, dotfiles and source maps. SPA routing must never convert unknown
`/api` or `/internal` routes into HTML. Set CSP `default-src 'self'`, no inline
scripts, `connect-src 'self'`, `frame-ancestors 'none'`, `base-uri 'none'`, plus
no-sniff and no-referrer. Adapt only styles needed by the compiled Tailwind UI;
do not enable arbitrary script/eval/CDN access. No prompt/token request logging.

Fly files follow FD-22/23 exactly. Provide templates with unmistakable app/org
placeholders; production command refuses placeholders and state mismatch. Build
Node/Rust in stages, ship release `native-bridge`, install only locked runtime
dependencies, and copy UI build assets. Pin image/tool versions actually checked
during implementation and capture them in the deployment report. Do not compile
on the 1-vCPU demo Machines. Provider TOML has no public service; coordinator uses
8080 HTTPS, `auto_stop_machines="off"`, `auto_start_machines=false`. Both mount
only `m2m_state` at `/data`, one Machine and one 1-GiB volume per recorded app.
Use explicit local builds / prebuilt image if supported; avoid unbounded remote
build resources. No release command, automatic secrets-to-repository writes,
destructive cleanup or application-wide scale command without exact targets.

Deployment README must give read-only plan/preflight, deterministic build,
explicit bounded creation, role-specific secret transfer, role initialization,
readiness, start/fund/task/close/refund and stop/reopen steps. Do not include real
secret values, private local wallet paths or convenience shell substitutions
that expose credentials in argv. The helper may consume secret files and pass
bytes to Fly stdin/secret injection without echoing; no browser uploads of keys.
An existing app not listed as newly owned by this deployment is never touched.
Do not execute these deployment steps from this implementation assignment.

## 4. Luna L3 — real Tailwind browser interface

Own only new `ui/agent-demo/` sources, tests, README and its package/lockfile.
Root decides integration commands and root dependencies. Do not edit backend,
adapter, protocol, Fly or root package files.

Use React/TypeScript/Vite and Tailwind's current official Vite plugin, with exact
resolved versions committed to the UI lockfile. Import neutral shared types
type-only. Production module `src/api.ts` implements same-origin authenticated
fetch, finite API calls, fetch-SSE parsing with streamed UTF-8, partial lines,
multiple events, comment heartbeats, abort and the last durable cursor. No
WebSocket/third-party event service is necessary. HTTP failure is surfaced and
never switches transports/backends or loads sample data.

Keep token only in a React/module in-memory session; erase on logout/401 and
abort streams. Use `credentials:'omit'`, no redirects, Authorization header and
JSON control envelopes. Remember an accepted pending command ID in memory and
query it after a transient failure; retry that identical command only. On full
reload reauthenticate and load session/history, rather than automatically
resubmitting the last task. Viewer gets read-only controls; UI role indication
comes from the exact `DemoSessionResponse` envelope around DemoSnapshot.

Implement layout and accounting exactly as FD-18–20. A compact fixed-height
channel strip may expand for exact values/evidence; no rounded animation that
obscures money. Keep task editor, status, source links, both transcripts and
controls usable at 1440×900 and a 390px mobile viewport. Do not auto-scroll a
reader who scrolled back; show a new-activity affordance. Render packet/payment
activity only when an actual corresponding source event appears. Show both the
browser live-event connection and the separate Iroh state.

Projection reducer semantics are shared with backend/test vectors: dedupe by
sequence and source identity, preserve byte-exact delivery with a streaming
decoder per request, accumulate **only verified output bytes**, and replace
cumulative numeric observations. A split UTF-8 code point across deliveries
must not show replacement characters or double billing. Do not duplicate the
same right-panel answer from provider and coordinator event sources. Show
public coordinator answer and research delivered answer as distinct artifacts.
No raw HTML, hidden reasoning panel, guessed sources or synthetic transfer rows.

Tests live under `tests/` with explicit fixture event records and visible fixture
banner when rendering their harness. Production entrypoint cannot import that
harness and has no mode switch. Test body content includes secrets/HTML strings
to prove safe text rendering and absence of arbitrary file/API data exposure.
Prefer meaningful interaction tests and one browser smoke test over snapshots
that merely mirror JSX. Test disconnect/reconnect replay and controls against
a running test HTTP server, clearly labeled fixture inference.

## 5. Root integration and rollout sequence

At most three implementation children run simultaneously. A suggested sequence
is runtime adapter + L1 + L3 after shared contracts freeze; start L2 when a slot
opens. L3 can work independently from typed test fixtures while backend slices
finish. No agent needs real model/search keys, Fly access or wallets for its
offline implementation. Root coordinates signatures/contracts and runs live work
only after implementation handoffs and Astra review.

An additional bounded **L0 provisioning separation** assignment owns only
`scripts/native-setup.ts`, a new import-safe setup helper if needed, and
`scripts/test-agent-demo-setup.ts`. It can run when an implementation slot opens;
it does not overlap L1–L3. Add `--name-wallet <path>` used exclusively for
`NativeNames.createLeaves`, separate from the existing publisher/controller
`--wallet`. Demo invocation requires different wallet addresses, verifies the
expected parent-registration owner before public mutation, and pins both public
addresses in its protected setup manifest. Ordinary legacy/localnet invocation
without that option retains its existing semantics. A public setup report
contains addresses and digests only.

Use the existing Move ABI without changes:

```text
identity::create_domain(network: vector<u8>)
identity::register(domain: &Domain, transport_key: vector<u8>,
                   economic_key: vector<u8>, expires_ms: u64, clock: &Clock)
```

`register` sets controller from transaction sender; therefore publishing and
registering directly with the fresh demo controller is sufficient. The parent
wallet signs only the separate existing SuiNS leaf transaction. Do not invoke
`identity::replace_controller`, transfer the parent registration, retarget an
existing leaf, or reinterpret existing setup controller metadata automatically.
If preexisting Agents belong to a different controller, stop with a concrete
authority mismatch; an optional future rotation is a separately reviewed action.
Preserve exact signed transaction journaling for publication, domain, registration
and names. A crash cannot substitute wallets under an old operation journal.
No parent wallet is part of the per-role Fly key export.

L0 tests use distinct generated test keys and injected transaction/chain/name
ports: exact sender for each ABI call, parent-owner check before any mutation,
same-operation replay, changed signer rejection, legacy one-wallet compatibility,
mainnet rejection and role export excluding parent/private counterpart keys.
It must not read real wallets or run public setup. Root handles actual testnet
funding/provisioning only with the user-authorized inputs and fixed limits.

Root owns:

- Shared `demo-types.ts` and agreed neutral validators/test vectors; root package
  commands, top-level lockfile and integration documentation/status links.
- Final integration corrections after owner handoff; no simultaneous edits to
  agent-owned files. The runtime adapter discriminator remains opt-in and old
  Codex gate remains intact.
- Testnet/controller/name provisioning preflight and the actual bounded Fly
  deployment manifest, if the user-authorized workflow and available credentials
  permit them. Each mutation has a concrete target and verified authority.
- Live acceptance/report, independent Sui evidence, and clean stop with retained
  volumes. The root's preflight report is evidence about observed external state,
  not a claim that later provisioning or demo operations occurred.

Before deployment, root requires the adapter's actual registered-tool callback,
continuation, credential-failure and isolation gates to pass. The OpenAI and
Brave credentials/quotas, testnet native deployment, exact name-controller access,
buyer funding wallet/balance and Fly app creation authority are independent gates.
An authentic named demo cannot substitute display labels for absent leaf records.
Finish build/offline checks while a required access input is pending.

## 6. Acceptance matrix

Record each row as passed, failed or not run with the actual command, date,
runtime/build version and evidence path. No prefilled success report. Offline
fixtures are expressly not live-model/payment evidence. An earlier agent-services
test result is not a replacement for the new hosting/control rows.

| ID | Owner | Required evidence |
|---|---|---|
| F01 | L1 | Opening demo runtime, repeated start, GET/status and process restart invoke zero fund/close callbacks; existing runtime gate still fails before funding; model factory/manifest mismatch rejected |
| F02 | L1 | Separate local role roots with only own private keys; required volume/component loss/corruption/fingerprint mismatch fail closed; duplicate writer rejected; durable worker path survives restart |
| F03 | L1 | Strict/duplicate-key controls; same ID replay and changed command conflict; active task allows immediate cancel/pause; crash at accepted/start/result boundaries launches at most the saved task/request |
| F04 | L1 | Real budget/signer seam race: pause while reserveCredit awaits wins against signature; retained signed credit remains replayable; pause persists restart; resume resets no budget/deadline; cancel wakes a paused waiter; unknown signing intent stays uncertain |
| F05 | L1 | Disconnect closes actual bridge, browser loss does not; reconnect authenticates same Agent and replays saved expired-core/application operations; no new opening/request/credit from reconnection; provider survives idle listener timeout |
| F06 | L1 | Explicit funding survives lost acknowledgement with same nonce/transaction; no auto replacement; natural zero-research model task has zero credits; no-credit close refuses fabricated checkpoint and allows only real eligible expiry refund |
| F07 | L1 | Exactly priced multi-turn channel; close/refund states, pending/failed chain transactions, advance redemption above delivered price, immutable prior spend and gas separate; exposure clears only on independently confirmed terminal state, historical authorization remains, and counters/balance never become zero merely from RPC failure |
| F08 | L2 | Every route auth/method/Host/Origin/role gate; arbitrary paths/URLs/IDs/unknown fields denied; viewer cannot mutate; token absent from logs/URLs/errors; private provider has no work/control route |
| F09 | L2 | Public schema rejects extra private/tool/diagnostic fields; fetched bodies/hidden reasoning/key sentinel absent; no private files/source maps served; untrusted text cannot execute markup |
| F10 | L2 | Both sources emit host:1 without collision; same-content duplicate no-op, changed content/gap/future cursor fail; projection restart/append-crash recovers exact source IDs; provider records cannot confirm balances |
| F11 | L2 | SSE replay/live race has no gap/duplicate; partial writes, 256-KiB backpressure, heartbeat, auth expiry, provider outage and resume; future/foreign cursor rejected; source/projection caps preserve old evidence and stop new work |
| F12 | L3 | Keyboard/responsive UI, exact BigInt price/cumulative replacement, split UTF-8 delivery, duplicate stream events, stale/unknown RPC values, separate browser/Iroh state, pending real control acknowledgements |
| F13 | L3/root | Production build contains no fixture import/path/switch and missing backend shows failure; browser integration test uses explicitly labeled fixture backend and asserts real HTTP controls/replay |
| F14 | root | Existing typecheck/native/agent-service regressions plus new offline tests; locked production UI/container build; image inspection finds no private state, test fixtures or credentials; exact resource/config plan validates |
| F14a | L0/root | Separate demo-controller/name-owner setup, unchanged register ABI, wrong parent owner fails before mutation, signer-bound transaction recovery, and per-role export contains no parent key; public setup execution separately recorded |
| F15 | root, live gate | Runtime adapter acceptance passes with real required host callbacks and resumed context; actual model/effort and tool surface retained; no default-Codex bypass; no fixture model used |
| F16 | root, live gate | Named testnet leaves/controller/key pins independently checked; two new app IDs/Machine IDs/regions/volume IDs/image digest recorded; authenticated UI and private provider reachability; actual Iroh unpaid exchange before any funding |
| F17 | root, live gate | Operator explicitly funds displayed terms, submits an unseen research question, observes both real model turns plus actual search and allowlisted fetch, delivered text and citations, real signed cumulative payments, and independent testnet close/refund evidence |
| F18 | root, live gate | Browser disconnect/reload/replay with no duplicate text/money/control; explicit spending pause prevents new signatures; actual Iroh disconnect/reconnect with same Agent/channel/request identity and honest pending/uncertain state |
| F19 | root, live gate | Restart each recorded Fly Machine using its same volume during separate runs, including active or draining work; exact saved model/transaction recovery or explicit uncertainty, no fresh model launch/funding; no journal replacement |
| F20 | root, live gate | Three genuinely unseen operator prompts across continuing tasks/conversation as limits permit; record observed branches, sources, byte prices and failures; no fixed response/call-count requirement or forced follow-up; explicit channel replacement only after reconciled predecessor |
| F21 | root, live gate | Bounded model/search quota or missing-credential failure remains visible without fixtures; real no-credit channel refund tested when eligible if that path occurs; report gas/API usage separately; stop only recorded Machines and retain recoverable state |

F17 may produce a failure honestly if the LLM does not choose research or a tool
fails; it then does not establish the required successful research observation.
Use additional ordinary unseen questions within the explicit budget if needed;
do not edit tools/prompts to force a predetermined demo narrative or manufacture
research activity. Follow-up and natural completion decisions remain model-owned.
F20 is evidence of multiple live tasks, not proof that every prompt succeeds.

Suggested root package commands (create only after scripts exist):

```sh
npm run typecheck
npm run native-tests
npm run agent-services-tests
npm run agent-demo-tests
npm --prefix ui/agent-demo ci
npm --prefix ui/agent-demo test
npm --prefix ui/agent-demo run build
```

New test suite comprises `test-agent-demo-runtime.ts`,
`test-agent-spending-pause.ts`, `test-agent-demo-http.ts` and
`test-agent-demo-projection.ts`. A separate opt-in root integration command
selects real localnet Iroh/inference fixtures, actual live local adapter/research,
or the explicitly listed live Fly deployment; no automatic mode choice. It must
fail without required credentials, not silently mark the live row skipped/passed.
Ordinary offline tests should not read ambient credentials or call public chains.

Write `docs/FLY_AGENT_DEMO_VALIDATION.md` and a bounded public JSON report only
from observed results. Include model/runtime/version, qualified Agent refs,
configuration fingerprint, Fly IDs/regions/image and volume attachment, actual
Iroh evidence, exact request/checkpoint/transaction references, per-channel
deposit/signed/delivered/redeemed/refund and separately measured gas, replay/kill
outcomes, failed/not-run gates and retained-state instructions. Omit secrets,
private paths, model internal reasoning and raw model/source responses. An
investor-demo URL is reported only once it serves the real backend, with access
credentials distributed separately and never placed in a URL or checked-in doc.

## 7. Copyable implementation instructions

**L1:** Implement only Luna L1 ownership in this document against FD-01–12 and
the shared frozen types, using `responses-tools-v1` through the adapter's public
factory. Preserve old Codex gates/wire/payment contracts. Focus on an embeddable
persistent runtime with explicit start/fund/close, durable controls, race-proof
spending pause and actual Iroh reconnect. Run F01–F07 with explicit injected
fixtures and existing relevant regressions. Do not read real credentials, mutate
public chain/Fly, edit another slice, or spawn agents. Report exact exports,
files, tests, limitations and any interface issue promptly to root.

**L2:** Implement only Luna L2 ownership against FD-13–17/22–23 and shared types.
Create authenticated role HTTP, strict sanitized durable source projection,
replayable SSE, private provider read client and narrow Fly/container artifacts.
Use an injected test runtime, never runtime fallback or shell-driven controls.
Run F08–F11 plus artifact checks. Do not deploy, read real secrets, mutate public
chain, edit lifecycle/UI/adapter modules or spawn agents. Report exact exports,
files, tests, limitations and interface issues to root.

**L3:** Implement only `ui/agent-demo/` with React/TypeScript/Vite/Tailwind and
real same-origin authenticated API code under FD-18–21. Tests can render explicit
fixture events with the required visible label; production never imports a
fixture/fallback. Implement two panels, exact channel accounting, real controls,
source citations and durable SSE replay. Run F12–F13 and report build/tests and
actual UI screenshots if available. Do not edit backend/protocol/root package,
access real credentials/deploy, or spawn agents. Ask root promptly about shared
contract issues.
