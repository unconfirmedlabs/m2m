# Responses runtime: repaired-hash Astra re-review

Checked 2026-09-11 by Astra `xhigh`. This is a separate
read-only implementation review of the Luna repair, not an amendment to the
[original RR-01–12 findings](responses-runtime-astra-review-2026-09-11.md) or live
acceptance. **Return for correction; keep `agent_tool_runtime_unvalidated`.**
No actual inference, credentials, web research, Iroh/Sui execution, funding,
provisioning or deployment occurred. No implementation or owner test was edited.

## Frozen provenance and actual passing evidence

All five hashes matched the handoff both before and after probing:

| File under `scripts/` | SHA-256 |
|---|---|
| `agent-runtime.ts` | `a3967367c1636451af3cdd205762215a5ff440c3fb89a13b3e55f13ecce79943` |
| `responses-transport.ts` | `39abef131766390d8a904cd812acb0e7f1f3b2c797091c2fede81d6f11a42443` |
| `responses-worker.ts` | `abb99ae39eaa65b04a4d904999b5d47683d3e5e4ca19ff2794e2c0b2fed7d24b` |
| `test-responses-transport.ts` | `42b93875f5d5eb65f875fcf6effd6150ee25df1081bb8e0ffe16a9652be1008f` |
| `test-responses-worker.ts` | `4e9626e71e1fb737aa5f5ff120f0840150e9b677c8e6c3aa9bb88073f851dc38` |

Independently reran and passed:

```sh
npm run agent-runtime-tests
npm run agent-runtime-integration-tests
npm run typecheck
```

Both `tsx scripts/test-responses-worker.ts --live` and `--live-continue` still
exit 1 with `live_probe_unimplemented`, before fixture execution or network use.
This is a preserved gate, not passing R14 evidence.

The root integration test was also read. Its actual coordinator, Responses
worker and BudgetLedger use explicitly injected transport/ResearchPort/channel
bindings. Assertions now establish one initial POST and no continuation after an
uncertain paid result; explicit reconciliation retains the exact local thread,
generating response, callback and paid request IDs; exactly one continuation
uses the saved result; completed coordinator replay adds no callbacks, research
effects, POSTs or GETs. Both valid complete streams require **zero recovery GETs**.
These are useful narrow same-process fixture assertions, not crash, chain,
network or live-model evidence.

Independent positive checks additionally established:

- A held external `cancel` keeps shutdown pending: grace expiry returns
  `worker_shutdown_uncertain`, an actual competing reopen fails `worker_lock`,
  and releasing the cancellation allows shutdown and replacement. The old
  instance's subsequent `reconcile` fails `worker_closed`.
- A new task after orderly restart uses the saved previous response ID. This
  probe made zero predecessor GETs; it does **not** establish expired-context
  rejection before creation.
- A valid multiline `data:` JSON event with split CRLF parses successfully.
  Existing production-HTTP tests exercise duplicate-key/Unicode/depth rejection,
  pre-abort, delayed byte charging, header timeout, midstream abort and close.
- The original created-event fallthrough and required synthetic `call_id` on
  argument-done events no longer block the root's official-shaped happy path.
  The original first-response `__proto__` global-prototype mutation probe is
  covered by the repaired owner test; this does not certify every opaque-ID map.

The OpenAI Docs skill was used to check current primary API evidence before
evaluating event assumptions. The [streaming-event reference](https://developers.openai.com/api/reference/resources/responses/streaming-events)
and [background guide](https://developers.openai.com/api/docs/guides/background),
opened 2026-09-11, distinguish response payload identity from item/output indices
and document known-ID sequence resume. The review does not require invented
`response_id`/`call_id` fields on events that do not declare them, or turn optional
API fields into universally mandatory ones. The fixed host policy and durable
identity bounds remain requirements of AR-05–14, separately from API syntax.

## Confirmed remaining blockers and exact regression recipes

All probes below ran the frozen production worker or transport. Worker probes
were isolated `node --import tsx --input-type=module -e ...` programs with real
private temporary journals and a strict empty-object `status` tool. Response
metadata was copied from the actual submitted body, with a matching predecessor;
normal message/function items had their documented role/status/identity fields.
Fault variants changed only the identified boundary. Child-crash cases used real
process exit, followed by lock reacquisition and journal reopening. HTTP probes
rerouted only `https.request` to a loopback Node HTTP server: production body
iteration/parser/charging ran, but these probes are not TLS evidence.

### NR-01 — P1: acknowledged continuation is submitted again after a crash

Related RR-02 / R05–06. `responses-worker.ts:893` (`execute`), particularly the
intent-recovery branch followed by the pending-result branch.

1. Response `resp-1` completes with `status`; handler returns saved `ok`.
2. The continuation POST creates `resp-2`. Exit the child immediately after
   yielding/processing its valid `response.created`; before any response-2
   terminal event. Disk has known IDs `[resp-1, resp-2]`, acknowledged intent for
   step 1, and the old `pendingCallId`/`continuationResult`.
3. Reopen; make GET `resp-2` return a valid complete text-only response. Call
   `run` with the identical original request/prompt.

Observed: **one new POST**, in addition to GET `resp-2`, submitting the exact
already-sent `function_call_output` again, now with `previous_response_id:resp-2`.
With a fresh response ID for that erroneous third POST the worker completes;
there is no artificial duplicate-ID rejection needed to reproduce the effect.
Expected: zero new POSTs/handlers, settle the completed second response and retain
it as predecessor. Commit the consumed-result/continuation-step association so
recovery cannot confuse an old pending result with an unsent one. Test both
`run` replay and `reconcile`, not only the latter as in the current first-ack test.

### NR-02 — P1: pending nonrecoverable callback reexecutes; prepared recovery changes input

Related RR-02/03 and AR-07/10; `invokeCall` at 808, `reconcileInternal` at 972.

For the callback case use `recoverableTools:[]` and exit the child **inside the
first handler**, after the worker has persisted its `state:'pending'` record.
Reopen the same fingerprint and replay the original request. Observed one new
handler invocation plus one continuation POST, ending completed. The existing
guard protects only `state:'uncertain'`, not the more important crash-retained
`pending` state. Expected zero handler/POST effects and durable uncertainty.
Add the same case through explicit reconciliation, and positive same-ID recovery
only for genuinely recoverable callbacks.

Separately, wrap the real synchronous `persist` in a child and exit immediately
after the first prepared request save, before any creation intent. On reopening,
call `reconcile(ref)`. Observed one POST whose user input text is **the empty
string**, not the original committed `review prompt`. `reconcileInternal` creates
an empty `WorkRequest`, while prepared state retains only its hash. Expected no
invented input: either reconstruct the exact saved prompt/body under the contract
or refuse creation until exact caller input is supplied. A recoverable intent
must never be reconstructed from an empty placeholder.

### NR-03 — P1: cancellation clears an unacknowledged continuation by cancelling its predecessor

Related RR-02/09 / AR-08/12; `cancelRecord` at 866 and `applySnapshot` at 739.

Complete `resp-1` with a successful tool result, then let the continuation POST
return an empty stream/no acknowledgement. Confirm initial state uncertain and
two POSTs. Call `cancel(ref)` and have the fixture return `{id:'resp-1',
status:'cancelled'}` for the received target. Observed target `resp-1`, returned
state **cancelled**, and a new task is admitted for **POST 3**. The latest escaped
intent had no response ID; its predecessor's terminal state cannot settle it.

Expected: no guessed cancellation target for that intent, durable uncertainty,
no third create, no allowance release; same outcome after close/shutdown/reopen.
Test cancellation and shutdown of a lost-ack continuation, not only replay of
the still-open request. Also include a realistic cancellation response reporting
the predecessor already completed; neither predecessor outcome proves the
unacknowledged successor terminal.

### NR-04 — P1: same-request concurrent admission executes a host callback twice

Related RR-03 / AR-07/12; `run` at 953.

Hold the first `status` handler on a deferred promise. While `run(request)` is
awaiting it, call `run` again with the **identical** reference/prompt. The busy
guard rejects only a different key. Observed `handlers=2`, `operations=2` and one
initial create before releasing either handler. Both invocations later returned
uncertain after competing state transitions; uncertainty does not undo the
duplicated external effect.

Expected: join/replay or reject the second admission before any handler/GET/POST;
at most one active handler/response across all public entrypoints and keys.
Include same-key run/run, run/reconcile and simultaneous reconcile admissions,
as well as the existing different-request rejection. Do not weaken the accepted
external-cancel/shutdown join described above.

### NR-05 — P1: full output validation remains incomplete and can create unreopenable state

Related RR-05/06/10; `validateOutput` at 437 and `applyEvent` at 495.

Each row was a valid created event followed by one complete snapshot, except the
explicit delta rows in NR-06. Effects/counts were checked before shutdown.

| Changed complete output | Actual observation |
|---|---|
| Assistant text, then `function_call` named `unregistered` | Text **31 bytes committed**, then uncertain/unknown_tool; zero automatic cancel calls |
| Assistant message with present `status:'in_progress'`, then registered function | One handler, two POSTs, completed |
| Assistant message ID `''`, then registered function | One handler, two POSTs, completed; orderly reopen fails `journal_corrupt` |
| Registered function with empty `call_id:''` | One handler before missing_tool_identity; orderly reopen fails `journal_corrupt` |

Expected: validate every complete item, identity, present terminal status,
registered name and full local argument policy **before accepting any new
snapshot text or handler effect**. Retain already legitimately delivered prefix
evidence, but do not commit new text from a snapshot whose later function is
invalid. Validate bounded identifiers consistently on input and journal read.
Do not invent requirements for optional upstream fields: distinguish a missing
optional field from a present contradictory value and from required host mapping.
Require zero handler effects, zero newly accepted invalid-snapshot bytes and
successful honest reopen for every negative fixture.

### NR-06 — P1: retained item/content identity is not an exact terminal prefix

Related RR-08 / R04. Emit created sequence 0, valid text delta `abc` at sequence 1
for item `answer`, content index 0, then a complete response at sequence 2:

| Terminal variant | Actual result |
|---|---|
| Same message ID but `content:[]` | Completed, retained text `abc` |
| Same ID changed from message to reasoning | Completed, retained text `abc` |
| Insert new message `earlier` before retained `answer` | Completed; public text order remains `abc` then `new-before` |
| Instead use delta content index `-1`, final message content index 0 | Completed with **two `abc` entries / six bytes** |

Expected: preserve and validate item type, output position and content-part
identity/order; every saved text part must occur in the complete representation
with its exact prefix. Reject negative indices before content publication. A
subsequence of item IDs alone is insufficient. Test retrieved snapshots as well
as streamed completion, including changed arguments/names and dropped call items.

Separate gap probe: created sequence 0 then delta sequence 2 returns
`uncertain/event_sequence_conflict`, with **zero GETs** despite a valid complete
snapshot being available. The repair detects the gap but does not perform the
bounded reconciliation required by AR-08. Distinguish reconcilable loss from
contradictory duplicates, and prove cursor/output commit atomicity with actual
crashes at its durable boundaries; the clone-and-commit structure is promising
but that complete crash matrix is not currently in the owner tests.

### NR-07 — P1: consumer stop does not persist cancellation of the actual request

Related RR-12 / AR-12/14. `makeDelivery` at 305; fresh-run construction at 953.

For a new request, emit created then text delta `prefix`; hold the stream. Have
the consumer return false on the content event. Observed actual worker state
still running, **no `cancelRequestedAt`**, no API cancel call; its I/O signal is
aborted. Delivery captured the placeholder record constructed before `execute`
created the canonical one. The cancellation mutates that placeholder instead.

Release the stream and make GET return the valid completed response with the
retained text plus a registered function. Initial run becomes uncertain; explicit
`reconcile` then invokes **one handler and one continuation**, ending completed.
Expected a real durable tombstone before abort, known-target cancellation, zero
new effects after stop/reopen/reconcile. Also test throwing consumers and a stop
on the first state event, with exact original deadline and lock retention.

Separately, hold the stream immediately after a valid created event. `status`
reports running and the acknowledged ID, but the consumer has only the launching
event. No durable running/dispatch event is emitted. The unchanged
`research-conversation.ts:586` recognizes dispatch through running/content/
terminal events plus worker status, not a launching event alone. AR-07/14 require
the first acknowledgement to become observable during the active stream even
before any text; add a held-after-ack assertion against that integration seam.

### NR-08 — P1: event exhaustion reports nondurable terminal success

Related RR-10 / AR-13/14. `state` at 336, `addEvent` at 328, create headroom and
`execute`'s terminal-aware catch.

Set `maxEvents:4`; complete one response containing three distinct one-character
assistant messages and no calls. The launching event plus three content events
fill the public journal. Observed `run` returns **completed**, while the actual
`responses-worker.json` still says **running**. Shutdown succeeds; reopened status
is running. `state` changes memory/deletes active admission before `addEvent`
throws, and the catch trusts the mutated terminal state.

Expected: every returned/published terminal state is already durable; reserve
terminal/cancel/recovery event and byte/entry headroom throughout generation,
not merely two free slots before the first POST. Reject/stop before exhaustion
can destroy evidence, never report transient in-memory success, and preserve
lock/admission behavior on genuine storage failure. Add near-limit byte, entry,
event, handler-result and write/fsync failure tests, not just `maxEvents:1`.

### NR-09 — P1: ordinary HTTP total deadline and byte accounting remain wrong

Related RR-04/11 / AR-04/13. `responses-transport.ts:250` onward, particularly
header timer removal and data handling at 315.

Actual loopback-routed production transport probes:

- With `requestTimeoutMs:20`, `streamIdleTimeoutMs:30`, immediately send JSON
  headers/opening text and a character every 8 ms, finishing after 105 ms.
  `retrieve` **succeeds at 116 ms**. Header timeout is removed and idle resets;
  there is no total ordinary-JSON request timeout. Test retrieve and cancel,
  including bytes arriving just under the idle threshold.
- With `maxResponseBytes:60`, stream eight small, individually valid SSE frames
  `data: {"n":i}\n\n`. It accepts four then rejects `response_body_limit`
  because total stream bytes exceed 60. That bound is for one event/retrieved
  response; total request bytes have a separate durable limit. Preserve bounded
  queues/frame parsing while allowing multiple bounded events up to that total.
- A one-chunk oversized JSON response yields `response_body_limit` with
  **charged bytes 0**. A one-chunk 400 response with a JSON error body also
  produces **charged bytes 0**. Check the transport's received-data callback,
  not an assumed server-write count: bytes reaching that boundary must be charged
  before rejection/discard. Aborting a non-2xx body need not drain unlimited data.

Current tests do exercise the real HTTP iterator, unlike the original handoff,
but their non-2xx case only checks an error code; their slow case delays headers,
not the ordinary body; their streamed responses stay below one-event byte cap.
Retain the repaired pre-aborted zero-request and async charge-before-yield tests.

### NR-10 — P1: terminal-control allowance has no byte headroom

Related RR-10 / AR-12/13. `charge` at 631 and `cancelRecord` at 866.

Set `maxReceivedBytes:100`; have the initial injected create charge exactly 100
bytes, yield a valid created event with status in_progress and then disconnect.
Make its first retrieval fail, leaving a known-ID uncertain request with **no
host calls**. The cancel transport receives that exact ID but charges one more
byte before returning a cancelled snapshot. Observed `cancellation_unconfirmed`
and the retained upstream status still in_progress: all paths share the exhausted
generation-byte counter. There is no separately reserved terminal-record/HTTP
headroom. Expected bounded terminal control can record the true backend terminal
state and confirm cancellation when no host operation remains, without refilling
generation. A separate pending-host-call variant must retain host uncertainty
even after the backend cancellation is confirmed.

Static related gaps, not additional measured passes: `recoverResponse` refuses
all GETs after the generation deadline; `controlAttempts` is a lifetime counter
capped at 3 although the frozen table says 3 per reconciliation invocation;
cancelled/failed/incomplete snapshots bypass metadata validation; failure events
can set terminal state without validating their response payload. Resolve these
against the frozen terminal-control and exact-target contracts, with explicit
bounded tests. Do not solve them with unlimited retries or new generation budget.

## RR disposition and missing acceptance rows

| Original finding | Repaired evidence / remaining disposition |
|---|---|
| RR-01 streaming shape | Normal root stream passes with zero GETs; first acknowledgement publication remains NR-07; owner fixtures still include synthetic convenience fields and are not an exhaustive API-shape oracle |
| RR-02 launch/restart | First no-ID and first acknowledged-ID tests improved; NR-01–03 still duplicate effects or clear unresolved execution |
| RR-03 lifecycle | Held external cancellation and old-instance guard independently pass; same-key concurrent callbacks fail NR-04 |
| RR-04 deadline | Owner test now proves the held SSE signal aborts and no late create after release; total JSON deadline fails NR-09; complete held-handler/late-result/control boundary matrix remains |
| RR-05 inherited keys | Own-key schema membership and first opaque-ID prototype regression improved; full opaque response/item/call IDs across continuation and reopen not established; NR-05 demonstrates reader/writer identity disagreement |
| RR-06 output policy | Invalid user-role/unknown-part rollback tests pass; NR-05 proves complete policy still not enforced before acceptance/effects |
| RR-07 bad metadata target | Acknowledged ID retained and explicit cancel works in the owner fixture; automatic bounded policy-rejection cancellation and terminal-payload validation remain incomplete |
| RR-08 cursor/recovery | Draft commit and first-ack resume improved; exact retained representation and gap recovery fail NR-06 |
| RR-09 cancellation | Straight known-ID cancellation works; lost-ack continuation and consumer tombstones fail NR-03/07 |
| RR-10 bounds/storage | Limit validation and shallow corruption tests improved; nondurable terminal success and absent control headroom fail NR-08/10 |
| RR-11 HTTP/parser | Production JSON now uses strict parser; pre-abort/close/async charge paths have tests; ordinary body timing and dropped-byte accounting fail NR-09 |
| RR-12 live delivery | Text reaches a consumer during a held stream and slow consumer does not prevent explicit cancel; ack delivery and consumer-initiated stop fail NR-07 |

No blanket R01–R12 acceptance is supported. Existing suites do not replace:

- R01: the full existing native/agent-services regression suite and runtime/
  manifest migration mismatch matrix (not rerun in this bounded review).
- R02–04: complete registered-schema/output/event families, proper refusal,
  contradictory/missing items, changed arguments, ordering and cursor crash
  matrices. The injected seam is a narrow valid positive, not this full matrix.
- R05–09: the exact child-crash and cancellation scenarios above, saved-result
  before/after continuation boundaries, nonrecoverable pending callbacks, all
  concurrent admissions, and inaccessible predecessor failure without fallback.
- R10–11: every numerical bound, near-cap admission, generation versus terminal
  headroom, real delayed save/fsync failure, parser/writer relationship corruption
  and reopened event/byte/counter invariants. The lifetime control-count policy
  needs an explicit conforming implementation, not undocumented reinterpretation.
- R12: protected credential-file modes/symlinks/nonregular/oversize/conflict
  cases, mocked pre-funding ordering and sentinel secrets/reasoning/raw errors.
  Only missing/direct-vs-file conflict and the closed production gate are covered
  here; no credential was read by this review.
- R13–15: real Iroh/localnet economic integration, the still-unimplemented
  isolated live probe, actual two-LLM research and Fly/testnet/UI acceptance are
  distinct outstanding gates. No payment-wire, Move or transport change is
  requested by this runtime return.

Correction priority: NR-01–04 and NR-07 first (duplicate effects/cancellation
certainty), then NR-05–06 and NR-08–10 (validation and durable bounds). Return
repairs to Luna, add permanent invariant assertions at each named boundary, then
freeze new hashes for another Astra review. Green smoke output alone is not
acceptance of these remaining conditions.
