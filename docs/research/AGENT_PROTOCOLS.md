# Agent protocols and lessons for m2m

The most defensible starting point for m2m is a small, interoperable connection
between authenticated Iroh peers and programmable economic relationships on Sui.
The surrounding ecosystem already supplies tool access, task coordination,
identity, delegation, commerce, and payment protocols. The opportunity to test is
whether a reusable binding between those pieces removes meaningful work for
developers operating autonomous services.

Sui and Iroh are project requirements. Recommendations here evaluate scope within
that architecture. The broader product ambition is software that can communicate
and make economic commitments under bounded authority; the first audience and
economic workflow still require validation.

## Scope and evidence

This is a snapshot checked on **2026-09-10**, covering the major relevant agent
protocol families and selected identity, authorization, networking, and historical
foundations. It is a broad survey, not an exhaustive enumeration of every project
using the word "agent." Runtime frameworks, orchestration libraries, and provider
APIs are included only where they define a material interoperability boundary.

The comparison separates three types of statement:

- **Specified behavior:** a requirement or design described by a protocol's own
  versioned specification or upstream implementation.
- **Ecosystem evidence:** a shipped integration, SDK, implementation, or dated
  publisher announcement. This is not automatically evidence of active usage.
- **Assessment:** an inference about adoption or a recommendation for m2m.

Specifications describe intended behavior, not measured production reliability.
Partner counts, catalog entries, downloads, and GitHub attention are weak proxies
for sustained use. The available evidence does not support a comparable ranking
of active deployments across all protocols, or a causal proof of why one wins.
Dates, release status, and document conflicts matter more than an undifferentiated
"supported" checkbox.

## Protocol map

Agent protocols standardize different relationships. The useful comparison is
between their responsibilities, trust boundaries, and deployment costs.

| Protocol/family | Primary relationship | Status/evidence in this snapshot | Relevance to m2m |
|---|---|---|---|
| MCP | AI host/client ↔ tool/context server | Stable 2026-07-28 core; extensive SDK and product integration evidence | Tool-facing adapter and adoption example[^mcp-release][^mcp-products] |
| A2A | Client agent ↔ remote agent/service | Released v1.0, multiple bindings and TCK | Main candidate for work/task semantics[^a2a-release][^a2a-tck] |
| Agent Communication Protocol, BeeAI ACP | Application/agent ↔ agent runtime | Archived after joining A2A | Historical run/session ergonomics[^beeai-acp] |
| Agent Protocol | Client/evaluator ↔ agent execution API | Task/step contract; mostly historical release evidence | Minimal execution API reference[^agent-protocol] |
| Agent Client Protocol, coding ACP | Editor ↔ coding agent | Shipped integrations; v2 draft work | Client integration pattern[^client-acp] |
| AG-UI | Agent backend ↔ frontend | Active code and event specifications | Optional user-facing events[^agui] |
| A2UI | Agent output ↔ trusted renderer | Early public preview; released and candidate versions distinguished | Optional declarative UI[^a2ui] |
| Agentic Commerce Protocol, OpenAI/Stripe ACP | Agent/buyer ↔ merchant/payment infrastructure | Beta protocol with dated snapshots and product integration | Checkout and scoped payment lessons[^commerce-acp] |
| UCP | Commerce platform ↔ business | Released v2026-08-25 specification | Discovery and feature negotiation[^ucp-release][^ucp] |
| x402 | Resource client ↔ paid service/facilitator | v2 specification; separate Sui scheme and implementation coverage | Payment signaling and adapter candidate[^x402][^x402-sui] |
| AP2 | Principal/agent ↔ merchant/payment participants | v0.2 mandate work; FIDO standardization | Intent/authorization artifacts[^ap2][^ap2-fido] |
| MPP | Machine client ↔ payment-requiring service | Published specifications and tooling | Alternative payment lifecycle reference[^mpp] |
| Agent Commerce Protocol, Virtuals ACP | Agent buyer ↔ provider/evaluator/contracts | Platform contracts and CLI | Paid-job lifecycle reference[^virtuals-acp] |
| Visa TAP | Agent ↔ merchant/web/payment ecosystem | Vendor specification and rollout evidence | Signed request purpose and recognition[^visa-tap] |
| ERC-8004 | Agent registrant ↔ identity/reputation/validation registries | Draft ERC | Onchain identity comparison[^erc8004] |
| ERC-8128 | Ethereum signer ↔ HTTP verifier | Proposal | Application request-signing comparison[^erc8128] |
| ANP | Agent ↔ independently published agent services | Project-reported 1.1 suite and implementations | Direct conceptual neighbor[^anp] |
| AGNTCY OASF / Directory / Identity | Agent descriptions ↔ discovery and identity infrastructure | Schemas, directory code, identity work | Metadata and discovery comparison[^agntcy][^agntcy-dir] |
| AGNTCY SLIM | Applications ↔ distributed messaging infrastructure | Messaging implementation and language bindings | Transport comparison; Iroh remains required[^slim] |
| Agent Connect Protocol, AGNTCY ACP | Client ↔ configurable remote agent | Archived April 2026 | Additional historical ACP lineage[^agntcy-acp] |
| DIDs / VCs / did:webvh | Controllers, issuers, holders, verifiers | W3C Recommendations and method specifications | Identity and claims foundations[^did-core][^vc][^did-webvh] |
| UCAN / Biscuit | Delegator ↔ delegate ↔ verifier | Specifications and implementations | Attenuated authority patterns[^ucan][^biscuit] |
| DIDComm | Message sender ↔ recipient/routing service | Approved v2.1 messaging specification | Message-level security/reference[^didcomm] |
| SPIFFE / Tailscale Services | Workloads/services ↔ trusted infrastructure | Implemented identity/connectivity systems | Baseline for private infrastructure[^spiffe][^tailscale] |
| ARD / AIP / Agent-OSI | Discovery, delegation, layered agent systems | Proposals/research | Adjacent ideas, not adoption proof[^ard][^aip][^agent-osi] |
| KQML / FIPA ACL | Communicating software agents | Historical research/standards | Syntax, semantics, and deployment lessons[^kqml][^fipa] |

"ACP" must always be qualified: the BeeAI communication protocol, coding-client
protocol, OpenAI/Stripe commerce protocol, Virtuals commerce protocol, and archived
AGNTCY connect protocol have different goals and contracts. They are not versions
of one standard.

## Tool access: Model Context Protocol

MCP standardizes the connection between an application hosting an AI model and
servers exposing tools, resources, and prompts. A host manages clients and policy;
each client connects to a server. JSON-RPC schemas define the data contract.
This is a focused integration boundary with reuse across hosts and servers.[^mcp-spec]

The current stable revision checked here is **2026-07-28**. It removed the earlier
`initialize`/`initialized` handshake and protocol session identifier in favor of
self-contained requests. Version and client features travel with requests;
`server/discover` is an optional discovery operation. Older versions use the legacy
session/initialization model, so a description of "MCP" without a version can be
misleading.[^mcp-release]

There is a documentation inconsistency: the versioned overview retains wording
about extension negotiation "during initialization." The release announcement,
detailed discovery/transport documentation, and SDK compatibility guide describe
the modern per-request model. Use those specific contracts when implementing;
do not infer a restored handshake from the overview sentence.[^mcp-spec][^mcp-versioning]

Standard transports include local `stdio` and remote Streamable HTTP. Custom
transports can preserve the data contract, but a standard host still needs an
implementation or facade it can use.[^mcp-transports] **Assessment:** m2m can expose
its services to MCP through a local bridge or an explicitly supported transport.
That does not require every existing host to implement Iroh. The bridge's identity,
permissions, and visibility into requests must be documented.

HTTP authorization uses OAuth resource-server conventions. Client credentials are
addressed by a separate finalized extension proposal; this is not a complete
cross-agent economic delegation system.[^mcp-auth][^mcp-client-credentials]
Discovery metadata and tool descriptions do not themselves authorize spending.

MCP has also separated long-running work into an optional Tasks extension. The
2026-07-28 extension page still displays draft status, even though the associated
SEP is finalized. Treat those statuses separately and verify SDK behavior before
depending on the feature.[^mcp-tasks] A task handle identifies an operation; it is
not an agent's durable economic identity.

**Ecosystem evidence:** MCP has a public registry, official SDKs, and a dedicated
client/server conformance framework. Registry publication is distinct from runtime
trust. These are concrete adoption infrastructure, while download and catalog
claims remain publisher-reported proxies for use.[^mcp-registry][^mcp-conformance]
Microsoft documents MCP use in VS Code, and GitHub maintains its own MCP server.
These are direct implementer signals, not merely protocol-project endorsements;
they do not establish that every deployed client supports the newest revision.[^mcp-products]

**Assessment:** the transferable lesson is a useful initial contract with an easy
integration path, followed by tooling that makes implementations predictable.
MCP's evolution also shows that operational costs can force substantial protocol
changes. For m2m, make application state and economic state explicit, and provide
a compatibility policy rather than assuming a particular connection lifecycle
will remain suitable forever.

## Collaboration: A2A, BeeAI ACP, and Agent Protocol

### A2A is the main semantic reuse candidate

A2A v1.0 was released on 2026-03-12. Its specification separates core operations
and data models from bindings, with JSON-RPC over HTTP, gRPC, and HTTP+JSON/REST
among the standard options.[^a2a-release][^a2a-spec] This is a useful structure for
a project whose transport is already chosen.

An Agent Card describes interfaces, offered skills, protocol features, and security
requirements. Discovery may use a well-known URL, a catalog, or direct configuration;
it need not imply a global marketplace. A2A also supports signed cards, which
protect advertised metadata but do not establish Sui economic authority by
themselves.[^a2a-discovery][^a2a-spec]

An interaction can return a simple message or create a stateful task. Tasks carry
work through active, interrupted, and terminal states; messages and artifacts have
separate roles. Context IDs group interactions, while task IDs identify work.
This supplies a more useful basis for paid work than a generic chat envelope.[^a2a-task]

Custom bindings must preserve operations, data types, errors, security behavior,
and applicable streaming semantics. They declare their identity and endpoint in
Agent Cards. An Iroh binding is therefore a plausible design route, but it would
need a specification and implementation; it is not already supplied by A2A or
automatically understood by HTTP clients.[^a2a-bindings]

A2A also has explicit extension mechanisms, including declarations and required
features. Extensions can introduce domain semantics without replacing the whole
task model.[^a2a-extensions] **Assessment:** evaluate a Sui economic profile coupled
to an Iroh binding before defining another general-purpose work lifecycle. A
smaller m2m-native contract with an A2A adapter remains a candidate if full binding
requirements impose unnecessary initial scope. Do not claim full A2A conformance
for a subset implementation.

Payment composition already exists: Google's A2A x402 extension describes payment
behavior associated with task execution. A separate open Ed25519/RFC 9421 message
signing proposal is evidence of ongoing work, not a normative A2A feature.[^a2a-x402][^a2a-signing]
**Assessment:** claims that A2A has no identity or payment integration would
misstate the competitive baseline. The narrower question is which Sui-enforced
economic rules and endpoint bindings m2m contributes.

**Ecosystem evidence:** a versioned specification, multiple SDKs, a Technology
Compatibility Kit, and BeeAI integration are stronger evidence than a partner
list. The TCK does not automatically validate an unimplemented Iroh binding or
its economic behavior.[^a2a-tck][^beeai-a2a] A2A's public materials refer to the Linux
Foundation; an AAIF project proposal is marked approved. This administrative
transition does not change the technical conclusions here, and precise governance
claims should follow current project records.[^a2a-governance]

### BeeAI Agent Communication Protocol is historical input

IBM/BeeAI's **Agent Communication Protocol**, also ACP, merged its effort into
A2A in August 2025. The project repository is archived. Its run/session design,
HTTP API, asynchronous execution, and event streaming remain useful to study,
but it is not a separate active interoperability target on the same footing as
A2A.[^beeai-acp]

**Assessment:** consolidation is an adoption lesson. Two capable specifications
can create more integration burden than one shared interface. Preserve good
execution ergonomics while avoiding dependence on a superseded ecosystem solely
because its initial API was appealing.

### Agent Protocol is a minimal execution contract

The AI Engineer Foundation lineage of **Agent Protocol** now resolves to
`agi-inc/agent-protocol`. Its REST contract organizes tasks, steps, and artifacts.
The project FAQ leaves authentication to implementations and describes direct
agent-to-agent features as future work. Historical SDKs and contract tests show
the value of a compact interface; old adopter lists do not establish present-day
usage.[^agent-protocol]

**Assessment:** separate an agent's internal execution API from the agreement
between independently controlled economic participants. Step-by-step execution
exposure may be useful for a runtime or evaluator without belonging in every
network exchange.

## Coding clients and user interfaces

**Agent Client Protocol**, the Zed/JetBrains-associated ACP, standardizes how an
editor interacts with a coding agent: initialization, sessions, prompts, updates,
permissions, and cancellation over JSON-RPC. The v2 work checked here is draft;
remote support is evolving.[^client-acp] Product integrations and a registry provide
concrete distribution channels.[^client-acp-adoption] **Assessment:** its useful
lesson is a bounded interface that lets editors and agents evolve independently.
It is not a general economic exchange between autonomous counterparties.

**AG-UI** defines event-oriented interaction between an agent backend and a frontend,
including execution lifecycle, tool activity, and state updates.[^agui] **A2UI**
describes UI surfaces using declarative data interpreted by a trusted renderer;
its repository distinguishes current 0.9.x releases from 1.0 release-candidate work
and still describes the project as early public preview.[^a2ui]

**Assessment:** user-visible progress, executable authority, and rendered UI are
different contracts. m2m may eventually feed one of these integrations, but a
machine exchanging work and money should not need to implement a UI protocol.
The trusted-renderer pattern also illustrates a general principle: remote
descriptions are inputs interpreted under local policy, not arbitrary authority.

## Commerce and payment protocols

### Commerce ACP and UCP standardize buying workflows

OpenAI/Stripe's **Agentic Commerce Protocol** is another ACP. Its repository
publishes schemas for commerce interactions such as checkout and delegated
payment. It labels the project beta and identifies dated specification snapshots;
the latest stable snapshot listed when checked is 2026-04-17.[^commerce-acp]
Stripe's Instant Checkout announcement documents a real product integration and
scoped payment-token design, without establishing broad independent adoption.[^commerce-acp-launch]

**Universal Commerce Protocol (UCP)** defines business/platform profiles, feature
negotiation, and commerce capabilities. Its core documentation includes multiple
integration surfaces and separates discovery, identity linking, and payment
handlers. The checked release is v2026-08-25.[^ucp][^ucp-release]
**Assessment:** named capabilities, explicit compatible versions, and well-defined
business responsibilities are transferable. Their catalog/checkout/order semantics
should be adopted only where the m2m application actually needs them.

These commerce efforts should not be confused with BeeAI's archived communication
ACP or the coding-client ACP. Changes to a vendor's documentation links do not
establish that one commerce protocol has replaced or merged with another.

### x402 includes a Sui scheme

x402 v2 separates payment requirements and payloads from the schemes and networks
that implement payment. HTTP 402 is a familiar integration pattern; the
specification also accounts for MCP, A2A, and custom transport bindings.[^x402]
Its facilitator role verifies and submits payments without requiring custody of
the payer's funds.[^x402-facilitator]

The official repository includes an **`exact` scheme for Sui**. Its current design
uses a signed Sui transaction transferring the specified coin amount to the
declared recipient, with verification and settlement steps. The documented flow
does not make an arbitrary service's execution atomic with payment.[^x402-sui]

The official TypeScript and Python mechanism directories checked here do not list
a Sui mechanism alongside their other implementations. This is a bounded
implementation observation, not a claim that no community Sui facilitator or SDK
exists. Spec-level support, SDK support, facilitator availability, and production
usage must be tracked separately.[^x402-implementations]

**Assessment:** Sui support in x402 is an interoperability opportunity and a strong
baseline. m2m should not claim that a new payment envelope is necessary just to
transfer Sui assets. It must establish which further economic state or authority
rules need a shared profile and how existing x402 semantics map to Iroh.

### AP2 separates intent from payment execution

**Agent Payments Protocol (AP2)** describes mandates and related evidence for
agentic transactions. The v0.2 materials distinguish open checkout authority from
finalized payment terms and provide validation rules for the participants.[^ap2]
Google announced AP2's donation to the FIDO Alliance in April 2026; that is
governance and standards-development evidence, not a measurement of transaction
volume.[^ap2-fido]

**Assessment:** this is a relevant model for expressing what an agent was allowed
to buy. A mandate's validity and enforcement of a shared spending budget are
different questions. If m2m adopts an AP2 artifact, it must specify the subset of
its conditions that Move or another identified enforcement component checks.
There is no need to force commerce-specific mandates into every simple service
interaction solely for nominal compatibility.

### Other payment and paid-job systems

**Machine Payments Protocol (MPP)**, introduced by Stripe and Tempo in March 2026,
organizes machine payment through payment intents and methods, with published
specifications and integration tooling.[^mpp] **Assessment:** compare the actual
payment lifecycle with x402 and Sui primitives before selecting an adapter. Its
existence reinforces that payment signaling is an active standards space.

Virtuals' **Agent Commerce Protocol**, also ACP, has contracts and tooling for
agent jobs, payment, submission, completion, and rejection. It is the closest
reviewed application-oriented reference for paid work.[^virtuals-acp] **Assessment:**
its lifecycle is useful evidence that jobs and economics can be composed, but
platform-specific evaluators, policies, and contract behavior should not be
mistaken for universal correctness guarantees or a Sui/Iroh standard.

**Visa Trusted Agent Protocol (TAP)** describes agent recognition and signed
commerce requests, including scoped request context. Its public developer material
is a vendor ecosystem specification; launch and partner announcements do not
establish uniform merchant deployment.[^visa-tap] **Assessment:** merchants need to
verify who authorized a request, its intended recipient, and its allowed purpose.
Those questions also apply to an autonomous service provider.

### Onchain registries and signed HTTP requests

**ERC-8004** is a draft EVM standard for agent identity, reputation, and validation
registries. Its registration records can reference other agent interfaces;
payments are outside its core scope.[^erc8004] **Assessment:** portable onchain
agent identity is already a defined category. A Sui Agent object should be
justified by its intended economic ownership and enforcement behavior, with
optional mappings to other registries if an actual integration needs them.

**ERC-8128** is a proposal for Ethereum-account signatures on HTTP requests using
HTTP Message Signatures. Treat its project specification as proposal evidence,
not as a finalized universal agent identity standard.[^erc8128]
**Assessment:** possession of a request-signing key and permission to commit funds
remain separate. Iroh changes the transport authentication mechanism; m2m still
needs an explicit economic authorization model.

### Economic guarantees must be named precisely

| Evidence or mechanism | What it can establish | What requires something additional |
|---|---|---|
| Authenticated connection | Control of the expected transport key | Authority to spend or accept terms for a durable agent |
| Valid mandate or capability | A grant satisfying the verifier's checks | Aggregate budget enforcement and current resource control |
| Signed quote or acknowledgment | Authorship of the exact signed statement | Truth of service claims and objective quality of work |
| Payment transaction/receipt | The checked settlement state | Correct delivery and satisfaction of arbitrary offchain terms |
| Hash of a result | Integrity/identity of bytes against an expected commitment | Whether those bytes are useful, accurate, or complete |
| Evaluator or acceptance rule | A decision under a specified trust model | Universal or trust-free verification of arbitrary work |

This table is an analytical distinction, not a claim that each protocol omits
every mechanism in the right column. An implementation can compose additional
checks. m2m must describe exactly which composition it standardizes and which
guarantees its selected economic profile actually provides.

## Decentralized identity, discovery, and delegation

### ANP is a direct conceptual neighbor

The Agent Network Protocol project presents a released 1.1 suite that spans
identity, naming, descriptions, discovery, messaging, and payment-related
integration, while identifying some negotiation work as draft. That is substantial
conceptual overlap with an "agent internet" proposition.[^anp]

ANP descriptions can advertise interfaces and services. Its discovery specification
includes domain publication and search agents that crawl or index descriptions.
This separates distributed publication from the availability and policy of search
services; it is not evidence of a universally available, trustless directory.[^anp-discovery]

The `did:wba` design uses web infrastructure and includes key-bound forms, including
Ed25519. Identifier choices determine how key replacement affects continuity;
stable naming is a distinct concern.[^anp-identity] **Assessment:** shared cryptography
and decentralized identity are not unique m2m claims. A credible distinction must
describe the Sui economic state and how it binds to Iroh communication.

ANP has specification and implementation evidence, but the reviewed public sources
do not establish comparable independent production usage to the largest tool
ecosystems. Treat the project's maturity descriptions as project statements.

### DIDs, credentials, and DIDComm solve separate pieces

W3C DID Core 1.0 is a Recommendation defining identifiers, verification methods,
and related document structures. Individual DID methods determine control,
resolution, updates, and recovery. DID compliance alone does not guarantee a
particular durability or trust model.[^did-core] DIF's `did:webvh` illustrates
explicit verifiable history and update mechanisms in a web-based method.[^did-webvh]

Verifiable Credentials Data Model 2.0 is a W3C Recommendation for issuer-authored
claims. Verification of a credential does not establish the truth of its claims
or supply a complete authorization policy.[^vc] **Assessment:** credentials can
supplement agent descriptions, but spending and settlement need identified
enforcement rules.

DIDComm Messaging v2.1 specifies secure messaging independently of a particular
transport, including message types, threading, and routing concepts.[^didcomm]
**Assessment:** it is another source of reusable envelope semantics. Adopting it
would still require explicit Iroh endpoint and Sui authority mappings. Avoid
mandatory overlapping security layers unless they serve a real forwarding,
storage, or interoperability requirement.

### UCAN and Biscuit are delegation references

UCAN models delegation through verifiable capabilities, with attenuation and
constraints such as audience and expiry. Cryptographic validity still requires
semantic checks connecting authority to the referenced resource.[^ucan] Biscuit
uses appendable restrictions and policy evaluation to let a holder narrow a
token's authority.[^biscuit]

**Assessment:** these are stronger baselines than inventing an unrestricted signed
`capabilities` list. They illustrate delegation without transferring a controller's
private key. Neither an offchain token nor its valid signature independently
serializes spending against a shared Sui budget. Any adopted format must map to
the economic checks in the chosen Move design; adopting a general policy language
is not automatically necessary for the first use case.

### AGNTCY supplies broader infrastructure

AGNTCY's **Open Agentic Schema Framework (OASF)** describes agent attributes and
offered functionality. Its identity work describes agent identity assertions and
verification, while its Directory repository provides content-addressed records,
distributed discovery, and tooling.[^agntcy][^agntcy-dir] **Assessment:** this is a
stronger baseline than assuming a searchable, signed agent description is a new
idea. Descriptions remain distinct from current spending authority.

**SLIM**, AGNTCY's Secure Low-latency Interactive Messaging system, supplies routed
messaging, sessions, group-security mechanisms, and authentication integrations.[^slim]
**Assessment:** it overlaps the connectivity and coordination infrastructure
category. Iroh remains m2m's required transport; the relevant lesson is to compare
deployment and interoperability needs honestly rather than describing the
ecosystem as lacking transport-aware agent infrastructure.

AGNTCY also had an **Agent Connect Protocol**, another ACP. Its repository is
archived, so it is a historical OpenAPI/REST interface reference.[^agntcy-acp]
Across AGNTCY, code, schemas, and SDKs establish implementation activity. They
do not by themselves establish widespread independent use or a paid-agent market.

### Emerging proposals and historical standards

Agentic Resource Discovery v0.91 is a proposal for federated discovery across
agentic resources, with trust references separate from artifact-specific
authentication. AIP and Agent-OSI are research proposals exploring layered
identity/delegation and communication/economics respectively. They show that
layered composition is already being investigated; they do not establish
standardization or production adoption.[^ard][^aip][^agent-osi]

KQML and FIPA ACL precede today's LLM systems. They organized agent communication
using structured messages, conversational context, and shared meanings. KQML also
discussed facilitator roles for finding and coordinating services.[^kqml]
FIPA's later ACL Message Structure specification, **SC00061G**, is a Standard dated
2002-12-03; the earlier **XC00061E** was Experimental. Do not describe the whole
FIPA effort as merely an experimental protocol because an older document appears
in search results.[^fipa]

**Assessment:** syntax alone cannot make two services agree about what a job means,
what counts as completion, or what a payment buys. m2m should specify a small
shared economic boundary and leave domain-specific work interpretation to explicit
service contracts. The history argues for implementations and concrete exchanges
alongside formal models, not for copying an entire agent ontology.

## Integration with the required Sui and Iroh foundations

### Shared Ed25519 is a useful bridge

Iroh uses an Ed25519 public key as its endpoint identity. Its address lookup can
resolve that identity to changing network locations; moving a process does not
inherently require a new endpoint identity if its key is retained.[^iroh-endpoints]
Sui supports Ed25519 account signing and Ed25519 verification inside Move.[^sui-signing]

**Assessment:** an authorized endpoint could sign a well-defined quote,
acknowledgment, or other economic statement that both a peer and a Move contract
can verify. This provides a concrete bridge between transport authentication and
economic programmability. It is a design possibility, not a property already
provided by m2m.

Do not collapse public keys, account addresses, and object IDs. The Sui SDK derives
an Ed25519 signing address by hashing the scheme flag `0x00` with the public key;
the Agent object would have its own stable object ID. The SDK also has specific
intent-aware signing conventions.[^sui-keys] Exact message bytes, domain separation,
authority scope, and replay handling determine whether signatures mean the same
thing across the application and Move.

The design should support economic authority that can be narrower than object
control or wallet custody. Separate operational keys are a recommended default;
the common signature algorithm does not require sharing a controller's private
key with a network process. Revocation of a key, transfer of an Agent object, and
outstanding obligations need separate policies.

### Sui already contains economic building blocks

Sui's payment documentation distinguishes direct transfers from structured Payment
Kit operations. Registry payments provide receipt records and duplicate checks;
ephemeral payments have different persistence and duplicate-prevention properties.
These are reusable mechanisms to assess before inventing equivalent contract
behavior.[^sui-payments]

The Sui Foundation's December 2025 agentic-commerce article explicitly discusses
AP2 authorization, x402 signaling, and Sui execution together. It is evidence of
the ecosystem's intended composition, not proof that every described workflow is
deployed or automatically enforced.[^sui-commerce]

**Assessment:** the case for m2m should describe what additional agreement,
authority, endpoint, and recovery semantics it standardizes. The mere availability
of blockchain payments is not a gap. Equally, a transfer primitive need not satisfy
a workflow involving aggregate delegated budgets, escrow release, or metered work.
Choose the required economic invariant first and reuse existing primitives where
their actual semantics fit.

### Transport and discovery remain separate concerns

Iroh relays help establish connections and carry encrypted fallback traffic when
a direct path is unavailable. They cannot read application plaintext, but
infrastructure and connectivity dependencies remain.[^iroh-relays] Peer-to-peer
communication does not establish anonymous operation, universal reachability, or
absence of operating costs.

There are at least three distinct lookup problems: find a service by its offered
function, resolve a known agent to authorized endpoints, and resolve an endpoint
key to current network addresses. A Sui object, a searchable index, and Iroh address
lookup can play different roles. A known-counterparty workflow can avoid global
search while still validating the central economic exchange.

For private infrastructure, compare honestly with existing solutions. SPIFFE
defines workload identity across heterogeneous environments and supports
implementations that issue short-lived identity credentials. Tailscale Services
provides stable service addressing across changing hosts within a tailnet.[^spiffe][^tailscale]
**Assessment:** durable identity and migration alone do not distinguish m2m. Its
case must include the intended economic relationship between independently
operated participants.

## Adoption principles

The protocol-specific evidence should be read alongside older protocol-design
experience. RFC 5218 identifies real net value, aligned incentives, and incremental
deployment among the factors associated with protocol success. Participants who
must deploy something need a benefit even before a large ecosystem exists.[^rfc5218]

For m2m, this suggests an initial integration with a service and client that can
already exchange useful work. A worldwide marketplace is an eventual application;
it is not a prerequisite for proving that the protocol saves effort. The exact
improvement should be measured against a functioning baseline, including setup,
debugging, operation, and failure recovery.

RFC 6709 cautions that extensibility and version negotiation need deliberate,
simple rules. RFC 9413 argues for active maintenance and specified handling of
unexpected input rather than accumulating incompatible permissive behavior.[^rfc6709][^rfc9413]
**Assessment:** a small economic protocol especially needs predictable rejection
of unsupported mandatory terms, shared signed-byte vectors, and a migration story.

### Lessons to carry into the north star

| Observed pattern | Assessment for adoption | Concrete m2m guidance |
|---|---|---|
| MCP and coding ACP expose bounded application interfaces | A participant can understand the benefit and implement one side | Make an existing service usable through one small integration |
| A2A separates work semantics from bindings | Transport evolution can preserve application contracts | Evaluate reuse over Iroh before inventing a task model |
| Commerce protocols name parties, terms, and lifecycle operations | Ambiguity around economic actions is expensive | Define exact terms, who authorizes them, and who enforces them |
| x402 and Sui Payment Kit distinguish payment mechanisms | Payment behavior is a contract, not a generic success flag | Reuse compatible primitives and specify reconciliation |
| UCAN/Biscuit separate possession from narrowing authority | Delegation can avoid sharing unrestricted credentials | Model scoped, expiring authority and its enforcement point |
| ANP/DIDs/SPIFFE already address identity and discovery | A new identity label alone is a weak value proposition | Explain the Sui/Iroh economic relationship and its practical advantage |
| MCP/A2A publish conformance tooling and versioned contracts | Multiple implementations need shared expectations | Ship schemas, vectors, errors, and interoperability checks |
| BeeAI ACP consolidated into A2A | Coordination costs matter alongside technical merit | Prefer a profile or contribution when it meets the actual need |

These are reasoned design lessons, not measured causal explanations for protocol
success. The corresponding engineering principles are distilled in
[NORTH_STAR.md](../NORTH_STAR.md).

## Positioning implications

The broad claims "agents need a common language," "agents need identities," and
"agents need to pay each other" describe areas that already have standards and
implementations. The research does not establish a market-wide absence of any
particular composition. It does establish enough overlap that m2m should explain
its contribution more precisely.

**Recommended proposition for discussion:** m2m connects autonomous software over
Iroh and binds its work agreements to economic authority and settlement rules on
Sui. The value to test is a coherent, reusable way to establish those relationships
and recover their outcomes, with low integration effort.

An implementer assembling a strong baseline could already combine:

- Iroh connectivity with an application-specific authorization lookup;
- A2A work semantics or an existing service API, exposed through MCP where useful;
- a mandate/capability format where delegated intent requires one;
- an existing payment scheme and Sui economic primitives;
- application-specific acceptance and result evidence.

That composition is a candidate baseline, not a turnkey integration demonstrated
by this survey. The unsolved work to investigate is the glue: consistent agent
and endpoint binding, exact agreement references, enforcement of the selected
economic constraints, and recovery across work and payment state. General
verification of arbitrary work remains a separate problem.

### Choose a deliverable after defining the first exchange

| Candidate deliverable | Benefit | Cost or risk |
|---|---|---|
| A2A Iroh binding plus Sui economic extension/profile | Reuses work semantics and ecosystem conventions | Full binding obligations and client support may be substantial |
| Small m2m economic protocol over Iroh, with A2A/MCP adapters | Can focus tightly on the selected economic exchange | A new contract and adapter mappings must earn their maintenance cost |
| Reusable SDK assembling existing contracts | Fastest route if semantics already fit | May be an integration product before it justifies a distinct protocol |

Sui and Iroh remain fixed in all three. **Recommendation:** settle the participant,
service, repeated pain, and economic rule before selecting one. Compatibility
work is valuable even if it avoids a new standalone protocol.

A first technical experiment should exercise both Iroh communication and a real
Sui economic invariant. Authenticated ping alone would validate connectivity;
it would not validate the proposed economic proposition. Conversely, an
unconstrained transfer over a conventional endpoint would not demonstrate the
reason for combining these foundations.

The suggested initial audience, concrete problem hypothesis, alternatives,
disconfirming evidence, and decisions for discussion are recorded in
[POSITIONING.md](../POSITIONING.md). No first market, economic model, or proof of
concept is approved by this research document alone.

## Limitations and refresh policy

This survey does not measure real interoperability through live transactions,
audit the cited projects, or establish customer demand. A listed specification or
SDK is not a production assurance. Cross-protocol compositions described as
candidates still require implementation and trust-boundary verification.

Before implementing an adapter, record the exact upstream version or commit,
check its release and feature status, inspect its conformance requirements, and
test the selected behavior. Update this report when a material protocol merges,
changes its core model, or ships a feature on which m2m's positioning depends.
Do not treat a current draft as a permanent external constraint.

## Sources

All living sources below were checked on 2026-09-10. Numbered references distinguish
specifications, implementation sources, and publisher accounts. Dates are publication
or release dates where stated; "living" means no single publication date is asserted.

[^mcp-spec]: Model Context Protocol project. [Specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28), released 2026-07-28. Roles, schemas, and principal features.
[^mcp-release]: D. Soria Parra and D. Delimarsky / MCP. [The 2026-07-28 Specification](https://blog.modelcontextprotocol.io/posts/2026-07-28/), 2026-07-28. Release changes and publisher-reported ecosystem measures.
[^mcp-versioning]: MCP project. [Server Discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover), revision 2026-07-28; MCP TypeScript SDK. [Protocol Versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions), living implementation documentation. Modern/legacy compatibility boundary.
[^mcp-transports]: MCP project. [Transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports), revision 2026-07-28. Standard and custom transports.
[^mcp-auth]: MCP project. [Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), revision 2026-07-28. HTTP authorization requirements.
[^mcp-client-credentials]: MCP project. [SEP-1046: Support OAuth client credentials flow](https://modelcontextprotocol.io/seps/1046-support-oauth-client-credentials-flow-in-authoriza), live SEP, Final status checked. Machine-to-machine authorization extension.
[^mcp-tasks]: MCP Tasks extension project. [Tasks, revision 2026-07-28](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks), page marked Draft when checked; MCP [SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension), Final status checked. Extension and proposal status distinction.
[^mcp-registry]: MCP project. [Introducing the MCP Registry](https://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview/), 2025-09-08; [Registry aggregators](https://modelcontextprotocol.io/registry/registry-aggregators), living documentation. Catalog role and downstream policy.
[^mcp-conformance]: MCP project. [Conformance Test Framework](https://github.com/modelcontextprotocol/conformance), living implementation; [Official SDKs](https://modelcontextprotocol.io/docs/2025-11-25/sdk), live SDK directory under a dated URL. Implementation infrastructure.
[^mcp-products]: Microsoft. [Add and manage MCP servers in VS Code](https://code.visualstudio.com/docs/agent-customization/mcp-servers), living product documentation; GitHub. [Official MCP server](https://github.com/github/github-mcp-server), living implementation. Product adoption evidence.
[^a2a-release]: A2A project. [Release v1.0.0](https://github.com/a2aproject/A2A/releases/tag/v1.0.0), 2026-03-12. Released version and changes.
[^a2a-spec]: A2A project. [Agent2Agent Protocol Specification v1.0.0](https://a2a-protocol.org/v1.0.0/specification/), 2026. Core model, bindings, and security descriptions.
[^a2a-discovery]: A2A project. [Agent Discovery](https://a2a-protocol.org/v1.0.0/topics/agent-discovery/), v1.0 documentation. Card publication and lookup.
[^a2a-task]: A2A project. [Life of a Task](https://a2a-protocol.org/v1.0.0/topics/life-of-a-task/), v1.0 documentation. Message/task distinction and lifecycle.
[^a2a-bindings]: A2A project. [Custom Protocol Bindings](https://a2a-protocol.org/v1.0.0/topics/custom-protocol-bindings/), v1.0 documentation. Binding requirements and compatibility obligations.
[^a2a-extensions]: A2A project. [Extensions](https://a2a-protocol.org/v1.0.0/topics/extensions/), v1.0 documentation. Extensibility and declarations.
[^a2a-x402]: Google Agentic Commerce. [A2A x402 Payments Extension v0.1](https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.1/spec.md), versioned extension in a living repository. Payment/task composition.
[^a2a-signing]: A2A project discussion. [Proposal: minimal Ed25519 + RFC 9421 signing extension](https://github.com/a2aproject/A2A/issues/1829), opened 2026-05-09, proposal rather than core requirement.
[^a2a-tck]: A2A project. [Technology Compatibility Kit](https://github.com/a2aproject/a2a-tck), living implementation. Conformance testing for supported bindings.
[^beeai-a2a]: BeeAI. [A2A integrations](https://framework.beeai.dev/integrations/a2a), living implementer documentation. A2AAgent and A2AServer integration.
[^a2a-governance]: AAIF project proposals. [A2A project proposal #37](https://github.com/aaif/project-proposals/issues/37), approved status dated 2026-06-18; A2A v1.0 documentation retains Linux Foundation attribution. Governance transition evidence.
[^beeai-acp]: BeeAI. [ACP Joins Forces with A2A](https://github.com/orgs/i-am-bee/discussions/5), 2025-08-25; [ACP repository](https://github.com/i-am-bee/acp), archived 2025-08-27; [OpenAPI contract](https://raw.githubusercontent.com/i-am-bee/acp/main/docs/spec/openapi.yaml), archived implementation artifact. Merger and historical interface.
[^agent-protocol]: AGI, Inc. / Agent Protocol. [Repository](https://github.com/agi-inc/agent-protocol) and [FAQs](https://agentprotocol.ai/faqs/), living pages with largely historical release evidence. Task/step/artifact model and authentication scope.
[^client-acp]: Agent Client Protocol project. [Introduction](https://agentclientprotocol.com/get-started/introduction) and [Updates](https://agentclientprotocol.com/updates), living documentation with July 2026 draft work. Coding-client boundary and evolution.
[^client-acp-adoption]: Zed. [The ACP Registry is Live](https://zed.dev/blog/acp-registry), 2026-01-28; JetBrains. [Bring your own AI agent to JetBrains IDEs](https://blog.jetbrains.com/ai/2025/12/bring-your-own-ai-agent-to-jetbrains-ides/), December 2025. Implementer distribution evidence.
[^agui]: AG-UI project. [Repository](https://github.com/ag-ui-protocol/ag-ui) and [Events](https://docs.ag-ui.com/concepts/events), living code and documentation. UI event contract.
[^a2ui]: A2UI project. [Repository](https://github.com/a2ui-project/a2ui), living status and specification index; Google. [A2UI v0.9](https://developers.googleblog.com/en/a2ui-v0-9-generative-ui/), 2026-04-17. Declarative rendering and release evidence.
[^commerce-acp]: OpenAI and Stripe / Agentic Commerce Protocol. [Repository and specification snapshots](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol), beta status, stable snapshot 2026-04-17 listed when checked. Commerce scope and schemas.
[^commerce-acp-launch]: Stripe. [Stripe powers Instant Checkout in ChatGPT and releases Agentic Commerce Protocol](https://stripe.com/newsroom/news/stripe-openai-instant-checkout), 2025-09-29. Product integration and scoped payment tokens.
[^ucp]: Universal Commerce Protocol project. [Core Concepts](https://ucp.dev/documentation/core-concepts/), living specification documentation. Discovery, capabilities, and commerce boundaries.
[^ucp-release]: Universal Commerce Protocol project. [Release v2026-08-25](https://github.com/Universal-Commerce-Protocol/ucp/releases/tag/v2026-08-25), 2026-08-25. Version evidence.
[^x402]: x402 Foundation. [x402 Specification v2](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md), v2, dated 2025-12-09. Payment protocol, schemes, and transports.
[^x402-facilitator]: x402 project. [Facilitator](https://docs.x402.org/core-concepts/facilitator), living documentation. Verification and settlement role.
[^x402-sui]: x402 Foundation. [Scheme: exact on Sui](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_sui.md), living upstream scheme specification. Signed-transaction payment flow.
[^x402-implementations]: x402 Foundation. [TypeScript mechanisms](https://github.com/x402-foundation/x402/tree/main/typescript/packages/mechanisms) and [Python mechanisms](https://github.com/x402-foundation/x402/tree/main/python/x402/mechanisms), live directory listings checked on 2026-09-10. Bounded observation of implementation coverage.
[^ap2]: Google Agentic Commerce / AP2. [AP2 specification](https://github.com/google-agentic-commerce/AP2/blob/main/docs/ap2/specification.md) and [overview](https://github.com/google-agentic-commerce/AP2/blob/main/docs/index.md), v0.2 materials in a living repository. Mandates and payment authorization.
[^ap2-fido]: Google. [We're donating Agent Payments Protocol to the FIDO Alliance](https://blog.google/products-and-platforms/platforms/google-pay/agent-payments-protocol-fido-alliance/), 2026-04-28. Governance transition and release announcement.
[^mpp]: Stripe. [Introducing the Machine Payments Protocol](https://stripe.com/blog/machine-payments-protocol), 2026-03-18; Tempo and Stripe. [MPP specifications](https://github.com/tempoxyz/mpp-specs), living repository. Payment intents/methods and implementation direction.
[^virtuals-acp]: Virtuals Protocol. [Agent Commerce Protocol contracts](https://github.com/Virtual-Protocol/agent-commerce-protocol) and [ACP CLI](https://github.com/Virtual-Protocol/acp-cli), living repositories. Paid-job lifecycle and platform tooling.
[^visa-tap]: Visa. [Trusted Agent Protocol developer documentation](https://developer.visa.com/use-cases/trusted-agent-protocol), living documentation; [launch announcement](https://corporate.visa.com/en/sites/visa-perspectives/newsroom/visa-unveils-trusted-agent-protocol-for-ai-commerce.html), 2025-10-14. Agent/request recognition in commerce.
[^erc8004]: Ethereum ERC authors. [ERC-8004: Trustless Agents](https://eips.ethereum.org/EIPS/eip-8004), created 2025-08-13, Draft status checked. Identity, reputation, and validation registries.
[^erc8128]: ERC-8128 project. [Signed HTTP requests with Ethereum](https://erc8128.org/) and [Ethereum Magicians proposal discussion](https://ethereum-magicians.org/t/erc-8128-signed-http-requests-with-ethereum/27515), living proposal materials. HTTP request authentication.
[^anp]: Agent Network Protocol project. [ANP repository](https://github.com/agent-network-protocol/AgentNetworkProtocol), living suite, 1.1 release descriptions checked. Scope and project-reported status.
[^anp-discovery]: ANP project. [Agent Description Protocol](https://raw.githubusercontent.com/agent-network-protocol/AgentNetworkProtocol/main/07-anp-agent-description-protocol-specification.md) and [Agent Discovery Protocol](https://raw.githubusercontent.com/agent-network-protocol/AgentNetworkProtocol/main/08-ANP-Agent-Discovery-Protocol-Specification.md), living specifications. Publication and search.
[^anp-identity]: ANP project. [did:wba Method Specification](https://github.com/agent-network-protocol/AgentNetworkProtocol/blob/main/03-did-wba-method-design-specification.md), 1.1 suite, living specification. Web and key bindings.
[^agntcy]: AGNTCY project. [Documentation](https://docs.agntcy.org/index.html), living architecture index. OASF and identity scope.
[^agntcy-dir]: AGNTCY project. [Directory](https://github.com/agntcy/dir), living repository. Discovery and content-addressed records.
[^slim]: AGNTCY project. [SLIM](https://github.com/agntcy/slim), living repository. Distributed messaging and authentication mechanisms.
[^agntcy-acp]: AGNTCY project. [Agent Connect Protocol](https://github.com/agntcy/acp-spec), repository archived 2026-04-11. Historical configuration and invocation contract.
[^did-core]: W3C. [Decentralized Identifiers v1.0](https://www.w3.org/TR/did/), Recommendation 2022-07-19. Core identity data model and method boundaries.
[^did-webvh]: Decentralized Identity Foundation. [did:webvh v1.0](https://identity.foundation/didwebvh/v1.0/), versioned method specification. Verifiable history and updates.
[^vc]: W3C. [Verifiable Credentials Data Model v2.0](https://www.w3.org/TR/vc-data-model-2.0/), Recommendation 2025-05-15. Claims and verification boundaries.
[^didcomm]: Decentralized Identity Foundation. [DIDComm Messaging v2.1](https://identity.foundation/didcomm-messaging/spec/v2.1/), working-group approved specification. Transport-independent messaging.
[^ucan]: UCAN Working Group. [UCAN specification](https://github.com/ucan-wg/spec), living specification. Delegation, attenuation, and resource authority.
[^biscuit]: Eclipse Biscuit. [Specifications](https://doc.biscuitsec.org/reference/specifications), living versioned specification index. Attenuation and policy evaluation.
[^ard]: ARD project. [Agentic Resource Discovery specification](https://github.com/ards-project/ard-spec/blob/main/spec/ard.md), proposal v0.91, 2026-08-26. Federated discovery proposal.
[^aip]: Sunil Prakash. [AIP: Agent Identity Protocol for Verifiable Delegation Across MCP and A2A](https://arxiv.org/abs/2603.24775), submitted 2026-03-25. Research proposal.
[^agent-osi]: Wenxin Xu, Taotao Wang, Yihan Xia, Shengli Zhang, and Soung Chang Liew. [Agent-OSI: An Interoperability Architecture for Communication and Settlement in the Decentralized Internet of Agents](https://arxiv.org/abs/2602.13795), submitted 2026-02-14, revised 2026-07-18 (v2). Research architecture/prototype.
[^kqml]: T. Finin and collaborators / UMBC. [KQML: A Language and Protocol for Knowledge and Information Exchange](https://research.cs.umbc.edu/kqml/papers/kbkshtml/kbks.html), 1994. Historical research.
[^fipa]: FIPA. [ACL Message Structure Specification SC00061G](https://www.fipa.org/specs/fipa00061/SC00061G.html), Standard, 2002-12-03; [XC00061E](https://www.fipa.org/specs/fipa00061/XC00061E.html), Experimental, 2001-08-10. Historical status distinction.
[^iroh-endpoints]: n0 / Iroh. [Endpoints](https://docs.iroh.computer/concepts/endpoints), living documentation. Cryptographic endpoint identity and address lookup.
[^sui-signing]: Sui Foundation / Mysten Labs. [Signature Verification in Move](https://docs.sui.io/develop/cryptography/signing) and [Key pairs](https://sdk.mystenlabs.com/sui/cryptography/keypairs), living documentation. Ed25519 signing and onchain verification support.
[^sui-keys]: Mysten Labs. [PublicKey implementation](https://github.com/MystenLabs/ts-sdks/blob/main/packages/sui/src/cryptography/publickey.ts), [signature-scheme flags](https://github.com/MystenLabs/ts-sdks/blob/main/packages/sui/src/cryptography/signature-scheme.ts), and Sui Foundation, [Object Model](https://docs.sui.io/develop/sui-architecture/object-model), living upstream sources. Address derivation, signing conventions, and stable object IDs.
[^sui-payments]: Sui Foundation. [Choose a Payment Model](https://docs.sui.io/onchain-finance/choose-payments-model), living documentation. Transfer and Payment Kit semantics.
[^sui-commerce]: Sui Foundation. [When Agents Pay: The Trust Layer for Agentic Commerce](https://www.sui.io/blog/ai-agents-agentic-commerce-trust-layer), 2025-12-23. Publisher's description of AP2/x402/Sui composition.
[^iroh-relays]: n0 / Iroh. [Relays](https://docs.iroh.computer/concepts/relays), living documentation. Connection assistance and encrypted fallback.
[^spiffe]: SPIFFE project. [SPIFFE Overview](https://spiffe.io/docs/latest/spiffe-about/overview/), living specification overview and implementation matrix. Workload identity.
[^tailscale]: Tailscale. [Tailscale Services](https://tailscale.com/docs/features/tailscale-services), page marked last validated 2026-02-02. Stable service identity and routing inside a tailnet.
[^rfc5218]: D. Thaler and B. Aboba / IAB. [RFC 5218: What Makes for a Successful Protocol?](https://datatracker.ietf.org/doc/html/rfc5218), July 2008. Informational protocol adoption analysis.
[^rfc6709]: B. Carpenter, B. Aboba, and S. Cheshire / IAB. [RFC 6709: Design Considerations for Protocol Extensions](https://datatracker.ietf.org/doc/html/rfc6709), September 2012. Informational extension design guidance.
[^rfc9413]: M. Thomson and D. Schinazi / IAB. [RFC 9413: Maintaining Robust Protocols](https://www.rfc-editor.org/info/rfc9413/), June 2023. Informational protocol maintenance guidance.
