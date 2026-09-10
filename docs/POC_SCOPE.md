# Proof of concept scope: one paid service exchange

Status: technical fixture implementation authorized, 2026-09-10. Sui and Iroh are
accepted foundations. The bounded file exchange and acceptance escrow define the
technical experiment; a real customer workflow remains unvalidated. Inference is
not the selected first use case.
The technical fixture needs no GPU, model server, or additional hardware.
See [the protocol](PROTOCOL.md) and [quickstart](QUICKSTART.md) for the implementation.

## The question

Can a buyer commission a fixed-price service from an independently operated
machine, communicate over Iroh, and settle a Sui escrow using an acceptance signed
by the buyer's authenticated endpoint, with an unambiguous outcome after failure?

The participant hypothesis is a developer purchasing a service from a known
operator on another network. The friction hypothesis is connecting that service
to a buyer, tying the request to enforceable payment terms, and recovering from
interruption without paying twice. We have not yet observed this exact combination
of needs with a customer.

Paid search/research APIs and browser sessions already have documented machine
payment integrations. They support investigating paid services as a use case;
they do not establish demand for peer-to-peer delivery or buyer-acceptance
escrow.[^services] Neither a service category nor an economic model should become
a product requirement just because it makes a convenient demo.

## Separate technical scope from use-case selection

The technical scope below tests endpoint authority, signed agreements,
escrow transitions, and failure recovery with a disposable service fixture. It
cannot demonstrate that a particular market needs m2m.

| Candidate real workflow | Evidence so far | What remains unproven |
|---|---|---|
| Buy a tool, data query, or browser session | Providers document machine-payment integrations[^services] | Why these operators need Iroh and the proposed economic condition |
| Buy independently hosted inference | Fits an example in the user's brainstorm; not validated by customer evidence | Why a buyer/provider would adopt this instead of existing API access and billing |
| Buy storage or another infrastructure operation | Architectural hypothesis from the brainstorm | A recent actual purchase, relevant connectivity friction, and manageable permissions/lifecycle |

Select the real adapter only after identifying an actual buyer, provider,
transaction, and failure or integration cost in their current approach. Compare
the existing alternative, whether Iroh solves a relevant connectivity problem,
which Sui-enforced rule matters, and whether both parties can try the exchange.
If the workflow calls for prepaid access or a bounded allowance rather than
acceptance escrow, revise the economic rule for that real adapter. These are
product decisions; they do not block the authorized technical fixture.

## Start on the existing server

Run two separate processes with separate endpoint keys, Agent objects, and local
state directories: a buyer and a provider. The provider serves a fixed test file.
Develop and test the economic contract on a local Sui network, then run the
exchange on Sui testnet. No inference stack is involved.

This first run proves the exchange and economic behavior. A later run places the
same processes on hosts in different networks to evaluate Iroh connectivity.
Until that happens, report cross-network behavior as untested; a successful
same-server exchange is not evidence of NAT traversal or deployment simplicity.

## The exchange

A buyer process starts with the provider's Sui Agent object ID. A separate provider
process serves the request, initially on the same server and later on another
network. The operators know each other. Both use Sui testnet and testnet SUI.
For the technical fixture, the service returns a fixed
test artifact whose expected bytes/hash are known to the buyer. This makes
delivery checks deterministic without pretending the artifact is a useful market.

1. **Resolve and connect.** The buyer reads the provider's Agent object, obtains
   its authorized endpoint key, and connects over Iroh. The provider also checks
   the buyer's endpoint against the buyer's Agent object.
2. **Get a quote.** The buyer requests one bounded, non-streaming result. The
   provider signs a fixed price, request commitment (including operation and
   parameters), parties, payment destination, unique request nonce, quote expiry,
   and settlement deadline.
3. **Fund the agreement.** The buyer's funding command checks its maximum price
   and signs one Sui transaction. Move verifies the provider quote against the
   registered endpoint and locks the exact amount into an escrow. A uniqueness
   record prevents funding the same buyer/request nonce again.
4. **Do the work.** The provider verifies the escrow onchain, calls its service
   handler, persists the output, and returns it over Iroh.
5. **Accept the result.** The buyer checks the response against the demo's local
   acceptance policy and signs an acceptance containing the escrow ID, agreed
   terms commitment, and hash of the exact result bytes. It durably stores the
   acceptance before sending it.
6. **Settle and reconcile.** The provider submits that acceptance to Sui. Move
   verifies it with the buyer endpoint key recorded in the escrow and releases
   funds to the fixed provider address. Both sides can recover the terminal
   outcome by reading chain state after a lost reply or process restart.

The normal flow runs without per-step human intervention after the buyer starts
the purchase. The buyer's local price ceiling controls whether it funds a job;
Move enforces the funded amount and release conditions. This does not implement
an aggregate daily allowance or unrestricted autonomous purchasing.

The later network demonstration runs without configuring a public
inbound application port, a provider domain, or a provider TLS certificate.
Record whether Iroh uses a direct path or a relay. Its address lookup and relay
services, plus Sui RPC access, remain explicit dependencies.[^iroh]

## One economic primitive

Use **fixed-price escrow released on buyer acceptance, with timeout refund**.

| Escrow state | Permitted transition | Enforced condition |
|---|---|---|
| Funded | Settle | Valid buyer acceptance and chain time strictly before the deadline |
| Funded | Refund | Chain time at or after the deadline; funds go to the fixed buyer refund address |
| Settled | None | No further payout or refund |
| Refunded | None | No further payout or refund |

The contract fixes amount, asset, parties, payout/refund destinations, request
commitment, endpoint keys, and deadline at funding. Submitting a settlement or
refund transaction grants no right to change its destination. Terminal records
and funding uniqueness records remain available for the duration of the PoC.

A transport disconnect does not cancel an agreement. Before funding, the buyer
can abandon a quote. After funding, a job that does not settle follows the timeout
refund path. Refund transaction fees are separate from the escrow amount.

This is a deliberately limited trust arrangement. A buyer can receive useful
output and withhold acceptance. The provider can then lose its work and the buyer
can eventually recover the escrow. A signed acceptance delivered too late for
onchain settlement also does not guarantee payment. Use known counterparties and
small testnet jobs; do not describe this as trustless fair exchange or proof of
arbitrary service quality. The experiment tests verifiable economic transitions and
recovery, not dispute resolution.

## What we build

| Component | PoC responsibility |
|---|---|
| Small Sui Move package | Agent registration and endpoint replacement; quote verification; escrow funding, uniqueness, settlement, refund, and queryable outcomes |
| Rust library and CLI, TypeScript chain adapter | Iroh connections, agent resolution, quote/acceptance signing, official Sui SDK interaction, purchase commands, status recovery, and diagnostics |
| Provider handler interface and fixture | One bounded, non-streaming operation; deterministic test artifact and durable result storage; application code separate from protocol code |
| Durable local job records | Store request IDs, escrow references, output, acceptance decisions/signatures, and transaction attempts before acknowledging relevant actions |
| Experimental exchange specification | Versioned message schemas, canonical signed bytes, economic states, errors, deadlines, and recovery rules |
| Verification and demo harness | Move economic tests, Rust integration tests, independent signature vectors, network demo, and injected failures |

Use hardware available to the operators. The deterministic fixture is sufficient
for the technical failure tests and network demonstration. A useful service
adapter is a separate, explicitly selected deliverable once the workflow above
is established. Peer-supplied data does not authorize arbitrary local commands.

### Identity and signed authority

Each Agent object has a controller and one current Ed25519 endpoint key. For the
demo, its controller is also its payment address. Controller/funding keys remain
separate from Iroh operational keys; an endpoint-only worker cannot spend the
controller's remaining wallet balance. Transaction gas comes from a separately
funded testnet signer and is reported separately from job payments.

Controller-authorized endpoint replacement preserves the Agent object ID and
applies to future agreements. Existing escrows retain the endpoint keys captured
at funding until they settle or expire. This bounds an old key's authority to
already funded jobs, but deliberately does not provide immediate revocation of
in-flight agreements. State that limitation in the CLI documentation.

Iroh uses Ed25519 endpoint IDs and Move can verify Ed25519 signatures.[^crypto]
Use this shared primitive explicitly: provider quotes and buyer acceptances are
application signatures verified offchain and in Move. The transport handshake
itself is not a transferable receipt, and endpoint keys are not Sui object IDs.

Specify exact BCS-encoded signing payloads with a protocol/version and purpose
domain, chain identifier, package ID, parties, unique request reference, economic
terms, and deadlines. Acceptances additionally bind the escrow and result hash.
Define hash algorithms, field order, length limits, and integer encodings before
implementation. Publish fixed positive/negative vectors checked by Rust, Move,
and an independent TypeScript verifier. This demonstrates agreement on signed
bytes; it does not claim full independent protocol interoperability.

### Keep the application boundary small

Expose one provider handler and one buyer purchase operation. Return the result,
agreement reference, and settlement status so a conventional program or an LLM
runtime can call it. The fixture's automatic acceptance policy verifies the exact
expected artifact and size limit. A real service must define its own acceptance
policy; the fixture's easy verification does not generalize to service quality.

Keep work progress separate from economic state. A process crash can leave
service execution uncertain. The provider must recover a cached result or
report that uncertainty; a retry must not silently create a second funded job.
Exactly-once service execution is not a PoC guarantee.

## Relationship to existing protocols

A2A already has an extension for payment requests and settlement associated with
tasks, and x402 already defines a Sui payment scheme.[^a2a][^x402] The new thing to
test here is the binding between an authenticated Iroh peer, the particular job,
and the selected escrow rule.

Start with a small experimental exchange profile for this single operation. It
is not a replacement task protocol or a claim of A2A, MCP, or x402 conformance.
The first design deliverable must map its operations and errors to A2A and its
economic flow to the existing A2A/x402 extension, identifying what can be reused
and where acceptance-based escrow differs. Prefer reuse where it preserves the
selected semantics. Keep a full A2A Iroh binding and MCP adapter outside the
initial deliverables. Revisit the packaging after the exchange works.

## Required failure demonstrations

| Scenario | Observable result |
|---|---|
| Peer claims another agent's identity | Reject the endpoint/Agent mismatch before accepting work or economic authority |
| Quote changes price, destination, request, or network; quote is expired | Reject funding |
| Old endpoint signs a new quote after key replacement | Reject funding; an existing escrow retains its documented key snapshot |
| Same funded request is retried after a lost funding reply | Recover the original escrow; no second deposit for that buyer/request nonce |
| Acceptance is forged, altered, or copied to another escrow | Reject settlement |
| Acceptance or settlement transaction is submitted repeatedly | Exactly one escrow payout; later attempts report or reconcile the terminal state |
| Provider restarts after persisting a result | Return the same cached bytes and agreement reference |
| Buyer restarts after signing acceptance | Recover and resend the persisted acceptance without a new purchase |
| Provider settles but the final reply is lost | Buyer recovers the settled state and transaction reference from Sui |
| No acceptance arrives, or provider never completes | Buyer can recover the escrow after the deadline |
| Settlement races refund at the deadline | Chain time and the escrow transition permit only one terminal outcome |
| Required chain state is unavailable | Report a pending/unknown state; do not infer payment success, issue fresh funding, or start unverified work |

These are economic and recovery invariants, not a requirement for a large test
framework. Exercise them deterministically on a local Sui network, then run the
successful exchange and a disconnect/recovery case on testnet.

## Acceptance criteria and evidence

The following are project targets. See [the validation record](VALIDATION.md) for
measured results and outstanding evidence:

- Complete ten sequential fixture purchases across separate processes on the
  existing server, with distinct keys, correct endpoint binding, and one payout
  per job.
- In the later network run, repeat the exchange across two hosts on different
  networks and show both a direct Iroh path and a forced relay path. Record
  network conditions and infrastructure dependencies; do not generalize this to
  every NAT/firewall. Keep this evidence separate from the server-only result.
- Pass every economic failure case above, including funding replay and the
  settlement/refund race. Track escrow value conservation excluding gas.
- A developer other than the author can run the buyer and provider fixture
  using the quickstart in at most 30 minutes after prerequisites
  are installed and keys funded. Report total setup
  time separately, including those prerequisites.
- Report resolution, connection, service execution, funding, and settlement times
  separately, along with gas and transaction counts. Avoid a single latency
  number that hides application cost or chain calls.
- For a selected real workflow, compare the service with its existing
  hosted/API-plus-billing approach,
  using the machine-payment integrations in the research as concrete references.
  Record setup steps, operator dependencies, and guarantees without building a
  second platform. Also separate reusable m2m code from the application-specific
  Iroh/Move glue, so the claimed simplification is inspectable. Until that real
  workflow is selected and measured, report this comparison as outstanding.

Alongside the demo, get feedback from at least one potential buyer and one
independent provider about a recent workflow they would run. Record any evidence
that HTTPS and existing billing already solve their problem. A technical pass
does not establish product demand; if no such participants are available, report
the demand result as unvalidated rather than blocking the technical experiment.

## Delivery sequence

1. **Specify the exchange.** Fix messages, signed bytes, key lifetime rules,
   economic transitions, protocol reuse mapping, and failure expectations.
2. **Prove the economic rule.** Build the Move package and signature vectors;
   verify payout/refund, uniqueness, tampering, and deadline invariants locally.
3. **Connect the fixture.** Add Iroh peers, durable recovery, CLI, and the
   deterministic service handler; complete the local exchange and failure runs.
4. **Run and evaluate.** Run the server-only
   exchange on Sui testnet and publish measurements and a repeatable quickstart.
   Follow with the two-network and relay demonstrations. Report each milestone
   separately, including technical feasibility versus demand. Add a real service
   adapter and update positioning when a workflow is selected.

## Explicit exclusions

Global discovery/search, a public marketplace, reputation, arbitrary-agent trust,
disputes or quality proofs, streaming/token metering, subscriptions, recursive
delegation, daily/shared budgets, simultaneous endpoints for one agent, automatic
in-flight migration, mainnet funds, multiple assets, a new model runtime, a web UI,
and full upstream-protocol conformance are outside this PoC.

Proceed beyond the PoC when the exchange and failure behavior are demonstrated
and a real participant can identify why this composition helps. If only the
technical experiment succeeds, preserve the learning and refine the use case
before expanding the protocol.

## Sources

Checked 2026-09-10. External sources establish available primitives and related
implementations. The technical fixture is authorized; customer hypotheses and
adoption targets still require evidence.

[^services]: [Parallel agentic payments](https://docs.parallel.ai/integrations/agentic-payments) and [Browserbase payment gateway](https://mpp.browserbase.com/), provider documentation for paid service integrations. Not independently verified usage volumes.
[^iroh]: Iroh, [Endpoints](https://docs.iroh.computer/concepts/endpoints) and [Relays](https://docs.iroh.computer/concepts/relays), living documentation for identity, address lookup, and fallback connectivity.
[^crypto]: Iroh, [Endpoints](https://docs.iroh.computer/concepts/endpoints); Sui, [Signature Verification in Move](https://docs.sui.io/develop/cryptography/signing), living documentation. Application-specific signing domains and escrow authorization remain m2m design work.
[^a2a]: Google Agentic Commerce, [A2A x402 Payments Extension v0.1](https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.1/spec.md), published extension specification in a living repository.
[^x402]: x402 Foundation, [exact scheme on Sui](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_sui.md), published scheme specification. It does not by itself specify this buyer-acceptance escrow.
