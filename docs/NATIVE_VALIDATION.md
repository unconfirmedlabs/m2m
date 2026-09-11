# Native implementation validation

Checked 2026-09-11, experimental issue #1 implementation. These are observations
from the local workspace, not a released protocol, customer-demand evidence or
production-readiness claim. Run instructions: [quickstart](NATIVE_QUICKSTART.md).
Public addresses, transaction digests and counters: [evidence JSON](validation/native-local-2026-09-11.json).
Private keys, signed transaction attempts, auth files and worker transcripts are
excluded. Localnet digests are not public-testnet explorer links.

## Acceptance coverage

| Requirement | Observed coverage | Remaining limit |
|---|---|---|
| Native identity/admission, separate keys, unpaid traffic | New shared Move Agents, independent RPC resolver, strict signatures and session binding; real Iroh echo/hash and service description | Known peers, one endpoint/writer, trusted RPC, 30-second authority lease |
| Independent interoperability | Rust core versus independently encoded/verified TypeScript core over raw Iroh bridge; unsupported-feature rejection and both-process restart/saved request replay | Bridge is Rust Iroh transport; not an independent Iroh implementation or browser peer |
| Generic pricing and channel economics | Bytes, records, separate counters and free policies; independent Node BCS/SDK/Move vectors; rounding, overflow, exact close, unilateral redemption and expiry/refund | Actual live composed service currently meters input/output UTF-8 bytes, not tokens |
| Durable streaming | Signed credit/Ack/checkpoint ordering, exhaustion/replenishment, duplicate/conflict rejection, persisted delivery, uncertainty and cancellation tests | Filesystem retention and single writer required; no exactly-once external execution claim |
| Real Codex adapter | CLI 0.154.0, `gpt-5.6-luna`, `xhigh`; actual streaming response, persisted replay and standalone conversation continuation | No browsing/tools; composed client is programmed and per-run worker isolation does not yet compose cross-channel continuation |
| Complete chain path | Separate package published on localnet; real Agent registration, funding and exact-close PTBs, same-channel recovery | New native package and both named Agents not yet deployed on testnet |
| SuiNS | Read-only expected parent ownership/lifecycle verification; two leaves absent; resolver/transaction failure tests | Need the local wallet-file path controlling `nozomi.sui` to create leaves and run named testnet exchange |
| Compatibility | Legacy signed fixtures, journals, Rust and Move tests remain passing | Legacy `payment.settlement` remains specified-only; no silent identity/agreement migration |
| Investor demo | [Accepted live-demo requirements and architecture](LIVE_DEMO_PROPOSAL.md); subsequent [implementation/validation ledger](AGENT_DEMO_PROGRESS.md) | Tailwind and tool-runtime implementation is in progress; two live LLMs, hosted integration and native Fly deployment remain unvalidated |

## Automated checks

- `cargo test --locked`: 45 passed, 2 legacy integration tests ignored because they
  require the old provider runtime. Includes 11 new native tests, real Iroh and
  independent TypeScript conformance. Native tests were rerun after adding
  independent service-description coverage.
- `bash scripts/sui.sh move test --path move/streaming`: 29 passed. Tests cover
  independent signed vectors and test-only transition helpers; the live run below
  separately checks the published opening/exact-close entrypoint path.
- `bash scripts/sui.sh move test --path move/m2m`: 25 legacy tests passed.
- `npm run typecheck` and `npm run native-tests`: passed. The six TypeScript suites
  check RPC/naming/uncertain transactions, native core, economic codec, payment
  engine, Codex worker, and composed research service. Test workers and RPC responses
  in these suites are synthetic, explicitly separate from live evidence.
- `npm run native-examples`: ten core envelope kinds plus 32 native-streaming
  envelopes; schemas, BCS, signatures, cross-message/session references, actual
  service/engine transitions, recovery/cancellation and negative branches passed.
- `npm run vectors`, `npm run channel-vectors`, `npm run channel-journals`, and
  `npm run message-examples`: legacy compatibility checks passed.

Tests assert economic and recovery invariants. Deterministic fixtures do not imply
that LLM output or a live conversation should follow a deterministic script.

The [09:03 UTC regression rerun](validation/agent-demo-foundation-regressions-2026-09-11.json)
reconfirms the Rust/Move/native/agent-service and legacy vector checks during demo
implementation. It preserves the two explicitly ignored legacy-provider tests;
it does not rerun or replace the earlier live localnet evidence below.

## Live localnet composition

The existing localnet was reused without resetting genesis. Setup published a new
`m2m_streaming` package and immutable Domain, registered two Agents, and generated
separate economic/transport keys. Both Agents used the same controller wallet
for this controlled experiment. The Node coordinator and provider were distinct
processes with real Iroh endpoints; the coordinator was a programmed protocol client.

The live Luna run produced **805 delivered UTF-8 bytes across seven credit updates**.
It exercised unpaid messaging before funding, exhausted credit, replenished credit,
then closed on Sui with the existing buyer authorization and provider final consent.
No answer-approval signature was added. An initially interrupted funded setup
was resumed on the same Channel; no replacement deposit was created.

| Counter | Observed value |
|---|---:|
| Deposit | 100,000 MIST |
| Highest authorized ceiling | 238 MIST |
| Delivered usage at exact policy price | 215 MIST |
| Confirmed redeemed | 215 MIST |
| Confirmed residual refund | 99,785 MIST |

Deposit conservation is `215 + 99,785 = 100,000`, excluding gas. The policy used
rates `[1, 2]` for input/output bytes and denominator 8. Test pricing does not
represent backend API cost or meaningful commercial value. An advance ceiling
is not proof of delivery; unilateral redemption can claim that advance. The live
run used cooperative exact close, not unilateral redemption or expiry.

Settlement digest: `9Sa7ryMHKJC5GNBhUVYmdMX4ndiq4sijiYXz2TiZbaG4`.
The result is a recorded observation, not an expected fixed future model answer,
byte count or price. The research worker answered a synthetic text question from
model knowledge; source-seeking research was not enabled.

## Restart boundaries on real channels

`scripts/test-native-demo.ts` launched two independent fixture experiments against
real localnet and Iroh. Each intentionally failed once, then restarted with the
same persisted session and Channel:

1. After the buyer durably saved a delivered checkpoint: replay continued without
   duplicate credit, work charge or opening.
2. After confirmed Sui exact close but before saving the local terminal result:
   the resumed client reconciled the terminal Channel and reconstructed the result,
   rather than funding or settling again.

Each delivered 448 fixture bytes with four credits and settled 126 MIST, refunding
99,874 MIST from the 100,000-MIST deposit. Exact Channel IDs and digests are in the
public evidence file. These are controlled persistence-boundary process restarts,
not tests of host power loss. Separate worker tests cover uncertain launch and
persisted interruption intent; an ambiguous external launch is never blindly
started a second time.

## Observed model meter

A separate live adapter probe completed in 5,994 ms; its first visible text was
at 3,269 ms and last at 5,900 ms. It observed 151 fragments / 893 UTF-8 bytes, but
only one usage notification at 5,991 ms: 2,515 input plus 195 output tokens,
including 38 reasoning tokens within output. Reopening the worker/process replayed
the same request without a new turn; a new request in the same conversation used
a distinct turn in the saved thread and produced 167 bytes in 3,572 ms.

These timings/counters describe those probes only. They do not establish token
streaming metering or compute backpressure. The provider can keep generating
while payment credit pauses delivery. Bounded worker duration/output and explicit
cancellation limit that exposure but cannot undo already incurred API cost.
Byte accounting, upstream token telemetry, signed credit and redeemed Sui value
must remain separate in any UI.

## Not yet validated

No new native testnet transactions, SuiNS leaf creation, new native cross-region
Fly deployment, browser runtime, genuine two-LLM orchestration or investor UI has
been completed. The current text-worker sandbox intentionally excludes browsing.
The parent `nozomi.sui` registration was verified read-only; deployment awaits its
controlling wallet's local **file path**, not a key pasted into chat. Mainnet and
name purchase are out of scope. Issue #1 remains open pending its testnet acceptance.
