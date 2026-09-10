# m2m

A new foundational standard for autonomous software to communicate and transact,
using **Iroh for transport** and **Sui for identity and economic programmability**.
This is the project direction; the implementation is currently a paid-exchange
proof of concept. An agent can be an ordinary process, service, or device.

**[Explore every current message](examples/messages/README.md)** ·
[Draft core messaging design](docs/CORE_MESSAGE_PROPOSAL.md)

The examples cover all 12 channel messages and all 7 escrow request/response
shapes, with recovery variants. Channel `payment.settlement` is specified but has
no runtime sender or handler. General messaging and service descriptions are
proposed next steps, separate from the current wire formats.

The proof of concept exchanges a fixed test file between two processes over Iroh.
The optional `sui.channel.v1` method reserves one Sui deposit, carries cumulative
payment authorizations alongside ten offchain jobs, and settles the total at
close. It needs no GPU or LLM.

```mermaid
sequenceDiagram
    participant B as Buyer
    participant P as Provider
    participant S as Sui channel
    B->>P: Iroh: request channel offer
    P->>B: Iroh: signed terms
    B->>S: Open and fund channel
    P->>S: Verify funded agreement
    loop Ten jobs, no per-job RPC
        B->>P: Iroh: signed cumulative credit
        P->>B: Iroh: signed acknowledgement
        P->>B: Iroh: file and signed result
    end
    B->>P: Iroh: signed final close
    P->>B: Iroh: countersigned close
    B->>S: Pay cumulative total and refund unused deposit
```

**[Run channels](docs/CHANNEL_QUICKSTART.md)** · [Channel specification](docs/CHANNEL_SPEC.md) ·
[Validation](docs/CHANNEL_VALIDATION.md) · [Implementation plan](docs/CHANNEL_IMPLEMENTATION_PLAN.md) · [Fly Machines PoC](docs/FLY_POC.md)

Payment is a typed message category; the selected settlement method gives it
economic meaning. Iroh transports the messages, and Sui enforces the collateral,
redemption, close, and expiry rules. These are signed channels, without ZK proofs.
The buyer prepays one job at a time; the provider can claim that advance even if
delivery fails. See the [architectural decision](docs/SETTLEMENT_PROFILES.md).

The existing per-job escrow remains available with its original wire format and
acceptance-after-delivery rule: [escrow quickstart](docs/QUICKSTART.md),
[protocol](docs/PROTOCOL.md), and [validation record](docs/VALIDATION.md).
The [Fly experiment](docs/FLY_POC.md) runs separate buyer/provider machines in
Ashburn and Sydney. Cross-region relay transport is verified; direct public-IP
routing was unavailable under the default Fly network configuration.

The first real customer workflow remains open. The current experimental payment
profiles serve known counterparties, using localnet/testnet funds. The intended
core will support communication without requiring a funded agreement; payment
methods and optional integrations such as A2A will build on that foundation.

Start with the [positioning and problem definition](docs/POSITIONING.md), then
read the [north star](docs/NORTH_STAR.md) and the
[agent protocol research](docs/research/AGENT_PROTOCOLS.md).
The [comparative review](docs/research/M2M_COMPARATIVE_REVIEW.md) and
[implemented message inventory](docs/research/M2M_MESSAGE_INVENTORY.md) distinguish
current capabilities from proposed extensions and upstream compatibility.

The [PoC scope](docs/POC_SCOPE.md) defines the exchange, trust assumptions,
deliverables, failure cases, and acceptance criteria.

[AGENTS.md](AGENTS.md) contains concise working guidance for contributors and
coding agents. The research is a dated reference; the north star should evolve
with evidence and explicit project decisions.
