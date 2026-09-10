# Working on m2m

## Project context

m2m explores economic coordination between autonomous software. **Iroh is the
required transport; Sui is the required layer for economic programmability.**
Their common Ed25519 support is an integration advantage. Preserve these choices
unless the user changes them.

The durable agent identity, its controller, authorized endpoint keys, and spending
authority are distinct concepts. An agent can be ordinary software; participation
must not require an LLM or a particular agent framework.

## Read before designing

- [North star](docs/NORTH_STAR.md): design principles and architectural boundaries.
- [Positioning](docs/POSITIONING.md): problem hypothesis, alternatives, and open decisions.
- [PoC scope](docs/POC_SCOPE.md): first exchange, economic rule, deliverables, and validation targets.
- [Protocol research](docs/research/AGENT_PROTOCOLS.md): dated evidence and adoption lessons.

Read the north star and positioning before substantial protocol changes. Consult
the relevant research sections when choosing an integration or making a claim
about another protocol. Verify current upstream specifications before implementing
against them; a research snapshot is not a version pin.

Current stage: PoC implementation, authorized by the user on 2026-09-10. Implement
the bounded test-file exchange on the existing server, with Iroh transport and
Sui escrow. No GPU or inference service is required. Proceed within that scope
without repeatedly asking. Keep localnet, testnet, and cross-network evidence
distinct, and do not treat a technical fixture as validated customer demand.

## Design discipline

1. Start with a named participant, a concrete workflow, and a measurable failure
   in the best existing alternative. Technology fit alone does not establish demand.
2. Keep Sui economic programmability and Iroh transport central. Evaluate existing
   task, tool, authorization, and payment standards before creating new semantics.
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
