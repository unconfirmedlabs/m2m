# Responses runtime interfaces, ownership and acceptance

Date: 2026-09-11. Implements [AR-01–15](AGENT_RUNTIME_SPEC.md) for the separately
selected `responses-tools-v1` runtime. This handoff describes work to do, not
successful tests. The sequence requested by the user is Astra `xhigh` specification,
Luna `xhigh` implementation, Astra `xhigh` review. No implementation agent may
change the model, weaken a gate or broaden its file ownership implicitly.

## 1. Fixed interface

The existing `AgentWorker` structural method signatures stay usable. Avoid a
large rewrite of service/payment consumers or a second economic state machine.
Create the following exports in `scripts/agent-runtime.ts`:

```ts
import type { AgentProfile, AgentWorker } from './agent-service-types.js';

export interface AgentRuntimeDescriptor {
  version: 1;
  kind: 'responses-tools-v1';
  model: 'gpt-5.6-luna';
  reasoning: 'xhigh';
}
export interface ResponsesLimits {
  maxDurationMs: number;
  maxOutputBytes: number;
  maxPromptBytes: number;
  maxOutputTokensPerResponse: number;
  maxReservedOutputTokens: number;
  maxResponses: number;
  maxToolResultTotalBytes: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxReceivedBytes: number;
  maxEvents: number;
  maxRecoveryAttempts: number;
  requestTimeoutMs: number;
  streamIdleTimeoutMs: number;
  cancelGraceMs: number;
}
export function responsesLimits(role: 'coordinator' | 'provider',
  lowerOrExplicitLimits?: Partial<ResponsesLimits>): ResponsesLimits;
export function agentRuntimeFingerprint(descriptor: AgentRuntimeDescriptor,
  profile: AgentProfile, limits: ResponsesLimits): string;
export function openAgentWorker(options: {
  descriptor: AgentRuntimeDescriptor;
  stateDir: string;
  create: boolean;
  profile: AgentProfile;
  apiKeyFile?: string;
  apiKey?: string;
  limits: ResponsesLimits;
}): Promise<AgentWorker>;
```

`responsesLimits` fills AR-13 defaults and rejects invalid/over-ceiling values.
`agentRuntimeFingerprint` is SHA-256 of UTF-8 canonical JSON: recursively sort
object keys, preserve array order, reject undefined/nonfinite/non-JSON values.
Include descriptor, fixed origin/configuration, profile ID/instructions/tools,
recoverableTools, profile call/result limits and resolved numerical limits.
The function body `handleTool` is not serializable; its policy is versioned by
profile ID and this runtime contract. Never include credentials.

`openAgentWorker` is the production gate/factory, not a fixture selector. It has
no arbitrary transport, API base URL, executable, Codex auth file or bypass flag.
Read the selected OpenAI secret file privately only after configuration validation.
If not accepted under AR-15, fail before opening any model connection; a precise
missing-credential failure may be reported before this gate. The candidate
`ResponsesWorker.open` below is available to isolated acceptance code; the live
CLI/control host must always go through `openAgentWorker`.

Create `scripts/responses-worker.ts` with these public methods:

```ts
import type {
  WorkRequest, RequestRef, RequestRecord, EventConsumer,
} from './codex-worker.js';
import type { AgentProfile } from './agent-service-types.js';
import type { AgentRuntimeDescriptor, ResponsesLimits } from './agent-runtime.js';
import type { ResponsesTransport } from './responses-transport.js';

export interface ResponsesDiagnostics {
  runtime: 'responses-tools-v1';
  responseCount: number;
  toolCallCount: number;
  reservedOutputTokens: number;
  usage: Array<{
    responseId: string;
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    reasoningOutputTokens: number | null;
  }>;
}
export class ResponsesWorker {
  static open(options: {
    stateDir: string;
    create: boolean;
    descriptor: AgentRuntimeDescriptor;
    profile: AgentProfile;
    limits: ResponsesLimits;
    transport: ResponsesTransport;
    now?: () => number; // deterministic tests only
  }): Promise<ResponsesWorker>;
  run(request: WorkRequest, consume?: EventConsumer,
    afterEvent?: number): Promise<RequestRecord>;
  status(ref: RequestRef): RequestRecord | undefined;
  reconcile(ref: RequestRef): Promise<RequestRecord | undefined>;
  cancel(ref: RequestRef, reason?: string): Promise<RequestRecord | undefined>;
  diagnostics(ref: RequestRef): ResponsesDiagnostics | undefined;
  close(): void;
  shutdown(): Promise<void>;
}
```

The imports from `codex-worker.ts` are type-only. Do not launch or inherit Codex
configuration. Compatibility projection uses these exact meanings:

| Existing field | Responses projection |
|---|---|
| `threadId` | Private stable `responses-conversation:<random UUID>` created once for the qualified conversation; not an OpenAI or Codex thread |
| `turnId` | First durably acknowledged API response ID for this m2m request; absent for uncertain unacknowledged launch |
| `knownTurnIds` | Acknowledged API response IDs for this request, ordered by local step |
| `clientUserMessageId` | First creation's saved client request UUID |
| `commitment`, `submittedInputHash` | Existing field shape with an explicitly versioned local request commitment; never reused Codex journal bytes |
| `items` / `content.itemId` | Qualified response/item/content-index identity mapped to exact assistant text |
| `state`, `events`, `producedUtf8Bytes` | Existing state/event contracts with AR-07–14 semantics |
| `baselineUsage`, `upstreamUsage` | `null`; API diagnostics are separate |
| `usageObserved` | `false`; no fabricated Codex `usage` event |
| `AgentToolCall.threadId`, `turnId`, `callId` | Local runtime conversation ID, actual generating response ID, AR-09 scoped call hash |

Copies returned by `status`/`run` cannot mutate canonical state. The canonical
journal is `responses-worker.json` with `version:1`, runtime descriptor,
fingerprint, explicit conversation/request/response/call records, original
deadlines, output event indices/cursors and all allowance counters. Reject
`worker.json`, legacy format, missing initialized state and mixed-runtime state.
Caller manifest must check the correct runtime journal filename, not assume the
old filename. Store enough private data to reconstruct each intended API body
exactly, including saved tool-result text; state is bounded before new effects.

Create `scripts/responses-transport.ts`:

```ts
// Types are locally validated projections of the checked Responses API; unknown
// JSON is never cast to trusted data without validation by the worker.
export type ResponsesEvent = Record<string, unknown>;
export type ResponsesSnapshot = Record<string, unknown>;
export type ResponsesCreateBody = Record<string, unknown>;
export interface ResponsesHttpOptions {
  signal: AbortSignal;
  // Charge every received byte tranche before accepting/parsing it, including
  // bytes that never become a complete event. May fsync through the worker.
  chargeReceivedBytes(count: number): void | Promise<void>;
}
export interface ResponsesTransport {
  create(body: ResponsesCreateBody, options: ResponsesHttpOptions & {
    clientRequestId: string;
  }): Promise<AsyncIterable<ResponsesEvent>>;
  retrieve(responseId: string, options: ResponsesHttpOptions): Promise<ResponsesSnapshot>;
  resume(responseId: string, startingAfter: number,
    options: ResponsesHttpOptions): Promise<AsyncIterable<ResponsesEvent>>;
  cancel(responseId: string, options: ResponsesHttpOptions): Promise<ResponsesSnapshot>;
  close(): void;
}
export class OpenAIResponsesTransport implements ResponsesTransport {
  constructor(options: {
    apiKey: string;
    maxRequestBytes: number;
    maxResponseBytes: number;
    requestTimeoutMs: number;
    streamIdleTimeoutMs: number;
  });
  // Same methods as ResponsesTransport.
}
```

The transport must not retry creation automatically. Use a small direct HTTPS
implementation or configure any chosen official SDK with automatic retries
disabled and verify equivalent raw-body/framing bounds. Direct HTTPS avoids
SDK version/middleware assumptions for this slice. Resettable idle timeout is
separate from the worker's absolute original deadline. Errors expose fixed codes
and only typed definite-rejection versus uncertain-dispatch categories, never raw
body/headers. Account for non-event, malformed, comment and partial-frame bytes.
The worker supplies each operation's request-scoped durable accounting callback;
opening the worker/transport alone performs no paid API creation. Control
reconciliation after a generation-byte cap is exhausted uses separately reserved,
bounded terminal-record/HTTP headroom, never another generation allowance.

## 2. Narrow shared amendment owned by root

Root extends `AgentToolResult` in `scripts/agent-service-types.ts` to
`{success:boolean;text:string;uncertain?:true}`. Update only the unresolved
ResearchPort/cancellation result branches of `AgentCoordinator.handleTool` to
return `uncertain:true` while retaining their pending operation. An actual
terminal failure or trusted no-dispatch result omits it. Add regression evidence
that an unresolved result causes zero next API creates, retains its original
request/call identity and can reenter its durable handler on explicit reconcile.

Add optional `shutdown?():Promise<void>` to the shared `AgentWorker` type; this
method is required on `ResponsesWorker`. Keep the old `close():void` signature.
Update `AgentCoordinator.shutdown`, provider backend cleanup and owning runner
cleanup to await `shutdown` when present before releasing enclosing locks. A
new-runtime cleanup wrapper must not erase the promise behind a `close():void`
wrapper. Compatibility close starts shutdown/abort; only awaited, quiescent
shutdown may release the worker lock. If grace expires with unfinished local
transitions, report uncertainty and retain their lock. Add a stalled-handler and
delayed-save regression that attempts reopen and proves no second writer is
admitted, then verifies safe release after quiescence or process termination.
If worker shutdown rejects while a handler can still mutate the coordinator,
retain the enclosing coordinator and Agent locks as well; a `finally` block
must not release them. The lifecycle owner reports failed admission/shutdown
and relies on quiescence or process termination before replacement.

Do not add a general "ignore errors" flag, derive this marker from a remote error
string, or treat a bare cancellation acknowledgement as drained terminal delivery.
The existing coordinator's final pending-call check remains mandatory. Pending
calls after cancellation can honestly remain uncertain; automatic handler reentry
must not turn cancellation recovery into permission for new work.

## 3. Owned implementation slices

| Owner | Files | Deliverable |
|---|---|---|
| Luna runtime implementer | New `scripts/agent-runtime.ts`, `scripts/responses-transport.ts`, `scripts/responses-worker.ts`, `scripts/test-responses-worker.ts`, `scripts/test-responses-transport.ts` | Exact contract, private journal, bounded HTTP/SSE, tool loop, fault tests and isolated opt-in live probe |
| Root / designated integration implementer | `scripts/agent-service-types.ts`, integration changes in `scripts/agent-coordinator.ts` and its tests, runtime wiring/manifest in `scripts/agent-services.ts`, integration tests/package commands and existing documentation status | Add uncertainty marker, new factory selection, runtime-pinned persistent manifest, credential paths and pre-funding gate; old runtime remains gated |
| Astra reviewer | Read-only review first; implementation corrections returned to owning implementer | Check AR invariants, injected and live evidence, public/private boundary, real gate behavior |

The runtime implementer owns no existing file and makes no API/Brave billable
probe without root's explicit task instruction. Root can prepare integration
against these interfaces while Luna implements the worker. If the concurrent
Fly/demo lifecycle pass edits `agent-services.ts`, that lifecycle owner must
perform all shared-file changes; the runtime agent supplies only its new factory
exports. Avoid concurrent edits or two different runner manifest migrations.

Runner selection is explicit `--runtime responses-tools-v1` or an equivalent
operator-only immutable configuration field. No runtime selector is accepted
from an LLM tool or unauthenticated network input. A new manifest version records
`runtime`, `runtime_fingerprint` and persistent `worker_location`; retained legacy
manifests stay legacy and cannot be upgraded by adding default fields on read.
Provider construction reuses `BoundedWebTools` and the existing citation ledger;
coordinator construction reuses its current profile, budget and ResearchPort.

An independently assigned Luna repair may touch only `scripts/agent-web.ts` and
`scripts/test-agent-web.ts` to fix the existing Node HTTPS pinned-lookup callback:
the profile is IPv4-only, so explicit `family:4` and `autoSelectFamily:false`
preserve its contract; alternatively handle Node's `all:true` lookup callback
shape correctly. Preserve pinned DNS, hostname TLS validation and every AS-24
rejection. The [Node 22 connection documentation](https://nodejs.org/download/release/latest-jod/docs/api/net.html#socketconnectoptions-connectlistener)
documents `autoSelectFamily` passing `all:true` to lookup; checked against
22.23.2 on 2026-09-11. Exercise the actual `node:https` request/lookup boundary in regression
tests, not just an injected complete `httpGet` result. This is a correction within
the existing network contract, not a tool/profile expansion. Root observed Fly
and Iroh HTML pages larger than the current 128 KiB web-response limit; retain
that limit and document those source-coverage failures. A larger web policy
would need its own explicit bounded configuration/fingerprint amendment.

Support `M2M_OPENAI_API_KEY_FILE` and `M2M_BRAVE_API_KEY_FILE` for the deployment
host; explicit direct-key inputs may be retained for process-local operation.
Resolve credentials outside model inputs, reject conflicting sources and never
persist their contents or expose file paths in public UI. Explicit runtime
preflight/gate checks precede funding/signing. API authentication failure after
funding does not authorize a new deposit or spending reset.

## 4. Acceptance matrix

Each deterministic row needs assertions about an invariant, not only a mocked
success transcript. Fixture-only passes are labeled fixture evidence. The
ordinary tests must not access live credentials or make external requests.

| ID | Requirement | Required evidence |
|---|---|---|
| R01 | AR-02/03 | Existing Codex/native/agent-services tests pass; old live gate still fails; explicit runtime/profile/limit mismatch and mixed/legacy journal rejection |
| R02 | AR-04/05/06 | Exact outgoing function-only body on every step; fixed Luna/xhigh/origin; no redirects/proxy or default tools; strict host schema, duplicate/extra key, malformed Unicode and unknown name rejection before handler |
| R03 | AR-07/09 | Text/function/result/text loop executes one real injected handler; response-completed-with-call does not terminalize worker; complete args only; scoped call identity, raw upstream call ID retained |
| R04 | AR-08/14 | SSE split UTF-8/CRLF/multiline data, duplicates and contradictory duplicates, malformed frames, sequence recovery, status snapshots with exact prefixes; event replay never duplicates output |
| R05 | AR-07/08 | Crash before POST and after remote create before ID persistence both remain uncertain with zero repeat creates; acknowledged-ID restart retrieves/resumes original response |
| R06 | AR-09/10 | Crash after call intent vs after result persistence; nonrecoverable pending effects never repeat; recoverable handler gets same ID; changed call fails; saved result is reused exactly |
| R07 | AR-10 | `uncertain:true` and thrown handler prevent next POST/terminal success; ordinary terminal failed result may continue; missing paid-operation proof retains coordinator pending state |
| R08 | AR-11 | Two tasks and explicit channel-replacement integration retain runtime conversation and correct predecessor; restart before next task; no-ID/expired/inaccessible context cannot start empty |
| R09 | AR-12 | Cancel before create, after create intent, during SSE, during handler and before continuation; no late external effect; known cancel completion survives reopen; missing ID/unresolved handler stays uncertain |
| R10 | AR-13 | Every HTTP/body/frame/event/text/token/call/deadline/state limit; response count and token cap reserved before I/O; header/idle/absolute deadlines; restart does not refill; telemetry absent/duplicate/invalid handling |
| R11 | AR-12/13/14 | Private permissions/lock/create/reopen, corrupt/missing/mismatched journal, parser/writer byte/depth/count agreement, save failure poisoning and sufficient terminal headroom; slow consumer still permits cancellation and bounded collection; shutdown never releases a lock while delayed local mutations can complete |
| R12 | AR-04/14 | Secret-file validation and no-credential failure before mocked funding/signing; sentinel secret/hidden reasoning/raw errors absent from projected events; no fake Codex usage source |
| R13 | AR-02 | Real Iroh/localnet v2 exchange using injected inference: multiple requests, exact paid/refund balances, lost delivery/restart, signed replay, no final-answer acceptance, original economic regression suite |
| R14 | AR-06/11/15, live adapter | Standalone actual Luna/xhigh: at least one host callback whose fresh secret-free result affects output, new task after process restart retaining predecessor, exact old-request replay with no POST; request/config evidence and controlled prohibited-tool sentinel attempts |
| R15 | AR-01/02/15, live research | Both actual LLMs over real Iroh with real Sui funding/settlement; actual Brave search, allowed HTTPS fetch and citation ledger; task/follow-up/new-task continuity with real decisions; independently checked payment evidence; no fixture fallback |

R14 must exercise the production HTTP implementation, not a fake Responses
transport. Use a fresh protected probe directory and a bounded host budget/status
tool with unpredictable nonsecret data; verify an observed callback and response
dependence. Reopen in a separate process, replay the original request, then run a
follow-up requiring retained context. Record actual model/effort, request/tool
counts, byte/token summaries and timing without credentials or private outputs.
Controlled prompts request filesystem writes, process execution and network work
outside registered tools; inspect the actual submitted schema/configuration and
sentinel state plus rejected dispatch evidence. A model refusal alone does not
establish the isolation property. No wallet/economic/transport keys or payment
objects are passed into this probe.

R15 follows reviewed R14 and production enablement. Use unseen research prompts
and repeated real runs; record actual choices rather than enforce a fixed number
of follow-ups. A distinct explicit operator follow-up proves continuing context
even when the model reasonably chooses to stop early in another task. Retain
real two-process restart and cancellation evidence without relabeling injected
inference as live. The separately specified Fly/Tailwind/testnet acceptance gates
remain outstanding until actually exercised.

Suggested commands after implementation:

```sh
npm run typecheck
npx tsx scripts/test-responses-transport.ts
npx tsx scripts/test-responses-worker.ts
npm run native-tests
npm run agent-services-tests
npx tsx scripts/test-responses-worker.ts --live
npx tsx scripts/test-responses-worker.ts --live-continue
```

The last two commands are explicit opt-in billable probes requiring
`M2M_OPENAI_API_KEY_FILE` and the same protected
`M2M_RESPONSES_PROBE_STATE_DIR`; they never fall back to a fixture. Root adds
the exact new-runtime live-research command to integration help when implemented.
Do not report a missing credential as a passing/automatically skipped live test.

## 5. Handoff and review procedure

Luna reads AGENTS.md, both runtime docs, the current worker/types and relevant
agent-service callers before coding, and uses the OpenAI Docs skill for API work.
It implements its new files against injected transports, runs R02–R11 portions
it owns, and reports exact changes/tests and unresolved interface issues to root.
No further delegation is required. Root implements shared amendments/wiring and
runs the complete deterministic/local matrix. Astra reviews the actual code and
fault tests before the isolated real probe, then reviews R14 evidence before
enabling the new production runtime. Findings go back to Luna for fixes followed
by targeted verification and review.

Root records validation status separately, with check date, code revision or
working-tree provenance, commands, actual observations and limitations. At this
specification handoff no OpenAI API or Brave credential has been identified, so
R14/R15 are pending. The retained Codex OAuth file is not an API-key substitute.
Finish all independent implementation and deterministic checks while those live
prerequisites are resolved; never claim investor-demo completion from these docs.
