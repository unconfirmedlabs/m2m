# Bounded Responses agent runtime

Status: implementation contract for an explicitly authorized adapter evaluation,
2026-09-11. Specification: Astra `xhigh`; implementation: Luna `xhigh`; review:
Astra `xhigh`. Requirements are acceptance criteria, not measured live results.
See [implementation ownership and gates](AGENT_RUNTIME_IMPLEMENTATION.md).

## 1. Decision and compatibility

**AR-01.** Evaluate a small direct OpenAI Responses API adapter, named
`responses-tools-v1`, for the coordinator and research service. The concrete
failure is documented in [agent-services validation](AGENT_SERVICES_VALIDATION.md):
the tested Codex 0.154.0 configurations either did not invoke registered callbacks
or exposed an unwanted built-in tool. A direct function-calling loop puts local
dispatch entirely in the application. This is an adapter decision above m2m,
not evidence that every Codex configuration is unsuitable.

The new runtime retains `gpt-5.6-luna` and `xhigh` for both roles. The official
[Luna model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
checked 2026-09-11, documents Responses, function calling, streaming and this
reasoning setting. Account access and background-mode compatibility still need
the live acceptance probe; there is no model, effort or backend fallback.

**AR-02.** For an explicitly selected new runtime, this document replaces only
the Codex-specific execution and thread mapping in AS-01/17/18/20/21 of
[AGENT_SERVICES_SPEC.md](AGENT_SERVICES_SPEC.md). All other service requirements
remain applicable. Preserve Iroh, Sui, separate economic/transport keys, native
wire versions and signing bytes, the streaming engine and Move interfaces,
bounded prepayment, budget reservation, cancellation tombstones, exact delivery
replay, nonfinal turn receipts and explicit economic close. General unpaid
messages remain valid. No model decides whether a delivered answer earns payment.

The original `CodexWorker`, knowledge-only worker and AS-20 live-profile gate
remain unchanged. Selecting `responses-tools-v1` never removes a Codex gate.
Neither adapter may read the other's journal. No NanoCodex, private ChatGPT
backend, Codex OAuth conversion, new model, model process shell or fixture fallback
is part of this decision.

**AR-03.** A role manifest explicitly pins runtime kind/version, fixed model and
effort, profile fingerprint and worker location. The worker fingerprint also
binds exact instructions, tool descriptions/schemas/order, recoverable tool names,
all numerical limits, API origin and request configuration. Credential contents
and secret-file paths are excluded. A changed runtime/profile/limit on reopen
fails `runtime_profile_mismatch`; changing limits never refills old allowances.

Initial migration requires a fresh application conversation ID and fresh worker
state. An existing Codex conversation cannot be relabeled as Responses, even if
its latest task completed. Preserve the old manifest, budget, execution and
economic journals; settle/reconcile outstanding obligations under their original
contracts. Reusing already provisioned Agent identities is allowed once exclusive
writer and prior-obligation checks pass. New runtime conversations do continue
through their own process restarts and explicitly authorized channel replacement.
Transcript import or in-place cross-runtime migration needs a separate contract.

## 2. API and host boundary

**AR-04.** The production inference client connects only to
`https://api.openai.com:443`, with normal certificate/hostname validation and no
redirects, proxy inheritance or configurable alternate origin. Only these routes
are implemented: `POST /v1/responses`, `GET /v1/responses/{id}` (JSON or resumed
SSE), and `POST /v1/responses/{id}/cancel`. IDs are bounded opaque strings encoded
as one path component, never URL fragments supplied by the model. Request bodies,
headers and endpoint selection are constructed by trusted code. Test HTTP and
transport injection is explicit and unavailable through production controls.

Use an operator-supplied OpenAI API key, preferably read from a protected secret
file. It is not a Codex OAuth token. Reject conflicting file/direct-key settings,
missing/empty files, symlinks, nonregular files, files readable by group/others,
oversized files and embedded control characters. Read at most 16 KiB, accepting
one trailing line ending. Keep the key only in the private HTTP client; never in
prompts, tool arguments/results, journals, command arguments or public errors.
The provider separately needs the existing Brave credential and exact fetch-host
allowlist. Missing credentials fail before identity mutations, channel funding
or credit signing. Possession of a key does not prove model access or quota.

**AR-05.** Every creation uses the following host-built shape. `instructions` is
the fixed concatenation `baseInstructions + "\n\n" + developerInstructions`.
Tool parameter schemas are the unchanged profile `inputSchema` values. No
operator/model-supplied arbitrary API fields are merged into this body.

```ts
{
  model: 'gpt-5.6-luna',
  reasoning: { effort: 'xhigh' },
  instructions,
  tools: profile.tools.map(t => ({
    type: 'function', name: t.name, description: t.description,
    parameters: t.inputSchema, strict: true,
  })),
  tool_choice: 'auto',
  parallel_tool_calls: false,
  background: true,
  stream: true,
  store: true,
  truncation: 'disabled',
  max_output_tokens: reservedOutputTokens,
  previous_response_id: previousResponseId, // omit only at first creation
  input, // initial user text OR one saved function_call_output
}
```

First/new task input is `[{role:'user',content:[{type:'input_text',text:prompt}]}]`.
A function continuation uses
`[{type:'function_call_output',call_id:upstreamCallId,output:savedResultText}]`
with its generating response as predecessor. Result text is the exact saved
`JSON.stringify({success: result.success, text: result.text})`; wrapper overhead
counts toward HTTP/state bounds. Re-send the same instructions and tools on every
creation. The [create reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
documents that predecessor instructions are not inherited, that the output-token
cap includes reasoning, and that `max_tool_calls` bounds built-in tools rather
than this host's custom functions. Do not use that parameter as a host call limit.
`truncation` is currently documented but deprecated; no automatic context dropping
or compaction is enabled. Checked 2026-09-11.

This profile requires an API project that permits stored Responses. A ZDR
project's background request runs with `store:false` and does not satisfy this
stored-context contract. Reject an effective storage/background configuration
that differs from the request and retain the acknowledged ID for cancellation.
For Modified Abuse Monitoring projects, explicitly requesting `store:true` is
necessary for retention beyond the background polling period. Do not assert
indefinite storage or bypass an organization's retention controls. These data
policy distinctions are documented in the
[background guide](https://developers.openai.com/api/docs/guides/background),
checked 2026-09-11.

**AR-06.** Only strict custom function definitions are sent. There are no built-in
web, shell, apply-patch, filesystem, browser, code interpreter, MCP, plugin,
subagent, deferred-tool or code-mode definitions. Every profile schema must be a
supported strict object schema; unsupported schema features fail at startup.
Validate model arguments again locally, including unknown/duplicate keys, type,
Unicode and length constraints, before invoking a handler. The first slice needs
only the existing empty-object and required-string service schemas; it must not
pretend to implement an unrestricted JSON Schema validator.

The [function-calling guide](https://developers.openai.com/api/docs/guides/function-calling)
documents custom calls/results, strict schemas and serial-call configuration.
Those are API mechanisms; local allowlisting, durable dispatch and budgets below
are m2m host requirements. The model may answer in text; text that resembles a
tool invocation is never executable. No model-generated code is evaluated.

Validate the acknowledged response's model, effort, tools and fixed
execution configuration against the submitted request before dispatching host
tools or exposing text. An unrecognized tool/output action, contradictory ID,
changed profile, multiple function calls despite serial configuration or missing
required execution metadata stops processing and requests cancellation. Preserve
the upstream ID for reconciliation even if the policy check fails.

## 3. Durable model turns and tools

**AR-07.** One m2m worker request may contain several sequential API responses:
model response, durable host tool, model continuation, until a completed response
has no tool call. API response completion alone is not worker completion. The
worker serializes one active request per state root, one API response and one
host handler. It rejects a competing request rather than opening another loop.

Persist a prepared request with qualified caller/conversation/request identity,
prompt commitment, immutable runtime/profile, original deadline and limits. Before
every POST, persist a creation intent containing a random client request ID,
exact serialized body or its reconstructable private data plus hash, predecessor,
step index, consumed response count and token reservation. Then issue that POST
once. Persist `response.created` and its actual response ID before publishing
events or dispatching a tool. The first acknowledged ID establishes dispatch to
the existing research binding; subsequent API continuations do not bill the
original m2m prompt again.

**AR-08.** A known background response is recovered by its saved ID and event
cursor, never by POSTing its input again. The
[background guide](https://developers.openai.com/api/docs/guides/background)
documents streaming background creation, retrieval with
`stream=true&starting_after=<sequence_number>` and cancellation. Resuming a stream
requires creation with `stream:true`. Stored-response retention remains an
upstream dependency; `store:true` is explicit because omitted storage can expire
background responses after the short polling window. Checked 2026-09-11.

Persist each accepted upstream sequence number and a digest of its relevant
payload atomically with the resulting output/state. An identical duplicate is a
no-op; a contradictory duplicate fails. Do not advance the cursor before durable
processing. Discontinuity, truncated SSE, read timeout or reconnect failure
triggers bounded GET reconciliation. A complete retrieved snapshot may recover
missing output only when every saved item's text is an exact prefix and item
identity/order agrees. It may append the missing suffix, never replace delivered
bytes. In-progress retrieval alone cannot invent missed deltas or terminal state.

If POST may have escaped but no response ID was durably retained, set
`uncertain`/`backend_launch_uncertain`. Do not retry POST, create a fresh response,
release its allowance or continue the conversation. This deliberately includes
the crash between saving an intent and actually writing the network request.
No supported create-idempotency or lookup-by-client-ID guarantee was established
by the checked sources. `X-Client-Request-Id` is a diagnostic correlation value;
the [debugging reference](https://developers.openai.com/api/reference/overview#debugging-requests)
does not make it duplicate suppression. A documented, definite nonexecution
rejection can be terminal failed, but disconnect/5xx/timeout cannot establish it.

**AR-09.** On a completed API response, validate its entire output structure before
dispatching its sole function call. Accept only assistant message, reasoning and
registered `function_call` output items. Reasoning is never a public event or
billable text. Only `output_text` becomes content; refusal can produce a fixed
terminal reason without fabricating assistant output. Arguments become executable
only after their complete, valid JSON is durably stored; argument deltas never
trigger effects.

Journal `(runtime conversation, API response ID, upstream call_id)`, name, exact
arguments and their semantic digest, then reserve a host call before invoking.
Supply existing handlers a stable local `callId` computed as SHA-256 of the UTF-8
canonical JSON array `["m2m/responses/host-call/v1", responseId, upstreamCallId]`.
Retain the raw upstream ID separately for the API result. This avoids collisions
in existing handlers that key only by call ID. Changed arguments/name under the
same identity fail; duplicate delivery returns the exact saved result.

**AR-10.** A completed result is persisted before the next creation intent. On
reopen, it is reused without reexecuting the handler. A pending call reenters its
handler only when explicitly listed in `recoverableTools`; that handler must
reconcile the same durable operation, and read retries consume original host
allowances. A nonrecoverable pending call remains uncertain. Calls are counted
once at the adapter identity boundary; actual HTTP retries consume the web
adapter's separate attempt allowance. Replays do not refill either allowance.

Add the narrow optional `AgentToolResult.uncertain?: true` marker. It is legal
only with `success:false`. An ordinary failed result means the tool operation is
terminal. An uncertain result or thrown callback means effects may be unresolved:
retain the call as uncertain, send no function output, launch no next response,
and keep the worker/conversation uncertain. A later explicit `reconcile` may
reenter the same recoverable handler. The coordinator must return this marker
when its ResearchPort failure left a pending request; its trusted
`ResearchNotDispatchedError` path and validated terminal receipts remain terminal.
Never infer execution certainty by matching a peer's error string.

**AR-11.** Continue new tasks using the exact last completed response as
`previous_response_id`, including the full tool loop in its ancestry. Persist
the mapping under qualified Agent and application conversation, independent of
channel/socket/alias. After restart, validate the saved mapping and upstream
predecessor before admitting another create. An expired/deleted/inaccessible
predecessor fails `backend_context_unavailable`; do not silently start empty or
replay visible text as equivalent hidden model state. A noncompleted final API
response blocks further model conversation until a separately specified recovery
establishes a usable predecessor; it does not prevent otherwise valid economic
drain/close of known-terminal work.

The [conversation-state guide](https://developers.openai.com/api/docs/guides/conversation-state)
documents predecessor chaining and default response retention of 30 days, and
notes that prior inputs in a chain are still billed as model input. This first
adapter promises durable local mapping and recovery while required upstream
state is available, not indefinite portable memory. Failure/refusal/limit receipts
remain replayable from local state even if upstream context expires.

## 4. Cancellation, bounds and accounting

**AR-12.** Persist cancel intent before aborting an active handler or requesting
API cancellation. It immediately prevents new creates and new tool effects.
After an awaited lock/reservation/handler boundary, check cancellation/deadline
again before any subsequent effect. Cancellation of a known background response
uses its saved ID; retry cancellation/retrieval on explicit reconciliation within
bounded control limits. A lost creation ID cannot be cancelled by guessing.

Closing HTTP or a process is not proof of remote cancellation. Mark worker
`cancelled` only when backend execution is terminal and every started host
operation is known terminal; if completion wins, completed is permissible.
Pending/uncertain handlers remain uncertain after cancel. Do not reenter a
cancelled handler automatically merely to obtain a result: root may reconcile
already started paid work via its existing durable cancellation/drain logic.
Late results can record effects already completed, but cannot initiate further
research, credit, HTTP work or model continuations. Preserve generated bytes for
the service's authorized drain/discard rules. Stop/close never expands budget.

The compatibility `close():void` only stops admission, starts cancellation and
aborts local I/O; it does not release a writer lock. New runtime owners await
`shutdown():Promise<void>` before releasing their own role/Agent locks. Shutdown
joins all local journal and handler transitions before releasing the worker
lock. On grace expiry it reports `worker_shutdown_uncertain` and retains the
lock while unfinished operations remain; it cannot advertise a safe in-process
replacement. Closing/poison guards fence late completions from new effects.
Remote uncertainty can remain in a quiescent durable journal after local lock
release, but unfinished local writers cannot. The process supervisor may stop
the process after recording the shutdown result; process death does not prove
remote cancellation.

An enclosing coordinator/Agent lock also remains held if worker shutdown fails
with an unfinished local handler that may mutate that enclosing journal. Do not
unconditionally release those locks in a `finally` block. Reopening stays denied
until all such local transitions quiesce or the owning process exits.

**AR-13.** All limits are positive safe integers, fixed on initialization. The
first live profile uses these defaults; an operator may select lower values or
explicitly configure within the listed hard ceilings before a fresh conversation.

| Bound | Default | Hard ceiling |
|---|---:|---:|
| Request duration | provider 120 s; coordinator 300 s | 300 s |
| Produced assistant text per request | 32 KiB | 256 KiB |
| Prompt bytes at worker boundary | 64 KiB | 64 KiB |
| API output tokens per response, including reasoning | 4,096 | 16,384 |
| Sum of reserved API output-token caps per worker request | 131,072 | 262,144 |
| API creations per worker request | 32 | 64 |
| Host calls / one result | existing profile values | 32 / 64 KiB |
| Aggregate host result text per worker request | 256 KiB | 512 KiB |
| One encoded create body | 256 KiB | 1 MiB |
| One SSE event or retrieved response | 1 MiB | 2 MiB |
| Total received API bytes per worker request, including retries | 16 MiB | 32 MiB |
| Durable upstream event records per request | 8,192 | 16,384 |
| API reconnect/retrieval attempts per worker request | 8 | 16 |
| Cancel/retrieve control attempts per reconciliation invocation | 3 | 3 |
| Worker journal | 16 MiB | 16 MiB |
| Requests per conversation | 32 | 32 |
| Header/ordinary JSON request timeout | 15 s | 30 s |
| Live SSE idle timeout | 30 s | 60 s |
| Cancellation/shutdown local grace | 3 s | 10 s |

Reserve the response count and the full next `max_output_tokens` cap durably
before POST. Never refund that reservation automatically, including definite
errors. This bounds possible output over all creates even if usage telemetry is
lost. Input cost is separately bounded by conversation/request/body sizes and
response count; it is not a hard USD spend limit. API token reservations are
provider exposure, not Sui budget or delivered-byte billing. Record actual input,
output, cached and reasoning tokens per unique response only when supplied and
valid; cached/reasoning counters are subsets, not extra tokens. Missing telemetry
stays missing. Never label Responses totals as Codex thread usage.

Count consumed HTTP bytes and reconnect attempts before accepting more input.
Bound decoding and framing before JSON parse/allocation, reject invalid UTF-8,
and retain SSE parser state across split lines/code points. Use bounded storage
headroom for pending snapshots, call results and terminal/cancel records; refuse
new work before it could destroy recovery evidence. A storage failure poisons
the writer. Directory 0700, records 0600, exclusive lock, atomic rename, file and
directory fsync, explicit create/reopen and missing/corrupt-state rejection apply
as in AS-17. Neither public-event nor private-journal exhaustion evicts evidence.

Private journal parsing allows its full declared 16 MiB bound, depth at most 64
and 250,000 total object/array entries; reject duplicate keys and unsupported
field versions. Admission serialization obeys those same depth/entry limits, so
the writer cannot create state the reader rejects. API JSON allows a maximum
depth of 32 and 32,768 entries inside the stated byte limit; tool argument JSON
allows 8 levels and 256 entries. Reject before recursively allocating or invoking
handlers. Do not apply the existing 1 MiB wire parser blindly to larger journals.

**AR-14.** Persist stable worker event indices before calling a consumer. Event
replay after `afterEvent` is exact and free of duplicate units. Slow consumers
must not prevent bounded backend event collection or cancellation supervision.
The adapter exposes produced text; the unchanged service alone commits paid
delivered bytes. It does not count input history, function results, reasoning,
API overhead, source bodies or generated-but-undelivered bytes as service units.

Only sanitized content/state/error events reach existing public projections.
Never publish raw SSE, backend errors, hidden reasoning, authorization headers,
private paths, response bodies or worker journals. API usage belongs in an
explicit Responses diagnostics record, with absent fields `null`; do not fabricate
values just to fill old Codex types. Public protocol/citation evidence keeps its
existing schema and provenance checks.

## 5. Acceptance and enablement

**AR-15.** Keep independent gates for (a) deterministic transport/worker tests,
(b) isolated live adapter acceptance, (c) real Iroh/Sui integration, (d) two live
LLMs with real web tools, and (e) Fly/Tailwind/testnet demo. The new runtime's
production factory remains `agent_tool_runtime_unvalidated` until its isolated
live callback, resumed-conversation and prohibited-tool checks pass and Astra
review accepts the implementation/evidence. A bounded standalone live probe may
instantiate the candidate worker before that factory is enabled; it has no
payment or chain objects and no production override flag.

Record missing API/search credentials, unavailable Luna/background support,
quota or network failures honestly; they do not authorize another backend or
fixture. Existing AS-20/T18 remains failed for Codex regardless of new-runtime
results. Passing the new adapter gate allows the new profile's subsequent live
research gate, not a claim that live research has already run. The acceptance
matrix is in [AGENT_RUNTIME_IMPLEMENTATION.md](AGENT_RUNTIME_IMPLEMENTATION.md).
