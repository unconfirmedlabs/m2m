# Responses runtime: independent Astra review

Checked 2026-09-11 by Astra `xhigh`, after Luna's frozen implementation handoff.
Scope: `agent-runtime.ts`, `responses-transport.ts`, `responses-worker.ts` and
their two new tests, against AR-01–15 / R01–R12. Separate narrow review of root's
coordinator/Responses integration test and accounting oracles is recorded below.
This is a failed implementation review, not live acceptance. Keep the production
`agent_tool_runtime_unvalidated` gate. No API/search credentials, external model
requests, Iroh/Sui execution or remote mutations were used. Implementation files
were inspected but not edited by this reviewer.

## Provenance and baseline

Frozen SHA-256 values:

| File under `scripts/` | SHA-256 |
|---|---|
| `agent-runtime.ts` | `0fe0ff85cdb4f35c201d422f1d46499422df5d33015046450efc281556a62cf3` |
| `responses-worker.ts` | `d2921608bc6f7fbb7bc44c60adc01cc5bda9de7576555588d4efeedb2687a778` |
| `responses-transport.ts` | `bc40c07a2302b5055e1db8fb6b48b32bbd196dcb0c3bd0d7892f942ee85dd5ed` |
| `test-responses-worker.ts` | `5931e6a64c22f40e7dcaf8efbec2c23971e015a4156026c9d5190506e5bb0b43` |
| `test-responses-transport.ts` | `9ddfadf769ee63b3c3c4223a3229545880d86226880b640f3be4fe9a234f7bf3` |

These commands passed despite the failures below:

```sh
./node_modules/.bin/tsx scripts/test-responses-worker.ts
./node_modules/.bin/tsx scripts/test-responses-transport.ts
npm run typecheck
./node_modules/.bin/tsx scripts/test-agent-demo-vectors.ts
```

Fault probes were isolated `node --import tsx --input-type=module` programs using
the actual worker, private temporary journals, a registered empty-object `status`
tool, and injected transport promises/events. One probe used a child process
exiting immediately after the first durable acknowledgement. HTTP-parser probes
wrapped only `https.request` routing to a local Node HTTP server, preserving the
production transport's body iteration/parser; those probes are not TLS evidence.
All credentials were nonsecret literal fixture strings. Reproduction recipes
below specify the fault boundary and exact expected assertions for permanent
tests; inline probes are not shipped test coverage.

## Confirmed implementation blockers

### RR-01 — P1: valid streaming events are rejected; GET hides the failure

`responses-worker.ts:255–289`, especially lines 259–268 and 283–288.
`response.created` performs its initial work and then falls through to
`unknown_response_event`. Every normal fixture create stream therefore abandons
stream processing and retrieves a completed snapshot. The current happy-path test
passes because its transport already has that snapshot ready.

Repro: emit a valid created event followed by a completed text response; record
GETs and saved upstream cursor. Observed `creates=1`, `retrieves=[resp1]`,
`cursor=0`, `upstreamEvents=1`, worker completed. Expected zero GETs and accepted
stream events through completion.

Function argument delta/done handling separately requires `event.call_id`
(lines 274–277), which the checked Responses event schema does not supply. The
event carries `item_id`/`output_index`; retain the added function item's mapping
to its raw `call_id`. Official-shaped events on a resumed stream produced
`uncertain/invalid_function_call`, zero handler calls. Also remove invented
`response_id` fields from happy-path fixtures; the stream and response object
already establish identity. Checked the current [official streaming reference](https://developers.openai.com/api/reference/resources/responses/streaming-events)
on 2026-09-11. Its declared text-delta shape includes `logprobs`.

Required test: official complete function/text streams, no synthetic correlation
fields, no fallback GET/resume, exact callback and continuation counts. Test
intentional disconnect/retrieval separately, not as the happy path.

### RR-02 — P1: launch/restart state permits duplicate paid model creates

`responses-worker.ts:304–322`, `398–423`, `428–440`, journal validation at 176.
A new continuation intent leaves the predecessor in `currentResponseId`. If the
new create yields no acknowledgement, the old completed response is mistaken for
the new one, and the saved tool result is submitted again.

Repro: response 1 completes with one registered call; return a successful handler
result; all subsequent create streams are empty. With `maxResponses=3`, observed
three creates with predecessors `[null, resp1, resp1]`, ending `response_limit`.
Expected exactly two creates total and permanent unacknowledged-launch uncertainty;
reconcile/reopen must not produce create 3 or release reservations.

A separate actual child-process crash probe exited in the first `retrieve`
(after `response.created` had saved `resp1`, before terminal output). Reopen found
state `running`, known ID `resp1`; replaying the same request issued one fresh
create before retrieving `resp1`. Expected zero new creates, recovery of `resp1`
only. Associate each acknowledgement with its exact intent/step, distinguish an
unacknowledged latest intent from its predecessor, and recover existing work
before model admission.

### RR-03 — P1: shutdown releases locks with writers pending; closed instances restart effects

`responses-worker.ts:388–395`, `428–447`, `454–461`.
Public `cancel` and `reconcile` are not included in the shutdown join and have no
closed/poison admission guard. Reconciliation can execute a new continuation
outside the tracked `running` set. Per-conversation admission also allows two
different conversations to run concurrently in one worker root.

Confirmed probes:

1. Start from a known-ID uncertain request; hold external `transport.cancel`.
   Call `worker.cancel`, then `shutdown`. Shutdown resolved and a second worker
   acquired the same directory lock before the first cancel promise resolved.
   Releasing the promise caused another old-worker journal transition.
2. An uncertain recoverable handler returned once; shut down and open a replacement.
   Calling the old instance's `reconcile` then invoked handler 2 and create 2 and
   completed, while `oldWorker.lockReleased === true`.
3. Hold create; run two requests with distinct conversation IDs in the same root.
   Observed two creates and two tracked runs, not a competing-request rejection.

Required assertions: all asynchronous run/reconcile/cancel/storage/handler
transitions join or retain the lock; closed/poisoned instances cannot write or
start effects; shutdown rejection is retryable after quiescence; one request per
root. Tests must attempt an actual competing reopen while each boundary is held.

### RR-04 — P1: no absolute deadline supervision during SSE or a handler

`responses-worker.ts:315–334`, `365–380`, `409–422`.
Duration is checked only between complete operations. There is no absolute
watchdog to abort live SSE or a stalled handler and no deadline check immediately
before the handler effect after response collection.

Repro: `maxDurationMs=100`; resume an in-progress response and hold the resumed
stream before completion. After another 250 ms, run was unsettled and its active
signal was not aborted. Release a completed function response: one new handler
effect executed after the deadline. Expected no post-deadline handler/POST,
active I/O aborted by the original deadline, bounded local shutdown, and honest
uncertainty if a previously started handler does not quiesce. Add held-handler
and header/JSON/SSE deadline tests, including recovery and reopen.

### RR-05 — P1: inherited keys bypass argument policy and poison runtime maps

`responses-worker.ts:103–115`, `233`, `249`, `265`, `342–347`.
Schema lookup uses `properties[key]` without own-key membership. Response/call
maps are ordinary objects indexed by untrusted IDs.

Repro A: empty-object strict schema, arguments
`{"__proto__":"unexpected"}`. Observed completed task and one handler receiving
the extra key. Expected rejection before the handler.

Repro B: acknowledged response ID `__proto__`, completed empty output. Observed
`Object.prototype.completed === true` and an added `Object.prototype.usage`.
The isolated probe removed those two added fields before cleanup. Expected no
global mutation for any opaque ID; use own-key-safe maps/lookup throughout and
test `__proto__`, `constructor`, `prototype` and ordinary IDs across reopen.

### RR-06 — P1: full output is not validated before accepting text/effects

`responses-worker.ts:235–252`, `269–283`, `342–347`.
Message role/status/id/content shape is not checked strictly; unknown content
parts are ignored. Text is persisted while the output array is still being
examined. Multiple content parts share content index 0. Added calls may be marked
complete from nonempty partial arguments, and snapshot processing does not check
the entire retained item/call set against the final output.

Repro: completed output containing a message with `role:'user'`, an
`output_text` part plus an unknown content part, then a registered function call.
Observed worker completed, one handler effect, and the user-role text accepted
as assistant content. Expected reject/cancel before accepting that snapshot's
text or dispatching its function. Add malformed later-array-item, mixed parts,
duplicate/changed call, multiple calls, refusal and item-order tests. Validate a
complete bounded representation before committing any snapshot-derived effects.

### RR-07 — P1: policy mismatch loses a known cancellation target

`responses-worker.ts:224–229`, `259–262`, `342–347`.
The ID is retained only after execution-policy validation. A real known-ID
acknowledgement with `store:false` produced `backend_policy_mismatch`, no
`knownTurnIds`, and zero cancel calls even after explicit cancel.

Expected: durably retain the validated opaque ID as the target of that create,
reject policy before text/tools, and bounded cancellation/reconciliation of that
exact ID. Also validate the required effective instructions, predecessor and
output-token cap against the submitted intent; currently instructions and
predecessor are not compared and a missing `max_output_tokens` is accepted.

### RR-08 — P1: cursor and recovery output are not an atomic, exact-prefix transition

`responses-worker.ts:268–270`, `235–252`, `325–347`.
Cursor/digest are persisted before the resulting content/state. A synchronous
persist-boundary probe observed cursor 7 saved with its text still absent; the
same 0-to-7 sequence jump was accepted and its text appended rather than forcing
bounded gap reconciliation.

Snapshot repro: retrieve `in_progress` output with text `in-progress invented`
without any text delta; 20 output bytes were accepted. Change the snapshot to
completed output containing only a different item: the missing old item was not
rejected, both texts remained in the journal. Expected no invented in-progress
output and exact identity/order/prefix agreement for every retained item in a
complete snapshot. Do not advance the cursor until its resulting transition is
durable; crash at each persist boundary and replay must not lose/duplicate units.

That same explicit complete-snapshot recovery set the response's `completed`
flag but left the worker `uncertain`; without a pending callback, `reconcile`
does not finish the recovered text-only request. Require terminal recovery and
usable predecessor mapping without new creates.

### RR-09 — P1: confirmed cancellation never reaches the confirmed terminal state

`responses-worker.ts:342–347`, `443–447`.
`processSnapshot` throws for `status:'cancelled'`, so `cancel` cannot reach its
later cancelled-state branch. A known-ID request with no pending host call and a
valid matching cancelled snapshot remained `uncertain/cancellation_unconfirmed`.
Expected cancelled, durably replayable after reopen. Keep a genuinely pending
host operation uncertain, and handle completion winning cancellation separately.
Cancellation/retrieval control attempts also need their specified bounded
accounting/headroom and shutdown tracking, not a fresh unbounded control path.

### RR-10 — P1: explicit recovery exceeds durable caps and makes state unreopenable

`responses-worker.ts:173`, `325–334`, `428–440`.
The explicit flag bypasses the recovery-attempt cap; resume is not separately
reserved. Repro with `maxRecoveryAttempts=1`: the first uncertain run consumed one
retrieve; explicit reconcile persisted attempt 2 and did another retrieve. The
next reopen failed `journal_corrupt` because its own reader rejects that count.
Expected no generation/recovery allowance refill or above-cap write; use the
separately bounded terminal-control allowance for allowed reconciliation.

There is no pre-effect journal/event headroom reservation. With `maxEvents=1`,
one create was dispatched even though terminal/recovery events could not fit.
`persist` poisons only after byte/depth/entry exhaustion; it does not establish
the required space for already-admitted effects. `ResponsesWorker.open` also
does not validate its supplied limits with `responsesLimits`, and journal
validation checks only a shallow subset of record/call/response relationships.
Add complete lower-bound/ceiling, parser/writer agreement, exhausted allowance,
save-failure and near-cap admission/reopen tests.

### RR-11 — P1: production JSON paths bypass bounded parsing; already-aborted HTTP still dispatches

`responses-transport.ts:49–75`, `80–83`.
SSE uses the strict bounded parser, but retrieve/cancel use ordinary `JSON.parse`.
Through local HTTP routing, production `retrieve` accepted duplicate keys, an
escaped unpaired surrogate and depth-80 JSON. Expected the same API depth 32 /
32,768-entry / duplicate-key / Unicode policy for all three response paths.

A pre-aborted signal still dispatched one HTTP request: adding a listener does
not deliver a previously fired abort. Check initial abort before constructing or
writing the request, and again at the effect boundary.

Static gaps requiring tests with the production HTTP iterator: non-2xx status
throws before consuming/closing its body iterator; ordinary JSON has only a
header timeout plus resettable idle timeout, not a total ordinary-request timeout;
close/abort must wake pending iterators and account received error/partial bytes.
The existing 20-line transport test does not execute this HTTP code at all.

### RR-12 — P1 for live streaming integration: consumer events arrive only after execution

`responses-worker.ts:383–385`, `404–405`, `426`.
`consume` is replayed after the execution loop, not during backend collection.
Repro: accepted/saved 11 bytes of a resumed response, then held the stream;
consumer event count remained zero. Thus even the first acknowledged running
state is delayed until execution ends, rather than making dispatch/text available
to the research binding while generation continues.

Required test: first acknowledgement and content reach the consumer during an
active stream; stable indices are already durable; a slow/stalled consumer does
not block bounded collection, deadline or cancellation; replay after its durable
cursor remains exact. Implement a separately supervised bounded delivery loop,
not an awaited consumer call inside unbounded backend collection.

## Acceptance rows still missing or invalidated

No blanket R01–R12 pass is supported by this handoff. Existing tests cover an
exact initial body, a snapshot-assisted toy tool loop, terminal replay, one
duplicate-argument case, one policy mismatch, first-create no-ID uncertainty,
one profile mismatch and limited standalone SSE framing. Required repairs above
invalidate the central R02–R11 paths.

- R01: no complete mismatch/mixed-runtime/initialization matrix; old gates remain
  closed but this review did not rerun the entire native/payment suite.
- R02–R04: official events and actual streaming/sequence/output validation missing;
  test output claims multiline SSE, but no successful multiline-data test exists.
- R05–R09: add real process-boundary crashes, known-ID and continuation recovery,
  pending/saved/nonrecoverable callbacks, explicit channel-replacement ancestry,
  competing calls and all cancellation timing boundaries.
- R10–R11: exercise every stated bound and actual HTTP path, private-state
  corruption and admission headroom, real delayed local transitions, lock denial
  during them, and safe later release. Lowering only `maxResponses` is not bounds
  coverage; a fixture transport that never charges bytes is not byte accounting.
- R12: protected fake credential-file cases, no-credential pre-funding ordering,
  sentinel secret/reasoning/error projection checks remain absent from these files.
- R13 is independent real Iroh/localnet economic evidence, not established by this
  worker review or injected coordinator seam.
- R14 probe implementation is explicitly unfinished: both live flags throw
  `live_probe_unimplemented`. No live adapter acceptance was claimed or attempted.
  R15 and Fly/Tailwind/testnet remain separate gates.

## Narrow root integration and accounting review

The original `test-agent-runtime-integration.ts` passed: uncertain ResearchPort
result yielded one create/no continuation; explicit worker reconciliation used
the same paid request and callback/turn identities, then one continuation; a
completed same-process coordinator replay produced no further creates/research
effects and consumed only one budget request allocation. This was fixture-only
evidence, not crash durability, Iroh, Sui, API or live UI evidence.

Review requested capture of `threadId`, exact callback counts before/after replay,
official stream event shapes, and zero fallback retrieval on valid streams. Root
made those changes. Its zero-retrieve assertion now fails, correctly exposing
RR-01; the strengthened seam is not passing acceptance until repaired.

`tests/agent-demo/accounting-vectors.json`, `test-agent-demo-vectors.ts`, FD-19 and
the Fly implementation reducer contract agree. Historical signed/reserved 900
and delivered/redeemed 850 retain active exposure 50 before terminal confirmation;
independently confirmed CLOSED/REFUNDED with empty funds and checked paid evidence
sets active exposure to zero, keeps historical maxima, and records actual refund
11,150 from the 12,000 deposit. Pending close, model completion, a local signature,
RPC failure or terminal status without confirmation does not clear exposure or
invent refund. These are display semantics, not a payment wire/Move ABI change.

The neutral `demo-types.ts` dependency append matches the frozen type-only factory
contract. The Fly-doc preamble now explicitly excludes model/search credential
paths while permitting protected test operational-key/ticket paths for Iroh.
