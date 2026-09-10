# m2m implemented message inventory

m2m implements payment, work-delivery, session-recovery, and error messages. Its
application surface is a bounded paid-file exchange. General conversations,
arbitrary tool calls, task orchestration, service discovery, and delegated work
are not implemented.

This inventory checks commit
[`b8c209e84d89a6e39d108e4f58e6847bd17e8ad1`](https://github.com/unconfirmedlabs/m2m/tree/b8c209e84d89a6e39d108e4f58e6847bd17e8ad1)
against its Rust types, runtime dispatch, Move objects, and committed validation
records on 2026-09-10. A declared schema variant is distinguished from a runtime
workflow. This is a capability review, not a new security audit or a new funded
experiment. The [comparative review](M2M_COMPARATIVE_REVIEW.md) places these findings
beside other protocols.

## Channel messages

The channel profile uses Iroh ALPN `m2m/payment/1`, method `sui.channel.v1`, and
version `1`. Its enum declares **12 message types**: seven `payment.*` types, two
`work.*` types, two `session.*` types, and `error`. **Eleven have active runtime
roles.** `payment.settlement` is declared but lacks its specified runtime
workflow.[^channel-types][^provider]

| Message | Direction in the implemented workflow | What it does | Implementation status |
|---|---|---|---|
| `payment.offer_request` | Buyer → provider | Requests a channel for a known result hash, number of jobs, deposit, and maximum unit price | Buyer sends; provider authenticates, validates, and handles |
| `payment.offer` | Provider → buyer | Returns a signed offer and fixture terms | Provider emits; buyer checks and persists before funding |
| `session.resume` | Buyer → provider | Requests admission or recovery for an existing funded channel | Buyer sends; provider checks chain state and the channel's original endpoint-key snapshot |
| `session.ready` | Provider → buyer | Summarizes phase, highest saved credit, completed work, transcript, redeemed amount, and any saved close certificate | Provider emits; buyer reconciles with its own history and chain snapshot |
| `payment.authorize` | Buyer → provider | Binds a request descriptor to a signed cumulative credit | Buyer persists and sends; provider validates and durably records |
| `payment.acknowledge` | Provider → buyer | Signs acknowledgement of the accepted credit | Provider persists and emits; buyer validates and saves |
| `work.get` | Buyer → provider | Retrieves the result for an already authorized request hash | Provider requires admission and a matching saved credit; produces or replays the fixture |
| `work.result` | Provider → buyer | Returns bytes plus a signed statement binding the result to its request, credit, and channel | Buyer verifies, saves, and advances the transcript |
| `payment.close` | Buyer → provider | Proposes the final cumulative amount and transcript, signed by the buyer | Both sides validate against durable history; provider freezes further work |
| `payment.close_acknowledge` | Provider → buyer | Returns the jointly signed close certificate | Buyer persists the certificate and submits close through the Sui adapter |
| `payment.settlement` | Specified as a post-submission hint | Would carry a digest, trigger independent reconciliation, and return `session.ready` | **Type and validator exist; no sender or receive handler implements this flow** |
| `error` | Provider → buyer for handled request failures | Returns a code and diagnostic message without changing economic authority | Provider emits; buyer recognizes; some malformed frames instead close the connection |

The buyer's authorizations, acknowledgements, work retrieval, and result checks
are present in the execution/replay loop. Closing submits directly through the
local chain adapter after obtaining the certificate.[^buyer-work][^buyer-close]
The provider handles offer requests, resume, authorization, retrieval, and close;
other incoming variants fall through to rejection.[^provider]

`session.ready` is a summary of a payment agreement. It does not implement a
conversation session or a generic task status API. Likewise, acknowledgement of
a credit is neither a delivery guarantee nor proof that a payment has already
settled. These meanings matter when mapping the messages to another protocol.

## What a work message can express today

`payment.authorize` contains the job's `RequestDescriptor`: channel, terms hash,
request ID, and sequence. There is no operation name or arbitrary argument object.
`work.get` refers to that descriptor by hash. The fixture terms already identify
the exact expected output.[^channel-types]

The application interface is:

```rust
trait ServiceHandler: Send + Sync {
    fn result_hash(&self) -> Vec<u8>;
    fn execute(&self) -> Result<Vec<u8>>;
}
```

The sole handler is `FixedFile`; its `execute` method returns the configured file.
Both servers construct this handler. Files are limited to 64 KiB. This is a useful
boundary for separating service code from payment code, but it does not yet
supply a general request-input or task-output contract.[^service][^server]

Each channel request uses a bidirectional QUIC stream, with a bounded complete
JSON request and response. The runtime buffers the result. QUIC transport streams
do not constitute token streaming, incremental artifacts, progress events, or
server-initiated application subscriptions.[^exchange]

Work retrieval also requires a funded, admitted channel and a matching credit.
There is no independent free-message or unpaid-work workflow. Arbitrary
application messaging is technically possible over Iroh, but it would require
additional protocol semantics and implementation in m2m.

## Original per-job escrow messages

The original escrow is preserved as a separate profile on `m2m/fixture/1`. It has
three request shapes and four response shapes, using different discriminators
from the channel envelope.[^escrow-types]

| Direction | Wire discriminator and value | Meaning |
|---|---|---|
| Buyer → provider | `method: "quote"` | Request signed terms for the expected fixture |
| Provider → buyer | `kind: "quote"` | Return the signed escrow quote |
| Buyer → provider | `method: "deliver"` | Retrieve the result for the funded escrow |
| Provider → buyer | `kind: "result"` | Return the fixture bytes and escrow reference |
| Buyer → provider | `method: "accept"` | Send the buyer's signed acceptance |
| Provider → buyer | `kind: "settled"` | Report a reconciled settlement digest |
| Provider → buyer | `kind: "error"` | Report a request failure |

All seven shapes have runtime paths. In particular, the escrow's `settled`
response is implemented; it must not be confused with the channel's unimplemented
`payment.settlement` hint.[^escrow-provider]

Escrow settles on signed buyer acceptance after delivery. The cumulative channel
allows the provider to redeem a signed advance without proving delivery. They
have different economic rules, so matching names or fields would not make their
messages interchangeable.

## Implemented operations that are not Iroh message types

Agent initialization, identity inspection, status queries, unilateral redemption,
and timeout refunds are exposed through CLI and chain-adapter operations. Their
existence does not imply wire messages such as `agent.register`, `task.status`,
`payment.redeem`, or `payment.refund`.[^cli]

The Sui `Agent` object records a deployment, controller, one endpoint key, and
escrow nonce/job bookkeeping. The channel module adds its own opening-nonce index.
There is no Agent Card, service catalog, metadata field, reputation registry, or
multi-endpoint delegation tree in that object.[^agent]

Endpoint tickets give already known peers routing information. They are not a
service-discovery protocol. Method and version checks reject unsupported values;
they do not provide a negotiated list of services or settlement methods. The two
profiles have separate CLI paths and wire contracts, rather than an implemented
universal method router.[^channel-types][^cli]

## Capability boundary

| Capability | Current evidence | Boundary |
|---|---|---|
| Durable identity and authenticated peer binding | Sui Agent/controller/endpoint checks; Iroh endpoint authentication | One endpoint key per Agent; old funded agreements preserve their snapshot |
| Price and agreement formation | Signed offers/quotes, buyer maxima, exact deposit and deadlines | Fixed fixture terms; no general negotiation language |
| Work request and result | Request references, fixture execution, signed channel results | No arbitrary arguments, typed service catalog, or multi-part artifacts |
| Repeated payment | Cumulative credits, acknowledgements, two-transaction ten-job happy path | One buyer/provider channel, SUI collateral, no top-up or bidirectional balance |
| Economic recovery | Durable journals, replay, close freeze, redemption and residual refund | Timely chain access and preserved state remain necessary |
| General task lifecycle | No implementation | No generic submit/query/list/cancel, input-required continuation, or background task notifications |
| Conversations and event streaming | No implementation | Session recovery concerns an economic agreement; results are buffered |
| Discovery and capability negotiation | No implementation | Peers use exchanged tickets and fixed method/version checks |
| Delegation and shared budgets | No implementation | A funded deposit constrains that agreement; it is not a downstream authority grant or cross-channel spending policy |
| MCP/A2A/payment-standard adapters | No implementation or conformance claim | Existing similarities are conceptual mappings |
| Independent implementation interoperability | Rust/TypeScript/Move signing checks | Both live peers use the same Rust runtime |

The committed evidence demonstrates localnet and public-testnet settlement,
recovery tests, and Ashburn–Sydney communication through an Iroh relay. It does
not demonstrate arbitrary service interoperability, public-IP direct transport,
a public network of independent operators, or adoption.[^validation]

## Review findings to carry forward

1. **Reconcile the `payment.settlement` mismatch.** Either implement its specified
   hint/reconciliation workflow with an interoperability check, or explicitly
   revise the next specification to omit/defer it. The current successful close
   path does not depend on that hint; the gap concerns the published contract.
2. **Make the generalization decision before adding message names.** Choose an
   application-facing task or tool contract and define how work references bind
   to economic agreements. A new `work.submit` name alone would not define task
   progress, cancellation, inputs, outputs, or payment consequences.
3. **Maintain a message-to-runtime conformance map.** Serialization tests and a
   successful buyer/provider demo do not establish support for every declared
   message or error. Error classification currently maps diagnostic text into
   codes; it is not an A2A/MCP error contract.[^provider]
4. **Keep method-specific guarantees explicit in any adapter.** An authenticated
   message, a credit acknowledgement, a delivered result, and chain settlement
   are separate observations. A task cancellation cannot silently cancel a valid
   outstanding credit.

These are review recommendations. No protocol behavior or normative requirement
was changed by this inventory.

## Sources

All repository links below pin the reviewed commit. Public validation records
are historical evidence, not tests rerun for this review.

[^channel-types]: m2m, [channel message types, validation, and envelope](https://github.com/unconfirmedlabs/m2m/blob/b8c209e84d89a6e39d108e4f58e6847bd17e8ad1/src/channel_protocol.rs#L654); [normative wire table](https://github.com/unconfirmedlabs/m2m/blob/b8c209e84d89a6e39d108e4f58e6847bd17e8ad1/docs/CHANNEL_SPEC.md#wire-contract).
[^provider]: m2m, [provider connection and request dispatch](https://github.com/unconfirmedlabs/m2m/blob/b8c209e84d89a6e39d108e4f58e6847bd17e8ad1/src/channel_runtime.rs#L2527). The handler's final wildcard rejects unsupported incoming roles/variants.
[^buyer-work]: m2m, [credit/acknowledgement loop](https://github.com/unconfirmedlabs/m2m/blob/b8c209e84d89a6e39d108e4f58e6847bd17e8ad1/src/channel_runtime.rs#L1635) and [work retrieval and result verification](https://github.com/unconfirmedlabs/m2m/blob/b8c209e84d89a6e39d108e4f58e6847bd17e8ad1/src/channel_runtime.rs#L1759).
[^buyer-close]: m2m, [close handshake and direct adapter submission](https://github.com/unconfirmedlabs/m2m/blob/b8c209e84d89a6e39d108e4f58e6847bd17e8ad1/src/channel_runtime.rs#L1958).
[^service]: m2m, [ServiceHandler and FixedFile](https://github.com/unconfirmedlabs/m2m/blob/b8c209e84d89a6e39d108e4f58e6847bd17e8ad1/src/service.rs).
[^server]: m2m, [channel server constructs FixedFile](https://github.com/unconfirmedlabs/m2m/blob/b8c209e84d89a6e39d108e4f58e6847bd17e8ad1/src/channel_runtime.rs#L3373) and [escrow CLI](https://github.com/unconfirmedlabs/m2m/blob/b8c209e84d89a6e39d108e4f58e6847bd17e8ad1/src/main.rs).
[^exchange]: m2m, [Iroh request/response exchange](https://github.com/unconfirmedlabs/m2m/blob/b8c209e84d89a6e39d108e4f58e6847bd17e8ad1/src/channel_runtime.rs#L858).
[^escrow-types]: m2m, [escrow request and response enums](https://github.com/unconfirmedlabs/m2m/blob/b8c209e84d89a6e39d108e4f58e6847bd17e8ad1/src/protocol.rs#L104).
[^escrow-provider]: m2m, [escrow provider handlers](https://github.com/unconfirmedlabs/m2m/blob/b8c209e84d89a6e39d108e4f58e6847bd17e8ad1/src/transport.rs#L124).
[^cli]: m2m, [CLI commands and dispatch](https://github.com/unconfirmedlabs/m2m/blob/b8c209e84d89a6e39d108e4f58e6847bd17e8ad1/src/main.rs#L29).
[^agent]: m2m, [Agent object](https://github.com/unconfirmedlabs/m2m/blob/b8c209e84d89a6e39d108e4f58e6847bd17e8ad1/move/m2m/sources/exchange.move#L37) and [channel opening state](https://github.com/unconfirmedlabs/m2m/blob/b8c209e84d89a6e39d108e4f58e6847bd17e8ad1/move/m2m/sources/channel.move).
[^validation]: m2m, [channel validation](https://github.com/unconfirmedlabs/m2m/blob/b8c209e84d89a6e39d108e4f58e6847bd17e8ad1/docs/CHANNEL_VALIDATION.md) and [original escrow validation](https://github.com/unconfirmedlabs/m2m/blob/b8c209e84d89a6e39d108e4f58e6847bd17e8ad1/docs/VALIDATION.md).
