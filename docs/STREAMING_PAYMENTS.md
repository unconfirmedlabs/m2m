# Native streaming payments

Decision date: 2026-09-11. Status: accepted architectural direction; the generic
wire contract and implementation remain unfinished. The user selected tunneled
streaming payments as a built-in m2m primitive applicable to real-time per-unit
pricing. The [research-agent proposal](RESEARCH_AGENT_PROPOSAL.md) is its first
proposed application. Sui and Iroh remain requirements.

## The primitive

A buyer funds a channel and authorizes incremental consumption. A provider
delivers within acknowledged credit and returns signed output/usage checkpoints.
The buyer replenishes credit as the interaction proceeds. The accumulated signed
state supports Sui settlement and recovery. Payment does not await subjective
task-completion approval.

This mechanism belongs in the m2m standard and reference SDK. An application
selects its unit definitions, rates, meter, and operating limits; it should not
have to invent credit replenishment, replay protection, recovery, and settlement.
Inference is one consumer of the primitive.

| Service | Possible priced units |
|---|---|
| Inference/research | Uncached input tokens, cached input tokens, output tokens; separately agreed tool charges |
| Data transfer | Bytes delivered |
| Media processing | Frames processed or milliseconds of audio processed |
| Compute rental | Milliseconds of an agreed resource allocation |
| API or sensor service | Calls, records, or samples delivered |

These are possible unit definitions, not claims that all measurements are equally
verifiable. Each policy must define the meter and admissible evidence. A signature
authenticates a measurement claim; its truth depends on the selected evidence and
trust model. The primitive does not judge whether research was useful.

## Built in, with optional use

Native streaming payments are part of m2m's foundation, with normative behavior,
schemas, signing rules, reference implementation, and conformance tests. Services
should compose with that implementation directly. Additional settlement methods
and service-specific pricing policies can extend it.

**Recommended placement: a standard m2m extension using core primitives.** The
user accepted built-in streaming payments and subsequently asked whether the
channel belongs in core or an extension. Extension placement is the recommendation
here, not yet a separately accepted user decision. Built-in means standardized
and shipped with the reference SDK; it does not require every peer to implement
channel accounting as a condition of basic communication.

| Mandatory communication core | Standard streaming-payment extension |
|---|---|
| Qualified Agent identity and operational authority | Buyer/provider roles and agreement-specific economic authority |
| Iroh admission, framing, and feature/version negotiation | Channel opening, funding, and selected payment-method version |
| Signature conventions, message IDs, and correlation | Economic statement domains, credits, usage checkpoints, and transcript rules |
| Delivery/replay contracts and persistence interfaces | Economic duplicate handling, monotonic counters, and credit-window control |
| Explicit unsupported-feature/error behavior | Pricing validation, redemption, exact close, refunds, and deadline recovery |

The extension must specify its own economic invariants; generic reliable delivery
does not supply them automatically. Implementers can update payment methods and
pricing policies without changing ordinary message semantics. Peers select a
version before opening a paid stream; once selected, its rules are mandatory.
Unsupported streaming payments must never silently turn into unprotected work.

Service adapters above the extension define unit meanings and supply metering
events. The extension handles the common payment machinery. Future escrow or
subscription extensions can reuse the same core without inheriting channel state.

Unpaid messaging remains available. Establishing a peer connection does not open
a channel, create buyer/provider roles, or require a deposit. Peers negotiate the
payment feature and supported policy before paid use; unsupported requirements
fail explicitly. Minimum conformance levels still need specification. Optional
use does not make the primitive an application-owned billing add-on.

Keep the reusable payment state machine separate from connection admission and
work execution internally. A paid logical stream survives an Iroh reconnect; its
identity is not a QUIC stream ID. Transport packets, work responses, usage
checkpoints, and credit updates need not occur one for one.

## Common contract versus service policy

| m2m defines and implements | Service policy supplies |
|---|---|
| Agreement and paid-stream references; exact immutable terms binding | Supported service and billable unit definitions |
| Separate communication and economic authority | Meter identity, usage source, and accepted evidence |
| Cumulative authorization, checkpoints, credit renewal, and duplicate handling | Rates and any expressly supported fee/tier rules |
| Common price-policy encodings and deterministic validation | Chosen policy version, asset, unit denominators, and negotiated limits |
| Durable acknowledgement, resume, stop, close, redemption, and expiry behavior | Execution-specific cancellation and resource control |
| Enforcement of the selected economic method's invariants | Application interpretation of the result |

The standard should ship common evaluable pricing policies. A bounded vector of
integer quantities and integer rates, with explicit denominators and cumulative
rounding, is a useful initial family. This permits different input/output rates
without putting the concept of a token into the generic channel engine. Pin each
dimension's meaning so the same quantity cannot be reinterpreted mid-agreement.
Exact encoding, allowed dimension count, and extension negotiation are spec work.

An arbitrary price callback or an opaque terms hash is insufficient for a claim
of shared formula enforcement. The chosen method must specify what the peers
check and what Move checks. Reject unsupported mandatory pricing rules before
funding. Publish optional immutable Sui policy objects when useful, and always
pin accepted terms. This decision does not require one onchain object per message.

## Required economic and recovery behavior

1. Bind the buyer/provider Agent references, economic signers, asset, terms,
   destinations, deposit, and deadlines when opening the agreement.
2. Bind each work request and cumulative credit to the agreement and current
   transcript/checkpoint. Persist signed authorization and acknowledgement before
   their corresponding externally visible transitions.
3. Keep authorized units, delivered units, authorized amount, actual accrued
   amount, and redeemed amount distinct. Validate the price equation and caps;
   a cumulative update never adds its entire total again.
4. Deliver only within acknowledged credit. Renew authorization during the
   interaction; stop at the boundary if renewal fails. Application adapters
   must define cancellation latency and any generated-but-undelivered overshoot.
5. Support exact cooperative close using the existing buyer authorization plus
   provider usage and close consent. It does not require the buyer to approve
   the final answer. Preserve unilateral credit redemption and expiry recovery.
6. Retransmit and reconcile persisted statements after reconnects and crashes.
   Duplicate messages must not create another charge or dispatch. Do not restart
   uncertain external work merely because a connection was lost.

Exact close cannot reverse funds already redeemed above actual usage. A rolling
credit window bounds the outstanding advance; initial input or setup charges
need their own explicit bound. Funding alone grants no right to claim the entire
deposit. Changing display names or transport keys cannot erase economic rights.

Begin with one payer, one payee, and one writer per role for an agreement.
Concurrent streams sharing a deposit require a specified serialization/reservation
rule; no stream may independently assume it owns the whole remaining budget.

## Foundation and compatibility work

Specify the primitive alongside the F0 model and identity/signature boundaries.
Implement general admission and reliable messaging first, then bind the payment
engine and service adapters according to [F1–F4](FOUNDATION_PLAN.md). The foundation
must anticipate streaming payments now even though implementation has dependencies.

m2m's current `sui.channel.v1` proves a narrower fixed-file exchange. It does not
yet implement generic units, a research stream, separate economic keys, or the
metered exact-close binding described here. Preserve its signed formats and
funded agreements through explicit compatibility/versioning work. The intended
tunnel flow is the starting model for this generalization.

Conformance must include credit exhaustion, checkpoint-bound replenishment,
request/payment replay, wrong units or rates, cumulative rounding, duplicate
delivery, crash recovery, exact close, unilateral redemption, and deadline races.
Use at least two unit policies over the same engine to demonstrate that the
primitive is reusable beyond inference. Examples must distinguish implemented
messages from this unfinished generic contract.
