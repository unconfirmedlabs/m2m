# Event helper ER01–05: critical-path re-review

Checked 2026-09-11. **The five exact returned correction groups pass on this
hash. No remaining blocker was reproduced in this bounded regression set;
proceed to real L1/L2/UI integration.** This is not a new exhaustive helper audit,
nor HTTP/SSE, cryptographic/history, production UI, live-model or demo acceptance.

The review deliberately did not expand the exploratory matrix. Implementation
and owner tests were read-only; no credentials, network services, public chain,
provisioning or deployment were used. Browser and economic inputs are explicitly
test fixtures.

## Frozen provenance

Hashes matched before and after the review:

| File | SHA-256 |
| --- | --- |
| `scripts/agent-demo-event-contract.ts` | `8c3cae326f417b0114297bc4acf664acdc5fbaab2ec7f1e1d97921fda631c236` |
| `scripts/test-agent-demo-event-contract.ts` | `0cc595b26d5332e01cbf472584e40780cfa752977c6bb4483a32bae64432ab3c` |

The comparison is specifically against ER01–05 in
[the prior repaired-hash review](agent-demo-event-contract-rereview-2026-09-11.md).

## Independently re-probed corrections

| Group | Exact failure and nearest valid evidence |
| --- | --- |
| ER01, final source page | Complete coherent coordinator page through coordinator 4 / host 12 passes. Changing final-page host high water to 99 rejects. The same 99 with `has_more:true` passes. The seventh actual Chromium regression now passes. Absent-role/cross-page history is not inferred. |
| ER02, nested direct-input descriptors | The **original** getter on `identities.coordinator.agent` rejects `invalid_snapshot` with zero reads. Getter at authorization purpose byte 0 rejects `invalid_event` with zero reads. An extra property on the method byte array rejects instead of being stripped. Cyclic malformed bootstrap returns the fixed snapshot error. |
| ER03, standalone observation | Each original open/refund contradiction rejects, with terminal null, unknown, or confirmed. Open/null-refund/null-terminal passes. A complete structurally confirmed zero-credit refund passes. These are present-field shape checks, not independent transaction confirmation. |
| ER04, qualified namespace | Canonical wrong provider package and domain reject both bootstrap and consistently changed supplied-provider-pin variants. The unchanged common namespace passes. Changed current economic key with retained historical offer remains accepted; no invalid historical-key-equals-current-key shortcut was introduced. |
| ER05, delivered summary envelope | Original matching-count synthetic research summaries of 32,768 and 32,769 bytes both pass. The latter encodes a 33,745-byte source event / 33,394-byte result under its explicit zero-output-rate structural fixture policy. Research and follow_up both accept the larger summary. 65,536/65,537-character summaries and an escaping-overhead source-envelope overflow reject. Coordinator model_text and operator.task still reject 32,769-byte answers. |

Code changes match those results: present-role final page completion is checked;
identity containers and statement purpose/method arrays are validated before the
previous unsafe reads; standalone open/refund/terminal consistency is checked;
bootstrap compares both participants' network/package/domain; delivered research
summary text uses its larger envelope while coordinator text retains 32 KiB.

## Regression and browser evidence

Passed independently:

```sh
npm run agent-demo-event-contract-tests
npm run agent-demo-contract-browser-tests
./node_modules/.bin/tsx scripts/test-agent-demo-public-fixture.ts
./node_modules/.bin/tsx scripts/test-agent-demo-economic-session.ts
```

Actual Chromium result: all seven root assertions pass, all 19 coherent public
events validate, and the canonical cursor roundtrip is coordinator 4 / research 0
/ host 12. The **61,656-byte** bundle has exactly one runtime input, the helper;
`Buffer` and `process` are undefined. This proves that isolated helper execution
is browser-neutral, not that the production dashboard installed or used it.

The prior independent real `BudgetLedger` probe was rerun without changing its
fixture transitions: unsigned reserve 50, historical signed maximum 38, delivered
26, reserved exposure 24, signed exposure 12, with uncertainty and durable reopen.
Validation passes. A separate actual ledger's injected zero-credit refunded
observation yields refund 12000 and no checkpoint, and still validates. These
preserve the financial distinction and legal refund path without claiming a
chain observation occurred.

## Permanent-test precision notes, not reproduced production blockers

The owner suite's ER04 values use `'0x09'.repeat(32)` and `'0x0a'.repeat(32)`.
Those are malformed addresses, so the checked-in assertions do not specifically
prove qualified-namespace mismatch. Use `'0x' + '09'.repeat(32)` / `'0x' +
'0a'.repeat(32)` for the permanent negatives. This review independently used
canonical `'0x' + '99'.repeat(32)` with and without matching changed supplied pins;
the production namespace check correctly rejects it.

The owner ER02 identity regression places its getter on the nested AgentRef's
`agent` field, one level below the original failure. Retain it, and add the
original identity object's `agent` getter with a zero-read assertion. The exact
original placement independently passes now.

These two precise permanent-test improvements need not delay connecting the real
vertical slice: the actual production fixes have independent negative evidence.
Other broader parser/descriptor/economic Cartesian matrices are not represented
as newly completed by this short review. L1/L2 remain responsible for signatures,
retained authority epochs, stateful receipt/checkpoint/control relations, durable
publication/replay and exact snapshot-at-S construction. Final live-runtime,
testnet provisioning, protected hosting and unscripted two-agent acceptance gates
remain unchanged.
