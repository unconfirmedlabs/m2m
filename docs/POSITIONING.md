# m2m positioning and problem definition

m2m's proposed proposition is: **connect autonomous software over Iroh and make
its economic agreements executable on Sui.** The research supports investigating
this integration. It does not yet establish customer demand or prove that a new
standalone wire protocol is necessary.

## Accepted direction

| Decision | Status | Rationale |
|---|---|---|
| Use Iroh for transport | Accepted, 2026-09-10 | Connect software across changing networks using authenticated endpoints |
| Use Sui for economic programmability | Accepted, 2026-09-10 | Express economic authority, ownership, conditions, and settlement in programmable state |
| Build on their shared Ed25519 support | Accepted motivation, 2026-09-10 | Common signature primitives make a direct cryptographic binding feasible |
| Separate durable agent identity from its execution environment | Working architectural direction | Preserve the actor's identity across machine and operational-key changes |
| Review findings and define the problem before a proof of concept | Accepted sequence | Keep implementation focused on the agreed problem |

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
small common protocol/profile and SDK. This must be tested with developers; a
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
| A2A semantics with an Iroh binding and Sui economic extensions | A credible way to compose the required stack | Whether this is sufficient; if so, a profile/SDK may be the appropriate deliverable |
| x402 or another payment protocol plus Sui | Programmatic payment requirements and settlement integration | More than attaching a transaction digest to a request: clear agreement, authority, and recovery semantics |
| ANP or existing decentralized identity standards | Decentralized identity and discovery approaches | Specific Sui/Iroh economic behavior and a better integration experience |
| Tailscale/service identity plus APIs and existing billing | Mature private connectivity and workload/service identity patterns | Why the intended cross-operator economic workflow benefits from m2m |
| Direct custom Iroh application plus a small Move contract | All required ingredients under one developer's control | Enough repetition across independent applications to justify standardization |

The strongest competitor is often a composition of these tools. Benchmark against
that composition. Keeping Sui and Iroh fixed does not mean every layer above them
must be new.

## Proposed scope

The smallest promising scope is a shared contract connecting four things:

1. A durable agent and its currently authorized endpoint.
2. An identifiable agreement with exact economic terms and authority.
3. A work request/result reference understood by the application or an existing task protocol.
4. An enforceable Sui economic transition and a recoverable outcome.

That scope could become a protocol binding and economic profile, an SDK with a
small common envelope, or a distinct protocol if existing extension mechanisms
prove insufficient. Prefer the option that preserves interoperability and keeps
the mandatory surface small. Do not decide its encoding, task model, or object
schema solely to make a demo convenient.

Keep the longer-term possibilities visible: constrained budgets, escrow, metered
payments, recurring relationships, rights/access, and delegation among multiple
workers. Select one economic primitive for the initial validation. Implementing
all of them at once would obscure which problem creates demand.

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
Sui and Iroh foundations. They are not permission gates for routine research work.

## Decisions for the positioning discussion

Before the proof of concept, settle:

1. **The first exchange:** who buys what service from whom, and where does it run?
2. **The repeated pain:** what current integration or failure makes that exchange hard?
3. **The economic rule:** what condition must Sui enforce that matters to these parties?
4. **The trust model:** known counterparties, prepayment, acceptance, evaluator, or another explicit arrangement?
5. **The integration surface:** which existing client, task protocol, or service will adopt m2m first?
6. **The success threshold:** what measured improvement and failure behavior would justify continuing?

A useful first discussion can settle the first three, then choose the smallest
trust and interoperability model that supports them. The proof of concept should
test that chosen hypothesis, rather than become an implicit protocol specification.

## Suggested later proof-of-concept criteria

Once the positioning is agreed, a bounded technical experiment should demonstrate
an actual exchange between separately running peers, an authenticated binding to
the relevant Sui authority, and enforcement of the selected economic rule. It
should also demonstrate an applicable failure case such as duplicate submission,
revoked authority, excess budget, or disconnect during settlement.

Measure integration effort and operational behavior against the agreed baseline.
Keep any acceptance targets explicit and labeled as project targets. A demo will
validate technical feasibility; adoption requires independent use and continued
demand beyond that demo.
