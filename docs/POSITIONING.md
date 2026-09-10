# m2m positioning and problem definition

m2m's direction is to build **a new foundational standard for autonomous software
to communicate and transact: durable Sui identities, Iroh connectivity, native
messages, and programmable economic agreements.** The user selected this direction
on 2026-09-10 after reviewing alternatives. Existing agent protocols may integrate
above m2m or through adapters; they are not required bases.

This is a product and architecture decision, not evidence of adoption. The current
implementation proves a narrower paid-exchange mechanism. Customer demand, the
smallest useful native core, and production guarantees still need validation.
See the [current examples](../examples/messages/README.md) and the separate
[draft core proposal](CORE_MESSAGE_PROPOSAL.md).

The [PoC scope](POC_SCOPE.md) makes this hypothesis concrete: one
fixed-price service exchange between known operators, transported over Iroh and
settled from Sui escrow on a signed buyer acceptance, with a timeout refund path.
It separates a deterministic technical fixture from the still-open customer
workflow. Paid inference has not been selected as the first use case. The economic
rule now defines the technical experiment authorized on 2026-09-10. Implementation
and validation are documented in the [quickstart](QUICKSTART.md) and
[validation record](VALIDATION.md); customer positioning remains unvalidated.

The user subsequently authorized a [signed cumulative-channel PoC](CHANNEL_SPEC.md).
It targets a measured limitation of the first fixture: every job needs its own
funding and settlement transactions. One deposit should support ten jobs with
offchain payment authorizations, followed by one close. This changes the economic
rule to bounded prepayment and preserves the original escrow as another method.
Actual ZK proofs and a production customer workflow remain separate decisions.

## Accepted direction

| Decision | Status | Rationale |
|---|---|---|
| Build a new foundational m2m standard with native semantics | Accepted, 2026-09-10 | Give autonomous software a common communication and economic foundation; allow optional higher-level protocols and adapters |
| Use Iroh for transport | Accepted, 2026-09-10 | Connect software across changing networks using authenticated endpoints |
| Use Sui for economic programmability | Accepted, 2026-09-10 | Express economic authority, ownership, conditions, and settlement in programmable state |
| Build on their shared Ed25519 support | Accepted motivation, 2026-09-10 | Common signature primitives make a direct cryptographic binding feasible |
| Separate durable agent identity from its execution environment | Working architectural direction | Preserve the actor's identity across machine and operational-key changes |
| Review findings and define the problem before a proof of concept | Accepted sequence | Keep implementation focused on the agreed problem |
| Typed payment messages with optional settlement methods | Accepted PoC direction, 2026-09-10 | Keep economic meaning explicit without requiring every participant to implement every method |
| Signed cumulative Sui channels over Iroh | Authorized PoC, 2026-09-10 | Test repeated purchases under one deposit, durable recovery, and one-job prepayment exposure |

The shared cryptography does not require a single private key for all roles. Key
custody, delegation, Agent object ownership, and exact signature formats remain
design decisions. See the [north star](NORTH_STAR.md).

## Proposed problem statement

A developer exposing a useful service from an independently operated machine
wants another software process to buy or commission work under a bounded budget.
The service may move between machines or sit behind a network that does not offer
a convenient public application endpoint.

The developer needs one coherent way to bind the peer they communicate with to
the party authorized to accept economic terms, associate work with those terms,
and recover the correct payment outcome after failures. The buyer needs its
delegated spending limits enforced across requests and endpoints. The provider
needs to know which agreed condition lets it receive payment.

Existing protocols and libraries supply many of these pieces. The hypothesis is
that integrating them correctly still creates enough recurring work to justify a
small common core, optional profiles, and SDKs. The intended core also supports
unpaid communication; a funded agreement must not be a prerequisite for contacting
a peer or exchanging application messages. This must be tested with developers; a
landscape survey cannot establish the size or frequency of that pain.

## Candidate first participants

Recommended starting hypothesis: a developer buying a small, fixed-price compute
or data job from a known provider operating on a separate network. Both control
their own software and can adopt a lightweight integration. The relationship may
start by exchanging an agent identifier directly, without service search.

This setting exercises both required foundations: Iroh for reaching the running
service, Sui for an agreed economic condition. It also lets us state a modest
trust model while investigating demand. A broad public marketplace introduces
additional questions about discovery, fraud, evaluation, and liquidity.

| Candidate workflow | Why it could fit | What could make it a poor first choice |
|---|---|---|
| Fixed-price compute/data job between known operators | Clear parties, price, work reference, and economic outcome | Existing hosted APIs may already be easier and sufficient |
| Budgeted infrastructure service purchased from another operator | Repeated autonomous work and explicit spending authority | Broad operational permissions and long-running resource lifecycle |
| Paid inference across independently operated machines | Natural SDK integration and potentially variable deployment locations | Model quality, usage metering, privacy, and competing hosted APIs complicate the first test |
| Public marketplace for arbitrary agents | Broad long-term application | Requires supply, discovery, trust, and demand before the protocol can prove value |

These are candidate workflows, not an agreed roadmap. The first interview or
internal use case should supply the actual service and participants.

## Positioning against existing options

The [protocol survey](research/AGENT_PROTOCOLS.md) documents the evidence for each
comparison. The assessments here are proposed product judgments.

| Existing option | What it already offers | What m2m would need to demonstrate |
|---|---|---|
| MCP plus a service's existing authentication and billing | Tool integration into existing agent clients | Useful economic coordination and Iroh connectivity with little integration work |
| A2A over HTTPS plus OAuth and an established payment scheme | Task coordination, standard endpoints, and composable authorization/payments | A concrete advantage for independently operated peers and programmable Sui terms |
| A2A semantics with an Iroh binding and Sui economic extensions | A credible alternative composition and potential interoperability path | Where a native m2m core improves integration or guarantees, and what an optional adapter must preserve |
| x402 or another payment protocol plus Sui | Programmatic payment requirements and settlement integration | More than attaching a transaction digest to a request: clear agreement, authority, and recovery semantics |
| ANP or existing decentralized identity standards | Decentralized identity and discovery approaches | Specific Sui/Iroh economic behavior and a better integration experience |
| Tailscale/service identity plus APIs and existing billing | Mature private connectivity and workload/service identity patterns | Why the intended cross-operator economic workflow benefits from m2m |
| Direct custom Iroh application plus a small Move contract | All required ingredients under one developer's control | Enough repetition across independent applications to justify standardization |

The strongest competitor is often a composition of these tools. Benchmark against
that composition. Keeping Sui and Iroh fixed does not mean every layer above them
must be new.

## Scope for the foundational standard

The proposed architecture connects five things:

1. A durable agent and its currently authorized endpoint.
2. Negotiated protocol features and general correlated messages, without compulsory payment.
3. An optional identifiable agreement with exact economic terms and authority.
4. A work request/result reference understood by a native profile, application, or adapter.
5. An enforceable Sui economic transition and a recoverable outcome when payment is involved.

The deliverable is a native protocol with a small mandatory core and optional
profiles. The [core proposal](CORE_MESSAGE_PROPOSAL.md) explores that boundary;
its names and wire sketches are not yet a released contract. Preserve existing
PoC formats until a versioned migration is specified. Do not decide encoding,
task state, or object schemas solely to make a demo convenient.

Keep the longer-term possibilities visible: constrained budgets, escrow, metered
payments, recurring relationships, rights/access, and delegation among multiple
workers. The existing escrow and channel methods are the economic baseline.
Select further primitives against concrete workflows; implementing all of them at
once would obscure which problem creates demand.

## What shared Ed25519 contributes

The promising property is a common proof path: authenticate an Iroh endpoint,
associate its key with an agent and scoped authority, and let Sui Move verify an
explicit statement signed by that authorized key. The exact same statement could
be checked offchain and onchain when the protocol defines matching bytes and
verification rules.

This can support quotes, authorizations, acknowledgments, or receipts according to
the chosen economic model. It does not automatically solve delegation, aggregate
budgets, correct computation, or disputes. Those properties come from state and
verification rules we would specify and test. Transport authentication is not
itself an application agreement, and an ordinary Sui wallet signature uses signing
conventions that must be handled explicitly.

The underlying facts and exact address distinctions are sourced in
[the cryptography guidance](NORTH_STAR.md#3-use-ed25519-compatibility-precisely).

## Claims to earn

| Hypothesis | Evidence needed | Result that would change the direction |
|---|---|---|
| Developers repeatedly need this composition | Concrete recent workflows from intended buyer and provider developers | Interest remains abstract and no one has an exchange to run |
| The integration can be substantially easier | Compare setup and debugging effort with the strongest baseline | Baseline is equally simple and has the same required guarantees |
| Iroh helps the actual deployment environment | Reproduce connectivity/migration needs on representative networks | Providers are all conventional public APIs with no relevant connectivity pain |
| Sui programmability provides useful enforcement | Show the selected rule rejects an actual unauthorized or duplicate economic action | The workflow only needs a payment link or an unconstrained transfer |
| A reusable protocol is justified | At least two independent applications need the same semantics | Only one tightly coupled application needs them |

These tests can narrow the audience or protocol scope while retaining the accepted
foundational-standard direction, Sui, and Iroh. They are not permission gates for
routine research or implementation work.

## Decisions for the positioning discussion

The fixed-file PoCs already establish a technical baseline. For the next usable
protocol iteration, settle:

1. **The first exchange:** who buys what service from whom, and where does it run?
2. **The repeated pain:** what current integration or failure makes that exchange hard?
3. **The economic rule:** what condition must Sui enforce that matters to these parties?
4. **The trust model:** known counterparties, prepayment, acceptance, evaluator, or another explicit arrangement?
5. **The integration surface:** which existing client, task protocol, or service will adopt m2m first?
6. **The success threshold:** what measured improvement and failure behavior would justify continuing?

A useful next discussion can settle the first three, then choose the smallest
trust model and native profile that supports them. The fixtures should inform
the standard without making a paid fixed-file exchange its universal message model.

## Criteria for the next usable iteration

A bounded next iteration should demonstrate
an actual exchange between separately running peers, an authenticated binding to
the relevant Sui authority, and enforcement of the selected economic rule. It
should also demonstrate an applicable failure case such as duplicate submission,
revoked authority, excess budget, or disconnect during settlement.

Measure integration effort and operational behavior against the agreed baseline.
Keep any acceptance targets explicit and labeled as project targets. A demo will
validate technical feasibility; adoption requires independent use and continued
demand beyond that demo.
