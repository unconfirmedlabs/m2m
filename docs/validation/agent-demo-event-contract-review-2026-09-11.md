# Shared demo event contract: independent Astra review

Checked 2026-09-11 by Astra `xhigh`, against sections 1–9 of
[AGENT_DEMO_EVENTS_SPEC](../AGENT_DEMO_EVENTS_SPEC.md), the actual streaming codec,
BudgetLedger and public receipt types. This is read-only implementation review:
only this artifact was added. No model, network research, Iroh exchange, Sui
transaction, credentials or deployment was used. Local Chromium ran injected
fixtures only. No UI or live-demo acceptance is claimed.

**Result: return for bounded correction before installation in L1/L2/UI.**
The helper has a clean browser runtime graph and accepts the coherent baseline,
but accepts forbidden public records and impossible present-field combinations,
rejects an important legitimate budget state, and aliases trusted configuration.

## Frozen provenance and executed checks

Hashes matched before and after review:

| File under `scripts/` | SHA-256 |
|---|---|
| `agent-demo-event-contract.ts` | `f4e6ba4d34e8d5d9a014f68472dbd62130e054b6bb97d51299709f56f357ef58` |
| `test-agent-demo-event-contract.ts` | `c532f9b36931eed175fcc9800a01748fc00e1980825d759ae2035af90739515e` |
| Root browser regression `test-agent-demo-contract-browser.mjs` | `519199446ea1698f335e7d7ca1838340b2dcbf2b438cd6c53e413ed2fc48c275` |

Independently passed:

```sh
./node_modules/.bin/tsx scripts/test-agent-demo-event-contract.ts
./node_modules/.bin/tsx scripts/test-agent-demo-public-fixture.ts
./node_modules/.bin/tsx scripts/test-agent-demo-economic-session.ts
```

An independent 39-case source-shape/provenance corpus passed 38 allowed cases;
the legitimate coordinator `backend_unavailable` case failed. Wrong-machine
variants exposed the two provider-host operator-result acceptances below. The
corpus exercised original tool-result variants, research/follow_up, web tools,
receipt outcomes, source errors and all six additive lifecycle event names.
It is not the full required Cartesian product of every nullable/state variant.

An independent browser-platform bundle had exactly one input, the helper itself,
with no external runtime imports. Root's actual Chromium command was also rerun:

```sh
npm run agent-demo-contract-browser-tests
```

Its 55,071-byte isolated helper bundle accepted all 19 coherent fixture events
and canonical cursor roundtrip with both `Buffer` and `process` undefined.
All six added assertions **failed**: access-array rejection, provider operator
provenance, detached configuration, unsigned reservation, nonfinal channel_final,
and unknown-chain refund. This is browser helper evidence, not production UI
integration or a full snapshot/history reducer test.

## E1 — P1: provenance and strict enum holes permit arbitrary public metadata

`validateSourceEventShape` / `validateEventData`, especially lines 440–443 and
487–496; enum checks throughout role/connection/transaction/control/session.

Concrete accepted JSON inputs:

1. Source provider, event role host, type tool_result,
   `name:'operator.task'`, matching task `call_id`/outer request and ordinary
   terminal result. Only C/H may emit this variant, but the provider record passes.
2. The same forbidden origin with `name:'operator.status'` and
   `result:{activeTask:null,activeRequest:null,state:{private_path:'/TEST_FIXTURE/private',hidden_reasoning:'must reject'}}`.
   The arbitrary nested `state` object survives validation verbatim. This hole
   also exists with the otherwise legitimate C/H origin; state has no enum check.
3. Session `access:['operator']`, role `phase:['ready']`, and receipt
   `outcome:['completed']` / `reason:['cancelled']` pass and remain arrays.
   `String(value)` makes a legal JSON array appear equal to a string literal.
   The same pattern appears in connection, transaction, control and other enums.

Required: every permitted source/event-role/type/data combination must be
explicit, including C/H-only operator results. Validate each enum as an actual
string before membership checks; return that scalar, never a coerced original.
Validate operator.status.state against its exact six-state vocabulary. Reject
unknown nested fields before any public return or append; do not redact an
already numbered record and claim unchanged source equality.

Add one valid and wrong-source/wrong-role case for every table row. Mutate each
string enum to a one-element array, object, number and boolean. A legitimate
provider host runtime/connection/error remains allowed; provider operator results,
money, delivery, model text and controls remain forbidden.

## E2 — P1: valid reserved liability is confused with signed exposure

`economy`, lines 364–376, compares BudgetSnapshot.outstanding_mist with
DemoEconomy.outstanding_mist. The former is reserved-minus-delivered; the latter
is signed-minus-delivered. They intentionally differ while a reservation is
saved before a signature, or that signature outcome is uncertain.

Repro uses the actual BudgetLedger, not only handwritten arithmetic:

1. Replay the public fixture's real ledger funding binding, request, reservations
   and checkpoint observations through its last delivery. Retain actual latest
   signed credit 38 and delivered price 26.
2. Reserve ceilings `[1,16]` through `ledger.reserveCredit`; policy `[2,3]/1`
   produces reserved 50, with no new signature.
3. Put the actual `ledger.snapshot()` in the public economy, keep signed credit
   38 and signed exposure 12, and set reserved maximum 50/exposure 24.

Observed: `invalid_snapshot`. Ledger outstanding is correctly 24; signed exposure
is correctly 12. Required: accept that state, including the honest uncertain
variant; compare ledger outstanding to reserved exposure before confirmation.
Keep signed maxima, unsigned reservation and delivered price as separate values.
The retained reservation must still be at least the signed maximum; separating
the two exposure fields must not admit signed authority above reserved liability.
Retain positive baseline and confirmed-terminal release tests.

## E3 — P1: present economic evidence is not self-consistent

`economy`, lines 353–382. These checks need no history or signature verification;
all contradictory values are present in the supplied snapshot.

Confirmed mutations of the coherent baseline that are accepted:

| Mutation | Accepted contradictory result |
|---|---|
| Set checkpoint to null | Delivered remains 26 / units `[1,8]` |
| Replace checkpoint with the fixture's older, genuinely signed input-only checkpoint | Declared delivered 26 while checkpoint cumulative amount is 2 |
| Set refunded_mist to 123 with unknown status and no observation/terminal | Invented known refund |
| Set redeemed_mist to 12001 for deposit 12000 | Payment exceeds the entire channel deposit |
| Add a second copy of the same channel | Duplicate channel history IDs |

Require delivered counters/units to agree with the mutually present checkpoint;
nonzero delivery cannot lack the claimed evidence. Preserve the valid no-credit,
zero-delivery/refund path with no fabricated final checkpoint. Enforce channel
ID uniqueness, amount bounds/conservation where defined, and nonnull refund only
with the required confirmed terminal evidence and exact deposit-minus-paid value.
Do not zero uncertainty by constructing zeros or infer proof from a label.

The existing positive terminal test correctly requires confirmed terminal
transaction/digest, empty funds, known paid/observation and released ledger
reservation before zeroing active exposure. Preserve that conditional rule.
Add independently missing evidence fields, wrong refund, paid above deposit,
pending/failed/unknown terminal, nonempty funds, historical channels and
redeemed-above-delivery-but-within-authorization tests. A structurally consistent
claimed transaction is still not independently confirmed by this helper.

## E4 — P1: local statement/receipt/lifecycle relationships are omitted

`statement`, `receipt`, `validateEventData` and `localEventData`.

Confirmed accepted cases and required assertions:

- An existing nonfinal delivery checkpoint used as channel_final is accepted.
  The event must require `final:true`; delivery must continue to require false.
- A credit with units `[1,4]` under pinned policy `[2,3]/1` and cumulative amount
  1 passes; the exact price is 14. Validate policy price against credit/checkpoint
  amount whenever the pinned policy and units are available. U64 quantity/rate
  inputs whose sum overflows U128 also pass in standalone authorization; preserve
  both codec U128 intermediate and U64 result overflow rules.
- Receipt generated_output 1 / discarded_output 2 passes. Even without the prior
  request baseline, discarded cannot exceed generated. Apply other necessary
  present-value bounds without guessing request-local output from cumulative
  units or pretending to verify an absent checkpoint history.
- Funding deposit 10 passes with immutable configured deposit 12000. Check the
  known fixed terms; do not invent an opening nonce association without retained
  opening state. The current test's positive funding example should use 12000.
- A runtime host event's embedded cursor.host can equal its own event ID. Its
  own-role pre-append high water must be event.id minus one. Other-role history
  and source contiguity still require the stateful merger.
- A nonempty source page returning host events through 12 can set high_water.host
  to 99 with has_more false. For a role present in that final page, its last
  returned ID must reach the captured high water. Do not infer an absent role's
  starting cursor: initial/cross-page completeness still belongs to L2, which
  has the actual request cursor.

Add positive/negative pairs through exported source/event/page APIs, not only
private nested helpers. Test empty input checkpoints, split bytes, genuine final
consent without settlement, cancelled/failed paid receipts, page limits and the
same checks wrapped inside a snapshot/finite session where applicable.

## E5 — P1: returned configuration aliases pins; bootstrap misses basic invariants

`pinSet`, lines 383–389; snapshot return, identity and config validators.

Exact alias repro:

```ts
const f = createPublicSessionFixture();
const checked = validateDemoSnapshot(f.snapshot, f.pins);
checked.config.price.input_rate = '99';
// Both f.pins.config.price.input_rate and f.snapshot.config.price.input_rate
// now equal '99'; checked.config === f.pins.config is true.
```

Return a fully detached JSON tree on every export, including valid supplied
pins. Neither mutating inputs later nor mutating a returned value may affect the
other, nested arrays, or trusted pins. The existing test checks that validation
does not immediately mutate the input, which does not exercise this requirement.

Additional accepted invalid bootstrap states:

- Current transport_key equals current economic_key, violating required key
  separation even though each has length 32.
- Provider AgentRef network differs from buyer/offer network in a snapshot that
  claims that same qualified streaming agreement; namespace relations are not
  checked when deriving bootstrap pins.
- max_turn_mist is zero in both config and budget limits; actual BudgetLedger
  normalization requires positive limits/deadline and max-channel-deposit no
  greater than total. Mirror those checks rather than only U64 syntax.
- validateDemoControlRecord accepts a funding command with a different
  configuration_hash despite being given the immutable pins. Validate that
  immediate pin relationship; retained control ID/body and transition history
  remain the host/HTTP consumer's separate responsibility.

**Rotation qualification:** do not add blanket equality between every historical
offer signing key and the current identity economic key. An old agreement can
retain its original signing rights after authorized identity rotation. Current
economic/transport separation is a pure check; matching historical agreement
keys to retained epochs/authority belongs to L1/L2 evidence. This review does not
ask the stateless helper to invent or erase that history.

## E6 — P2: canonical JSON and direct validators violate their pure-input boundary

`canonical`, lines 139–159, plus `keys`/`detached` and export error normalization.

Confirmed cases:

- `canonicalDemoJson({'\ud800':1})` accepts a lone-surrogate object key; the strict
  parser rejects that canonical output. Validate key Unicode as well as values.
- Generic `canonicalDemoJson('x'.repeat(32769))` rejects valid JSON using the
  model-text 32768-byte cap and emits invalid_event. Generic canonical equality
  must not impose an unrelated model-output ceiling. Apply field/record limits
  at the relevant validators; the coordinator text cap is not every JSON string
  or every delivered research-tool result's cap.
- An enumerable accessor at array index 0 is invoked by canonical serialization.
  An enumerable command getter is invoked by validateDemoControl. Neither should
  execute accessors; reject non-JSON descriptors before reading values.
- If that command getter throws `Error('TEST_FIXTURE_PRIVATE_ERROR')`, the raw
  Error/message escapes validateDemoControl instead of a fixed contract error.

Use descriptor-aware/prototype-safe traversal for the declared direct-unknown
API, dense arrays and all own keys, with no accessor invocation or silent loss of
unsupported properties. Preserve byte/depth limits and fixed public errors at
each export. Network consumers must still cap received bytes before allocation;
this pure helper does not replace HTTP/SSE body limits.

The owner suite covers duplicate keys, one prototype key, one lone surrogate
value, cycle, object accessor and one length failure. Required additions include
escaped duplicate names, nested prototype/unknown keys, array accessors/extra
properties/sparse arrays, surrogate keys and valid astral text, depth boundary,
byte-versus-character bounds, complete event/page limits and detached mutations.

## E7 — P2: legal fixed error and codec-valid offer are rejected

- COORDINATOR_CODES omits `backend_unavailable`, expressly allowed as the current
  coordinator's unknown-exception fallback. The positive C/C error event rejects
  with invalid_event. Test every permitted code and reject unrelated snake_case
  text; do not broaden to arbitrary exception strings.
- The helper rejects offer refund==payee. Actual validateOffer accepts this;
  distinct buyer/provider Agent IDs do not require distinct payout/refund
  recipients. The helper must not invent an additional signed-statement rule.
  Preserve genuine distinct-party, deadline, deposit, byte and sequence checks.

## Correction checklist and acceptance boundary

Use the root-owned coherent public fixture for valid shape/signature inputs;
keep deliberately inconsistent mutants separate and explicitly labeled. The
96-line owner suite does not establish every row/state/privacy requirement:
it misses both exported role/control-record entrypoints as independent targets,
actual detached-return mutation, full provenance negatives, unsigned liability,
present-field contradictions and the parser cases above. Some existing positive
funding/settlement examples use amounts unrelated to the fixed channel terms;
do not preserve those merely to keep the old test green.

Before handoff, rerun the owner suite, root public/economic fixture oracles and
actual Chromium helper regressions; add the proven cases above to permanent
owner tests. Exercise each export with valid and invalid inputs and confirm a
single browser-neutral runtime graph. Installing the helper into actual L1/L2/UI
boundaries remains a separate required integration step after review.

Do not implement signature/hash cryptography, live chain freshness, task-control
authorization, arbitrary previous-request baseline inference, cross-page source
history, legal durable transition replay or snapshot-at-S construction in this
stateless module. Those guarantees require their assigned trusted/stateful
owners. In particular, retain historical signing authority through rotation;
repair immediate self-consistency without replacing economic verification with
either permissive casts or over-restrictive guesses.
