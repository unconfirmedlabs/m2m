# Demo public events: payloads, provenance and replay

Status: proposed implementation contract, 2026-09-11; Astra `xhigh` specification
for Luna implementation and Astra review. Refines FD-15–17, without changing the
Fly architecture, native messages, signed statements, Move ABI or standalone
`AgentEvents` behavior. No live validation is claimed. The existing 11 event
types below have real emitters; the six lifecycle types are proposed additions.
The new strict demo boundary must exist before those records reach HTTP/browser
consumers. `AgentEvents.data` itself is not a sanitizer.

Inspected sources: `agent-events.ts`, `agent-services.ts`,
`agent-coordinator.ts`, `agent-service-client.ts`, `agent-web.ts`,
`research-conversation.ts`, `agent-service-types.ts`, `streaming-codec.ts` and
the frozen type-only `demo-types.ts`. Keep this document and shared fixtures
aligned when an emitter is deliberately changed.

## 1. Shared validation boundary and ownership

Root coordinates one owner for the browser-neutral
`scripts/agent-demo-event-contract.ts` before creating shared exports. It may
import existing types with `import type`; it must have no Node/filesystem,
wallet, chain client, model, environment or network runtime imports. Pure JSON
shape, bounds, canonical IDs, provenance and deterministic arithmetic checks
can be shared by L1 emission, L2 ingestion and UI consumption. Cryptographic
verification and live chain reads remain in the existing trusted host layers.
Browser schema validation is not independent Sui/signature verification.

The helper surface is frozen in section 9; implementation and independent review
remain pending. All validators accept `unknown`, reject unsupported fields and
return validated values or fixed validation errors; none accepts injectable
arbitrary validators or performs I/O. Root added the six local lifecycle literals
to `AgentPublicEvent.type` and unified `PublicEventInput.type` through a type-only
import. That additive vocabulary is not evidence of a production emitter or a
strict boundary already being installed.

L1 owns trusted field construction, pre-append validation, durable publication
intent/headroom and the six new emitters. L2 owns authenticated provenance,
durable merge/deduplication, economic evidence checks and snapshot/SSE coupling.
UI owns strict consumption, display/history state and reconnect behavior. Shared
fixtures/oracles are root-owned; ordinary standalone `AgentEvents` tests must
continue to work without imposing this demo-specific payload allowlist on them.

## 2. Exact envelopes and scalar rules

The source envelope has exactly:

```ts
{ version:1, id:U64, role:'coordinator'|'research'|'host',
  conversation:ID, request:ID|null, at_ms:U64, type:EventType, data:EventData }
```

The merged envelope has exactly
`{version:1,sequence:U64,source:'coordinator'|'provider',event:SourceEvent}`.
`source` is authenticated machine provenance, not copied from model text, an
HTTP body supplied by an arbitrary client, or `event.role`. For the private
provider API it must be `provider`; for the local coordinator journal it must be
`coordinator`. The envelope conversation must match the pinned conversation.

- `ID`: exactly 64 lowercase hex characters, no `0x`. Used for conversation,
  demo task/request/control IDs and configuration fingerprints. Task IDs accepted
  by the older coordinator may be looser; this demo boundary is not.
- `Address`: exactly `0x` plus 64 lowercase hex characters.
- `U64`: canonical decimal string `0|[1-9][0-9]*`, at most `18446744073709551615`.
  No padded `"01"`, signs, whitespace, exponent, JSON number or conversion through
  floating point. Source event ID and merged sequence are positive; a cursor
  starts at `"0"`. They are decimal IDs, not hexadecimal digests.
- `ToolID`: valid Unicode, 1–512 UTF-8 bytes, no control characters. The selected
  Responses adapter produces 64-hex scoped call hashes; keep this opaque tool-ID
  field distinct from decimal source IDs. Operator call IDs are `ID` exactly.
- All text rejects lone surrogates; count UTF-8 bytes, not JavaScript code units.
  Text is plain untrusted text, never executable markup/code. A complete encoded
  source event must fit the existing 65,536-byte bound, including escaping and
  nested fields; the 1-MiB/8,192-record source journal caps remain in force.
- Byte arrays contain integer numbers 0–255, with the exact lengths below.
  No base64/hex substitution or numeric-string coercion. A `Signed<T>` has
  exactly `{payload:T,signature:Byte[64]}`.
- Source cursor is exactly `{coordinator:U64,research:U64,host:U64}`. Its query
  encoding is unpadded base64url of UTF-8 canonical JSON (recursively sorted object
  keys); reject noncanonical re-encoding, unknown/missing keys and duplicate keys.
  Empty/missing HTTP cursor uses the explicitly documented all-zero cursor, never
  a partial supplied object. Standalone `AgentEvents.replay` remains unchanged.

Strict parsing precedes trusted casts: reject duplicate keys, prototype-key
tricks, non-JSON values and extra fields at every nested level. Use own-key
membership / prototype-safe maps. Network parsers bound bytes before allocation
and parsing. A field's textual bound never overrides the full event/journal cap.
L1 must reserve encodable publication/recovery headroom before new effects;
reject incompatible configured output bounds before admission, not truncate a
signed receipt or silently split a final-text event into invented deltas.

## 3. Original emitters: exhaustive allowed variants

Notation: `C/C` = coordinator machine / coordinator event role; `C/H` = coordinator
/ host; `P/R` = provider / research; `P/H` = provider / host. `null`, literals and
every displayed key are exact. Any unlisted source/role/type/data variant fails.
“Text” is bounded by the enclosing source event and the producer limit below.

| Type | Origin; outer request | Exact `data` |
|---|---|---|
| `task_started` | C/C; null | `{task_id:ID}` |
| `model_text` | C/C; null | `{text:Text}` |
| `tool_started` | C/C; paid request ID | `{name:'research'|'follow_up',call_id:ToolID}` |
| `tool_started` | P/R; paid request ID | `{name:'web_search',call_id:ToolID,arguments:{query:Query}}` |
| `tool_started` | P/R; paid request ID | `{name:'web_fetch',call_id:ToolID,arguments:{url:URL}}` |
| `tool_result` | C/C; null | `{name:'budget',call_id:ToolID,result:{snapshot:Budget}}` |
| `tool_result` | C/C; null | `{name:'stop',call_id:ToolID,result:{stopped:true}}` |
| `tool_result` | C/C; paid request ID | `{name:'research'|'follow_up',call_id:ToolID,result:{text:DeliveredText,receipt:Receipt}}` |
| `tool_result` | C/C; paid request ID | `{name:'research'|'follow_up',call_id:ToolID,success:false,code:NoDispatchCode}` |
| `tool_result` | P/R; paid request ID | `{name:'web_search'|'web_fetch',call_id:ToolID,success:boolean,result_bytes:number}` |
| `tool_result` | C/H; task ID | `{name:'operator.task',call_id:ID,result:{state:'completed'|'failed'|'cancelled'|'uncertain',text:Text}}` |
| `tool_result` | C/H; null | `{name:'operator.status',call_id:ID,result:{activeTask:ID|null,activeRequest:ID|null,state:'idle'|'running'|'completed'|'failed'|'cancelled'|'uncertain'}}` |
| `request_started` | C/H; paid request ID | `{request:RequestV2,request_hash:Byte[32]}` |
| `delivery` | C/H; paid request ID | `{checkpoint:Signed<Checkpoint>,output:Byte[0..1024]}` |
| `turn_terminal` | C/H; paid request ID | `{receipt:Receipt}` |
| `budget` | C/H; null | `Budget` |
| `budget` | C/H; paid request ID | `{...Budget,action:'mechanical_credit'}` — explicit field construction, not arbitrary spreading |
| `channel_final` | C/H; null | `{checkpoint:Signed<Checkpoint>}` |
| `settlement` | C/H; null | `{channel:Address,status:'closed',digest:TxDigest,paid_mist:U64,refund_mist:U64}` |
| `error` | C/C; paid request ID or null | `{code:CoordinatorCode}` |
| `error` | C/H or P/H; null | `{code:HostCode}` |

These are current shapes, not instructions to emit all of them for every task.
`AgentServiceClient.event` uses host role. The provider wrapper emits only web
tool arguments and summary counts, never web results/page bodies/citation text.
`AgentServiceHost` itself currently supplies no public EventSink; its received
or generated deliveries must not be invented as provider-origin public events.
Provider-origin `delivery`, `model_text`, `turn_terminal`, `budget`, `settlement`
and any coordinator role are invalid, even with valid-looking nested evidence.

Correlations: `RequestV2.request`/`Receipt.request` equals outer request;
their conversation equals envelope conversation. Operator task `call_id` equals
its outer task request. Coordinator research receipt text is a duplicate summary
of already delivered text, not another output chunk or payment. `model_text`
and `operator.task.result.text` describe the same coordinator task answer; render
one canonical answer, not concatenate both. Correlate the null-request model
event to the sole active task from `task_started`/host control history. When a
transcript begins mid-history, mark unknown correlation rather than guess.

Bounds: task/coordinator input and research question are at most 16,384 UTF-8
bytes. `RequestV2` is exactly `{version:2,conversation:ID,request:ID,sequence:U64,
prompt:string}` with positive sequence and nonempty prompt up to 16,384 bytes.
Coordinator output is limited by its pinned runtime profile (default 32,768
bytes) and the full source-event cap. Delivered summary text must equal the
verified request delivery reconstruction and satisfy the existing 64-KiB
coordinator tool-result limit including its receipt. `result_bytes` is the
existing numeric safe integer 0–65,536; it is diagnostic result size, not MIST or
delivered output. Query is nonempty, at most 256 UTF-8 bytes and 50 whitespace-
delimited words. URL is nonempty, at most 2,048 UTF-8 bytes, HTTPS, no userinfo,
fragment or non-443 explicit port; use the configured host policy where the web
operation/citation requires it. Do not publish an invalid/unapproved argument
object before tool validation. A rejected attempt can have its fixed failure
summary without publishing unsafe arguments or inventing successful dispatch.

## 4. Nested public records and evidence

`Budget` has exactly `limits,channel,authorized_mist,delivered_mist,redeemed_mist,
settled_prior_mist,remaining_mist,outstanding_mist,requests_remaining,uncertain`.
`limits` has exactly `max_total_mist,max_channel_deposit_mist,max_turn_mist,
max_outstanding_mist,max_requests,deadline_ms,output_tranche_bytes`.
Money/timestamps are U64; channel is Address|null; booleans are actual booleans;
`max_requests` is integer 1–32, `requests_remaining` is integer 0–max_requests,
`output_tranche_bytes` is integer 1–262,144. Limits must equal pinned configuration;
the existing budget invariants still apply. Budget authorization is a reserved
maximum, not proof that that much credit was signed or redeemed.

`Receipt` has exactly `version,conversation,request,request_hash,sequence,outcome,
reason,checkpoint_hash,delivered_units,generated_output,discarded_output,
continuation,citations`. Version is 2; hashes are Byte[32]; sequence positive U64;
outcome is completed|failed|cancelled; continuation is ready|requires_channel_close;
units are exactly two U64s. **generated_output and discarded_output are U64 byte
counts, never text.** Current host receipt reasons are null, `invalid_citation`,
`cancelled` or `backend_unavailable`; do not rewrite signed/proven receipt fields
to turn an unsupported record into an accepted one. A receipt is not channel
close and a failed/cancelled task does not undo already delivered units.

Citations are an array of at most eight exact objects
`{id,url,title,retrieved_at_ms,content_hash}`. IDs are `s1` through `sN` in order,
unique within that request; title is valid text up to 256 UTF-8 bytes, URL has
the safe URL bounds above, timestamp is U64, hash Byte[32]. They are approved
fetched-ledger metadata from the verified receipt, not search snippets or fetched
body text. Receipt generated bytes must equal request-local delivered output
bytes plus discarded bytes; cumulative delivered units must match its last
verified checkpoint/baseline. UI links render only validated HTTPS and use
`noopener noreferrer`; never make an unknown citation ID into a fabricated URL.

`Policy`, `Offer`, `Credit`, `Checkpoint` retain the exact fields/purposes/method/
version from `streaming-codec.ts`; the shared pure helper mirrors those public
shape checks, not a new signing codec. Common statement fields are exactly
`purpose,method,version,network,package_id,deployment,buyer,provider`. Purpose is
the existing kind-specific `m2m/streaming/<kind>/v1` UTF-8 bytes; method is
`sui.streaming.v1`; version 1; network 1–64 valid UTF-8 bytes; addresses canonical
and parties distinct. Suffixes are:

- Offer: `buyer_key,provider_key,refund,payee,opening_nonce,policy_hash,deposit,
  offer_expires_ms,work_deadline_ms,claim_deadline_ms`.
- Credit: `channel,offer_hash,sequence,request_sequence,request_hash,
  previous_checkpoint,units,cumulative_amount`.
- Checkpoint: credit suffix plus `credit_hash,output_hash,final` (same field set
  as the existing codec; object key order is not a different statement).
- Policy: exactly `purpose,version,units,rates,denominator`; demo dimensions are
  input_utf8_bytes then output_utf8_bytes. Rates/denominator U64, denominator
  nonzero; exact policy matches config and offer hash. Array unit names are the
  existing UTF-8 byte representation, not display strings.

Keys/nonces/hashes are Byte[32], units exactly two U64s, quantities and timestamps
U64, positive statement sequences, `final` boolean. Existing offer deposit/
deadline/price-overflow/signature checks remain mandatory. `TxDigest` is a
canonical Sui base58 32-byte digest, not a fake `0x` transaction ID or URL.

L1 verifies with the existing native/streaming engines before emitting. L2 binds
all evidence to the selected known channel/offer/parties/policy and source, and
checks cumulative ordering and exact duplicate equality. Only C/H verified
delivery bytes feed provider-panel text and delivered counters. Empty input
checkpoints are valid. A delivery checkpoint must be nonfinal, output hash and
request match, and its output-unit increase equals the byte array length; final
checkpoint has `final:true` and no new output. Keep a streaming fatal UTF-8
decoder per request across frames: bytes can split a Unicode scalar. Do not
decode each frame independently or flush on disconnect; finalize at validated
terminal delivery. Identical checkpoint replay adds zero bytes/units.

## 5. Fixed public codes

`NoDispatchCode` is exactly `cancelled_before_dispatch|budget_rejected|
deadline_exceeded|request_limit_exceeded`. It is public wording, never a proof
category reconstructed from peer text; only the trusted typed host path provides
no-dispatch certainty.

Current coordinator error constructors use the following finite `CoordinatorCode`
set, plus `backend_unavailable` for unknown exceptions:

```text
already_initialized budget_policy_conflict budget_uncertain channel_mismatch
channel_not_bound channel_not_open channel_open channel_status_conflict
conversation_busy coordinator_closed credit_not_monotonic deadline_expired
delivered_mismatch deposit_exceeded funding_conflict funding_limit integer_overflow
invalid_agent invalid_argument invalid_budget_limits invalid_channel_binding
invalid_coordinator_options invalid_credit invalid_integer invalid_json_value
invalid_observation invalid_opening_nonce invalid_policy invalid_receipt
invalid_request invalid_task invalid_tool_arguments invalid_units journal_corrupt
journal_limit journal_missing ledger_closed limit_exceeded
observation_lowered_authorization observation_regressed output_tranche_limit
outstanding_limit profile_mismatch profile_not_bound request_active
request_baseline_mismatch request_conflict request_limit storage_failure task_conflict
total_limit turn_limit uncertain_execution unknown_request unknown_tool
unreserved_authorization unsafe_state_directory worker_shutdown_uncertain
```

Proposed demo `HostCode` is that set plus NoDispatchCode and this closed set:

```text
runtime_error backend_unavailable backend_context_unavailable backend_launch_uncertain
agent_tool_runtime_unvalidated search_unconfigured identity_changed authority_unavailable
runtime_profile_mismatch invalid_config invalid_control control_conflict
control_not_allowed invalid_event invalid_event_cursor event_conversation_mismatch
event_journal_limit projection_conflict projection_gap projection_limit
provider_unavailable provider_start_failed connection_failed transport_closed
publication_pending publication_failed
spending_paused waiting_for_credit funding_uncertain settlement_uncertain
uncredited_channel_requires_expiry_refund refund_not_eligible duration_limit
output_limit response_limit recovery_limit tool_result_uncertain
```

The same closed host set applies to nullable lifecycle/status/control `code`
fields. New useful codes require an explicit shared-contract/fixture change.
The legacy `safeError` regex accepts arbitrary snake_case exception messages and
does **not** establish a trusted finite code set. L1 demo construction maps typed
known error categories to these literals before append; unknown exceptions become
the fixed `runtime_error` without copying text. L2 rejects unknown published codes;
it must not silently sanitize an already-numbered event and claim original-source
equality. No raw exception text, stack, private path or error body is public.

## 6. Six proposed additive local-only event types

All have event role `host`, unchanged source-envelope version 1, and exact data:

| Type | Origin; outer request | Data and cross-check |
|---|---|---|
| `runtime` | C/H or P/H; null | `{status:DemoRoleStatus}`; status.role matches machine, conversation/config/runtime pins match; cursor is pre-append source high water |
| `connection` | C/H or P/H; null | `{connection:DemoConnection,actor:'operator'|'host'}`; provider actor is host, since no provider control API exists |
| `control` | C/H; null | `{control:DemoControlRecord}`; nested task/channel provide correlation; exact stored command and durable state, no fabricated acknowledgement |
| `funding` | C/H; null | `{channel:Address|null,opening_nonce:ID,deposit_mist:U64,transaction:DemoTransaction}`; nonce/deposit match retained opening and never imply confirmed funds from submission alone |
| `authorization` | C/H; paid request ID | `{channel:Address,credit:Signed<Credit>,actor:'host'}`; actual saved signature, tied to that request/channel, distinct from reservation or peer acknowledgement |
| `chain_observation` | C/H; null | `{channel:Address,status:'open'|'closed'|'refunded',redeemed_mist:U64,locked_mist:U64,refunded_mist:U64|null,observed_at_ms:U64,terminal:DemoTransaction|null}`; independently checked fresh chain object only |

Nested DemoRoleStatus/DemoConnection/DemoControlRecord/DemoTransaction use the
exact already frozen fields in `demo-types.ts`, including every nullable field;
no optional bags. Validate enums, IDs, U64s, lengths and pinned identity/config
relations. The runtime descriptor is exactly version 1 / responses-tools-v1 /
gpt-5.6-luna / xhigh. Commands use the existing nine-operation discriminated union
with exact operation-specific keys; task prompt is nonempty, max 16,384 UTF-8
bytes. Transaction state is pending|confirmed|failed|unknown; digest is
TxDigest|null; gas is null or the four exact U64 fields in DemoTransaction.
Connection path direct|relay|unknown is measured host evidence, not guessed from
deployment regions. Runtime events cannot recursively contain their own future ID.
Control IDs bind immutable command bytes, accepted timestamp and task mapping;
updated timestamp cannot precede acceptance. Enforce the frozen lifecycle's
legal state transitions, never let an older event replace a later control state,
and do not derive permission from a model tool named like a control.

The public source schema rejects any provider-origin authorization/funding/chain
observation/control. Provider status/connection cannot advance coordinator money
or controls. Local source event IDs remain stable when importing an existing
canonical credit/checkpoint/control publication after restart.

Only a confirmed terminal chain observation with empty funds and checked terminal
evidence clears active outstanding/reserved exposure; historical maxima remain.
In a snapshot this requires closed/refunded status, locked_mist `"0"`, known
redeemed_mist and observed_at_ms, and a terminal transaction with state confirmed
and a valid nonnull digest, all matched to the same independently checked channel.
Otherwise preserve `max(signed-delivered,0)` / `max(reserved-delivered,0)`.
Refund stays null until independently known. Terminal labels, a submitted digest,
model completion, `channel_final`, `settlement` summary alone or RPC failure do
not substitute for that confirmation. Unknown chain state is represented by
degraded status/snapshot nulls, not an invented chain_observation with zero funds.

## 7. Source merge, snapshot/history and SSE coupling

Deduplication key is `(conversation,source,event.role,event.id)`; timestamp is not
an ordering key. Each source+event-role starts at ID `"1"` and increments by one.
Same key and canonical content is a no-op; changed content, unknown schema or
gap fails that source visibly and blocks admission. Never skip an invalid record
and advance its cursor. C/H ID 1 and P/H ID 1 are two distinct records.

SourceEventPage has the exact frozen fields. Its high_water is the captured
per-role source high water; pages preserve original append order. With has_more
true, imported per-role cursors may be below high_water; request the next page
from the actually imported cursors, not advertised future high water. On the final
page all captured cursors must be covered. Enforce 256 records/1 MiB per page,
pin source/conversation and reject changed earlier records across pages.

Merged sequence starts at `"1"`, contiguous over all accepted source records;
persist merge/source cursors before publication. Exact repeats add no new merged
sequence. UI checks both merged sequence/content equality and source identity;
same source event at a different merged sequence is inconsistent, not more work.

Snapshot is the exact frozen `DemoSnapshot`, materialized at its stated
projection_sequence S, not live handles sampled independently around S. Channel
history, cumulative budget/economy, role states, controls and identity/config pins
must describe that same cut. L2 owns atomic snapshot/cursor coupling. Unsupported
network, mode, missing keys, mismatched channels/config or impossible confirmed
accounting state rejects the snapshot; do not substitute a fixture/default.

Snapshot contains no transcript history. Approved existing-endpoint bootstrap:

1. Fetch authenticated session/snapshot at S and retain that immutable state base.
2. Subscribe to SSE from sequence 0 to rebuild retained history. Events <= S
   rebuild transcripts/actions/source dedupe only: do not reapply their accounting,
   host controls or historical money animations to the snapshot.
3. Retain and apply events > S in exact order to live state, even if they arrive
   during history rendering. Do not discard them at cutover or refresh. Controls
   remain disabled while history/state synchronization is incomplete or invalid.
4. On reconnect use the last fully validated/applied browser event cursor, not S
   or 0 after a later cursor was reached. On a deliberate fresh snapshot refresh,
   buffer concurrent events and use the same base-cut rules; never reset source
   dedupe into a gap or apply an event twice. A full reload may intentionally
   discard all prior in-memory state and restart this complete bootstrap.

SSE durable frame is `event: agent_event`, ID `<conversation>:<sequence>`, and one
JSON merged record in data. ID and JSON conversation/sequence must agree exactly.
Accept LF or CRLF split across network chunks, split UTF-8 and legal multiline
data joining; bound incomplete frames (128 KiB maximum). A malformed frame/JSON,
unknown event type, mismatched ID, duplicate conflict or gap stops consumption
without advancing the cursor; show reconnection/recovery failure, never skip it.

Proposed explicit ephemeral status payload is
`{version:1,conversation:ID,state:'replaying'|'live',high_water:U64}` with event
`stream_status` and **no id field**. L2 emits replaying at the captured replay cut
and live only once that cut is delivered and live subscription is gap-free.
This does not advance durable cursors or affect money/control state. Fifteen-
second comment heartbeats likewise carry no effects. A browser connection label
is separate from Iroh connection state. Future/foreign/invalid Last-Event-ID fails
before headers; no silently reset cursor. Retain the existing authenticated,
no-store/uncompressed stream, 256-KiB slow-client bound and token refresh rules.

## 8. Minimum shared fixtures and acceptance

Fixtures are labeled test fixtures outside the production envelopes. They use
real-shaped canonical IDs/decimals, byte counts and signed-statement structures;
fake model text or fake signatures never become live evidence. Use the existing
verified codec fixtures when a test asserts cryptographic validity. No shipped
UI/backend imports a fixture fallback.

- One positive fixture for every table row, every tool-result variant, every
  lifecycle type/origin and nullable status/transaction state. Include input-only
  delivery, split multibyte output, failed/cancelled receipts with paid delivery,
  and no-credit expiry refund without a fabricated final checkpoint.
- Negative envelope/provenance matrix: provider delivery/economic/control,
  coordinator-machine research role, malformed/padded/zero/future IDs, wrong
  conversation/config, duplicate/extra/prototype keys, malformed Unicode,
  stringified booleans/numbers, invalid arrays and oversized nested records.
- Privacy: unknown extra secret/credential/path/raw-response/page-body fields at
  every nesting level reject before publication; provider result summary accepts
  only success/byte count. Unknown snake_case error strings are not trusted codes.
- Receipt/citation relations: wrong request/hash/sequence, text in generated_output,
  inconsistent delivered/discarded counts, unapproved URL, duplicate/missing source
  ID, nine citations, wrong content-hash length and altered signed field reject.
- Shared accounting vectors: latest cumulative ceiling, exact integer price,
  unsigned reservation versus signed authority, verified delivery only, unknown
  redeemed/refund nulls, confirmed terminal+empty funds versus pending/nonempty
  terminal, historical channel switch and already-redeemed-above-delivery warning.
- Source/merge: C/H 1 plus P/H 1 distinct; identical source replay no new sequence;
  conflict/gap fails; paged high water is not cursor advancement; crash between
  canonical evidence and publication imports exactly once and does not hide a
  failed durable sink as task success.
- Browser stream: valid real dashboard history from snapshot S/replay0; events
  after S arriving during backfill/refresh retained; reconnect after later cursor;
  exact duplicate no animation/payment; byte-split CRLF/UTF-8/multiline frames;
  SSE ID mismatch/malformed middle event/gap stops without skipping; a stale
  browser connection is not an Iroh disconnect or new spending authority.

L1/L2/UI all run the shared positive/negative corpus through their real validators
and integration boundaries. Tests of a parallel unused helper or login-only
screenshots do not validate event ingestion, dashboard accounting or live behavior.

## 9. Frozen shared-helper handoff

Root coordinated this API on 2026-09-11. Luna owns only the new
`scripts/agent-demo-event-contract.ts` and
`scripts/test-agent-demo-event-contract.ts` for this slice. Root owns shared
types, package wiring and fixture corpora. Leave the current UI and other owners'
runtime/lifecycle files unchanged until the helper has an Astra review. Installing
the accepted helper in real L1/L2/UI boundaries is a subsequent required step,
not established by passing helper-only tests.

```ts
// Type-only imports from demo-types.ts, agent-events.ts and other neutral types.
export type DemoContractCode = 'invalid_json' | 'invalid_event' |
  'invalid_event_cursor' | 'invalid_snapshot' | 'invalid_stream_status';
export class DemoContractError extends Error {
  readonly code: DemoContractCode;
  constructor(code: DemoContractCode);
}
export function parseDemoJson(text: string, maxBytes?: number): unknown;
export function canonicalDemoJson(value: unknown): string;
export function validateSourceCursor(value: unknown): SourceCursor;
export function encodeSourceCursor(value: unknown): string;
export function decodeSourceCursor(value: unknown): SourceCursor;
export function validateDemoSourceEvent(value: unknown,
  pins: DemoValidationPins & { source: MachineRole }): AgentPublicEvent;
export function validateDemoEvent(value: unknown,
  pins: DemoValidationPins): DemoEvent;
export function validateDemoSourcePage(value: unknown,
  pins: DemoValidationPins & { source: MachineRole }): SourceEventPage;
export function validateDemoSnapshot(value: unknown,
  pins?: DemoValidationPins): DemoSnapshot;
export function validateDemoControl(value: unknown): DemoControl;
export function validateDemoControlRecord(value: unknown,
  pins: DemoValidationPins): DemoControlRecord;
export function validateDemoRoleStatus(value: unknown,
  pins: DemoValidationPins & { source: MachineRole }): DemoRoleStatus;
export function validateDemoSessionResponse(value: unknown,
  pins?: DemoValidationPins): DemoSessionResponse;
export function validateDemoStreamStatus(value: unknown,
  conversation: ID): DemoStreamStatus;
```

`DemoValidationPins` is exactly the shared type in `demo-types.ts`:
`{conversation,configuration_hash,config,agents:{buyer,provider}}`. Pinned
AgentRefs bind public statement parties/network/package/deployment. L1 obtains
them from protected validated host configuration; L2 from the same authenticated
runtime; UI derives them from a structurally validated authenticated bootstrap
snapshot. Never derive authenticated machine provenance from the event body.
Snapshot bootstrap without pins still validates every nested shape and its
internal relations. Subsequent snapshots additionally equal the retained pins.
Identity observation times and role state may change; do not freeze those as
immutable identity pins or confuse shape validation with fresh authorization.

Return detached JSON values, never mutate input, preserve all supported public
fields, and do not silently sanitize unknown fields. Failures have only their
fixed code/message, without private data or original exception text. Do not
expose configuration, hashes, byte counts or credentials in error messages.
The standalone control/role validators expose the same nested checks used for
events (`invalid_event` on failure); the exact session envelope additionally
validates version/access/snapshot (`invalid_snapshot` on failure). These exports
avoid a second weaker finite-route schema in UI/L2. The HTTP control/status
response wrappers still require their exact `{version,record}` / `{version,snapshot}`
keys before using these helpers. Immutable control-request matching and legal
state transitions require retained host/HTTP/browser state as specified above.
`parseDemoJson` checks encoded size before parsing, uses a fixed maximum nesting
depth of 64, rejects duplicate and prototype-sensitive keys, malformed Unicode,
nonfinite values and trailing input. Its default cap is 1 MiB; explicit caps are
positive safe integers at most 16 MiB. Network consumers must also enforce the
byte cap while receiving, not allocate an unbounded response before this call.
`canonicalDemoJson` recursively sorts own object keys and rejects non-JSON inputs,
accessors, invalid prototypes, cycles, sparse arrays, lone surrogates and excessive
depth. This canonical representation supports equality, not new economic signed
bytes. Strict source cursor decode accepts only a supplied canonical string;
the HTTP layer explicitly handles a missing cursor as all-zero before calling it.

Implement the exhaustive section 3/6 variants and section 4/5 nested records,
including canonical byte-array representations of codec purpose/method fields.
Use exact BigInt arithmetic for policy/accounting checks with existing u64/u128
overflow limits. Mirror the codec's data validation; do not import Node crypto,
native-chain runtime code or create a second signing codec. Stateless validation
can bind fields and amounts to pins and mutually present snapshot evidence. It
cannot verify a signature, derive an absent request baseline, determine whether
a transaction was independently observed, or detect a conflict with an absent
prior event. Those checks remain explicitly required in existing trusted engines
and stateful L1/L2 reducers; a helper pass is never an economic verification pass.
The default text ceiling is 32,768 UTF-8 bytes for coordinator output; the complete
65,536-byte source-event bound still applies. Admission of nondefault producer
limits must also reserve the real publication bound in L1 before effects.

Tests must cover every allowed variant and each listed privacy/provenance class,
roundtrip/canonical cursors, input immutability, scalar/depth/size boundaries,
and snapshot arithmetic including unknown and confirmed-terminal states. Use
the signed economic fixture for real-shaped evidence, with visible test labels
outside production envelopes. Root will run independent vectors and Astra will
review the helper before its use by other owners. No new dependency, runtime
fallback, public transaction or deployment is authorized by this assignment.
