# m2m experimental exchange profile 0.1

Implementation target: fixed test-file exchange, Iroh 1.2.0, Sui testnet CLI
1.79.0. This profile has no MCP, A2A, or x402 conformance claim.

## Reuse and boundaries

The provider exposes one `fixture.get` operation. A2A's send-message, artifact,
and task-query concepts correspond to requesting the file, receiving its bytes,
and recovering the job. We retain stable request references and separate economic
status from work progress, without implementing a second general task framework.

The [A2A x402 extension](https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.1/spec.md)
already coordinates payment-required, authorization, verification, and settlement.
The [x402 Sui exact scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_sui.md)
uses a signed transfer transaction. This experiment instead reserves funds and
requires a later endpoint-signed acceptance or deadline refund. An adapter must
preserve those distinct conditions; pretending this is an ordinary exact transfer
would change the agreement. A full A2A binding is deferred.

| Experimental operation | Related A2A / payment-extension concept | Boundary in this profile |
|---|---|---|
| `quote` | Send a request; payment-required terms | Endpoint signs exact escrow terms; no general conversation or task negotiation |
| Fund on Sui | Payment authorization and verification | A deposit reserves value; it is not a completed transfer to the provider |
| `deliver` | Retrieve an artifact | One bounded result, recovered by escrow ID; no streaming task lifecycle |
| `accept` and settle | Payment submission and settlement | Buyer signs the artifact/escrow commitment; Move enforces payout |
| Status / refund | Task query and economic recovery | Read authoritative escrow state; refund follows chain time, not task cancellation |
| `request_failed` | Request/task errors | Diagnostic only; no A2A error-code compatibility or economic finality is implied |

## Cryptographic contract

Sign raw BCS bytes of the structs below with Ed25519 (64-byte signature, 32-byte
public key). These are application signatures, not Sui personal-message or
transaction signatures. Hash with BLAKE2b configured for a **32-byte output**,
not truncated BLAKE2b-512. Addresses are 32 fixed bytes; vectors have BCS ULEB128
length prefixes; `u64` values are unsigned little-endian integers. JSON is only
the transport/debug representation and is never signed.

Field order is part of the protocol:

```
Quote {
  purpose: vector<u8>,        // UTF-8 "m2m/quote/v1"
  network: vector<u8>,        // UTF-8 chain identifier reported by Sui
  package_id: address,
  deployment: address,        // immutable Domain object ID
  buyer: address, provider: address, // Agent object IDs
  buyer_key: vector<u8>, provider_key: vector<u8>,
  refund: address, payee: address,
  nonce: u64,                 // buyer Agent's next_nonce
  request_hash: vector<u8>, result_hash: vector<u8>, // exactly 32 bytes
  amount: u64,                // MIST; only 0x2::sui::SUI
  quote_expires_ms: u64,
  deadline_ms: u64,
}

Acceptance {
  purpose: vector<u8>,        // UTF-8 "m2m/accept/v1"
  network: vector<u8>,
  package_id: address, deployment: address,
  escrow: address,
  quote_hash: vector<u8>,     // BLAKE2b-256(BCS(Quote))
  result_hash: vector<u8>,
}
```

`request_hash` is BLAKE2b-256 of the concatenation of UTF-8
`m2m/fixture.get/v1\0` and the expected file's 32-byte hash. This deliberately
describes a single immutable fixture, not arbitrary paths or executable requests.

The immutable Domain identifies one deployment and its network. Clients verify
that its declared network equals the RPC's chain identifier and that its package
is the configured package. Agents belong to that Domain. Funding constructs Quote
from live Agent data and verifies the provider signature, controller authority,
exact coin value, hash/key lengths, nonce, and chain deadlines. Agent keys are
snapshotted in the escrow; rotation affects future funding only.

## Economic states and replay

Funding consumes the buyer's next nonce and stores `nonce -> escrow ID` in its
onchain table atomically with the deposit. A duplicate cannot create another
deposit, including after a process loses the original transaction reply. An
escrow retains its quote and terminal state permanently in this experiment.

Settlement before `deadline_ms` requires the buyer key's valid acceptance and
the quoted result hash. It transfers the full escrow to the fixed payee. At or
after the deadline, anyone can trigger refund to the fixed refund address.
Neither transaction submitter can redirect funds. A terminal escrow cannot
transition again. Chain time governs the boundary, including races.

The buyer may withhold acceptance after delivery, and a provider may fail to
submit a valid receipt before expiry. Known counterparties and test funds are
assumed. This is not fair exchange or proof of arbitrary service quality.

## Transport and recovery

Use Iroh ALPN `m2m/fixture/1`. Each bidirectional stream carries one bounded JSON
request and one response, with stream FIN marking the frame end. Reject unknown
fields/versions and frames over the limit. The peer's Iroh identity must match
the registered key for new quotes, or the escrow's key snapshot for existing
work. A ticket supplies routing information, never authorization.

Persist a buyer request before obtaining its quote, the quote before funding,
and acceptance before sending it. Resolve a lost funding reply using the onchain
nonce mapping. Providers persist result bytes before delivery. Both sides query
escrow state after uncertain settlement and expose pending/unknown outcomes when
RPC fails. A retry uses the original request and escrow; it never invents a new
nonce or assumes success from a transport disconnect.

CLI state directories contain private operational keys and job records. Keep
them outside version control, restrict file permissions, and lock each state
directory so concurrent commands cannot overwrite a pending purchase.

The transport schema is [exchange-v1.schema.json](../schemas/exchange-v1.schema.json).
Frames are limited to 1 MiB; fixture files to 64 KiB. Wire `u64` values use exact
decimal strings, with range and canonical-format checks in the Rust decoder.
Peer failures return `request_failed` plus a diagnostic message. Do not derive
economic status or retry authorization from diagnostic text; reconcile chain
state. Requests time out, and a failed RPC produces an error/unknown outcome.
The serial provider is intended for known peers, not a public production service.

See the [quickstart](QUICKSTART.md) and [validation record](VALIDATION.md) for
commands, measured behavior, and remaining limitations. The reference client uses
a TypeScript subprocess with the official Sui gRPC SDK for chain operations;
transport and application signing are Rust/Iroh. This boundary is an implementation
choice and is not part of the wire protocol.

The small `ServiceHandler` interface in `src/service.rs` supplies the advertised
artifact hash and result bytes. The included `FixedFile` handler has no chain or
network dependency. The provider verifies its output before persisting and
delivering it. This interface covers only the fixture operation; arbitrary tool
parameters and service acceptance policies require a separately designed profile.
