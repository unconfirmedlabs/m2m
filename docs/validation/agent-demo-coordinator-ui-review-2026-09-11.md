# Coordinator correction and browser UI: independent Astra review

Checked 2026-09-11 by Astra `xhigh`. Read-only implementation review with actual
coordinator/API/reducer/accounting code and local Chromium fixture probes. No
credentials, model API, Iroh exchange, Sui transaction or Fly action was used.
No implementation or owner tests were edited. This is a bounded return tranche,
not acceptance of L1/L2/L3 or the live investor demo.

Requirements: AR-10/12/14, prior C4/C5 in
[the coordinator/setup review](agent-demo-coordinator-setup-review-2026-09-11.md),
FD-13–21 and [the public event contract](../AGENT_DEMO_EVENTS_SPEC.md).

## Frozen inputs and narrow passing evidence

The coordinator review below applies to the handed-off hashes, not later fixes:

| File | SHA-256 |
|---|---|
| `scripts/agent-coordinator.ts` | `a449975372ff500571747d25df79eddd4b61c8792557aa605448f99aefe8f245` |
| `scripts/test-agent-coordinator.ts` | `83a16d9806df5a9e370e6cd66efbc64da7627b01e4ee37e489788ee81593b9b1` |
| `ui/agent-demo/src/api.ts` | `a70d5bcca0a645ea09ad1b962973d9f6899fa86849408941350b94d1c1b0f9b3` |
| `ui/agent-demo/src/reducer.ts` | `ea4f1f64aa48f4d78a19a53786f294fa29a8e506f5800232b6d6699d24be37d2` |
| `ui/agent-demo/src/accounting.ts` | `d2802ed883b74cf24a6b500a35f3ca7a14fb211d9c6d600835cc0b3f9e318edc` |
| `ui/agent-demo/src/App.tsx` | `8052dfc8ec390e3313767f7975420be9427b337ccf46825c5143a30661593d21` |
| `ui/agent-demo/src/types.ts` | `4d28715a7384479b60d589561d1818392008a42cc69d3e6244aca0d45d92c97f` |
| `ui/agent-demo/src/styles.css` | `006ddb8a20fdf701523eaf85acfb2141f553cb627a8e93ddfb7065491d5d2c3e` |
| `ui/agent-demo/tests/dashboard-fixture.ts` | `08d112a51fb9cdeeccd0a65cad4d7aa8e5ab4cfa74dedc412b0dd2a2ff461871` |
| `ui/agent-demo/tests/browser/smoke.spec.ts` | `aa6ec5fdef521c2ba14b574660acddd08f62f58f86f59769a67a79c55a1ff657` |
| `ui/agent-demo/tests/app-dashboard.test.tsx` | `e6ebfc8a6bcefcc6994dd5ac83f79ead8955da9dec8ac26af26ad1c6789e9743` |
| `tests/agent-demo/accounting-vectors.json` | `0d3bc0d45975612b16d4a8e5f22af9c1e9900ad98d4dafd4a68626c01ab92646` |
| `tests/agent-demo/economic-session.json` | `6a762899fad2b2e2489f1bfcacb34312b6f3798bb6c66a639a1bd4359d2fbd7e` |

Independently passed at these inputs:

```sh
./node_modules/.bin/tsx scripts/test-agent-coordinator.ts
./node_modules/.bin/tsx scripts/test-agent-demo-ui-contract.ts
./node_modules/.bin/tsx scripts/test-agent-demo-vectors.ts
./node_modules/.bin/tsx scripts/test-agent-demo-economic-session.ts
cd ui/agent-demo
npm test
npm run build
npm run smoke
```

UI results were 13 unit tests, a successful TypeScript/Vite build, and three
Playwright checks: one login-only and two authenticated fixture cases. The root
UI contract command initially had seven assertions; all seven passed. Root then
added six negative assertions during this review; the expanded command produces
seven passes and six failures, consistent with the findings below. Do not report
the original seven passes as the result of the expanded suite.

Production `src` imports no test fixture, wallet, Node runtime or model adapter;
shared imports are type-only. Bearer authentication is memory-only, fetch omits
cookies and rejects redirects, and React renders public strings as text. Normal
well-formed 401 handling, lost-POST/same-ID retry and CRLF byte-split framing have
narrow passing tests. These positives do not establish the remaining negative
boundaries or independent cryptographic/chain validation in a browser.

## Coordinator first: C4/C5 exact cases repaired, one shutdown variant remained

Independent probes repeated the original failure cases with the actual
AgentCoordinator/BudgetLedger and explicit worker/ResearchPort doubles:

- C4: a pending paid callback, uncertain cancel, and terminal worker reconcile
  without a provider receipt now remain uncertain. Active request is retained;
  counts remain one model run, one port execute and one worker reconcile.
- C5: after uncertain launch, shutdown/reopen and cancel before reconstructing
  the lazy worker no longer fabricate cancellation. Same-task replay remains
  uncertain with only the original run.

**C5b — P1: shutdown after admitting a held recovery factory still fabricates
terminal cancellation.** Frozen `agent-coordinator.ts:849–852` checks only pending
paid calls in its `this.closed` branch, ignoring the durable prior launch.

Deterministic repro and required regression:

1. Seed an uncertain task with one prior model launch and no paid call; safely
   shut down and reopen the actual coordinator.
2. Replay exactly that task while its replacement worker factory is held.
3. Begin shutdown. Hold the factory until shutdown's cancellation transition has
   finished and only the active run transition remains. The isolated probe used
   a test-only barrier equivalent to `while (coordinator.transitions.size > 1)`;
   releasing immediately can hide the defect behind the cancel transition's
   later write.
4. Release the factory; await run and shutdown; reopen and replay the same task.

Observed both run result and reopened replay: `cancelled`, with one original
worker run and zero reconciles. Required: `uncertain` until exact prior-worker
terminal evidence exists. Absence of a pending ResearchPort call is not proof
that an old model operation stopped. Retain the positive case where a genuinely
never-launched task may be safely cancelled without running the late worker.

This result was reported before UI review. Root assigned a repair and the files
subsequently changed to `70fb5d361dd942479c897353df1078956c62d03cf7d84255d0c64bd202b5ca98`
and `65d831d19401cb7b2e4c7f82ec562d082ad17b66ed8ef42f9005cd7fd383ca58`.
That newer coordinator handoff is not accepted by this artifact; it needs its
separate frozen re-review. No runtime rewrite was reviewed here.

## UI return requirements

### U1 — P1: strict event/session ingestion and fail-stop are not installed

`api.ts:137–156,211–226,253–266`; `reducer.ts:63–85,98–124`.
The current parser checks a few envelope fields and then casts. The reducer
advances the durable cursor before checking an event's admissible meaning.

Confirmed probes using the actual DemoApi/consumer:

- Provider/research `delivery` is visually suppressed but accepted by DemoApi;
  reducer cursor advances from 0 to 1 with no failure. Required: reject source
  provenance, no transcript or source/global cursor advance.
- A record with source ID `9`, invalid request `not-hex`, an extra envelope key
  and `data.hidden_reasoning` is accepted. Unknown nested fields must reject,
  not become a retained public event; first source-role ID must be 1.
- Global sequence 1, then 3 fails at cursor 1, but subsequent sequence 2 is
  processed and displayed. The invalid stream is not latched/stopped; callback
  dispatch does not propagate reducer failure to the reader. Required: no more
  consumption or cursor advancement on the failed stream, including later
  `connected`/`disconnected` callbacks which currently can erase failure state.
- `event: made_up` and malformed `stream_status` frames are silently skipped;
  a later valid durable event is delivered. Both must reject. Valid ephemeral
  stream status needs its exact schema/conversation/high-water checks.
- A 131,440-byte incomplete frame, padded with a comment and ending in a valid
  event, is accepted. The declared limit is 128 KiB encoded bytes; current code
  permits 256 KiB JavaScript characters. Test multibyte padding as well.

Required repair/tests: install the single reviewed shared validator in actual
API/reducer ingress; retain host-side crypto/history responsibilities. Cover all
source/role/type variants, positive per-role counters, U64 overflow, extra and
duplicate/prototype keys, unknown access/session fields, wrong configuration and
invalid receipt/URL nesting. Preserve the existing seven regressions. Reordered
object keys with identical canonical content must be treated as the same replay,
not a JSON.stringify-order conflict. Parser success must precede any cursor,
transcript, money, control or connection mutation.

### U2 — P1: snapshot S/history/live cut and refresh races are not implemented

`reducer.ts:122–141`; `App.tsx:56–92`; `api.ts:253`.
Replaying from zero is now correct, but there is no immutable base-cut/history
mode, and HTTP stream headers are treated as a synchronized connection.

Confirmed minimal cases:

- Start from snapshot S=5 with connected Iroh. Replay historical connection
  event 1 saying disconnected: live Iroh becomes disconnected. Historical runtime
  event 2 requests a status refresh and sets new activity. Events <=S must only
  rebuild transcripts/actions/dedupe, never change current host state or replay
  financial/activity transitions.
- `replaceSnapshot` accepts a different conversation/configuration and S=0 while
  retaining cursor 2 and the old conversation's history. Reject mismatched pins;
  a deliberate refresh must buffer/rebase rather than install incoherent cuts.
- Actual Chromium dashboard: hold the status request caused by event 1, deliver
  event 2, then answer the first request with snapshot S=1. After settling, there
  is only one status request, browser says connected, projection says 1 and last
  event says 2. The in-flight ref suppresses the second refresh and clearing it
  does not rerun the effect. No later event is needed to demonstrate the stale
  state. Required: retain/reapply event 2 or complete a follow-up refresh, with
  coherent state and exact cursor, including delayed/out-of-order responses.

Live delivery does not itself request a refresh or update economic state; funding
is also missing from the refresh event list. Add actual post-S delivery/funding
tests, not only budget events that happen to refresh a final snapshot. Test
S+1 arriving during backfill and status refresh, reconnect after a later cursor,
empty history, exact replay without new activity, and channel-history selection.
Keep admission disabled until validated replay-live synchronization is complete.

### U3 — P1: incomplete terminal evidence clears exposure and invents refund

`accounting.ts:25–46`; `App.tsx` ChannelStrip.
Shared vectors and docs agree: historical maxima remain, and active exposure
reaches zero only after checked terminal channel evidence. The UI only checks
terminal label, status and locked funds for its exposure predicate.

Use deposit 12000, signed/reserved 900, delivered 850, status closed, locked 0,
terminal confirmed. Independently null each required proof field:

| Missing field | Observed outstanding / exposure | Observed refund |
|---|---|---|
| `redeemed_mist` | 0 / 0 | null |
| `observed_at_ms` | 0 / 0 | 11150 |
| terminal `digest` | 0 / 0 | 11150 |

Required in each case: retain 50/50 and unknown refund, or reject the impossible
snapshot while retaining prior honest state. Never render zero as confirmation.
Positive confirmed/empty/known-paid/valid-digest/same-channel evidence must still
yield zero exposure; pending, failed, unknown and nonempty variants must not.
Also reject paid above deposit/impossible arithmetic rather than show negative
refund. Browser structural checks do not independently confirm a transaction.

Separate static display defect: `deriveEconomy.transaction` selects terminal
before opening, but ChannelStrip labels it `Opening`; confirmed close therefore
relabels the close digest/gas as opening evidence. Display actual opening and
terminal receipts separately, including all specified gas fields and prior-channel
spend. Test those labels with distinct valid-shaped fixture receipts.

### U4 — P1: uncertain control identity, reply validation and auth lifetime

`App.tsx:103–129,167–170`; `api.ts:57–63,185–226`.

- Actual authenticated Chromium: return `uncertain` for a task POST, then submit
  the identical task body again. The two POSTs have different IDs because line
  128 deletes every non-running intent, including uncertain ones. Retain the
  exact unresolved intent/ID and recover it; a new task needs explicit distinct
  admission after reconciliation. This probe proves UI ID abandonment, not that
  the backend accepts another paid/model operation.
- The same dashboard permits task submission with browser disconnected and no
  valid replay-live proof. `can` uses only access and the stale snapshot predicate.
  Disable new-effect controls during invalid/incomplete synchronization; keep
  any deliberately available safety controls narrowly specified, not all controls
  enabled because cancel/pause should remain usable during a pending operation.
- `controlStatus(id)` accepts `{version:1,record:{state:'completed'}}` with no ID,
  command or timestamps. Validate full records and exact submitted ID/body on
  POST and polling, reject impossible state/time/task mappings, and retain intent
  on invalid replies. Unknown session access must not become operator permission.
- A finite endpoint returning HTTP 401 with `{broken` leaves DemoApi's token
  present and calls the unauthorized handler zero times; error is `invalid_json`.
  Revoke the session on status 401 before parsing/bounding the body, including
  invalid UTF-8, oversized and stalled bodies. Test active dashboard clearing,
  not just a well-formed direct API call.

Static additional lifetime gap: logout does not invalidate/abort already-running
finite requests or control polling. Add a session-generation/abort regression:
old responses after lock/logout or a new login must not install old state, resume
polling with a replacement token, or repopulate retained operation data. No claim
of a server authorization bypass is made here.

### U5 — P2: actual event shapes are not rendered in their correct roles

`reducer.ts:10–39,51–60,90–119`; App AgentPanel.

Confirmed: valid provider/research `tool_started` with
`{name:'web_search',call_id,arguments:{query}}` renders in the coordinator panel as
“Coordinator requested bounded research.” It omits the real tool/query and
misattributes the actor. Actual C/H `turn_terminal.data.receipt` produces no
citation entry; C/C research `tool_result.data.result.receipt.citations` is not
read. The existing tests put citations on delivery or channel_final instead,
neither of which is an allowed current emitter shape.

Required: render allowed actions/arguments on the correct machine, correlate
request_started questions and delivered requests, consume actual receipt nesting,
and render one canonical coordinator answer rather than model_text plus the
operator.task duplicate. Receipts must enrich the correct request, not invent a
delivery. Use the positive per-variant corpus and reject unsafe citation URLs.

Valid partial UTF-8 `[240,159]` in a nonterminal delivery sets `malformed:true`
because decodeChunks flushes after every frame. Keep the streaming decoder state
and only finalize at the appropriate terminal boundary. Incomplete-but-valid
scalars are not malformed; genuinely invalid bytes fail visibly before accepting
later events. Test both intermediate and terminal states, not only final text.

### U6 — P1 evidence gate / P2 layout: fixture captures are misleading and incoherent

`tests/browser/smoke.spec.ts:11–37`; `tests/dashboard-fixture.ts`;
`tests/app-dashboard.test.tsx`; reviewed both `/tmp/m2m-agent-demo-dashboard-*.png`.

The authenticated browser test explicitly asserts zero `TEST FIXTURE` labels,
uses “Live coordinator receipt”/“Live research delivery”, and captures those
synthetic records under `M2M / LIVE EXCHANGE`. The unit FixtureHarness has the
correct banner, but it is not used in these screenshots. A passing screenshot
test is therefore not even an honestly labeled fixture capture.

The default browser snapshot uses `t`-repeated task IDs, three-byte keys, a
non-digest `opening-digest`, missing signed statement fields, no signed credit,
and all controls. Its 1/1 policy and units 1/8 price to 9, while delivered_mist is
26; the screenshots visibly say evidence mismatch. The shared signed input is
2/3 and is not consumed by this browser test. The unit fixture using that input
still combines unrelated conversation/identity/selected-channel data and invented
citation envelopes. Do not use this as the positive real-shaped corpus.

Required: consume the root-owned coherent public-session fixture through the
actual reviewed validators/API/reducer; keep absent chain evidence unknown.
Use the persistent test-harness banner outside production envelopes, without a
production fixture switch or fallback. Assert its visibility in desktop/mobile
captures and do not call synthetic text live. Preserve production fixture-import
exclusion. Use separate intentionally invalid fixtures for error displays.

Actual Chromium at viewport width 390 measured document scrollWidth 440; both
agent panels ended at x=440.06 (width 420.06, left 20). The mobile screenshot's
panels overflow the header/accounting/control column. Require no horizontal page
overflow, complete readable agent names and usable keyboard/focus controls at
390 px and desktop, plus reduced-motion behavior. Screenshot existence alone is
not responsive-layout acceptance.

## Handoff boundary

Root has incorporated six of these negative cases into the actual UI regression
command. The remaining proven variants above still need tests; seven old passes
plus six new failures is not a complete provenance/replay/auth suite. The new
shared event helper is a separately owned, in-progress slice. Its frozen API is
compatible with these repairs; testing a helper alone will not fix production
ingress, stateful replay or display. No full schema/crypto, HTTP authorization,
real runtime, real Iroh/Sui, deployment, restart or unscripted live-demo acceptance
is implied by this review.

## Separate new-hash addendum: C5b and the shared public fixture

Checked later on 2026-09-11 after an explicit frozen handoff. This addendum
supersedes only the pending C5b re-review above; it does not accept or change the
UI findings. The four input hashes below were identical before and after review:

| File | SHA-256 |
|---|---|
| `scripts/agent-coordinator.ts` | `70fb5d361dd942479c897353df1078956c62d03cf7d84255d0c64bd202b5ca98` |
| `scripts/test-agent-coordinator.ts` | `65d831d19401cb7b2e4c7f82ec562d082ad17b66ed8ef42f9005cd7fd383ca58` |
| `tests/agent-demo/public-session.ts` | `b5077637ff1cdfa8f75c54fbba576e98dc621d83448f6b7fd89202de8763ee1c` |
| `scripts/test-agent-demo-public-fixture.ts` | `a7def2794f7a022b6ec6dc7ec7ca7a5414dc451e35fb66087189b2aea823875f` |

The coordinator suite, public-fixture oracle and underlying economic-fixture
oracle all passed independently. No actively written shared-helper code was
inspected or used for these results.

### C5b production correction: narrowly accepted

Repeated the exact prior-uncertain/reopen/held-factory/shutdown sequence, waiting
until the current shutdown cancellation transition had completed before releasing
the factory. The independent assertion probe now returns:

```text
held prior launch: result=uncertain, reopened replay=uncertain,
                  worker.run=1 total, worker.reconcile=1 on reopened replay
never launched:   result=cancelled, reopened replay=cancelled,
                  worker.run=0, worker.reconcile=0, paid port calls=0,
                  late worker shutdown=1
```

The prior model launch is no longer reinterpreted as safely cancelled; its exact
reconciliation remains the only allowed next worker action. Genuine no-launch
cancellation still does not introduce inference or a paid request.

Mutation check used isolated temporary source/test copies, never owner files.
The only behavioral mutation removed `priorLaunch ||` from the closed-branch
state assignment. The checked-in C5b regression rejected that mutant in 11/11
runs, at its reopened status assertion (`idle` instead of `uncertain`). The
independent current-cancel-completed barrier rejected the same mutant earlier,
at `result=cancelled` instead of `uncertain`. Thus this mutation is detected;
there is no demonstrated surviving-guard-regression blocker.

Test-precision note: checked-in `waitUntilStopped` observes a flag already set by
the seed shutdown. It does not itself prove that the current shutdown's cancel
transition finished. A future refinement should await a completion signal from
that specific transition, or its controlled persistence barrier, before releasing
the factory. Keep the reopened status assertion, which currently catches the
mutant despite that imprecise timing condition.

### Shared public fixture: coherent for its explicitly synthetic purpose

No blocking mismatch was found in this bounded fixture review. In addition to
running its independent oracle, separate assertions checked:

- Conversation/config pins, qualified buyer/provider references, controller and
  economic-key associations, and distinct 32-byte transport/economic keys.
- Per-machine/per-role source counters, runtime event pre-append cursors, final
  snapshot post-append cursors, canonical request IDs and source-event byte bounds.
- Request hash recomputation; offer/binding/request/credit hash relationships;
  actual credit/checkpoint signatures; receipt checkpoint/units/text byte counts;
  and equality of the delivered summary with the reconstructed UTF-8 response.
- Signed/reserved 38, delivered 26 and exposure 12; actual BudgetLedger duplicate
  reservation and durable reopen produce the handwritten public budget, including
  remaining 23962. These ledger observations are injected, not chain RPCs.
- Final checkpoint consent remains separate from settlement: chain status unknown,
  redeemed/locked/refund/observation/terminal null, unknown opening receipt, and no
  fabricated chain_observation or settlement event.

The module's notice/provenance correctly identifies synthetic host/model/tool/
identity metadata around independently engine-checked fixture signatures. It is
a Node-side test generator, not a browser production import. Its notice must
still be visibly rendered by every fixture harness/capture; exporting a notice
does not fix U6's unlabeled screenshots. Its synthetic receipt and metadata are
not authenticated NativePeer/chain/model evidence, and its injected credit
sequence is not an AgentServiceClient issuance/reconnect test. Empty citations
and the limited event set do not cover the full positive/negative event corpus.
Full schema integration remains the separately reviewed shared-helper and real
consumer work. No live or UI repair acceptance follows from this fixture result.
