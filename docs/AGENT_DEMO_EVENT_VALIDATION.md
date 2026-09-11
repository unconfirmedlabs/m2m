# Shared demo event contract: validation in progress

Checked 2026-09-11 against [the frozen contract](AGENT_DEMO_EVENTS_SPEC.md).
This is a local structural-validation layer, not independent signature/chain
verification, an authenticated backend, or a live demo. L1/L2/UI must still
install the reviewed helper at their actual boundaries and preserve the required
stateful evidence/replay/publication checks.

## First frozen handoff

Luna's two-file handoff hashes:

- `scripts/agent-demo-event-contract.ts`:
  `f4e6ba4d34e8d5d9a014f68472dbd62130e054b6bb97d51299709f56f357ef58`
- `scripts/test-agent-demo-event-contract.ts`:
  `c532f9b36931eed175fcc9800a01748fc00e1980825d759ae2035af90739515e`

Root independently ran `npm run agent-demo-event-contract-tests`: pass.
The checked-in tests cover a subset of the required positive/negative matrix;
their green result does not prove every variant or boundary claimed in a handoff.
Astra's [frozen E1–E7 review](validation/agent-demo-event-contract-review-2026-09-11.md)
identifies correctness blockers and has been returned to Luna for bounded correction. The helper
must not be installed in production consumers before correction and review.

## Actual browser evidence

`npm run agent-demo-contract-browser-tests` bundles the exact helper with the
existing development bundler and runs it in local Chromium. It writes no bundle,
downloads no browser, serves no files, and aborts page network requests. Root/UI
development dependencies and an installed Playwright Chromium are prerequisites.
The current workspace's cached Chromium is used when present.

The frozen browser bundle has only `scripts/agent-demo-event-contract.ts` as an
input, 55,071 encoded bytes, and no Node `Buffer` or `process` globals. All 19
coherent shared-fixture events, the session, the canonical cursor roundtrip, and
one unknown-private-field rejection pass. The preserved exposure is 12 MIST.
These are browser-neutrality and narrow positive checks, not schema acceptance
or integration with the actual dashboard.

The expanded command fails six permanent browser assertions on that same hash:

1. Session access accepts an array instead of a string enum.
2. Provider/host can publish an operator task result.
3. Mutating the returned snapshot can change the trusted configuration pins.
4. A valid unsigned reservation of 50 with signed authority 38 is rejected.
5. `channel_final` accepts a nonfinal checkpoint.
6. A snapshot with no chain observation accepts an invented refund.

For case 4 the legitimate active signed exposure is 12, reserved exposure 24,
and delivered amount 26. Reservation and signed authority must remain distinct.
The other cases are rejected inputs, not invitations to sanitize them into valid
numbered events. Root owns this browser regression script; the implementation
owner owns its own broader permanent Node-side regression matrix.

Astra's review also covers additional nested fields/enums, snapshot/statement
invariants, source provenance, detachment and valid failure-code cases. The six
browser probes are not an exhaustive replacement for that review or the full
contract. No model, search, Iroh, Sui, funded channel or Fly operation was involved.

## Repaired helper: original browser cases pass, final-page gap remains

Luna's repaired helper hash is
`c89ff29447258d9f89ff7a8cd09b28ced14343112821b221b5ddad5d940ccd7b`;
owner test hash is
`82c639fb25597b83c819cc29f2935af83f21c4ce869ea6e2d41b0367e573c436`.
Root independently passed the owner suite and all six original Chromium cases
at approximately 08:54 UTC. The browser bundle remains helper-only, now 60,801
bytes, with 19 coherent events and no Node runtime globals. Astra re-review is
in progress; its independent positive source-variant corpus passes.

One original E4 requirement still fails: a nonempty page marked `has_more:false`
returns host IDs through 12 but advertises host high water 99. It is accepted;
the owner test explicitly asserts that incorrect acceptance. This contradicts
the frozen present-role final-page rule; it is not a request for the stateless
helper to guess an absent role's prior cursor.

Root added the case as a seventh permanent actual-browser assertion, first
proving that the coherent unmodified page passes. On the same helper hash,
`npm run agent-demo-contract-browser-tests` now exits 1: original six pass,
new final-page-coverage assertion fails. Updated root browser script SHA-256:
`584eb1d204d031e396de7e416658316693cd2fe6156953768bb9439598c0361b`.
Helper installation remains gated on correction and independent acceptance.

The [frozen repaired-hash review](validation/agent-demo-event-contract-rereview-2026-09-11.md)
adds four remaining structural groups beside that page-tail case: nested
descriptor execution/array-property stripping, contradictory standalone chain
observations, incomplete provider namespace binding and the wrong ceiling for
delivered research summaries. Luna has ER-01–05 with failing-regression-first
instructions. Astra independently verifies actual BudgetLedger unsigned
reservation/uncertainty/reopen and valid zero-credit refund/rotation cases;
those repaired semantics must survive the remaining corrections.

## ER01–05 accepted for integration

The next candidate (`8c3cae326f417b0114297bc4acf664acdc5fbaab2ec7f1e1d97921fda631c236`;
owner tests `0cc595b26d5332e01cbf472584e40780cfa752977c6bb4483a32bae64432ab3c`)
passes root's owner-suite run and all seven actual Chromium regressions.
Astra independently accepted the five exact returned corrections and nearby valid
economic/rotation cases in the
[frozen bounded review](validation/agent-demo-event-contract-er-rereview-2026-09-11.md).
The helper-only browser bundle is 61,656 bytes with 19 coherent fixture events.

L1/L2/UI may now install this actual helper. Stateful projection, signatures and
authority history, exact snapshot fencing, real HTTP/SSE integration and all live
acceptance remain their own requirements. Two nonblocking permanent-test
precision improvements are recorded in the review; they do not defer integration.
