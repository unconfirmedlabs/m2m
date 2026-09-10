# Payment messages and settlement methods

Status: signed cumulative-channel PoC implemented and validated, 2026-09-10.
This document records the architectural decision and rationale; the channel
specification defines the exact wire contract. See [CHANNEL_SPEC.md](CHANNEL_SPEC.md)
and the [validation record](CHANNEL_VALIDATION.md). The
[implementation plan](CHANNEL_IMPLEMENTATION_PLAN.md) preserves the frozen design.
Sui and Iroh remain required foundations.
The existing fixture escrow and its published testnet package implement profile
0.1 in [PROTOCOL.md](PROTOCOL.md).

## Recommendation

Make payment communication part of m2m's core vocabulary. Implement payment
channels as a first-party, optional settlement method with its own signed payloads,
Move module, state machine, and recovery rules. An agent supporting only the
existing escrow can still participate in that method. Peers must agree on a
method before funding; unsupported methods fail explicitly.

Iroh carries work requests, results, and payment messages over authenticated
connections. A Sui agreement supplies collateral and enforceable redemption rules.
A monetary channel is a durable agreement, independent of any particular Iroh
connection or QUIC stream. Reconnecting must not create a fresh agreement or reset
payment sequence numbers. One connection can carry messages for several agreements.

| Boundary | Responsibility |
|---|---|
| m2m core | Agent identity and endpoint authority; agreement/request correlation; payment message category; method/version selection; signing domains and rejection rules |
| Settlement method | Meaning of authorization, collateral requirements, signed evidence, redemption, close/refund rules, deadlines, and authoritative outcome queries |
| Application | Work description, price negotiation, units/metering, result acceptance, and acceptable prepayment exposure |
| Optional proof implementation | Prove a precisely defined statement and verify it under the selected method's pinned rules |
| Iroh / Sui | Carry authenticated encrypted messages / enforce funded economic transitions |

Being optional does not mean being an unrelated add-on. The method ships with the
reference implementation and has a documented conformance suite. Its rules are
mandatory whenever that method is selected. Core does not need every participant
to run a prover or adopt inference-specific accounting.

## The problem this addresses

The current successful flow needs a funding and settlement transaction for every
job. Its [testnet baseline](VALIDATION.md#public-testnet) took 18,318 ms end to end,
including process startup and repeated RPC validation. That is not Iroh latency,
and removing transaction submission alone will not remove all of that overhead.

A channel can reserve a budget once, authorize many purchases through offchain
messages, and settle the cumulative amount later. The target for ten successful
jobs is two economic transactions total: open/fund and cooperative close. This
excludes deployment/registration, intermediate redemptions, and exceptional
recovery transactions. The deposit remains reserved for that particular payee;
it is not a shared offchain wallet spendable with arbitrary agents.

Sui Foundation describes a public experiment using programmable payment/state
channels whose offchain interactions end in mutually signed onchain closes. That
is relevant precedent, not a conformance specification or a throughput result for
m2m. [Sui Foundation, July 17, 2026](https://www.sui.io/blog/sui-processes-over-6-million-transactions-per-second-in-ai-agent-livestream-experiment).

## A payment is a typed message

The core envelope identifies the agents, agreement, request, method, action, and
version. The selected method defines the payload and how it is authenticated.
Illustrative JSON for a cumulative channel authorization:

```json
{
  "kind": "payment",
  "method": "sui.channel.v1",
  "action": "authorize",
  "agreement_id": "<channel object ID>",
  "request_id": "job-3",
  "body": {
    "sequence": "3",
    "cumulative_amount_mist": "3000",
    "request_hash": "<commitment to the agreed job>"
  },
  "signature": "<buyer endpoint signature>"
}
```

This means the designated provider can claim up to 3,000 MIST in total from that
channel. It does not add another 3,000 MIST to earlier authorizations. If 2,000
MIST has already been redeemed, the next redeemable delta is 1,000 MIST.

This example omits fields for readability and is not valid wire data. Canonical
signed bytes must bind the full chain identifier, package/deployment, method and
version, both Agent IDs, agreement, request/terms commitments, action, sequence,
and amount. Channel keys, recipient, deposit, and deadline are fixed by the
agreement. JSON remains a diagnostic representation; signed encoding stays BCS.

Method selection must be included in the signed agreement. An intermediary cannot
strip a required method or silently substitute escrow for a channel. Payment
messages require dedicated signing purposes so a signed work request cannot be
interpreted as an authorization to spend.

Candidate actions are `offer`, `authorize`, `acknowledge`, and `close`. Exact
action schemas belong to the method. A settlement notification carries a chain
reference that the receiver can verify. An acknowledgement establishes durable
receipt; it does not establish onchain payout. Expose authorized amounts,
redeemed amounts, residual escrow, and terminal outcomes separately.

## First method: a cumulative Sui payment channel

Use one buyer, one provider, one SUI deposit, and one writer per role. Retain the
existing distinction between controller wallets and operational endpoint keys.
The controller funds the channel and authorizes its endpoint; operational credits
cannot spend the controller's remaining wallet balance.

1. Open a channel with a bounded deposit, fixed payout/refund addresses, Agent IDs,
   endpoint-key snapshots, terms commitment, and immutable claim deadline. Persist
   an opening nonce and resolve uncertain funding to the original channel.
2. Quote a small fixed-price job over Iroh. The buyer signs and persists a
   cumulative credit before sending it. The provider verifies and persists it
   before acknowledging or doing the authorized work.
3. Deliver the result. After checking it, the buyer may authorize the next job.
   Request sequence and payment sequence have distinct roles. A repeated request
   reuses its durable records; it does not create another increment.
4. Cooperatively close with signatures binding the final amount and transcript
   commitment. Settle the unpaid delta and refund the residual deposit atomically.
5. If cooperation stops, the provider can redeem its highest saved authorization
   before the claim deadline. After expiry, the remaining escrow is refundable to
   the fixed buyer address. Previously paid funds are not reversed.

For the first fixture, allow only one job's price of advance credit at a time.
The provider can redeem that advance even if it fails to deliver useful work.
The buyer must understand and cap that exposure. This differs from the existing
escrow's acceptance-after-delivery rule, where the buyer can withhold acceptance.
The method must state this economic choice in the agreement.

Redemption is monotonic: cumulative amount cannot decrease or exceed the original
deposit, and only the difference from prior redemption is paid. Old authorizations
cannot pay twice or redirect the recipient. Each channel owns its mutable state;
independent channels must not contend on one shared provider balance object.

Before issuing terminal close consent, both runtimes durably freeze new channel
activity. A close cannot claw back an earlier redemption above its final amount.
Test this race explicitly and reconcile from chain state. Reclaiming residual
funds early must require the provider's consent; unilateral refund is deadline
bound, otherwise a buyer could cancel collateral behind an outstanding credit.

Retain a queryable terminal record in the first implementation. A missing object
or failed RPC must never be interpreted as evidence of payment or refund. If
later versions delete channels to recover storage, they need an equally clear
terminal evidence and transaction-recovery mechanism.

## Offchain operation and recovery

Validate funding and immutable channel terms when opening or resuming a session.
Normal in-session work uses local signature, sequence, budget, and transcript
checks. Move chain polling and settlement work outside the per-job request path,
while preserving the provider's ability to claim before expiry.

Stop accepting work before the claim deadline, leaving an explicit recovery
margin. Anchor deadline handling to observed chain time with conservative local
time handling. Schedule redemption/recovery; a manual command alone is not an
always-on payment guarantee. A bounded grace period cannot survive an arbitrarily
long RPC outage or loss of all copies of the latest authorization.

Persist credit before sending/acknowledging it, results before delivery, close
consent before transmission, and transaction attempts before submission. Reuse
m2m's process locks, durable writes, and unknown-outcome reconciliation. Refuse
ambiguous state after complete journal loss. Endpoint rotation affects future
channels; existing snapshots retain only their funded, time-bounded authority.

## Where actual ZK would fit

Offchain authorization followed by Sui redemption does not inherently require
zero-knowledge proofs. A signed channel can keep request and result bytes offchain
by settling commitments. Public Sui funding, participants, amounts, and timing
remain observable; a content hash alone is not a confidentiality guarantee.

If actual ZK is required, first specify what is proved and what must remain hidden.
One candidate is proof of authorized, budget-preserving transitions over a private
committed transcript. Proof of a particular model executing correctly is a
different application requirement. Neither follows from authenticated transport.

The core payment envelope can support a proof-bearing settlement method, but the
agreement must pin its verifier, circuit/version, public-input binding, and replay
rules before funds are committed. A sender cannot choose an arbitrary verifier
with each payment. Proof generation time, memory, verification gas, and failure
recovery need their own measurements.

Sui provides Groth16 verification over BN254 and BLS12-381. Its documentation
requires applications to identify the expected verification key and notes the
per-circuit trusted setup requirement. A shared Ed25519 identity primitive does
not choose the proof system. [Sui Groth16 documentation](https://docs.sui.io/develop/cryptography/groth16).

## Proposed implementation sequence and acceptance

1. Extract the shared identity/authority and agreement-binding interfaces from
   the current single escrow module. Add an explicit method selection boundary;
   do not turn the prototype into a universal task or payment framework.
2. Add a separate channel Move module and Rust driver using generic MIST amounts
   and commitments. Keep token counting, model selection, streaming policy,
   per-Node withdrawal machinery, and proving backends outside that module.
3. Add a session CLI that performs ten fixed-file jobs under one funded channel,
   then closes it. Use test funds and the existing server; no GPU is needed.
4. Test replay, stale/cross-channel/cross-method credit, overspending, fixed payout,
   key rotation, disconnects, restart, close/redemption races, expiry, and RPC loss.
   Verify actual signed vectors independently and execute the economic transitions.
5. Compare ten jobs against today's escrow baseline: transaction count and net gas,
   open/close cost, per-job latency, RPC calls during service, and recovery exposure.
   Claim a two-transaction happy path only when all ten jobs share one channel.

The extension requires a new experimental protocol version or negotiated ALPN;
existing v1 signed fields and meanings must not change silently. Multi-provider
routing, multi-party or bidirectional state channels, top-ups, general private
balances, and model-execution proofs remain separate scope decisions.

The implementation scope selects this core/method boundary and one job's price
of prepayment exposure. It implements signed cumulative credits; actual ZK proofs
need a separately specified statement and verifier and remain future work.
