# m2m in the agent protocol landscape

**m2m is a working prototype for authenticated, paid exchanges between software
peers. It is substantially narrower than a general agent communication protocol.**
It implements work delivery, session recovery, and errors alongside payments,
but those messages currently support one fixed-file service. Its most credible
contribution is the explicit binding between Sui Agent authority, Iroh endpoint
authentication, signed economic statements, and recoverable settlement.[^1]

The surrounding ecosystem already addresses tools, tasks, decentralized identity,
commerce, and funded offchain payments. In particular, **MPP sessions and x402
batch settlement overlap directly with m2m's cumulative-channel mechanics**.
Payments embedded in agent messages, cumulative vouchers, and blockchain agent
identities are established design directions. The opportunity to validate is
whether their integration on the required Sui–Iroh stack materially simplifies a
specific cross-operator workflow.[^8][^10][^12][^23]

This review checks public upstream materials on **2026-09-10** and evaluates m2m
at commit `b8c209e84d89a6e39d108e4f58e6847bd17e8ad1`. It separates implemented
behavior, published specifications, experimental drafts, and recommendations.
The [north star](../NORTH_STAR.md) and [positioning](../POSITIONING.md) remain the
project's governing direction. Recommendations below are proposals for discussion;
they do not change the requirements or adopt a new protocol architecture.

**Direction update, 2026-09-10:** after this review, the user selected a new
foundational m2m standard with native semantics. The comparisons and implemented
capability findings below remain a dated baseline; the A2A-binding recommendation
is an alternative considered, not the selected foundation. See the
[core proposal](../CORE_MESSAGE_PROPOSAL.md) and
[current message examples](../../examples/messages/README.md).

## What m2m actually implements

The [message inventory](M2M_MESSAGE_INVENTORY.md) supplies the full wire table,
runtime findings, and source anchors. The channel profile declares twelve message
types; eleven have active runtime roles:

| Category | Implemented surface | Meaning today |
|---|---|---|
| Payment | Six active types covering offers, authorization, acknowledgement, and cooperative close | Establish and advance one funded agreement |
| Work | `work.get`, `work.result` | Retrieve or replay bytes for an already authorized request |
| Session | `session.resume`, `session.ready` | Admit a connection and reconcile an existing payment agreement |
| Error | `error` | Report handled failures without granting economic authority |

The twelfth type, **`payment.settlement`, is a specification/runtime gap**. The
normative wire table describes a digest hint that triggers reconciliation and a
`session.ready` response. A type and validator exist, but no sender or receiver
handler implements that workflow. The successful buyer instead submits close
through its local chain adapter. This should be resolved through an explicit
conformance fix or specification revision, not described as an intentionally
reserved feature.[^1]

The original escrow remains a separate profile with three request shapes and
four response shapes, including an implemented `settled` response. Escrow pays
on signed buyer acceptance after delivery. The cumulative channel authorizes
payment before delivery and amortizes settlement across jobs. These economic
contracts and wire formats are distinct.[^1][^2]

There is no generic task submission, arbitrary argument object, conversation,
task list, cancellation, progress event, capability catalog, or delegation
protocol. `ServiceHandler.execute()` takes no job input; the only handler returns
the configured file, bounded to 64 KiB. The buyer supplies `--expected-file` and
its result hash before agreement. Ten jobs return the same preagreed bytes.
QUIC streams carry complete bounded requests and responses; they are not
application-level token or artifact streaming.[^1]

Consequently, changing the handler to call a model would not by itself create a
general paid-task protocol. Dynamic work needs an input commitment, output
contract, acceptance rule, and economic treatment of failure. The fixture
establishes transport and settlement mechanics, not demand for ten repeated
downloads or correctness of unknown computation.

## The comparison by responsibility

Protocols at different layers are often complementary. A tool interface is not a
payment rail, a registry is not a transport, and a signed authorization is not a
delivery guarantee.

| Protocol | Primary responsibility and representative semantics | Identity/authority and transport | Verified revision or status |
|---|---|---|---|
| **MCP** | Tool calls, resources, prompts; optional asynchronous tasks | Host/server access policy; OAuth for HTTP; stdio and Streamable HTTP | Current core **2026-07-28**; separate Tasks **2026-07-28 stable** snapshot and development draft[^3][^4] |
| **A2A** | Messages, tasks, artifacts, status, cancellation, subscriptions | Agent Cards and declared security schemes; JSON-RPC, gRPC, HTTP+JSON | Latest listed release **v1.0.1**, May 2026; living binding guidance[^5][^6] |
| **BeeAI Agent Communication Protocol** | Historical agent descriptions, runs, sessions, streamed events | HTTP runtime interface; application authentication | Joined A2A; repository archived **2025-08-27**[^7] |
| **Agent Client Protocol** | Editor/agent sessions, prompts, updates, permissions, filesystem/terminal operations | Client controls local resources; JSON-RPC, commonly subprocess stdio | Stable wire **v1**; **v2 draft**, July 2026[^17] |
| **MPP** | Payment Challenge, Credential, Receipt; charge and session methods | Payment signer plus optional request attestations; HTTP payment authentication | Working drafts; Tempo session `-00`; released `mppx@0.9.3`[^8][^9][^10] |
| **x402** | Requirements, signed payment payload, settlement response; exact, upto, batch mechanisms | Scheme-specific wallets/authorizers and facilitators; HTTP and other bindings | Core **v2**; EVM batch specification and implementation on upstream `main`[^11][^12] |
| **Sui Payment Kit** | Transfers, receipts, registry duplicate prevention, payment URIs | Sui transaction authority and administrative capabilities | Living standard with Move and SDK sources; not a channel specification[^15] |
| **Agentic Commerce Protocol** | Merchant checkout/cart/order lifecycle and payment handlers | Merchant authentication, scoped payment credentials; REST and MCP artifacts | OpenAI/Stripe project marked **beta**; latest listed stable snapshot **2026-04-17**[^18] |
| **UCP / AP2** | Commerce capabilities / signed purchase and payment mandates | Business/platform identity and payment participants; web interfaces and bindings | UCP release **2026-08-25**; AP2 **v0.2** materials, ongoing standardization[^19][^20] |
| **ANP** | DID identity, service descriptions/discovery, messaging, payment adaptation | `did:wba`, HTTP signatures, messaging encryption/federation profiles | Project's **1.1** suite; vNext drafts; payment status inconsistency noted below[^21][^22] |
| **ERC-8004** | Agent identity, reputation, validation registries | Ethereum registry ownership and associated wallet proofs | **Draft ERC**; not a task, transport, or settlement protocol[^23] |
| **Virtuals Agent Commerce Protocol** | Paid-job negotiation, escrow, delivery, optional evaluation | Platform contract/account roles and SDK integration | **ACP v2** implementer documentation[^16] |

These statuses describe the cited artifacts, not universal client support or
production maturity. In particular, a released SDK version is not a protocol
version, and an upstream implementation is not evidence that every facilitator
or deployment supports it.

## The closest economic alternatives

### MPP sessions

The Machine Payments Protocol uses an HTTP `402` challenge, an `Authorization:
Payment` credential, and a payment receipt. Its core separates payment methods
from the common interaction. The rendered core is `draft-httpauth-payment-01`,
dated September 9; the linked Datatracker submission uses the
`draft-ryan-httpauth-payment` name. These are working drafts, not an approved RFC.
The project also has released SDKs and integration examples.[^8][^9]

Tempo sessions fund a unidirectional channel, accept cumulative signed vouchers,
and support top-up, settlement, cooperative close, and forced withdrawal after
a close-request grace period. This is a direct comparison for m2m, including
its economic failure paths. The reviewed method uses EIP-712 voucher signatures
and Tempo settlement; it is not compatible with m2m's Ed25519/BCS statements or
Move Channel objects.[^10]

The `mppx` session implementation distinguishes accepted authorization, recorded
spend, and chain settlement. It provides server-owned settlement scheduling,
resumption, and atomic shared storage semantics. Its identity support also
includes Web Bot Auth and Trusted Agent Protocol attestations across payment
retries. Thus “payments plus identity plus recovery” is too broad a
differentiation claim for m2m.[^9]

The relevant distinction is the exact authority and deployment model: m2m ties
operational signatures to a Sui Agent and an Iroh peer, then enforces a bounded
SUI agreement. Whether that is easier or more useful for intended operators
remains unmeasured. A proposed Sui payment method or Iroh-facing adapter would
need an explicit mapping; MPP's extensibility does not supply either automatically.

### x402, including channels and Sui

x402 v2 separates resource/payment descriptions from network-specific mechanisms
and transport bindings. Its familiar HTTP flow uses payment-required,
payment-signature, and payment-response signaling. It is not limited to one
chain or to HTTP semantics embedded directly in applications.[^11]

The EVM `batch-settlement` scheme already uses funded channels and cumulative
offchain vouchers. Clients can top up and delegate voucher signing; server
channel managers claim, settle, and refund. Claims can aggregate many channels,
with receiver transfer in a separate settlement step. The current source includes
client recovery and file/server storage implementations. This is implemented
overlap, not merely a proposal for future micropayments.[^12]

There is also an **`exact` Sui scheme specification**: the payer signs a complete
Sui transaction; a facilitator verifies and submits it. That is different from
a reusable collateralized channel. The checked official TypeScript mechanisms
directory does not include a Sui package, so the specification should not be
reported as universal official-SDK or facilitator support. No Sui channel
implementation was established from these examined x402 artifacts.[^13]

Payment-Identifier, Sign-In-With-X, and signed offer/receipt extensions address
retry identity, reuse of paid access, and verifiable commercial statements.
Google's separate A2A x402 v0.1 extension demonstrates payment requirements and
receipts correlated with A2A tasks. Versioned extension compatibility must still
be checked against the selected A2A/x402 revisions.[^14]

**Assessment:** m2m can credibly claim a tested Sui–Iroh channel composition.
It cannot claim that existing payment protocols require an onchain transfer for
every request, have no identity, or ignore recovery. Its exact transaction count
should not be compared with another scheme without matching funding, claim,
withdrawal, and failure assumptions.

### Sui Payment Kit and Virtuals ACP

Payment Kit supplies reusable Sui transfer validation, receipt objects, events,
and optional registry-based duplicate prevention. Ephemeral payments intentionally
omit persistent duplicate checks; registry records have retention/expiration
rules. These are practical primitives for a Sui application. The reviewed
standard does not define cumulative vouchers, an Iroh session, or a work-delivery
agreement, so it is a component to evaluate rather than a replacement for all
of m2m.[^15]

Virtuals **Agent Commerce Protocol** is a closer paid-job comparison than a
coding-client protocol. Its v2 documentation describes adaptable job offerings
and an optional evaluator. It demonstrates another effort to combine agreement,
escrow, delivery, and assessment. Evaluation is a distinct trust mechanism;
neither evaluator approval nor m2m's result hash should be presented as an
automatic proof of arbitrary execution. A Virtuals integration would require
its own account, contract, and message mapping.[^16]

## Work, tools, and user-facing interaction

MCP standardizes service exposure through operations such as `tools/list`,
`tools/call`, `resources/read`, and prompt retrieval. Its current core uses
self-contained requests with per-request metadata, rather than the older
initialization/session handshake. `server/discover` is available for learning
server versions and features. HTTP authorization follows an OAuth resource-server
model; local stdio has a different credential boundary.[^3][^4]

Asynchronous Tasks is now an optional extension, with polling and input-update
semantics. Its official repository marks the `2026-07-28` snapshot Stable and
`draft` Development. The rendered site's “Draft” navigation link is not evidence
that the released extension remains experimental. Host support still varies and
requires explicit opt-in. m2m supplies neither MCP's service catalog nor a
compatible tool-call surface. A local bridge could reach existing clients if it
specifies funding authority and uncertain payment outcomes.[^3][^4]

A2A is the strongest existing candidate for external work semantics. It supports
messages without tasks as well as task execution, contextual interactions,
artifacts, interrupted states, cancellation, and asynchronous updates. An Agent
Card describes services and interfaces; its identity/security declarations do
not themselves grant Sui spending authority.[^5]

A2A also explicitly permits custom protocol bindings. A genuine Iroh binding
must support all required core operations, preserve the data model, errors,
security, and advertised streaming behavior, and declare its binding/version
in the Agent Card. Merely
serializing an A2A-shaped JSON object over QUIC would not establish conformance.
The required integration work is real, even when reusing the task model is the
right decision.[^6]

BeeAI's historical **Agent Communication Protocol** contributes useful run/session
ergonomics, but its effort joined A2A and the repository is archived. Treating
both as equally current integration targets would overstate the landscape.[^7]

**Agent Client Protocol** concerns an editor interacting with a coding agent:
prompts, updates, permission requests, filesystem access, and terminal management.
Its v1/v2 distinction is separate from the commerce protocols also called ACP.
These editor-facing features are not missing mandatory pieces of m2m's economic
core. They could be supplied by a client integration if a selected workflow
needs them.[^17]

## Commerce authorization and decentralized identity

OpenAI/Stripe **Agentic Commerce Protocol** defines merchant checkout operations
including create, update, retrieve, complete, and cancel. The April snapshot
includes idempotency behavior and payment handlers, while product integration
is evidenced by Stripe's Instant Checkout announcement. This is a commerce
workflow with merchant infrastructure, not a universal paid-computation contract.[^18]

UCP organizes commerce into discoverable capabilities, extensions, and payment
handlers. Its specification includes REST, MCP, and A2A bindings and explicit
business/platform negotiation. AP2 adds signed authorization artifacts: current
materials distinguish open and closed **Checkout Mandates** and **Payment
Mandates**, with receipts and verification roles. AP2 leaves general agent-to-agent
mandate delegation outside its current scope. These systems distinguish purchase
intent from payment authority more fully than a simple wallet signature.[^19][^20]

Neither an AP2 mandate nor m2m's endpoint authorization proves that a service
delivered a useful answer. For m2m, a funded channel currently authorizes one
endpoint to advance one agreement. It does not implement “spend up to $10/day”
across agents or issue attenuated downstream grants. Future delegation needs a
separate enforcement and concurrency model; importing a mandate shape would
not enforce it in Move.[^1][^20]

ANP is a close conceptual neighbor for the broader “agent internet” ambition.
Its released `did:wba` 1.1 document uses web-resolved identity and HTTP request
signatures, including an Ed25519 profile. Descriptions, discovery, messaging,
and encryption/federation profiles provide considerably more communication
semantics than m2m currently implements. This is a web-based architecture with
its own trust boundaries, rather than an Iroh binding.[^21]

There is a material ANP status caveat: the repository describes its English
payment adaptation as released v1.1, while that document's title still says
“draft” and describes adaptations of an earlier Google AP2 model. Treat it as
evidence of payment design work; do not infer compatibility with current Google
AP2 or implementation support for the entire suite.[^22]

ERC-8004 proposes identity, reputation, and validation registries. Its identity
registration can reference agent interfaces, but registry existence does not
provide task transport, funded settlement, or service correctness. The EIP is
still marked Draft. It is relevant precedent for durable onchain agent identity,
not a reason to replace the project's required Sui foundation.[^23]

## Evidence, maturity, and positioning

| Dimension | m2m's current standing | What the comparison implies |
|---|---|---|
| Funded repeated exchange | Implemented and tested on Sui localnet/testnet | A concrete foundation; cumulative channels also exist elsewhere |
| Transport/authority binding | Sui-authorized endpoint checks plus Iroh communication | A specific integration to evaluate with real operators |
| Economic recovery | Durable credit/result/close history, replay, redemption, refund | Useful implementation evidence; not unique as a protocol category |
| General service semantics | One immutable fixture, known output hash | Behind task/tool standards for application integration |
| Negotiation/discovery | Known tickets and exact method/version rejection | No negotiated service/method catalog or general discovery |
| Interoperability | Cross-language signing vectors; same Rust runtime on both live peers | Not yet independent wire implementations or upstream compatibility |
| Distribution/maintenance | Repository quickstarts and tests; packages marked nonpublishable | Early project packaging, not a published SDK ecosystem |

The committed validation records ten sequential jobs using two economic
transactions, with 10,000 MIST paid and 2,000 refunded. A local experiment denied
RPC at both peers during the admitted job loop. Separate Fly machines in Ashburn
and Sydney completed the loop through a verified Iroh relay in 4,591 ms.
These are meaningful scoped results.[^2]

They are single-run diagnostics, not comparative throughput measurements. The
direct public-IP probe did not establish a usable direct path, and both regions
were on Fly. The experiment does not demonstrate residential NAT diversity,
independent client implementations, or customer demand. The recorded open/close
gas, 10,971,116 MIST, also exceeded the illustrative 10,000-MIST service revenue;
the transaction-count improvement alone does not establish commercial unit
economics.[^2]

The channel permits one job of unfulfilled advance under the honest buyer
runtime. Move enforces the deposit and signed cumulative payout, not delivery.
A compromised operational key can authorize the remaining deposit, and a
provider that cannot claim before the deadline can lose payment. Actual ZK,
fair exchange, and correct arbitrary computation remain unimplemented.[^2]

MCP's product integrations and conformance tooling, A2A's SDK/TCK infrastructure,
and MPP's released SDK demonstrate integration surfaces beyond m2m's current
stage. This does not establish a comparable ranking of active users, reliability,
or market share. Publisher download figures and service catalogs are not
equivalent to independent paid usage.[^9][^24]

At the reviewed commit, Cargo sets `publish = false`, npm sets `private = true`,
and the tracked tree contains no `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, or
`.github` CI workflows. These are observable distribution and maintenance gaps,
not conclusions about legal status or underlying code quality. If independent
adoption becomes the next objective, release terms, a security contact, CI, and
contribution expectations belong in that work.[^25]

The strongest current positioning hypothesis is:

> m2m makes funded service agreements between Sui-authorized Iroh peers explicit
> and recoverable, while allowing applications to use existing task or tool
> interfaces where those fit.

The harder question is whether this should become a standalone application wire
protocol, a reusable economic layer, or a binding/profile. The strongest
composition to compare is **A2A work semantics + a specified Iroh binding + a Sui
economic extension**. It keeps both required technologies and challenges only
which application semantics m2m needs to invent. Existing A2A payment extensions
demonstrate the composition pattern; they do not deliver this exact stack.[^6][^14]

An equally relevant economic baseline is a small service over Iroh using Sui
contracts directly, informed by MPP/x402 channel lifecycles. If m2m does not
reduce integration effort or failure handling beyond that baseline across more
than one application, a reference library may be the appropriate deliverable.
That would be a product-scope decision, not a failure of the technical PoC.

## Proposed next decisions

| Priority | Decision or experiment | Evidence needed before expanding scope |
|---|---|---|
| **1** | Reconcile `payment.settlement` and maintain a message/handler conformance map | Every normative message has a runtime path and behavior check, or an explicit versioned deferral |
| **2** | Select a participant and dynamic service workflow | Two independent operators identify an actual exchange and the limitation of their existing alternative |
| **3** | Choose native contract, A2A adapter, or full A2A binding | Compare implementation effort, preserved semantics, and actual client integration for that workflow |
| **4** | Specify work/economic correlation | Input commitments, output types, acceptance, retries, cancellation races, partial work, and outstanding-credit rules |
| **5** | Compare cumulative settlement methods | MPP/x402-informed review of deadlines, top-up, signer compromise, storage loss, concurrency, and recovery cost |
| **6** | Earn independent implementation and deployment evidence | A second client implementation, automated conformance, useful application integration, representative networks |

A constrained adapter is a reasonable initial experiment if it reaches a useful
client without requiring a complete new binding. A full A2A binding is preferable
only if preserving A2A's contract serves the chosen workflow and its compatibility
cost is justified. A small native contract remains reasonable if requirements
show a concrete mismatch. **None of these choices is adopted by this review.**

For the next application test, measure setup time, custom integration code,
recovery without operator intervention, actual gas relative to service value,
and repeat use by the independent parties. Define the acceptance contract for an
unknown output before adding dynamic computation. Add streaming, discovery,
delegation, alternative assets, or proofs only when the selected workflow
establishes which guarantee they must supply.

## Sources

All sources checked 2026-09-10. Living pages and `main` branches may advance;
the revisions below identify what was reviewed and are not dependency pins.
Repository validation is committed historical evidence, not a new benchmark or
security audit performed for this report.

[^1]: m2m. [Implemented message inventory](M2M_MESSAGE_INVENTORY.md), commit `b8c209e`, with pinned Rust/Move/CLI source references; [channel specification](../CHANNEL_SPEC.md), 2026-09-10. Message support, fixture scope, and conformance gap.
[^2]: m2m. [Channel validation](../CHANNEL_VALIDATION.md), [settlement methods](../SETTLEMENT_PROFILES.md), and [original escrow validation](../VALIDATION.md), commit `b8c209e`, 2026-09-10. Guarantees, tests, costs, and deployment limits.
[^3]: MCP maintainers. [The 2026-07-28 Specification](https://blog.modelcontextprotocol.io/posts/2026-07-28/), July 28, 2026; [current versioning](https://modelcontextprotocol.io/docs/2026-07-28/learn/versioning); [specification](https://modelcontextprotocol.io/specification/2026-07-28). Release, stateless requests, and features.
[^4]: MCP. [Transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports), [authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [Tasks extension repository/version table](https://github.com/modelcontextprotocol/ext-tasks), [stable Tasks specification](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks), and [host support/opt-in](https://modelcontextprotocol.io/extensions/tasks/overview). Stable optional extension versus separate development draft.
[^5]: A2A project. [Specification](https://a2a-protocol.org/latest/specification/), [Life of a Task](https://a2a-protocol.org/latest/topics/life-of-a-task/), and [releases](https://github.com/a2aproject/A2A/releases). v1.0.1 release entry published May 28, 2026, changelog dated May 26.
[^6]: A2A project. [Custom Protocol Bindings](https://a2a-protocol.org/latest/topics/custom-protocol-bindings/), living guidance. Declaration, equivalence, error, security, and interoperability requirements.
[^7]: BeeAI. [ACP repository](https://github.com/i-am-bee/acp), archived August 27, 2025; [ACP Joins Forces with A2A](https://github.com/orgs/i-am-bee/discussions/5), August 25, 2025. Historical implementation and consolidation.
[^8]: Tempo/Stripe. [MPP specifications repository](https://github.com/tempoxyz/mpp-specs), [rendered core `draft-httpauth-payment-01`](https://paymentauth.org/draft-httpauth-payment-01.txt), September 9, 2026; [Datatracker submission](https://datatracker.ietf.org/doc/draft-ryan-httpauth-payment/). Working-draft status and HTTP payment model.
[^9]: MPP/mppx. [Release `mppx@0.9.3`](https://github.com/wevm/mppx/releases/tag/mppx@0.9.3), September 10, 2026; [Tempo session design](https://github.com/wevm/mppx/blob/main/src/tempo/session/README.md); [improved sessions](https://mpp.dev/blog/sessions-improved), June 17; [identity support](https://mpp.dev/blog/mppx-identity-support), August 12. Implementation, recovery, accounting, and attestation evidence.
[^10]: Tempo. [Tempo Session Intent `draft-tempo-session-00`](https://paymentauth.org/draft-tempo-session-00.html), rendered September 9, 2026, especially §§6, 10–14; [EVM session draft](https://paymentauth.org/draft-evm-session-00.html). Working method specifications, not approved RFCs.
[^11]: x402 Foundation. [x402 specification v2](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md), v2 dated December 9, 2025, living source. Requirements, payloads, extensions, and bindings.
[^12]: x402 Foundation. [Batch settlement documentation](https://docs.x402.org/schemes/batch-settlement), [EVM scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement_evm.md), and [TypeScript implementation](https://github.com/x402-foundation/x402/tree/main/typescript/packages/mechanisms/evm/src/batch-settlement). Current source verified; no universal facilitator-support claim.
[^13]: x402 Foundation. [Exact Sui scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_sui.md) and [TypeScript mechanisms directory](https://github.com/x402-foundation/x402/tree/main/typescript/packages/mechanisms). Bounded specification/SDK coverage observation.
[^14]: x402 Foundation. [Payment-Identifier](https://docs.x402.org/extensions/payment-identifier), [Sign-In-With-X](https://docs.x402.org/extensions/sign-in-with-x), [signed offers/receipts](https://docs.x402.org/extensions/offer-receipt); Google Agentic Commerce. [A2A x402 extension v0.1](https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.1/spec.md). Optional extensions and task/payment composition.
[^15]: Sui Foundation. [Payment Kit Standard](https://docs.sui.io/onchain-finance/payment-kit) and [Choose a Payment Model](https://docs.sui.io/onchain-finance/choose-payments-model), living documentation with Move/SDK links. Receipt and duplicate-prevention primitives.
[^16]: Virtuals. [Introducing ACP v2](https://whitepaper.virtuals.io/get-started-with-acp/acp-v2-a-primer) and [technical deep dive](https://whitepaper.virtuals.io/about-virtuals/agent-commerce-protocol/technical-deep-dive), living implementer documentation. Paid-job lifecycle and optional evaluation.
[^17]: Agent Client Protocol. [v1 overview](https://agentclientprotocol.com/protocol/v1/overview), [updates](https://agentclientprotocol.com/updates), and [repository versioning](https://github.com/agentclientprotocol/agent-client-protocol). Stable wire v1, v2 draft announced July 20, 2026; SDK versions separate.
[^18]: OpenAI/Stripe. [Agentic Commerce Protocol repository](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol) and [April 17 checkout OpenAPI](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/blob/main/spec/2026-04-17/openapi/openapi.agentic_checkout.yaml); Stripe. [Instant Checkout launch](https://stripe.com/newsroom/news/stripe-openai-instant-checkout), September 29, 2025. Beta snapshot and historical product evidence.
[^19]: UCP. [Specification overview](https://ucp.dev/specification/overview/) and [v2026-08-25 release](https://github.com/Universal-Commerce-Protocol/ucp/releases/tag/v2026-08-25). Living capability/binding model and released snapshot distinguished.
[^20]: Google Agentic Commerce. [AP2 specification](https://github.com/google-agentic-commerce/AP2/blob/main/docs/ap2/specification.md); Google. [AP2 donation to FIDO and v0.2](https://blog.google/products-and-platforms/platforms/google-pay/agent-payments-protocol-fido-alliance/), April 28, 2026. Current mandate model, delegation boundary, and standardization status.
[^21]: ANP. [Repository and specification map](https://github.com/agent-network-protocol/AgentNetworkProtocol) and [did:wba 1.1](https://github.com/agent-network-protocol/AgentNetworkProtocol/blob/main/03-did-wba-method-design-specification.md). Released suite versus candidate drafts and web identity.
[^22]: ANP. [Agent Payment Protocol adaptation](https://github.com/agent-network-protocol/AgentNetworkProtocol/blob/main/application/10-anp-agent-payment-protocol-specification.md). Payment messages and inconsistent draft/release labeling relative to repository index.
[^23]: M. De Rossi, D. Crapis, J. Ellis, E. Reppel. [ERC-8004: Trustless Agents](https://eips.ethereum.org/EIPS/eip-8004), created August 13, 2025, still marked Draft. Identity/reputation/validation registries.
[^24]: Microsoft. [MCP in VS Code](https://code.visualstudio.com/docs/agent-customization/mcp-servers); MCP. [Conformance framework](https://github.com/modelcontextprotocol/conformance); A2A. [Technology Compatibility Kit](https://github.com/a2aproject/a2a-tck). Implementer and compatibility-tool evidence, not usage census.
[^25]: m2m. [Tracked tree](https://github.com/unconfirmedlabs/m2m/tree/b8c209e84d89a6e39d108e4f58e6847bd17e8ad1), [Cargo manifest](https://github.com/unconfirmedlabs/m2m/blob/b8c209e84d89a6e39d108e4f58e6847bd17e8ad1/Cargo.toml), and [npm manifest](https://github.com/unconfirmedlabs/m2m/blob/b8c209e84d89a6e39d108e4f58e6847bd17e8ad1/package.json). Checked file presence and publication flags.
