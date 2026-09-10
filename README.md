# m2m

Economic coordination for autonomous software, using **Iroh for transport** and
**Sui for economic programmability**.

The proof of concept exchanges a fixed test file between two processes over Iroh.
A Sui Move contract locks a quoted payment, releases it on a signed buyer
acceptance, or refunds it after a deadline. It needs no GPU or LLM.

```mermaid
sequenceDiagram
    participant B as Buyer
    participant P as Provider
    participant S as Sui escrow
    B->>P: Iroh: request quote
    P->>B: Iroh: signed quote
    B->>S: Fund verified agreement
    P->>S: Verify deposit
    P->>B: Iroh: file bytes
    B->>P: Iroh: signed acceptance
    P->>S: Submit acceptance; receive payment
    Note over B,S: Unsettled deposits are refundable after the deadline
```

**[Run the PoC](docs/QUICKSTART.md)** · [Protocol](docs/PROTOCOL.md) ·
[Validation and limits](docs/VALIDATION.md)

The first real customer workflow remains open. This is an experimental protocol
profile for known counterparties, using localnet/testnet funds.

Start with the [positioning and problem definition](docs/POSITIONING.md), then
read the [north star](docs/NORTH_STAR.md) and the
[agent protocol research](docs/research/AGENT_PROTOCOLS.md).

The [PoC scope](docs/POC_SCOPE.md) defines the exchange, trust assumptions,
deliverables, failure cases, and acceptance criteria.

[AGENTS.md](AGENTS.md) contains concise working guidance for contributors and
coding agents. The research is a dated reference; the north star should evolve
with evidence and explicit project decisions.
