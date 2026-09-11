# Live agent services and continuing research conversations

Status: specification for the user-authorized implementation pass, 2026-09-11.
Specification lead: Astra, reasoning effort `xhigh`. Implementation is assigned to
three Luna `xhigh` agents under the ownership plan in
[AGENT_SERVICES_IMPLEMENTATION.md](AGENT_SERVICES_IMPLEMENTATION.md). Requirements
below are implementation acceptance criteria, not claims of completed validation
or a released protocol standard.

## 1. Outcome and boundaries

**AS-01.** A person gives the local coordinator a research task and a bounded
spending policy. A real coordinator LLM decides whether to ask the independently
running provider a question, ask a follow-up, inspect its remaining budget, or
stop. A real provider LLM can search and fetch allowed web sources and produces
cited text. Both use persistent Codex threads. The existing programmed coordinator
and knowledge-only text worker are the concrete baseline: neither currently
demonstrates this pair of live decision loops with source-seeking research.

**AS-02.** This pass delivers a local two-process CLI composition over real Iroh,
with the existing Sui streaming channel implementation and localnet validation.
Fly is the selected later hosting environment. Fly deployment, UI, browser-hosted
agents, SuiNS registration, testnet/mainnet mutations, and NanoCodex migration are
outside this pass. Existing local identities/configuration can be reused; the
runtime must not provision or register remote identities as a side effect.

**AS-03.** Preserve `m2m/core/1`, every existing economic BCS/signature and Move
entrypoint, and [research v1](NATIVE_RESEARCH_SPEC.md). New behavior is opt-in.
The existing `CodexWorker` default remains its knowledge-only, tool-disabled v1
profile. Do not change the research model: it remains `gpt-5.6-luna`, `xhigh`.
For this implementation the coordinator also defaults explicitly to that model
and effort, as a runtime choice above the protocol. No availability-driven model
substitution is permitted. Economic keys never enter either LLM process.

**AS-04.** Supported concurrency is one active coordinator task, one active
provider request, one selected channel, and one writer per role/Agent state root.
Multiple turns are sequential. A process may accept another authenticated session
after disconnect, using its existing journal. This is not a distributed scheduler
or a promise of concurrent conversations across machines.

## 2. New application binding

**AS-05.** Negotiate both mandatory features:

```text
payment.sui.streaming.v1
service.research.conversation.v2
```

Carry the following commands in `extension.payment.sui.streaming.v1`. The
dispatcher MUST additionally check that the v2 service feature was selected;
selecting only the payment feature never enables v2. No fallback to v1. Native
unpaid echo/hash remains usable before funding. Service advertisements describe
the application; they are not spending authority.

**AS-06.** A v2 request is the exact JSON object below. All fields are required;
unknown and duplicate fields fail. `ID` is 64 lowercase hex digits, without `0x`.
`U64` is the existing canonical decimal-string encoding. `Hash` is an array of
32 bytes. `Address` is the existing full lowercase Sui address. A prompt must be
nonempty, valid Unicode without unpaired surrogates, at most 16,384 UTF-8 bytes.
Sequence is positive and increments once per request on a channel, starting at 1.

```ts
interface ResearchRequestV2 {
  version: 2;
  conversation: string; // ID, stable across explicit channel replacement
  request: string;      // ID, stable application execution identity
  sequence: string;     // U64, channel-local request sequence
  prompt: string;
}
```

Its commitment is BLAKE2b-256 of this exact ordered BCS structure, with no JSON
hashing and no signature prepass:

```text
purpose: vector<u8> = UTF8("m2m/research/request/v2")
channel: address
conversation: vector<u8> = 32 decoded ID bytes
request: vector<u8> = 32 decoded ID bytes
sequence: u64
input: vector<u8> = exact UTF8(prompt)
model: vector<u8> = UTF8("gpt-5.6-luna")
reasoning: vector<u8> = UTF8("xhigh")
service: vector<u8> = UTF8("service.research.conversation.v2")
```

The service-specific request commitment binds the new semantics without changing
the streaming Credit schema. Publish an independently encoded positive vector
and field-tampering negatives. The same execution ID cannot name different
prompts or be reused for a new channel execution.

### Commands and responses

**AS-07.** Every command has `{version:2, op_id:ID, op:string, ...}` and every
response has `{version:2, op_id:ID, type:string, ...}`. The response echoes the
operation ID. Tables list all additional fields; absence is represented by
explicit `null` where specified. Strict parsing precedes any side effect. Existing
Offer, Credit, Ack, Checkpoint and Policy objects use their unchanged strict
codecs. Maximum encoded command/result is 65,536 bytes.

| Command `op` | Additional fields | Successful response `type` and additional fields |
|---|---|---|
| `offer` | `conversation:ID`, `nonce:Hash`, `previous_channel:Address|null` | `offer`: `offer:Signed<Offer>`, `policy:Policy`, `service:"service.research.conversation.v2"` |
| `funded` | `conversation:ID`, `channel:Address` | `funded`: `channel:Address` |
| `credit` | `request:ResearchRequestV2`, `credit:Signed<Credit>` | `ack`: `ack:Signed<Ack>` |
| `start` | `request_hash:Hash` | `started`: `request_hash:Hash` |
| `poll` | `request_hash:Hash`, `after_checkpoint:Hash` | `delivery`, `waiting`, or `turn_terminal`, defined below |
| `status` | `request_hash:Hash` | `status`: `status:ResearchStatus` |
| `cancel` | `request_hash:Hash` | `cancellation_requested`: `confirmed:boolean` |
| `finish` | `request_hash:Hash`, `discard_unpaid:boolean` | `turn_terminal`: `receipt:TurnReceipt` |
| `close` | `conversation:ID`, `last_request_hash:Hash` | `channel_final`: `checkpoint:Signed<Checkpoint>`, `output:[]` |

Offer/funding belongs to the composition, and the remaining commands to the
research service. A caller knows the selected channel from its pinned binding;
request hashes and economic statements must match it. Offer nonce, conversation,
service and predecessor are durably bound before returning an offer. A funded
notice is not evidence of funding: read and verify the exact Sui Channel and offer.

```ts
type ResearchPhase =
  | 'credited' | 'launching' | 'running' | 'draining'
  | 'cancelling' | 'terminal' | 'uncertain';
interface ResearchStatus {
  request_hash: number[];
  phase: ResearchPhase;
  worker_state: string | null; // existing RequestState union when non-null
  checkpoint_hash: number[];  // latest channel checkpoint or zero hash
  delivered_units: [string, string]; // channel cumulative input/output
  authorized_units: [string, string];
  generated_output: string;   // durable request-local UTF-8 bytes
  available_output: string;   // generated bytes not yet delivered/discarded
  input_dispatched: boolean;
  cancel_requested: boolean;
}
// A poll returns one record, so response framing remains bounded.
type PollBody =
  | { type: 'delivery'; checkpoint: Signed<Checkpoint>; output: number[] }
  | { type: 'waiting'; reason: 'running' | 'credit_exhausted' | 'cancelling';
      status: ResearchStatus }
  | { type: 'turn_terminal'; receipt: TurnReceipt };
interface Citation {
  id: string;                 // request-local s1, s2, ...
  url: string;                // final validated HTTPS URL, <= 2048 bytes
  title: string;              // <= 256 UTF-8 bytes
  retrieved_at_ms: string;    // U64
  content_hash: number[];     // BLAKE2b-256 of extracted bounded text
}
interface TurnReceipt {
  version: 2;
  conversation: string;
  request: string;
  request_hash: number[];
  sequence: string;
  outcome: 'completed' | 'failed' | 'cancelled';
  reason: string | null;      // fixed code, never raw backend diagnostics
  checkpoint_hash: number[];
  delivered_units: [string, string];
  generated_output: string;  // request-local, never a billable counter
  discarded_output: string;  // request-local uncommitted bytes, excluded from bill
  continuation: 'ready' | 'requires_channel_close';
  citations: Citation[];      // <= configured fetch limit
}
```

`Signed<...>` above denotes existing streaming-codec types; it does not introduce
another signature scheme. TurnReceipt is carried in a verified provider core
response and retained with that envelope. It is an application terminal statement,
not economic close consent and not buyer approval of quality. It has no `final`
field. A close response is the distinct economic final checkpoint.

**AS-08.** Errors have exactly `{version:2,op_id,type:"error",code}`. Fixed codes:
`invalid_command`, `unsupported_version`, `unsupported_service`, `operation_conflict`,
`request_conflict`, `unknown_request`, `conversation_busy`, `channel_mismatch`,
`channel_not_open`, `work_expired`, `claim_expired`, `credit_mismatch`,
`credit_exhausted`, `checkpoint_cursor_mismatch`, `drain_required`,
`worker_not_terminal`, `uncertain_execution`, `journal_missing`, `journal_corrupt`,
`storage_failure`, `limit_exceeded`, `backend_unavailable`, `search_unconfigured`.
A rejected operation is not proof that earlier operations did not execute. A
storage failure poisons mutation in that process until reopen/reconciliation.

**AS-09.** `op_id` deduplication is scoped to qualified buyer, qualified provider,
conversation and selected binding (offer operations precede channel assignment).
Persist the validated command in schema field order and its exact result before
sending. The same op ID and semantic command replays that result; changed content
fails. Semantic comparison uses the strict parsed structure, including all signed
payload/signature bytes; JSON whitespace or key order does not create new work.
A new ID for the same Credit/request/start/cursor also reconciles those durable
application identities. A poll's saved `waiting` result is immutable; a fresh
poll uses a fresh operation ID to observe progress.

Core retry uses the original message ID and timestamps while valid. Reconnect may
rebind only the session/transport generation allowed by core v1. After envelope
expiry, create a new core ID correlated to the prior attempt and retain the same
application op ID and command. Never extend the old message's expiry. A recovered
core `dispatching` record requires the application journal to reconcile under a
new correlated core request; do not blindly repeat external work.

## 3. Turn lifecycle and cumulative metering

**AS-10.** Use exactly the existing byte policy dimensions, ordered
`[input_utf8_bytes, output_utf8_bytes]`. Rates/denominator are operator-configured,
validated before funding, and immutable per channel. Prompt input counts once
when actual backend dispatch is established. Original prompt bytes count; hidden
instructions, replay, thread history, reasoning, token telemetry, tool payloads,
web API fees and network framing do not. Output counts exact agent-message bytes
once when committed for delivery. Saved delivery replay adds zero. A new prompt
counts its own bytes even if it repeats earlier text. Prices use the unchanged
cumulative streaming formula, never a sum of rounded turn prices.

For a new request let `D=[I,O]` be previously delivered cumulative units and
`A=[AI,AO]` the previous signed ceilings. Dispatch of prompt length `P` changes
actual input to `I+P`. New input authorization is `max(AI,I+P)`; do not reset it
to `P`. New output authorization is at least `AO`, even when the prior response
used less. These unused old ceilings remain immediately redeemable and must be
included in budget/exposure calculations. Credit sequence increments per credit;
request sequence increments per new request. Neither resets at turn completion.

**AS-11.** Admission order is: validate exact request and binding; persist
application credit intent; `engine.acceptCredit`; persist Ack/result. Only after
the buyer has persisted that Ack may it send `start`. Persist dispatch intent
before calling the worker. Worker dispatch is identified by the stable qualified
buyer/conversation/request mapping. As soon as a known backend turn ID or
reconciled turn establishes dispatch, commit an input-only, nonfinal checkpoint
for `[I+P,O]` with empty output, before delivering response text. This supports
empty responses without inventing output units. Unknown launch state does not
establish dispatch or authorize another launch.

**AS-12.** Every ordinary delivery checkpoint has `final:false`. A poll cursor is
the hash of the last persisted checkpoint, with all-zero hash meaning the channel
start. This identifies input-only checkpoints and equal-output final checkpoints
without offset ambiguity. Cursor must be an exact checkpoint boundary in the
channel's retained chain, and its request relationship must be valid; an unknown
or future cursor fails. Replay already saved checkpoints in chain order before
committing new bytes. A request poll cannot obtain another request's new output.
Output chunks are at most 1024 bytes; transport chunks may split UTF-8 code points,
so the consumer uses streaming UTF-8 decoding and retains the exact bytes.

**AS-13.** The unchanged engine requires a checkpoint under the latest credit
before renewing or completing a request. Therefore a same-request output renewal
is issued only when status reports durable, undelivered output beyond the old
ceiling. Its new output ceiling may cover at most that durable generated extent,
subject to the configured tranche/budget limit. Validate that extent again when
accepting a renewal. Output already made credit-eligible cannot be discarded by a
concurrent cancellation before at least one positive-unit checkpoint under that
credit. Persist/replay the draining intent through crashes. Do not add fake units,
send a nonfinal zero-delta checkpoint, or relax StreamingEngine to bypass this.

**AS-14.** A worker can be terminal while delivery is still draining. The buyer's
mechanical driver polls all already authorized output. When the worker is terminal
and every selected byte is durably delivered, `finish` records a TurnReceipt and
calls `engine.completeRequest(sequence)` on the provider. The buyer validates and
persists the receipt plus source envelope, then calls its own `completeRequest`.
The next request may start only after both steps reconcile. `finish` is a
mechanical lifecycle operation; it does not ask either LLM whether an answer is
satisfactory and creates no new payment entitlement.

If output remains above the last signed ceiling, `finish(discard_unpaid:false)`
returns `credit_exhausted`. `finish(discard_unpaid:true)` explicitly discards only
that excess after authorized bytes are drained. Record the exact discarded count;
discarded bytes never enter paid output, later turn output, or a replay. Preserve
them only within the bounded private worker store. Once a receipt is committed,
its outcome, counters, sources and discarded count are immutable.

**AS-15.** Cancellation persists intent before requesting worker interruption,
and reissues it after restart until confirmed. Stop issuing further credit or
tool calls immediately. Drain already generated bytes within existing signed
ceilings, including a promised renewal slice; then discard uncredited excess and
record cancellation. Cancellation cannot revoke a signed credit or previously
committed output. A race where completion wins may honestly produce `completed`.
If interruption is unconfirmed, retain `uncertain`; do not call it completed,
release its budget reservation, or dispatch a follow-up.

Before dispatch, cancellation causes zero new input/output. If no checkpoint
exists under that request's credit, its receipt says
`continuation:"requires_channel_close"`; do not call `completeRequest` or accept
another request. An explicit close can then emit the permitted final zero-delta
checkpoint and mark the request complete. This bounded exception preserves the
unchanged engine and avoids charging a synthetic input merely to permit reuse.

**AS-16.** `close` is explicit and separate from `finish`, natural LLM completion,
budget pause and disconnect. It requires all execution terminal/reconciled and
delivery drained/discarded as above. It emits one durable `final:true` checkpoint
with empty output and the actual cumulative units, freezing the entire channel.
Then the existing `close_exact` path submits/reconciles settlement against Sui.
Saved final evidence can be recovered after deadlines; new work cannot. Close
consent may be created after the work deadline but before the claim deadline if
execution and accounting are reconciled. Already redeemed advances cannot be
clawed back; if redeemed amount exceeds exact delivered price, report that
economic incompatibility and preserve the existing redemption/expiry path.
Do not label an unknown transaction settled. A funded channel with no credit
cannot fabricate a final checkpoint; retain it for its existing refund path.

## 4. Persistence and identity

**AS-17.** State roots are operator-owned, outside the served model workspace,
private (directories 0700, records 0600), with process locks, file fsync, atomic
rename and directory fsync. Reuse NativeLock for the Agent root. Store a root
manifest that distinguishes explicit first creation from reopen. Once initialized,
missing required application, worker, budget, outbox, inbox or engine records
fail closed. Never silently create an empty replacement journal for a known
channel/conversation. Validate schemas, role, qualified Agents, binding hashes,
checkpoint chains, request mappings and profile fingerprints on reopen.
Record a component as initialized only after its creation completes; a lazy
component never initialized is distinct from loss of a required existing record.
A crash may leave a valid newly created component before its manifest marker.
Reopen may validate that exact file and complete initialization without replacing
it, provided no external side effect was permitted before the marker was durable.

Application transitions use write-ahead intents. A crash between app intent and
engine Ack/checkpoint is reconciled against the existing engine record and
completed idempotently. Persisting a terminal receipt before marking engine
completion permits replay of that marker after a crash. Missing worker evidence
after dispatch intent is `uncertain_execution`; it never implies safe rerun.
Each request stores prompt commitment, backend thread/turn references, metering
baseline, cancellation state, delivery cursors, sources and terminal receipt.

**AS-18.** Conversation identity is `(qualified buyer, qualified provider,
conversation ID)`, not an alias, socket, channel ID, or current transport key.
The mapping to a Codex thread is persistent and reused for follow-up requests.
Once a channel is selected, no automatic replacement is allowed. An explicit
operator continuation with `previous_channel` may attach a newly funded channel
only after the prior channel is independently confirmed CLOSED or REFUNDED and
its last execution is terminal/reconciled. Reuse the conversation mapping, start
the new channel's counters/sequences at zero/one, and use a fresh request ID and
opening nonce. A refunded channel with uncertain external work is still not safe
to continue automatically. A new SuiNS target never retargets a saved mapping.

**AS-19.** Default application limits are 32 requests per conversation, 512
application operation records per selected channel, 8 MiB per service journal,
16 MiB per worker profile journal, and 256 KiB aggregate persisted coordinator
visible transcript. Existing core inbox limits still apply independently. Reject
new work before exceeding a limit; never evict unresolved economic evidence or
silently truncate replay. Configurable lower limits are allowed. Larger limits
require explicit operator configuration within the core framing contract.

## 5. Live Codex profiles and bounded web research

**AS-20.** Extend the existing adapter through an optional, explicit `agentProfile`
option. The default profile, model, launch checks and old worker tests remain
unchanged. An opted-in profile supplies fixed instructions, schemas and a host
handler for named dynamic tools. It enables `experimentalApi:true`; no ambient
shell, plugins, MCP, filesystem tools, browser, memory, nested agents or built-in
web tool is enabled. Validate the effective read-only/no-network model sandbox
and model/effort as before. The network-capable host implements the narrow web
tools; it does not grant arbitrary network access to the model process.

The checked integration is installed `codex-cli 0.154.0`, including its generated
experimental TypeScript schema, inspected 2026-09-11. Register function specs as
`{type:"function",name,description,inputSchema}` on `thread/start`. Handle only
`item/tool/call` server requests with `{threadId,turnId,callId,namespace,tool,
arguments}`; namespace must be null in this profile. Return
`{contentItems:[{type:"inputText",text}],success}`. Match thread, turn, registered
tool and active request before dispatch. A matching dynamic-tool event may
establish a turn ID during the one persisted pending launch before turn/start
returns; save that ID and reject any later mismatch. Other server requests remain denied.
The installed `thread/resume` schema has no dynamicTools field: tools restore
from thread metadata. Persist a hash of profile ID, model/effort, exact
instructions and schemas, and refuse resume under a changed profile. The dynamic
tool interface is experimental, not a stable upstream API guarantee.
[Official app-server documentation](https://learn.chatgpt.com/docs/app-server)

Live enablement requires a verified tool-routing configuration for this pinned
version. Only registered service tools and explicitly specified computation-only
routing primitives may be exposed or dispatched. Namespace filtering, sandbox
write rejection and model instructions do not substitute for this requirement.
The default worker configuration remains unchanged.

Checked 2026-09-11: the tested configuration with code mode disabled produced no
required host callbacks; enabling code mode and its local host permitted callbacks
but also exposed built-in `apply_patch`. Excluding that tool from both nested and
direct dispatch has not been validated. The live profile therefore remains
unavailable: `agent_tool_runtime_unvalidated` must fail before chain/funding
operations. Explicit injected test adapters remain test-only; there is no CLI
override, knowledge-only fallback, permission widening or backend substitution.
T18 has not passed and T19 has not run; see the
[validation evidence and next adapter gate](AGENT_SERVICES_VALIDATION.md#live-adapter-blocker).

**AS-21.** Tool inputs have JSON object schemas with all fields required and
`additionalProperties:false`, plus independent host validation. Serialize calls
per worker. Journal call identity `(thread,turn,callId)`, name and arguments before
invocation, and save result before replying. An exact duplicate returns its saved
result; changed content fails. A pending coordinator call reconciles its stable
research operation, never creates a fresh request. Reinvocation is permitted only
for a tool explicitly declared recoverable with an idempotent durable handler;
otherwise a pending call remains uncertain. Read-only web retry may run
only within a newly charged local call allowance; it cannot reset limits after
restart. Unknown app-server requests or unrecognized items fail the request and
request interruption. Only known dynamic-tool item events are added to the old
allowlist. Tool result text is limited before sending to the backend; late
results after cancellation cannot authorize fresh work.

**AS-22.** Provider tools are:

| Tool | Exact arguments | Result text contains |
|---|---|---|
| `web_search` | `{query:string}` | `{results:[{url,title,snippet}]}` from the configured search backend |
| `web_fetch` | `{url:string}` | `{citation:Citation,text:string,truncated:boolean}` for a validated source |

Default per research request: at most 3 search calls, 5 results per search,
8 fetch calls, 256 UTF-8 query bytes and 50 words, 10 seconds per HTTP operation,
2 redirects, 128 KiB received bytes per response, 512 KiB aggregate received
bytes, 16 KiB extracted text per page and 64 KiB aggregate tool-result text.
Count attempts and reserve the limit before HTTP dispatch, including errors.
One active HTTP operation is permitted. Worker wall duration defaults to 120
seconds, maximum 300 seconds; generated output defaults to 32 KiB, maximum
256 KiB. Persist all counters and the original deadline so restart does not
refill the allowance. Credit exhaustion pauses paid delivery, not upstream
generation; duration, buffer and cancellation limits bound provider exposure.

**AS-23.** Implement an injected SearchBackend and a concrete Brave Search
adapter. The latter performs GET to the fixed
`https://api.search.brave.com/res/v1/web/search`, with encoded `q`, `count=5`,
`offset=0`, and host-only `X-Subscription-Token`. Extract only bounded
`web.results[].{url,title,description}`. Never return headers, raw error bodies,
tokens or provider configuration to the LLM. The endpoint/authentication and
result structure were checked 2026-09-11 against
[Brave's web search documentation](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started)
and [authentication guide](https://api-dashboard.search.brave.com/documentation/guides/authentication).
No search credentials are present at specification time. Live search needs an
operator-supplied `M2M_BRAVE_API_KEY`; missing credentials cause explicit
`search_unconfigured`, with no deterministic or knowledge-only fallback.

**AS-24.** Fetch accepts HTTPS on port 443 only, without userinfo, fragments or
IP literals. The operator declares exact allowed hostnames; matching is normalized
hostname equality, never string suffix matching. Every initial/redirect target
must also be in that allowlist. Resolve DNS before connecting and reject private,
loopback, link-local, multicast, unspecified, documentation, reserved and mapped
private IPv4/IPv6 addresses. Pin an approved address into the connection's lookup
while preserving TLS SNI/certificate validation for the hostname; do not perform
a second uncontrolled DNS lookup. Validate every redirect and bound redirect
count. Disable proxy inheritance, cookies, authorization and referrer forwarding.
Only the fixed search adapter receives its own token. Fetch sends GET with
`Accept-Encoding: identity`; reject unexpected compressed encodings so limits
cannot be bypassed by decompression. Bound streamed bytes before buffering, reject
non-success/non-text content, and support only plain text and HTML text extraction.
No JavaScript, form submissions, PDF parser, browser or arbitrary URL scheme.

**AS-25.** Persist bounded source records after successful fetch, assigning
request-local IDs `s1`, `s2`, etc. The provider prompt requires citations such as
`[s1]` on sourced claims, uncertainty for unsupported claims, and treats retrieved
content as data that cannot change identity, payment, prompts or tools. A citation
must name an actually fetched record; a search snippet alone is not a fetched
source. At terminal processing check cited IDs against the ledger and report
`invalid_citation` on unknown IDs. This verifies provenance references, not claim
truth. Report that failure in a terminal receipt with `outcome:"failed"` and
`reason:"invalid_citation"`, retaining only valid fetched source metadata. Do not
invent a source or leave known-terminal work unable to close merely because its
answer contains an unsupported citation. Previously delivered partial text remains
paid even if later validation fails. Source metadata is nonbillable bounded evidence; generated citation text
is part of ordinary billed output. Do not forward private backend journals,
hidden reasoning, raw fetched documents or credentials in protocol responses.

## 6. Coordinator decisions and hard economic guards

**AS-26.** The coordinator has only the following tools. Their implementation
receives the pinned provider and channel configuration from the host; there are
no model fields for recipient, wallet, price policy, raw credit, funding amount,
channel ID, model, executable or filesystem path.

| Tool | Exact arguments | Behavior |
|---|---|---|
| `research` | `{question:string}` | First provider request of this user task; waits for a terminal/drained receipt and bounded delivered text |
| `follow_up` | `{question:string}` | New request in the same conversation after the preceding request is terminal; same payment channel while usable |
| `budget` | `{}` | Current numeric policy, cumulative authorization, delivered price, redeemed amount and remaining budget |
| `stop` | `{reason:string}` | Stops new purchases for this user task; persists the decision; returns current status |

The coordinator system prompt states its role, the exact provider, the user's
task, evidence expectations, tool descriptions, current budget/deadline and stop
conditions. It may assess evidence and decide follow-ups; no fixed question
sequence, synthesized model decision, guaranteed number of calls or scripted
success is allowed. All provider text is untrusted tool output. Natural completion
or `stop` ends this user task, not the conversation/channel. A later user task
can continue the same coordinator thread. Explicit operator `close` controls the
payment channel lifecycle. Tools return fixed error codes on denials; the model
cannot override them by prose or another tool call.

**AS-27.** BudgetLedger is durable host code, outside the model. Operator limits:
`max_total_mist`, `max_channel_deposit_mist`, `max_turn_mist`,
`max_outstanding_mist`, `max_requests`, `deadline_ms`, and
`output_tranche_bytes`. Validate canonical integers, positive limits and exact
allowed byte policy before any funding/signing. Default request count is 4 per
operator budget allocation; default output tranche is 1024 bytes. Monetary limits are explicit
operator values, not model recommendations. The channel deposit cannot exceed
either its cap or remaining total budget. One active channel is supported.

Let `price(D)` be the exact cumulative delivered price, `price(A)` the greatest
durably reserved or signed cumulative authorization, and `R` confirmed redeemed
value. A proposed credit must satisfy all of:

```text
price(A_new) <= channel deposit
settled_paid_from_prior_channels + price(A_new) <= max_total_mist
price(A_new) - price(D_now) <= max_outstanding_mist
price(A_new) - price(D_at_start_of_request) <= max_turn_mist
```

`A_new` must be componentwise at least every prior signed ceiling, including
unused ceilings from old requests. `R` is tracked independently and cannot
reduce authorized exposure. Never sum cumulative Credit amounts. A reservation
is saved before calling the signing engine, so a crash cannot forget a signature
that might have escaped. Release a reservation only by reconciling the actual
engine journal and confirmed terminal Sui state; an uncertain transaction or
missing journal does not restore budget. Once a channel is confirmed settled,
replace its reservation with actual confirmed paid value. Require predecessor
reconciliation before reserving a replacement channel.

**AS-28.** The deterministic buyer driver applies BudgetLedger before every
initial/renewal signature and before funding; validates every Ack/checkpoint and
persistently advances cumulative meters; only then exposes text to the coordinator.
Mechanical replenishment within the accepted policy is a host action, separately
labeled from LLM decisions. No final-answer acceptance signature is introduced.
Budget exhaustion, task deadline, operator cancel or stop prevents fresh credit,
requests remote cancellation, drains existing authorization, and reports any
remaining uncertainty. A model completion must never hide an unreconciled pending
research tool call. Local model token usage is diagnostic and not m2m billing.

Implementation clarification, 2026-09-11: the trusted local ResearchPort driver
may terminate a request with `ResearchNotDispatchedError` only after durably
recording that request's local rejection/cancellation and proving that no credit
signing intent or signed credit ever existed for it. Its allowed codes are
`cancelled_before_dispatch`, `budget_rejected`, `deadline_exceeded`, and
`request_limit_exceeded`. This is local control evidence, never a fabricated
provider TurnReceipt, wire response, or payment checkpoint. An ordinary exception,
remote error code, or `cancel({confirmed:true})` is not this evidence: confirmed
interruption alone does not establish drained terminal delivery. Once a credit
intent exists, every failure remains uncertain until real evidence reconciles it.

Persist cancellation IDs even if their request record does not yet exist. Serialize
that tombstone with credit-intent creation; check it again after awaited budget
guards so cancellation that wins cannot be followed by signing or dispatch.
Replays of a durably rejected ID return the same typed local rejection. A local
never-credited request does not consume a channel request sequence; subsequent
sequence selection follows the last actually credited request, not the number of
local request records. The coordinator can mark that local call nonpending and
clear only its local active-request marker. A consumed request-count allowance
remains consumed; monetary reservations/ceilings, settled spend and stop/deadline
constraints do not change. A request rejected before its count was reserved has
no consumed counter to decrement. A new task/request still passes every normal
guard, and a rejected ID can never be used to resume fresh work.

## 7. Local control and public events

**AS-29.** The CLI has persistent provider and coordinator roles. The provider
listens on Iroh and retains one worker profile/thread mapping across reconnects.
The coordinator accepts local stdin NDJSON controls:
`{op:"task",id:ID,prompt:string}`, `{op:"cancel",id:ID}`,
`{op:"status",id:ID}`, `{op:"close",id:ID}`, and
`{op:"shutdown",id:ID}`. Exact-key validation applies. Task IDs deduplicate
unchanged user submissions and reject changed prompts. Cancel/status can be
handled while a task is active; stdin reading must not await the entire task.
Shutdown persists/interrupts active work and waits only for bounded reconciliation;
it does not pretend to settle. Controls are local process input, not a newly
exposed HTTP server or an unauthenticated remote admin API.

**AS-30.** Emit append-only NDJSON events after durable recording, with exactly
`{version:1,id:U64,role:"coordinator"|"research"|"host",conversation:ID,
request:ID|null,at_ms:U64,type:string,data:object}`. IDs are stable within each
role's conversation journal and increase from 1. Types are `task_started`,
`model_text`, `tool_started`, `tool_result`, `request_started`, `delivery`,
`turn_terminal`, `budget`, `channel_final`, `settlement`, `error`. `data` uses
the matching bounded public structure: text/delta for model_text; name/call ID
and sanitized arguments/result for tool events; request/hash for request_started;
checkpoint and output bytes for delivery; TurnReceipt for turn_terminal;
BudgetSnapshot for budget; final checkpoint for channel_final; confirmed channel
status/digest/paid/refund for settlement; fixed code for error. Host credit/chain
automation must use role `host`. Exclude secrets and hidden reasoning. Replay
retains IDs, so a future UI can deduplicate it. This pass adds no UI rendering.

## 8. Evidence required before claiming completion

**AS-31.** Run the numbered acceptance matrix in the implementation plan.
Deterministic test backends are explicit fixtures, used to test branching,
payment, crash and malformed-input invariants. Real Iroh/localnet tests establish
transport and economic composition separately from live-model behavior. A live
probe must report actual model IDs, tool invocations, fetched source metadata,
request/checkpoint references and backend failures. It may not substitute a
fixture when model/search credentials, quota or connectivity fail. In particular,
no-key tests cannot be described as live web-research validation.

The specification establishes bounded authorization and recoverable statements.
It does not establish truthful model usage, citation correctness, useful research,
prompt-injection immunity, instantaneous cancellation, profitable pricing,
production durability, Fly connectivity, market demand or general interoperability.
