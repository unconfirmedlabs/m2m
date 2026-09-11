# Native core and streaming-payment implementation

Status: implementation scope accepted by the user on 2026-09-11. Protocol and
SuiNS testing use testnet (localnet for deterministic economic tests); no mainnet
deployment or name purchase is authorized by this plan. The user already owns the
testnet `nozomi.sui` registration; its object and ownership were verified read-only.
Testnet ownership does not reserve the mainnet name. Provisioning its two leaves
still requires the local path to the controlling wallet key.

Implementation update, 2026-09-11: native admission, independent Rust/TypeScript
peers, generic Move economics, durable streaming, and a live Codex text-worker
composition pass local validation. See [results and remaining gaps](NATIVE_VALIDATION.md),
[quickstart](NATIVE_QUICKSTART.md), and [legacy compatibility](NATIVE_COMPATIBILITY.md).
The named testnet deployment is pending. The [live two-agent investor demo](LIVE_DEMO_PROPOSAL.md)
is a subsequent application: the present CLI coordinator is programmed, not an LLM.

## Deliverable and order

Build an embeddable native communication core, a standard streaming-payment
extension, and a two-process demonstration with a Codex research adapter using
`gpt-5.6-luna`, reasoning `xhigh`. Preserve the legacy escrow and fixed-file
channel ABI and signed bytes. Publish new identity/streaming types in a separate
Move package; old funded agreements keep their original authority.

1. Freeze the PoC core and economic wire contract below with verification vectors.
2. Implement free authenticated Iroh messaging and two parameterized handlers.
3. Implement generic unit/rate accounting and Sui channel transitions separately.
4. Compose them with durable credits, checkpoints, delivery gating, and recovery.
5. Add the Codex adapter and SuiNS resolution/registration; keep backend credentials
   outside protocol payloads, logs, model inputs, and the repository.
6. Run interoperability, failure/recovery, Move economics, and testnet integration
   checks. Record actual live observations and any narrower PoC guarantees.

## Core contract for this implementation

ALPN `m2m/core/1`. Length-prefixed frames use a four-byte big-endian length followed
by JSON, at most 1 MiB. JSON is a diagnostic wire representation of typed fields;
Ed25519 signs canonical BCS statements. Use strict structs, decimal strings for
u64 in JSON, full Sui addresses, explicit domains, and no implicit spending rights.

An Agent reference is `(network bytes, package address, domain address, agent
address)`. An authorization snapshot binds that reference to controller address,
transport and economic public keys, generation, and freshness expiry. A resolver
supplies it from the selected chain and validates object type/domain/network.
The first runtime has one active transport endpoint and one state writer per Agent.

Core signed envelopes bind purpose `m2m/core/message/v1`, sender/recipient Agent
references, transport authorization generation, 32-byte message ID, optional
32-byte correlation ID, creation/expiry timestamps, message kind, and payload
bytes. Every logical message is signed by the communication key; economic bodies
have independent economic signatures. Core kinds cover handshake/feature
selection, service description, generic application messages/receipts, and errors.
The core must not import a price or channel to admit unpaid traffic.

Peers authenticate the actual Iroh endpoint against fresh authorization snapshots.
A handshake binds fresh random challenges and selected features to both peers.
Reject expired/stale/wrong-peer/unsupported mandatory features before dispatch.
Replay identity is `(sender Agent, message ID)`; changed content for an existing ID
is an error. Durable receipt means locally persisted acceptance, not successful
execution, payment, or exactly-once external effects. Request dispatch and saved
results need separate journal states; uncertain dispatch requires reconciliation.

## Economic binding

The new Move package owns a Domain, shared Agent records, immutable Policies,
and independently shared Channels. Agent controller checks govern key replacement.
Transport and economic public keys must differ. Channel opening snapshots economic
keys and destinations; later transport rotation preserves existing payment rights.

The initial asset is SUI. A Policy has a bounded list (1–8) of distinct unit names,
integer rates, one positive common denominator, and versioned purpose. Price is
`ceil(sum(cumulative_units[i] * rates[i]) / denominator)`, with bounded arithmetic
and one cumulative rounding operation. This supports bytes, records, and separate
input/output counters without embedding inference semantics in the channel engine.

An offer binds network/package/domain, Agent parties, economic keys, refund/payee,
opening nonce, policy commitment, deposit, work deadline, and claim deadline.
Opening requires buyer controller authority and provider economic signature,
validates live Agent authority, and atomically prevents duplicate opening nonces.

Buyer-signed cumulative credit binds channel/offer, payment and request sequences,
request commitment, prior checkpoint, unit ceilings, and the exact policy price.
Provider acknowledgement is durable before authorized delivery. Checkpoints bind
delivered units, cumulative price, output commitment, and the current credit.
Receipt plus provider close consent can settle exact delivered usage against the
existing buyer credit without a new buyer acceptance of the answer.

Unilateral redemption can claim a valid credit ceiling before expiry. Exact close
must not claw back a higher amount already redeemed; expiry refunds only residual
funds. Credit exhaustion stops delivery; adapters must state any backend compute
overshoot. Request/payment sequences are distinct, monotonic within their scopes,
and retry/reconnect never creates fresh credit for already delivered work.

## PoC bounds and acceptance evidence

Start with known peers, one active paid request per channel, bounded frames and
worker duration, and no multi-writer budgets. Public RPC supplies chain state;
state freshness and unavailable-chain behavior must be explicit. Name resolution
pins qualified Agent identity and never retargets an existing agreement.

Required checks: distinct transport/economic keys; tampered/stale/replayed messages;
unsupported extensions; free handlers; two independent signature encoders; price
vectors and rounding; duplicate funding; wrong policy/channel/signers; exhausted
credit; exact close; unilateral redemption/refund; persistence/reconnect; key
rotation preserving funded rights; real testnet name/Agent resolution; a live
Luna xhigh response with recorded usage and no credential exposure.

Codex's actual event/meter granularity must be measured before claiming token-level
backpressure. Separate upstream execution costs from the selected service price.
The adapter cannot manufacture trustworthy token counters from visible text or
promise to cancel already incurred backend work. Document the measured binding.
