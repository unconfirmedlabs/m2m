# Working on m2m

## Project context

m2m is building a new foundational standard for communication and economic
coordination between autonomous software. This is the accepted project direction;
the present implementation is an experimental native core and streaming binding
alongside narrower paid-exchange proofs of concept. **Iroh is the
required transport; Sui is the required layer for economic programmability.**
Their common Ed25519 support is an integration advantage. Preserve these choices
unless the user changes them.

Economic signing keys and Iroh transport keys must be distinct: accepted user
decision, 2026-09-11. Apply this to the foundation and new bindings; migrate the
existing PoCs through an explicit compatibility specification rather than
silently changing their signed statements or agreement authority.

Tunneled streaming payments are a built-in m2m primitive for real-time per-unit
pricing: accepted user decision, 2026-09-11. Generalize the funded-channel flow
across services; keep unit/rate policies configurable and unpaid messaging valid.

The durable agent identity, its controller, authorized endpoint keys, and spending
authority are distinct concepts. An agent can be ordinary software; participation
must not require an LLM or a particular agent framework.

## Read before designing

- [North star](docs/NORTH_STAR.md): design principles and architectural boundaries.
- [Positioning](docs/POSITIONING.md): problem hypothesis, alternatives, and open decisions.
- [Foundation assessment and plan](docs/FOUNDATION_PLAN.md): current architectural gaps and recommended dependency order; proposed work, not a frozen core contract.
- [Identity and naming recommendation](docs/IDENTITY_AND_NAMING.md): Agent/key separation, rotation, and an optional SuiNS-to-Agent binding; proposed design with checked upstream evidence.
- [Named research-agent proposal](docs/RESEARCH_AGENT_PROPOSAL.md): proposed coordinator/Codex use case; service, pricing, and settlement boundaries; prerequisite foundation work and explicit prepayment limits.
- [Native streaming payments](docs/STREAMING_PAYMENTS.md): accepted built-in primitive direction; common channel machinery, service-defined units, and unfinished compatibility/specification work.
- [Message examples](examples/messages/README.md): every current wire message, with checked signatures and explicit implementation status.
- [Core message proposal](docs/CORE_MESSAGE_PROPOSAL.md): draft native messaging foundation; not implemented or a released wire contract.
- [Native implementation](docs/NATIVE_QUICKSTART.md): experimental core/streaming contracts, [compatibility](docs/NATIVE_COMPATIBILITY.md), and [validation limits](docs/NATIVE_VALIDATION.md).
- [Active reduced live demo](docs/REDUCED_LIVE_DEMO.md): deterministic user-driven coordinator, one real Luna xhigh research agent, Iroh, one testnet channel, incremental byte payments, simple UI, controlled restart and verified close. [Earlier two-LLM proposal](docs/LIVE_DEMO_PROPOSAL.md) is superseded; no scripted answers or fixture fallback.
- [Agent services](docs/AGENT_SERVICES_SPEC.md): v2 continuing research conversations, bounded tools/budgets, [implementation contracts](docs/AGENT_SERVICES_IMPLEMENTATION.md), and [validation gates](docs/AGENT_SERVICES_VALIDATION.md).
- [PoC scope](docs/POC_SCOPE.md): first exchange, economic rule, deliverables, and validation targets.
- [Payment messages and settlement methods](docs/SETTLEMENT_PROFILES.md): core payment vocabulary and optional cumulative channels; actual ZK proofs are a separate future method.
- [Channel specification](docs/CHANNEL_SPEC.md) and [implementation plan](docs/CHANNEL_IMPLEMENTATION_PLAN.md): exact signing, recovery, and acceptance contract for the channel PoC.
- [Protocol research](docs/research/AGENT_PROTOCOLS.md): dated evidence and adoption lessons.

Read the north star and positioning before substantial protocol changes. Consult
the relevant research sections when choosing an integration or making a claim
about another protocol. Verify current upstream specifications before implementing
against them; a research snapshot is not a version pin.

Current stage: the signed cumulative-channel PoC is implemented alongside the
existing per-job escrow. See [channel validation](docs/CHANNEL_VALIDATION.md)
for localnet, public testnet, recovery, and cross-region Fly evidence. Preserve
one-job prepayment exposure, durable recovery, and the existing escrow ABI/wire
meanings. No GPU, inference service, or actual ZK prover is part of the implemented
fixture scope. A separate native core/generic streaming binding now has local
Iroh, Sui and live Codex text-worker evidence. Named testnet provisioning remains
pending. The original native coordinator is programmed. A separate agent-services
runner now implements bounded tools and continuing conversations with localnet
payment/restart evidence using fixture inference. Live profiles fail before funding
under AS-20 until registered-only tool isolation is validated; preserve this gate.
The active first-demo gates are RD-0–RD-5 in the reduced specification; they
remain unverified. Two-LLM coordination and Fly are deferred, not completion
prerequisites. Preserve provider tool isolation before live funding; removing
the coordinator LLM does not waive that gate.
For that use case, the user selected a funded channel with incremental response
payments through signed offchain updates. Adapt the tunnel flow; do not make
subjective task completion or final-answer acceptance a payment prerequisite.
Keep measured technical behavior separate from customer demand and production
readiness. Further protocol changes should start from the specification and the
explicit guarantees of the selected settlement method.

## Design discipline

1. Start with a named participant, a concrete workflow, and a measurable failure
   in the best existing alternative. Technology fit alone does not establish demand.
2. Keep Sui economic programmability and Iroh transport central. Design a small
   native m2m core, learning from existing task, tool, authorization, and payment
   standards. A2A and other protocols may integrate above it or through adapters;
   they are not mandatory foundations. General communication must be possible
   without opening a payment agreement; economic authority stays explicit.
3. Distinguish service descriptions, negotiated protocol features, delegated
   permissions, and evidence about performance. Do not put them all under an
   ambiguous `capabilities` label.
4. Specify what each party can verify and what it must trust. Endpoint authentication,
   spending authorization, settlement, delivery, and correct execution are separate.
5. Keep bulk data and routine interaction offchain. Put state on Sui when independent
   parties need its ownership, shared enforcement, or settlement guarantees.
6. Define economic failure behavior alongside the successful flow: retries, duplicate
   requests, cancellation, expiry, partial results, disconnects, and uncertain settlement.
7. Use explicit versions, schemas, deterministic signed bytes, domain separation,
   and rejection of unsupported mandatory features. Never let permissive parsing
   silently change economic terms or authority.
8. Test cross-implementation behavior and enforceable invariants. A successful
   exchange between two copies of one SDK is not sufficient interoperability evidence.
9. Keep implementation, protocol specification, adapters, and commercial services
   separable. A hosted directory or marketplace must not define the protocol by accident.
10. Record important decisions with rationale, alternatives, status, and evidence.
    Mark proposed positioning and untested hypotheses honestly; do not silently
    promote them to accepted requirements.
11. Maintain examples for every declared message and meaningful failure/recovery
    branches. Validate schemas, signatures, and cross-message references. Keep
    design sketches separate from current wire fixtures; schema presence alone
    does not demonstrate a runtime sender or handler.

## Research and documentation

Use primary specifications, upstream source, and implementer documentation. Cite
exact pages beside factual claims and record the checked date and version/status.
Distinguish a released specification from a draft, implementation support from a
proposal, and shipped integrations from adoption claims. Disambiguate ACP by full
name. Do not claim market-wide absence from a bounded survey.

Keep this file concise. Put rationale and research in the linked documents and
update them together when the project direction changes. These documents guide
judgment and should evolve with evidence and explicit user decisions.

## Screenshots from the Mac

The user captures screenshots on their local Mac; they land on this box in
`~/shots/`, newest always at `~/shots/latest.png`.

If the user refers to a screenshot, image, screen, or UI without giving a path,
read `~/shots/latest.png`. Run `shotd latest` to resolve the newest path.
