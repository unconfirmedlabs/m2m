# Live agent services: implementation contracts and handoff

Date: 2026-09-11. Implements [AGENT_SERVICES_SPEC.md](AGENT_SERVICES_SPEC.md),
requirements AS-01 through AS-31. The user requested Astra `xhigh` specification
and Luna `xhigh` implementation agents. This plan fixes their interfaces and
ownership before they start. It does not report implementation or test results.

Implementation status is recorded separately in
[AGENT_SERVICES_VALIDATION.md](AGENT_SERVICES_VALIDATION.md). Local integration
and deterministic tests exist; live acceptance is incomplete. AS-20 now requires
the production profile/runner to fail before funding until tool isolation is
verified. Do not remove that gate merely to make T18/T19 execute.

## 1. Shared TypeScript contracts — root owns this file

Create `scripts/agent-service-types.ts` first. Preserve existing `WorkRequest`,
`RequestRef`, `WorkerEvent`, `RequestRecord` and `CodexWorker` default behavior.
Use type-only imports to avoid a runtime dependency cycle. The following exported
interfaces are the minimum shared boundary; wire fields match AS-06/07 exactly.
Do not independently rename these exports in an implementation agent.

```ts
import type { RequestRef, CodexWorker } from './codex-worker.js';
import type { AgentRef } from './native-chain.js';
import type { PolicyData } from './streaming-codec.js';

export type Units = [string, string];
export type AgentWorker = Pick<CodexWorker,
  'run' | 'status' | 'reconcile' | 'cancel' | 'close'>;
export interface AgentToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface AgentToolCall {
  request: RequestRef;
  threadId: string;
  turnId: string;
  callId: string;
  name: string;
  arguments: unknown;
  signal: AbortSignal;
}
export interface AgentToolResult { success: boolean; text: string }
export interface AgentProfile {
  id: string;
  baseInstructions: string;
  developerInstructions: string;
  tools: AgentToolSpec[];
  maxToolCalls: number;
  maxToolResultBytes: number;
  // Only these names allow a pending call to reenter the same durable handler.
  // The handler MUST reconcile by callId before any external mutation.
  recoverableTools: string[];
  handleTool(call: AgentToolCall): Promise<AgentToolResult>;
}
export interface ResearchRequestV2 {
  version: 2;
  conversation: string;
  request: string;
  sequence: string;
  prompt: string;
}
export interface Citation {
  id: string;
  url: string;
  title: string;
  retrieved_at_ms: string;
  content_hash: number[];
}
export interface TurnReceipt {
  version: 2;
  conversation: string;
  request: string;
  request_hash: number[];
  sequence: string;
  outcome: 'completed' | 'failed' | 'cancelled';
  reason: string | null;
  checkpoint_hash: number[];
  delivered_units: Units;
  generated_output: string;
  discarded_output: string;
  continuation: 'ready' | 'requires_channel_close';
  citations: Citation[];
}
export interface ResearchStatus {
  request_hash: number[];
  phase: 'credited' | 'launching' | 'running' | 'draining' |
    'cancelling' | 'terminal' | 'uncertain';
  worker_state: 'prepared' | 'launching' | 'running' | 'completed' |
    'failed' | 'cancelled' | 'uncertain' | null;
  checkpoint_hash: number[];
  delivered_units: Units;
  authorized_units: Units;
  generated_output: string;
  available_output: string;
  input_dispatched: boolean;
  cancel_requested: boolean;
}
export interface BudgetLimits {
  max_total_mist: string;
  max_channel_deposit_mist: string;
  max_turn_mist: string;
  max_outstanding_mist: string;
  max_requests: number;
  deadline_ms: string;
  output_tranche_bytes: number;
}
export interface BudgetSnapshot {
  limits: BudgetLimits;
  channel: string | null;
  authorized_mist: string;
  delivered_mist: string;
  redeemed_mist: string;
  settled_prior_mist: string;
  remaining_mist: string;
  outstanding_mist: string;
  requests_remaining: number;
  uncertain: boolean;
}
export interface CreditReservation {
  channel: string;
  request: string;
  ceilings: Units;
  delivered_units: Units;
  request_start_units: Units;
}
export interface ChannelBudgetBinding {
  channel: string;
  opening_nonce: string; // 64 lowercase hex digits
  deposit: string;
  policy: PolicyData;
}
export interface ChannelBudgetObservation {
  channel: string;
  status: 'open' | 'closed' | 'refunded';
  redeemed_mist: string;
  // Evidence has already been checked against trusted Sui state by the caller.
  delivered_units: Units;
  authorized_units: Units;
}
export interface ResearchResult { text: string; receipt: TurnReceipt }
export type ResearchNotDispatchedCode =
  | 'cancelled_before_dispatch' | 'budget_rejected'
  | 'deadline_exceeded' | 'request_limit_exceeded';
// Trusted host-only control result, never reconstructed from a wire error.
export class ResearchNotDispatchedError extends Error {
  constructor(readonly code: ResearchNotDispatchedCode) {
    super(code);
    this.name = 'ResearchNotDispatchedError';
  }
}
export interface ResearchPort {
  // Same requestId + prompt resumes saved work. A changed prompt fails.
  // May throw ResearchNotDispatchedError only under AS-28's durable proof rule.
  execute(input: { requestId: string; prompt: string }): Promise<ResearchResult>;
  // confirmed means interruption acknowledgement, not drained terminal delivery.
  // May throw ResearchNotDispatchedError after a durable no-dispatch tombstone.
  cancel(requestId: string): Promise<{ confirmed: boolean }>;
}
export interface PublicEventInput {
  role: 'coordinator' | 'research' | 'host';
  conversation: string;
  request: string | null;
  type: 'task_started' | 'model_text' | 'tool_started' | 'tool_result' |
    'request_started' | 'delivery' | 'turn_terminal' | 'budget' |
    'channel_final' | 'settlement' | 'error';
  data: Record<string, unknown>;
}
export type EventSink = (event: PublicEventInput) => Promise<void>;
// AgentRef is deliberately not replaced by an alias or unqualified Agent ID.
export type PinnedAgents = { buyer: AgentRef; provider: AgentRef };
```

Modules may export their own internal records, validators and options in addition
to the following exact entrypoints. Do not add a second shared state machine or
copy the generic payment codec/engine. All durable-store implementations must
satisfy AS-17; an application writer lock does not replace the worker's lock.
The existing `strictJson` parser has a 1 MiB input limit: keep wire content under
65,536 bytes, and do not apply that parser to larger application journals without
an explicitly bounded journal parser. A smaller journal limit is valid if new
work is rejected before overflow and existing economic records remain retained.

## 2. Agent A — Codex tools and web adapter

Own only:

- `scripts/codex-worker.ts` (opt-in extension; default path stays compatible).
- `scripts/agent-web.ts`.
- `scripts/test-agent-worker.ts` and `scripts/test-agent-web.ts`.

Implement AS-20–25, plus the worker-specific persistence/limit obligations in
AS-17/19/21. Reuse the existing durable worker launch/content/reconciliation
implementation. Add `agentProfile?: AgentProfile` to `WorkerOptions`; do not
introduce a replacement model adapter or change the old sidecar protocol.
Extend `AppServerRpc` with optional
`onServerRequest?(handler:(method:string,params:Record<string,any>) =>
Promise<Record<string,any>>):()=>void`. Profile-enabled worker open requires
this capability; old injected RPC fixtures need not implement it. Stdio supplies
it and sends the returned result under the original JSON-RPC request ID.

Only opt-in profiles enable experimental tool requests. `dynamicToolCall` may
arrive during the persisted `launching` state before turn/start returns a turn
ID. Accept it only when thread, unique pending request and event turn match;
persist the established turn ID before dispatch. Reject conflicting turn IDs.
Profile fingerprints include `recoverableTools` and numerical limits as well as
instructions, schemas, model and effort. Store profile state separately from or
explicitly versioned alongside legacy worker state; a legacy state cannot be
silently opened as an agent profile.

An interrupted tool call can reenter its handler only when its name is in
`recoverableTools`. Coordinator research/follow_up handlers are recoverable by
stable call ID; budget/stop are durable and idempotent. Web handlers can be
recoverable only if they reconcile their own attempt/result journal and charge
every retried read against the original request's bounds. Otherwise mark the
pending call uncertain. Never assume a generic callback is safe to repeat.

Export from `agent-web.ts`:

```ts
interface SearchResult { url: string; title: string; snippet: string }
interface SearchBackend {
  search(query: string, options: { signal: AbortSignal; maxBytes: number }):
    Promise<SearchResult[]>;
}
class BraveSearchBackend implements SearchBackend {
  constructor(options: { apiKey: string });
  search(query: string, options: { signal: AbortSignal; maxBytes: number }):
    Promise<SearchResult[]>;
}
class BoundedWebTools {
  static open(options: {
    stateDir: string;
    searchBackend: SearchBackend;
    allowedHosts: string[];
    // Optional injected clock/HTTP hooks and stricter limits may be added for tests.
  }): Promise<BoundedWebTools>;
  profile(): AgentProfile; // id m2m-research-web-v2
  sources(ref: RequestRef): Citation[];
  close(): void; // abort active HTTP work, retain journal
}
```

The profile must use the request reference passed by CodexWorker to scope counters
and citation IDs. `profile()` uses fixed provider instructions from AS-25.
Code must reject invalid arguments before invoking SearchBackend or HTTPS.
SearchBackend injection is for deliberate test composition, never automatic live
fallback. No live credentials or raw upstream diagnostics enter test fixtures.

## 3. Agent B — v2 provider conversation binding

Own only:

- `scripts/research-conversation.ts`.
- `scripts/test-research-conversation.ts`.
- `scripts/agent-conversation-examples.ts`.
- `schemas/research-conversation-v2.schema.json`.
- `examples/messages/research-conversation-v2/`.

Implement AS-05–19 and AS-25's terminal citation validation against the supplied
source ledger. Leave `native-research.ts`, `streaming-engine.ts`, all existing
wire examples, and all Move/Rust files untouched. Root owns offer/funded
composition and the deterministic buyer driver.

Exact exports:

```ts
export const RESEARCH_CONVERSATION_FEATURE = 'service.research.conversation.v2';
export const RESEARCH_CONVERSATION_VERSION = 2;
export function researchRequestHash(channel: string, request: ResearchRequestV2): number[];
export class ResearchConversationService {
  static open(options: {
    stateDir: string;
    create: boolean; // true only for explicit new initialization recorded by root
    engine: StreamingEngine;
    worker: AgentWorker;
    conversation: string;
    buyer: AgentRef;
    provider: AgentRef;
    observeChannel: () => Promise<{ channel: ChannelData; now_ms: string }>;
    sources?: (ref: RequestRef) => Citation[];
  }): Promise<ResearchConversationService>;
  command(bytes: number[]): Promise<number[]>;
  cached(bytes: number[]): number[] | undefined;
  finish(): Promise<void>; // bounded wait for currently supervised worker; not wire finish
}
```

`command` is the strict encoded v2 service boundary, returning encoded response.
It accepts credit/start/poll/status/cancel/finish/close from AS-07; root handles
offer/funded. It must serialize mutations while allowing poll/cancel during
background execution. It must not wait for the whole model response inside
`start`. `cached` only returns durable replies/evidence, never creates work or
new payment state; validate replay identity before returning anything.

`observeChannel` returns trusted-root observations, not peer snapshots. Check
channel ID, immutable offer/policy and status/deadline before new work. Permit
saved evidence reads after work expiry/terminal chain state. New close consent
requires the independent close conditions in AS-16. Use `buyer`'s complete
AgentRef, encoded deterministically, in the worker's `agent` reference. The
provider role has a persistent worker state root across channel replacements;
the service state is channel-scoped and pins the stable conversation. Root
enforces predecessor settlement/continuity before opening a replacement.

Provide a complete deterministic fixture conversation covering every command,
every response variant, a two-turn channel, pre-start cancellation, output
exhaustion, explicit discarded excess, close, and expired-core retry linkage.
Schema checking must reject extra/duplicate fields through the actual parser;
JSON Schema alone does not reject duplicate keys. Request hash vectors use an
independent Buffer BCS encoder, not `researchRequestHash` to compute expectations.
Fixture scripts expose `--write` and `--check`; only deliberate generation writes.

## 4. Agent C — coordinator and durable budget policy

Own only:

- `scripts/agent-coordinator.ts`.
- `scripts/test-agent-coordinator.ts`.

Implement AS-26–28 and coordinator-specific persistence/limits in AS-17/19/21.
Use AgentProfile and ResearchPort. Do not implement Iroh, Sui, credit signing,
provider wire commands or the CLI; root supplies those through the port. Tools
receive no mutable recipient/channel/price/model/path choices from the LLM.

Exact exports:

```ts
export class BudgetLedger {
  static open(options: { stateDir: string; create: boolean; limits: BudgetLimits;
    buyer: AgentRef; provider: AgentRef }): Promise<BudgetLedger>;
  reserveFunding(openingNonce: string, deposit: string): Promise<void>;
  bindChannel(binding: ChannelBudgetBinding): Promise<void>;
  beginRequest(requestId: string, startUnits: Units): Promise<void>;
  reserveCredit(input: CreditReservation): Promise<void>;
  observe(input: ChannelBudgetObservation): Promise<void>;
  markUncertain(): Promise<void>;
  completeRequest(requestId: string): Promise<void>;
  reservedUnits(): Units;
  snapshot(): BudgetSnapshot;
}
export class AgentCoordinator {
  static open(options: { stateDir: string; create: boolean; conversation: string;
    buyer: AgentRef; provider: AgentRef; budget: BudgetLedger; port: ResearchPort;
    workerFactory: (profile: AgentProfile) => Promise<AgentWorker>;
    emit?: EventSink }): Promise<AgentCoordinator>;
  run(task: { id: string; prompt: string }): Promise<{
    state: 'completed' | 'failed' | 'cancelled' | 'uncertain'; text: string;
  }>;
  cancel(): Promise<void>;
  status(): { activeTask: string | null; activeRequest: string | null;
    state: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'uncertain' };
  shutdown(): Promise<void>;
}
```

`reserveFunding` is idempotent for identical nonce/deposit and rejects conflicting
pending openings or a prior unclosed channel. `bindChannel` consumes that same
reservation and freezes the policy. `beginRequest` is idempotent for the same ID
and baseline, persists request-count consumption before external work, and never
resets it on replay. `reserveCredit` validates the policy price and every AS-27
bound and records its maximum before returning. `observe` takes only independently
validated caller evidence; open observations can advance delivered/redeemed
counters but never lower a signed/reserved ceiling. Terminal observations replace
the channel liability with confirmed paid value. An uncertain state blocks new
funding/signing until root explicitly reconciles complete retained evidence.
Do not infer a safe budget reset from timeout, model stop or missing records.

`completeRequest` is the local active-request marker, called only after a verified
provider receipt or a trusted `ResearchNotDispatchedError` for that same request.
It is idempotent, clears only that request's active marker, and never returns a
request-count allowance or reduces monetary liability. If the local count was
never reserved, there is no budget request record to complete; treat that case
as a no-op. For a typed no-dispatch error, the coordinator durably marks the tool
call failed/cancelled and nonpending without inventing a research result. Catch
by class identity, not matching error text. All other port exceptions retain the
pending request and uncertainty. A confirmed cancel reply alone never calls
completeRequest. Local cancellation races must also preserve the stop flag.

`reservedUnits()` returns a copy of the cumulative component ceilings, including
unsigned write-ahead reservations. A later request carries forward the maximum
of these ceilings and the engine's signed ceilings. This does not manufacture a
signed credit or permit an observation to erase an unused monetary reservation.

Coordinator profile ID is `m2m-coordinator-v2`; its fixed instruction/schema
fingerprint must survive task changes. Put changing user task/budget observations
in ordinary input/tool results, not mutable profile instructions. Derive each
provider request ID once from a persisted tool-call mapping, e.g. BLAKE2b-256 of
ordered BCS purpose `m2m/coordinator/tool-request/v1`, qualified buyer reference,
conversation ID, user task ID and backend call ID. The same call must invoke the
same idempotent ResearchPort operation after restart. Never create a second
provider request because the tool response was lost.

`research` is legal only before the first research result of the user task;
`follow_up` requires a prior terminal result. The host automatically uses the same
conversation. Natural coordinator completion while an operation is unresolved
must remain uncertain. `stop` persists purchase cessation and prevents further
research tools for that task. It neither signs a channel final nor changes
already authorized liability. A local later task can continue the same thread.

## 5. Root — composition, buyer driver and integration

Root owns `scripts/agent-service-types.ts`, new `scripts/agent-services.ts`,
`scripts/agent-events.ts`, `scripts/test-agent-events.ts`, new
`scripts/agent-service-client.ts` (optional extraction of the driver), new
`scripts/test-agent-services.ts`, package commands, `.gitignore` additions if
needed, existing documentation links/status, and role-specific public event
journals. Root may make integration-only corrections to child files after their
handoff, then report them to the owner. No simultaneous edits to shared modules.

Create shared contracts first, then launch exactly the three agents above. Each
can implement against injected ports while root builds composition. After all
handoffs, integrate typecheck and the acceptance matrix; escalate a necessary
spec/engine change for an explicit design amendment rather than letting an agent
silently reinterpret the existing contract.

The root buyer driver must implement this deterministic sequence:

1. Check operator configuration, explicit live backend/search availability and
   allowed hosts. Pin both Agents and negotiate both features. Retain the free
   echo path. Verify an offer and reserve its deposit before funding. Persist
   opening nonce and transaction journal; reconcile uncertain funding by the
   existing Sui nonce mapping, then bind BudgetLedger to the actual channel.
2. Resume any pending command/credit/checkpoint/receipt before fresh work. Create
   the new request and request-start cumulative units once; call beginRequest.
   Reserve prospective liability before engine.authorize. Persist credit/Ack
   before start. Use request sequence from the service journal, not tool-call
   count. Never overwrite a pending core envelope with another operation.
3. Poll with the last durable checkpoint hash, default interval 750 ms. Verify
   and save checkpoints/output before emitting or handing text to the model.
   Keep input-only checkpoints. A new poll gets a new op ID, whereas a retry of
   a poll retains its old op ID. Stop before exhausting core/application limits.
4. On credit exhaustion, inspect durable buffered-byte metadata; renew only for
   existing bytes and only if BudgetLedger permits. Include old unused ceilings.
   If budget/deadline stops renewals, cancel then drain existing authorization.
   Call finish with explicit unpaid-discard selection when needed. Persist the
   TurnReceipt and its provider SignedEnvelope, validate checkpoint/counters and
   request identity, then call engine.completeRequest. Return only bounded
   verified delivered text and public receipt to the coordinator.
5. Keep the channel open across response/user-task completion. Explicit close
   obtains channel_final, verifies/persists it, and submits/reconciles close_exact.
   Report confirmed onchain paid/refund independently of authorizations. Store
   final evidence, transaction journal and BudgetLedger terminal observation.
   Do not close or refund by fabricated results when work/settlement is uncertain.

Use persistent role directories such as `<state>/agent-services/<conversation>/`
with separate coordinator/provider application records; each role's worker lives
in an operator-owned protected location outside the served workspace. An
initialization manifest records each required component only when its creation
has completed. An absent not-yet-created lazy component is different from a
missing component marked initialized; the latter fails closed. Keep the worker
location and profile mapping through channel replacement. Operator credentials
are file paths/env inputs and must remain outside the repository and output.
If a valid component file exists after a crash but its initialization marker does
not, validate and reuse that file before completing the marker. This is allowed
only because external side effects are prohibited until initialization is marked;
do not overwrite it or reinterpret an initialized component's loss this way.

Root's driver persists pre-record cancellation tombstones, no-dispatch outcomes
and credit-signing intents in one serialized state machine. It can emit the typed
host error only before any signing intent/credit for that request; signing and
credited cancellation failures remain ordinary uncertain failures. Derive the
next channel request sequence from credited history so rejected local attempts
do not create economic sequence gaps. A successful budget reservation made before
a cancellation remains reserved until normal reconciliation; the local rejection
does not release it by itself.

Implement AS-29 controls without blocking stdin on an active `run()`. Persist
sanitized AS-30 events with role/conversation cursor IDs; retain verified provider
envelopes separately from the sanitized event projection. Expose honest status for
missing credentials, quota, cancellation, buffer limits, peer disconnect,
unconfirmed chain operations and uncertain backend execution. No HTTP/UI/Fly work.

## 6. Acceptance matrix and commands

Every row is required unless explicitly labeled conditional. A fixture success
does not satisfy a live row. Record commands, observed results and limitations
after execution; do not prefill a validation report with success.

| ID | Owner | Requirements | Acceptance evidence |
|---|---|---|---|
| T01 | A | AS-03/20 | Existing worker tests unchanged and passing; default profile still denies dynamic tools; exact model/effort remain pinned |
| T02 | A | AS-20/21 | Correct dynamic registration/response, early launching event, wrong thread/turn/namespace/name rejection, reroute/policy failure, profile mismatch on resume |
| T03 | A | AS-17/21 | Duplicate tool call returns stored reply; changed arguments fail; crash after intent never blindly repeats nonrecoverable callback; recoverable call retains ID; no limit reset |
| T04 | A | AS-22/23 | Host call/byte/deadline limits enforced before/while fetch; malformed input invokes no backend; Brave URL/header/result parser; no-key failure; raw errors/secrets absent |
| T05 | A | AS-24/25 | Private/mapped/reserved IPs, mixed DNS answers, redirect escape, credentials, protocols, compressed/oversize/nontext responses denied; TLS host preserved with pinned lookup; sources survive restart |
| T06 | B | AS-05–09 | Strict command/schema fixtures, extra/duplicate keys, canonical counters/IDs, independent v2 request hash bytes, changed version/prompt/model-domain rejection, unsupported feature |
| T07 | B | AS-10–14 | Two sequential requests on one channel, upfront input-only checkpoints, byte-exact replay, cumulative input/output and credit/request sequences, nonfinal turn receipts, final only on explicit close |
| T08 | B | AS-12/13 | Hash cursor replays same-output input checkpoint; invalid/future cursor fails; renewal requires saved buffered bytes; credit accepted then cancel/crash still drains its checkpoint |
| T09 | B | AS-14–16 | Empty response, zero-use pre-start cancellation requires close, terminal-but-draining state, uncredited excess explicit discard, no charge for discarded bytes, no follow-up before receipt reconciliation |
| T10 | B | AS-15/17/18 | Duplicate starts execute once; missing worker after dispatch intent stays uncertain; interruption intent survives restart; missing/corrupt journal fails; same conversation mapping with new request |
| T11 | C | AS-26 | Deterministic mock model chooses different branches from tool results; research/follow_up ordering; malicious peer text cannot change pinned recipient, policy or tools; task replay uses saved request IDs |
| T12 | C | AS-27/28 | Every monetary/time/count bound rejects before external effect; exact rounding; old unused ceilings included; reservations persist before signer/funder callback; cumulative credit amounts never summed |
| T13 | C | AS-17/27 | Restart with uncertain reservation cannot free funds; prior confirmed paid value counts against next channel; missing/corrupt budget record fails; conflicting task/tool replay fails |
| T13a | C/root | AS-17/28 | Before-credit guard rejection/cancel returns only trusted typed local error; cancellation before client record persists through restart; no signing after cancellation wins; no fabricated receipt; consumed count and money reservations unchanged; next credited request has no sequence gap; credited exceptions/confirmed interruption remain pending |
| T14 | root | AS-05/09/17 | Real Iroh two-process exchange, unpaid message before funding, feature mismatch, expired core envelope retried with fresh core ID/stable op ID, saved proof envelope retained |
| T15 | root | AS-10–18/28 | Localnet two-request channel with nonfinal first receipt and explicit final close; compare independently queried channel balance/paid/refund; restart each side during credit, delivery and completion |
| T16 | root | AS-18/27 | Explicit replacement after terminal channel preserves qualified conversation/worker mapping; new nonce/request and reset channel counters; uncertain prior work blocks replacement |
| T17 | root | AS-29/30 | Active task accepts status/cancel controls, restart event IDs remain stable, no hidden reasoning/secrets, no auto-close at turn/task completion, honest bounded shutdown |
| T18 | root, conditional live | AS-20/21/31 | Verified registered-only tool exposure/dispatch, actual bounded host budget/status callback and resumed thread. Label this an adapter probe, not full live research; current gate is not passed |
| T19 | root, conditional live | AS-01/22–25/31 | With explicit model and Brave credentials: both real LLMs, actual search/fetch/citation ledger, chosen follow-up and continuing thread. Record observed branching; no fixture fallback |

Commands after implementation:

```sh
npm run typecheck
npx tsx scripts/test-codex-worker.ts
npx tsx scripts/test-native-research.ts
npx tsx scripts/test-streaming-engine.ts
npx tsx scripts/test-agent-worker.ts
npx tsx scripts/test-agent-web.ts
npx tsx scripts/test-research-conversation.ts
npx tsx scripts/agent-conversation-examples.ts --check
npx tsx scripts/test-agent-coordinator.ts
npx tsx scripts/test-agent-services.ts
```

Root adds a package `agent-services-tests` command covering the new deterministic
suite. The integration script exposes explicit `--localnet`, `--live-adapter` and
`--live-research` modes; ordinary invocation uses clearly labeled test doubles.
`--localnet` reads preconfigured loopback localnet state; it may use the existing
authorized local test setup. Live modes require operator credential inputs and
never switch modes automatically. If unavailable, report the missing live row as
not run while finishing every independent deterministic/local test.

For reproducible CLI commands, root provides `--help` showing provider/coordinator
roles, state/conversation, existing chain config, wallet file, task/budget file,
fetch-host allowlist and live credential environment names. No private paths,
keys or public testnet writes appear in checked-in example values.

## 7. Copyable implementation-agent prompts

**Agent A prompt:** Implement Agent A ownership in
`docs/AGENT_SERVICES_IMPLEMENTATION.md` exactly, using the approved
`docs/AGENT_SERVICES_SPEC.md` requirements and root-owned shared interfaces.
You are Luna at `xhigh`. Read AGENTS.md and the existing Codex worker/tests; use
the OpenAI Docs skill for the Codex API work. Preserve the installed 0.154.0
adapter, Luna model/effort and default tool-disabled worker behavior. Add only
the explicit agentProfile path, bounded dynamic tools and Brave/search/HTTPS
adapter. Work only in A-owned files. Use injected tests, no external credential
reads or live API calls. Run T01–T05 and report exact results, exports, remaining
issues and every touched file. Ask root immediately before changing a shared
interface or protocol; do not spawn further agents.

**Agent B prompt:** Implement Agent B ownership in
`docs/AGENT_SERVICES_IMPLEMENTATION.md` exactly, using the approved
`docs/AGENT_SERVICES_SPEC.md` requirements and root-owned shared interfaces.
You are Luna at `xhigh`. Read AGENTS.md, native core/research/streaming specs and
the actual StreamingEngine before coding. Leave v1 research and payment engine,
Move, Rust and signed bytes untouched. Build the strict v2 provider state machine,
cumulative input/output, terminal receipt vs explicit final close, cursor replay,
draining/cancellation and write-ahead recovery, plus schemas/examples. Work only
in B-owned files. Run T06–T10 with deterministic worker injection and independent
request-hash vectors. Report exact results/exports/touched files. Ask root before
changing a shared interface or engine contract; do not spawn further agents.

**Agent C prompt:** Implement Agent C ownership in
`docs/AGENT_SERVICES_IMPLEMENTATION.md` exactly, using the approved
`docs/AGENT_SERVICES_SPEC.md` requirements and root-owned shared interfaces.
You are Luna at `xhigh`. Read AGENTS.md and the relevant current native economic
and live-demo documents. Implement the real coordinator profile/tools and
durable BudgetLedger behind injected ResearchPort/workerFactory. The model has
no keys, raw credit, mutable recipient or arbitrary tool access. Preserve unused
old-request authorization in every budget/exposure bound; reserve before every
potential signature/funding; never release unknown liability on timeout. Work
only in C-owned files. Run T11–T13 with deterministic model/port fixtures, and
report results/exports/touched files. Ask root before changing shared interfaces
or adding overlapping transport work; do not spawn further agents.
