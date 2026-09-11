# m2m north star

m2m is building a new foundational standard that makes it practical for independently
operated software to communicate over Iroh and coordinate economic activity through
Sui under explicit, verifiable terms. The first implementation should earn adoption
through one useful workflow and a small integration surface.

The foundational-standard direction, Sui, and Iroh are accepted requirements.
The authorized proof of concept implements
a fixed-file exchange to test transport authentication and economic settlement.
The initial audience, exact core contract, and optional compatibility adapters remain
open decisions. m2m will have native semantics; an existing agent protocol is not
a mandatory base. This document contains engineering guidance; a working
technical experiment does not establish market demand.

The evidence behind these principles is in the [protocol survey](research/AGENT_PROTOCOLS.md).
The proposed problem and decisions to settle next are in [positioning](POSITIONING.md).
The [PoC scope](POC_SCOPE.md) applies these principles to a paid service
exchange and separates technical validation from use-case evidence.
The [channel specification](CHANNEL_SPEC.md) extends that fixture to repeated
purchases under one deposit, with its prepayment and recovery rules stated explicitly.
The [current message examples](../examples/messages/README.md) document that
contract. The [core message proposal](CORE_MESSAGE_PROPOSAL.md) is a separate draft
for the next iteration, not a change to existing wire or signing formats.
The [foundation assessment and plan](FOUNDATION_PLAN.md) evaluates the shared
contracts that need to precede implementing that draft and recommends their
dependency order.
The [named research-agent proposal](RESEARCH_AGENT_PROPOSAL.md) applies those
boundaries to a prospective Codex service with independently selected pricing
and settlement; its terms and implementation remain proposed.

## 1. Make the benefit concrete

Every proposed feature should identify who benefits, the operation they are trying
to complete, and the integration or failure it removes. Evaluate the strongest
existing composition, including tools, task protocols, networking, and payment
libraries used together. A feature can be valuable even if its ingredients exist;
the improvement must be observable in integration effort, operation, or guarantees.

Aim for a useful exchange between a small number of participants before depending
on a global directory, marketplace liquidity, or reputation network. Measure time
to first successful exchange, number of integration changes, and repeat use by
independent implementations. Do not substitute downloads or partner logos for these
outcomes. This applies the deployment and incentive lessons in RFC 5218.[^1]

## 2. Give each layer a defined responsibility

| Layer | Intended responsibility | Boundary |
|---|---|---|
| Application | Produce useful work and interpret its domain-specific quality | May use an LLM, conventional service, or device controller |
| m2m core | Bind durable peers to authorized endpoints; negotiate features; exchange correlated messages | Native, application-neutral communication without a required payment agreement |
| Native streaming-payment primitive | Fund channels, authorize incremental consumption, exchange checkpoints, and recover/settle signed state | Built into m2m; services select units and rates; unpaid communication remains valid |
| m2m profiles | Define work lifecycles, economic agreements, and recoverable outcomes | Optional contracts with explicit guarantees; the current PoC implements payment profiles |
| Iroh | Authenticated encrypted communication and connection establishment | Endpoint authentication does not grant spending rights |
| Sui | Durable economic state, ownership, programmable permissions, and settlement | Onchain execution cannot itself establish arbitrary offchain work quality |

Keep prompts, model selection, memory, planning, and internal tools outside the
mandatory protocol. Integration should be possible through an SDK or adapter
without adopting an entire runtime.

The core should permit unpaid communication, while retaining Sui identity and
Iroh transport as requirements. The existing economic proof of concept exercises
actual Sui rules alongside Iroh communication. Use that evidence to design the
payment profile boundary; a generic message receipt cannot acquire settlement
meaning implicitly.

Tunneled streaming payments are an accepted built-in primitive for real-time
per-unit pricing (2026-09-11). The common mechanism belongs to m2m and its SDK;
inference, data transfer, compute, and other services supply their unit and meter
policies. See [native streaming payments](STREAMING_PAYMENTS.md). Its generic
contract remains unfinished; the current fixed-file channel is narrower evidence.
Recommended protocol placement is a standard m2m extension using core identity,
signed messaging, negotiation, and delivery primitives. Built-in SDK support and
standardized semantics do not require channel accounting in the mandatory core.

## 3. Use Ed25519 compatibility precisely

Iroh endpoint identity is an Ed25519 public key. Sui supports Ed25519 signing and
Move verification of Ed25519 signatures.[^2][^3] This gives m2m a direct way to
authenticate a peer and verify that peer's explicitly signed economic statements
in Move, subject to exact encoding and verification rules.

These identifiers have different meanings:

| Identifier | Meaning |
|---|---|
| Iroh endpoint ID | Public key identifying a transport endpoint |
| Sui signing address | Address derived from a signature scheme and public key |
| Sui Agent object ID | Stable identifier of a particular onchain object |
| Job or agreement ID | Identifier binding a specific exchange to its terms |

For an Ed25519 public key `pk`, the conventional Sui signing address derives from
`BLAKE2b-256(0x00 || pk)`. It is not the raw public key, and an Agent object ID is
not derived this way.[^4] A shared algorithm does not automatically equate these
identities or grant an endpoint control of an object.

Design an explicit authorization relationship between the durable agent and its
operational keys. **Economic signing keys and Iroh transport keys must be distinct**
(accepted user decision, 2026-09-11). Their common Ed25519 support does not require
private-key reuse. Keep controller/funding authority separate from operational
authority as well; the exact controller/recovery model still needs specification.
Economic signers receive narrowly scoped grants without unrestricted access to
the controller's funds. Transport authentication alone grants no spending rights.

The existing PoCs reuse endpoint keys for economic statements. Preserve their
signed bytes and outstanding agreement rights while specifying a new binding
that separates communication authorization from economic signing. See the
[identity and naming design](IDENTITY_AND_NAMING.md) for the recommended boundary.

Do not treat a transport handshake as a transferable signed quote or receipt.
Application signatures should bind a protocol/domain, network, agreement, parties,
exact terms or content commitment, and replay/expiry information. Specify canonical
bytes and publish positive and negative verification vectors before claiming
cross-language or Move interoperability.

## 4. Separate the kinds of trust

Keep five questions explicit:

1. Which endpoint is connected?
2. Which agent authorizes that endpoint, for this action and at this time?
3. What exact terms did the parties accept, and what budget backs them?
4. What was delivered, and what establishes acceptance or correctness?
5. What economic state actually settled?

Authentication answers the first question. Authorization, service claims, payment,
and evaluation require their own evidence. A signature authenticates a statement;
a content hash identifies bytes; neither proves a research answer is accurate or
an advertised model performed the computation.

Treat offchain advertisements and peer-supplied text as untrusted input. Local
execution policy and sandboxing remain runtime responsibilities. Define which
policies are enforced by Move, by a local signer, or by the counterparty. A budget
field is not an enforced budget unless an identified component rejects excess
spending on every applicable path.

## 5. Build a native core with explicit interoperability boundaries

Design m2m as the foundation for peer communication, identity binding, and economic
coordination. Learn from MCP's tool boundary, A2A's work/task semantics, and
authorization/payment standards when specifying native profiles. Applications may
use those protocols above m2m or through adapters. None is a mandatory dependency
of the core, and m2m participation must not require an LLM.

For every extension or adapter, write down the upstream version, preserved
semantics, authentication boundary, and failure mapping. Existing HTTP clients
will not automatically speak a custom Iroh binding. A gateway changes who sees
traffic and who authenticates whom; document that change.

Keep the native mandatory contract small. Add task state, delegation, or streaming
only with defined transitions, failure behavior, and independent implementation
examples. An adapter must preserve the upstream contract before claiming
compatibility; carrying an opaque payload alone is not A2A conformance.

## 6. Make uncertainty a protocol concern

Economic coordination is a distributed system. A disconnected requester cannot
infer whether work executed or a transaction settled. The eventual specification
must define duplicate suppression, idempotency scope and retention, retryable errors,
status recovery, deadlines, cancellation races, partial delivery, and refund or
release conditions appropriate to the selected economic model.

One job may have separate work and settlement states. Completing a task need not
mean funds moved, and canceling transport need not cancel a settled payment. Use
stable correlation references and explicit reconciliation. Do not claim exactly-once
delivery or fair exchange merely because transport is reliable or transactions
are atomic.

If multiple endpoints share a budget, identify how concurrent authorization is
serialized or reserved. If authority is cached, state the maximum revocation
delay and behavior when current chain state cannot be obtained. Check authority
again at economically meaningful transitions, according to the chosen policy.

## 7. Keep the onchain boundary economical

Use Sui for state that needs durable ownership, shared economic enforcement, or
settlement. Prefer offchain messages for negotiation and work; use commitments
when exact terms or results need to be referenced onchain. An economic workflow
may require chain transactions; each should earn its cost and latency.

Endpoint locator changes and live availability are distinct from endpoint-key
authorization. Iroh can resolve a persistent endpoint key to changing network
locations, so an IP change should not by itself require a chain update.[^2]
Service search and ranking are also distinct from identity resolution.

Record actual costs and failure dependencies: gas, RPC access, state freshness,
indexing, relays, and asset funding. Iroh relay infrastructure can assist connection
establishment and carry encrypted fallback traffic; P2P does not imply every path
is direct or infrastructure-free.[^5] Do not promise instant migration of agent
memory or in-flight work simply because its identifier remains stable.

## 8. Make independent implementation possible

A protocol release should have a readable specification, machine-readable schemas,
state and error definitions, signed-byte vectors, a compatibility policy, and
runnable examples. Reference SDKs are implementations of that contract.

Define required versus optional features, version negotiation, and unknown-field
behavior. Reject unsupported mandatory economic features rather than silently
weakening an agreement. Exercise extension and migration paths before relying on
them. Favor a small interoperable core over many theoretically possible modes.[^6]

Conformance should test peer implementations that did not share the same internal
assumptions, including authorization failures and economic race conditions. Publish
bug fixes and clarify ambiguous semantics as the protocol evolves; permissive
handling of unspecified behavior can entrench incompatibility.[^7]

## 9. Build an adoption path and maintain it

Provide a clear quickstart and a useful integration with software participants
already run. Make diagnostics show peer identity, chosen protocol version, job
status, and settlement reference without exposing secrets or private payloads.

An open protocol needs an explicit license, a specification owner, a contribution
process, compatibility commitments, and a way to report vulnerabilities. Start with
lightweight governance and grow it with independent implementers. Foundation
membership is not a substitute for usable tooling or deployed interoperability.

Future marketplace fees, hosted discovery, relay services, or reputation systems
are product decisions. Keep their business rules separate from the basic ability
of two implementations to interoperate.

## Sources

Checked 2026-09-10. These links support the foundational facts; the broader
comparative evidence and protocol-specific lessons are in the research survey.

[^1]: D. Thaler and B. Aboba / IAB. [RFC 5218: What Makes for a Successful Protocol?](https://datatracker.ietf.org/doc/html/rfc5218), July 2008. Informational analysis of deployment, incentives, and protocol success.
[^2]: n0 / Iroh. [Endpoints](https://docs.iroh.computer/concepts/endpoints), living documentation. Endpoint identity and address resolution.
[^3]: Sui Foundation / Mysten Labs. [Signature Verification in Move](https://docs.sui.io/develop/cryptography/signing) and [Key pairs](https://sdk.mystenlabs.com/sui/cryptography/keypairs), living documentation. Ed25519 support and verification.
[^4]: Mysten Labs. [PublicKey implementation](https://github.com/MystenLabs/ts-sdks/blob/main/packages/sui/src/cryptography/publickey.ts), [signature scheme flags](https://github.com/MystenLabs/ts-sdks/blob/main/packages/sui/src/cryptography/signature-scheme.ts), and [Sui object model](https://docs.sui.io/develop/sui-architecture/object-model), living upstream sources. Address derivation and distinct object identity.
[^5]: n0 / Iroh. [Relays](https://docs.iroh.computer/concepts/relays), living documentation. NAT traversal and encrypted fallback.
[^6]: B. Carpenter, B. Aboba, and S. Cheshire / IAB. [RFC 6709: Design Considerations for Protocol Extensions](https://datatracker.ietf.org/doc/html/rfc6709), September 2012. Extension and versioning design.
[^7]: M. Thomson and D. Schinazi / IAB. [RFC 9413: Maintaining Robust Protocols](https://www.rfc-editor.org/info/rfc9413/), June 2023. Active maintenance and predictable error behavior.
