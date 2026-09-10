# Signed channel validation

Checked 2026-09-10. The optional `sui.channel.v1` proof of concept completes
repeated paid file exchanges over Iroh with one Sui deposit and one cooperative
close. It also recovers saved credits after process failures and returns unused
funds after expiry. The original per-job escrow remains available.

This is an Ed25519 signed cumulative channel. It contains no zero-knowledge
proofs. Payment messages travel over Iroh; Sui holds the collateral and enforces
settlement. The [specification](CHANNEL_SPEC.md) defines the exact economic rule,
signed bytes, and failure behavior; the [quickstart](CHANNEL_QUICKSTART.md) gives
reproduction commands.

## What was checked

Astra xhigh scoped the implementation against the specification. Luna xhigh
workers implemented the Move, Rust protocol/runtime, and TypeScript components;
separate Luna xhigh review covered economic invariants, recovery, and Fly evidence.
The parent integrated the changes and ran all funded chain experiments.

| Check | Result |
|---|---|
| Rust unit/integration tests | 31 passed; two live endpoint tests are opt-in |
| Rust formatting and Clippy | Passed with warnings denied |
| Move tests | 25 passed, including the original 11 escrow tests |
| TypeScript type check and signing vectors | Passed; nine channel structures agree on BCS/hash, with Rust/TypeScript Ed25519 verification and Move signed vectors |
| Transaction-journal and codec regression tests | Passed, including uncertain submissions, external settlement attribution, mismatched arguments, and terminal refund accounting |
| Signed localnet economic checks | 34 passed; positive settlement and negative aborts use actual transactions |
| Live unrelated-endpoint attack | Rejected before the unregistered endpoint can act as the buyer |
| Ten-job RPC-denial experiment | Completed while both peer SDK transports refused RPC during the admitted job loop; zero actual RPC calls from either peer |
| Crash/restart matrix on localnet | Buyer persistence boundaries, provider faults, autonomous timer recovery, and zero-credit cooperative close passed |
| Recovery subset on public testnet | Buyer boundaries, provider faults, and autonomous timer recovery passed |
| Fly Machines | Separate Ashburn and Sydney machines completed ten jobs through Iroh relay |

The economic tests cover replay, cross-channel statements, overspending, stale
credits, exact payout/refund destinations, controller and endpoint authority,
endpoint rotation, nonce reuse, close/redemption races, deadline enforcement, and
residual refund. Snapshot keys authorize an existing channel until it terminates;
rotation affects new channels. Old endpoint keys and journals must be retained
until their funded channels are terminal.

Recovery tests stop at durable credit, acknowledgement, result, and close
boundaries. Replays preserve saved statements, result bytes, and transcript
commitments. Saved session reservations prevent silent replacement of missing
history. Terminal sessions permit authenticated replay of saved data and reject
new work. A provider restart can redeem the latest credit without another buyer
request; localnet also injects an actual RPC failure and verifies later retry.

Review fixes include strict connection admission and response binding, duplicate
request-ID rejection before persistence, durable close freeze, precise attribution
of recovered transactions, and timeout budgets that shrink with the remaining
claim window. Recovery runs independently of the accept loop and releases the
shared journal lock during RPC. Failed indexing waits retain the signed attempt
and successful execution evidence for reconciliation.

## Economic result and deployment

Each ten-job happy path funds **12,000 MIST**, pays **10,000 MIST**, returns
**2,000 MIST**, and leaves a terminal channel with zero funds. There are **two
economic transactions**, open and close, and no per-job transactions. Setup,
Agent registration, status reads, and failure-recovery transactions are counted
separately. The existing escrow requires two economic transactions per job, so
ten equivalent escrow jobs would require twenty; this is a transaction-count
comparison, not a measured ten-job gas or latency benchmark.

The public testnet package is
`0x71f11bfd3de3655838bc366de73da32323d213ac2f3e88a96d0f78ca51ab8739`,
with Domain
`0xc510365d0b4199f8c3a32e96292645a75d492f15deedb5aa2c7192a71c289f4e`.
The prior escrow deployment was retained. The new package adds the channel module
and package-scoped accessors without changing the existing escrow structs,
entry-point meanings, ALPN, or signed messages. An escrow exchange also passed
against this combined package.

The [local evidence](validation/channels-local-2026-09-10.json) records the
RPC-denial run and recovery matrix. The
[public evidence](validation/channels-testnet-2026-09-10.json) contains
checkpointed transaction digests, gas, balance changes, terminal channel state,
source hashes, and selected Fly observations. Operational keys, signed
transaction bytes, private archives, and raw journals are excluded. The audit
checks the actual genesis, package/Domain, changed Channel object, destination
balance changes, and refund net of gas independently of the buyer's reported
success.

## Cross-region connectivity and measurement limits

The [Fly experiment](FLY_POC.md) uses app `m2m-iroh-poc-20260910`, a provider in
`iad` (Ashburn), and a buyer in `syd` (Sydney). Each role has its own machine and
durable volume. The image contains neither role keys nor journals. Both peers
use the same public Sui testnet deployment.

The relay path is explicitly selected and verified from Iroh connection events.
A separate direct-path probe exposed no globally routable endpoint under the
default Fly configuration; private Fly 6PN addresses were rejected. This records
cross-region Iroh relay connectivity, without claiming public-IP direct transport
or diversity across residential NATs and independent hosting providers.

Before cleanup, the runner archives both complete role states privately and
checks the two settlement transactions against Sui. Temporary machines and
volumes are destroyed after successful settlement and archival; the empty app
is retained for further experiments.

The final Fly channel is
`0xd561a41ee2c72cc70a7b271b9461f2df4e087671116c0bee8b05dd2906400e24`.
Its open digest is `3mZDnoKWjFFRR2Xsa1eLSEhj84jsT1CWGQRvxwPcLyRU`, and its
close digest is `AXGUzVrKuxMj3EH7612zuFbdNC8qdgxsZZs5iHgYMjNq`. Both machines
reported image manifest
`sha256:5c545b1fdfced31e112dd58b681753176e04fb0eda9093092d5039a6b99f9131`.

| Final run | Ten-job offchain loop | Buyer command wall time | Net open + close gas |
|---|---:|---:|---:|
| Localnet, same host, debug build, both-peer RPC denial | 11,311 ms | 17,266 ms | 10,971,116 MIST |
| Public testnet, Fly Ashburn–Sydney, release build, forced relay | 4,591 ms | 38,467 ms | 10,971,116 MIST |

The Fly wall time includes the remote command round trip; the local command runs
on the control host. The final audit found eight terminal channels and no open
funded channels among all reported public testnet experiments. Setup, recovery,
and the earlier Fly run are included separately in the 23-transaction evidence
ledger; they are not part of the two-transaction happy-path count.

Timing samples are diagnostic single runs of a small deterministic file, with
durable storage and signature checking enabled. Local runs use a debug Rust
build; Fly uses a release build. Setup, RPC, relay placement, and storage affect
end-to-end measurements. These samples are not a throughput benchmark or a
production latency promise.

## Remaining boundaries

The buyer runtime limits unfulfilled prepayment to one job. A valid latest credit
can be redeemed even if that job is never delivered. Signatures, transcript
commitments, and file hashes do not prove arbitrary computation or fair exchange.
The provider must retain its latest authorization and get a transaction included
before the claim deadline; a sufficiently long outage can still lose payment.

This PoC has one operational endpoint/process per role, one fixture handler, SUI
collateral, and a bounded channel lifetime. Production custody, multi-worker
coordination, alternative assets, discovery, privacy proofs, and integration with
an independently implemented client remain future work. Matching signing vectors
across languages is useful conformance evidence, but both live peers currently
use the same Rust runtime. Customer demand and the first production workflow
remain open positioning questions.
