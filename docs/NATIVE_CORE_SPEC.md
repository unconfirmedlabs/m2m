# Native communication core v1

Status: implementation contract for issue #1, 2026-09-11; experimental, not a
released interoperability standard. This implements the accepted scope in
[the implementation plan](NATIVE_IMPLEMENTATION_PLAN.md). Legacy escrow/channel
ALPNs, Move types, signatures, and funded rights are unchanged.

## Participants, authority, and trust

A known coordinator contacts a known independently operated service, invokes
parameterized unpaid operations, and retries after losing a reply. The measurable
baseline failure is that the existing fixture requires an economic agreement to
authenticate/deliver any application request. Native admission requires no deposit.
This experiment establishes behavior, not customer demand.

`AgentRef` is the ordered BCS struct `(network: vector<u8>, package_id: address,
domain: address, agent: address)`. Network is nonempty UTF-8, at most 64 bytes;
the addresses are full 32-byte Sui addresses. An object ID or routing ticket alone
does not select a network, deployment, accepted object type, or authority.

A trusted `Resolver` independently supplies `Authorization`: qualified Agent,
controller address, transport and economic Ed25519 public keys (32 bytes each),
generation, `read_at_ms`, and `valid_until_ms`. Keys MUST differ. The caller must
pin the trusted chain/RPC, package/domain and supported Agent type. A peer's
self-reported snapshot is not an authority source. Resolution cannot silently
fall back to an expired cache: `read_at_ms <= now < valid_until_ms`, with both
maximum snapshot age and maximum lease duration 30,000 ms. Timestamps are Unix
milliseconds supplied by the embedder's clock. Clock rollback fails closed.

One active transport endpoint and one state writer per Agent are supported.
The controller may replace keys or retire an Agent through its identity binding;
the resolver rejects retired/missing/wrong-type records. New sessions and each
application exchange resolve both Agents again. Generation/key changes invalidate
the session. Cached chain observations imply at most the stated 30-second
revocation delay plus trusted RPC correctness; snapshots are not light-client proofs.
Controller transfer/recovery policy belongs to the identity binding; its generation
change requires a new session. The core does not invent a recovery authority.
Multi-writer delegation is unsupported here.
Endpoint rotation preserves Agent identity and requires transfer of its durable
journal; it does not transfer memory or alter old payment agreement rights.

Iroh authenticates endpoint keys and encrypts traffic. Core signatures authenticate
statements; neither establishes application correctness or spending permission.
Storage durability depends on the local filesystem. A lying endpoint, disk loss,
compromised controller, untrusted RPC, relay outage, or application side effect
cannot be repaired by a delivery signature. Payloads remain untrusted application
input. Network reads, frame/payload sizes, journal size, sessions, and dispatch
are bounded; applications must separately bound their own work.

## Encoding and signatures

ALPN is the exact bytes `m2m/core/1`; there is no downgrade to a legacy ALPN.
Each frame is a 4-byte unsigned big-endian JSON byte count, followed by exactly
that many bytes. Length 0 or length above 1,048,576 is rejected before allocation.
The Rust core endpoint uses 10-second frame/admission timeouts. The TypeScript
composition's raw Iroh bridge uses a 30-second connect timeout and 180-second
accept/frame bounds; signed message expiry and authority freshness are still
checked independently. These are implementation resource limits, not negotiated
extensions of message validity. There is one bidirectional stream per admitted
session, no cross-stream ordering guarantee, and at most one
outstanding exchange on that stream. Both connection roles may send requests.
The reference endpoint permits one remotely opened bidirectional stream, no
unidirectional streams, and caps stream/connection receive windows at 1 MiB + 4
and 2 MiB + 8 bytes. The host handles one session at a time; connection-flood
admission policy remains an operator responsibility.

JSON structures reject unknown and duplicate keys. `u64` values are canonical
decimal strings (`0` or `[1-9][0-9]*`, at most 18446744073709551615). Addresses
are `0x` plus exactly 64 lowercase hexadecimal digits. Byte vectors are JSON
arrays of integers 0..255; IDs and hashes are exactly 32 bytes and Ed25519
signatures exactly 64. Null correlation is required when absent.

Every frame is a `SignedEnvelope`: `{ "message": Envelope, "signature": [..] }`.
Ed25519 signs the BCS encoding of `Envelope`, without a hash prepass. Its exact
verification requires a canonical scalar S, and canonical, nonzero prime-order
public keys and R points, followed by the strict Ed25519 verification equation.
The Rust implementation checks these points explicitly then uses `verify_strict`.
ZIP215's broader acceptance is not the core verification policy. Its exact field
order/types are:

1. `purpose: vector<u8>` = UTF-8 `m2m/core/message/v1`.
2. `sender: AgentRef`, `recipient: AgentRef`.
3. `generation: u64` (sender transport authorization generation).
4. `id: vector<u8>` (32 fresh random bytes).
5. `correlation: option<vector<u8>>` (null or 32 bytes).
6. `created_ms: u64`, `expires_ms: u64`.
7. `kind: string` (ASCII, at most 128 bytes).
8. `payload: vector<u8>` (at most 65,536 bytes).

BCS vectors/strings use ULEB128 byte/item counts; addresses are 32 raw bytes;
u64 is little endian; option is length 0/1 followed by its value. The exact payload
bytes are signed. Core payloads are UTF-8 JSON parsed directly into strict typed
structures; semantic reformatting is not signature-preserving. No canonical JSON
assumption is required. Creation must not be in the future; expiry is exclusive,
after creation, and at most 86,400,000 ms later.

## Admission state machine

The connector opens the sole stream and sends `core.hello` with payload
`{challenge: bytes32, required: [feature], optional: [feature]}`. Lists are sorted,
unique, disjoint, each at most 16 names; a feature is nonempty ASCII `[a-z0-9._/-]`,
at most 96 bytes. Mandatory core behavior cannot be negotiated away.

The acceptor verifies fresh authority and the actual Iroh `remote_id`, signature,
sender/recipient, and expiry. It replies `core.welcome`, correlated to hello ID:
`{hello_hash: bytes32, challenge: bytes32, required: [...], optional: [...],
selected: [...]}`. `hello_hash` is BLAKE2b-256 of hello's BCS Envelope.
`selected` MUST be the sorted intersection of both advertised feature sets, and
MUST contain every required feature from both parties. Missing requirements fail
closed. Both sides independently calculate this selection.

Session ID is BLAKE2b-256 of BCS `(purpose: vector<u8> =
"m2m/core/session/v1", hello: Envelope, welcome: Envelope)` in connector order.
It commits to both Agents, generations, fresh challenges, complete offers, and
the selection. The connector sends `core.confirm`, correlated to welcome ID,
with `{session: bytes32}`; the acceptor replies `core.ready`, correlated to
confirm ID, with the identical payload. Both verify all signatures and bindings.
Application dispatch becomes legal only after confirm is checked / ready received.
Hello replay cannot complete admission without signing a fresh transcript.

Before admission, authenticated negotiation rejection may be a signed `core.error`
correlated to the offending envelope. Unauthenticated, malformed, expired, or
misbound traffic closes the connection; no trusted error or non-execution claim
is implied. Session timeout/disconnect leaves application outcome uncertain.

## Established messages and applications

Every established payload starts with an explicit `session` hash checked against
the admitted transcript. Sender/recipient/generation and actual transport are
also checked on every receive. Envelope IDs are independent of sessions.

| Kind | Strict payload fields | Meaning |
|---|---|---|
| `agent.describe` | `session` | Ask for this peer's service descriptions |
| `agent.description` | `session`, `services` | Advertisements, not grants |
| `message.send` | `session`, `service`, `content_type`, `content` (bytes) | Parameterized request; optional correlation supports replies |
| `message.receipt` | `session`, `message_id`, `commitment`, `state`, `result` (nullable bytes) | Durable acceptance and separately recorded local dispatch status |
| `core.error` | `session` (nullable), `code`, `detail` | Typed failure; diagnostic text grants no authority |
| `extension.<feature>` | `session`, `content` (bytes) | Payload delivered only when exact feature was selected |

Description entries are `{id, description, input_media_type, output_media_type}`.
Built-in unpaid handlers are `echo` (returns supplied bytes, media type
`application/octet-stream`) and `blake2b-256` (returns 32 raw digest bytes).
`ServiceHandler` accepts verified sender context and parameterized input; its
registration/local policy governs invocation. No channel types are imported.
Extension dispatch is an embeddable handler interface; an economic extension must
validate its own economic signatures, terms, state and durable accounting.

Error codes: `invalid_message`, `unauthorized`, `stale_authority`,
`unsupported_feature`, `message_conflict`, `expired`, `overloaded`,
`unknown_service`, `uncertain_dispatch`, `storage_failure`, `internal`.
Only `overloaded` is a safe automatic retry indication before durable admission.
For every timeout/other failure, resend the identical logical request to recover
its durable status; an error is never evidence of non-execution or non-payment.

## Delivery and persistence

Replay key is `(sender AgentRef, message ID)` in the recipient Agent's journal.
Logical commitment is BLAKE2b-256 of BCS `(purpose =
"m2m/core/logical/v1", sender, recipient, id, correlation, created_ms,
expires_ms, kind, logical_payload)`. For established payloads, logical_payload
is the BCS typed payload with `session` removed. Thus session IDs and transport
generation/signature may change on reconnect/rotation while the logical message
does not. Core request content, media type, service and timestamps remain bound.
Extensions commit to their exact content bytes, not an interpreted JSON object.

Before invoking an application, persist `accepted` and its commitment, then persist
`dispatching`. On success persist `completed` plus bounded result before sending
a receipt. A receipt distinguishes these states and is neither application quality
acceptance nor payment. An identical retry returns the saved state/result and never
re-dispatches. Changed logical content returns `message_conflict`. Recovered
`dispatching` means `uncertain_dispatch`: application reconciliation is required;
the runtime never guesses completion or repeats potentially external effects.
Recovered `accepted` is likewise returned without implicit dispatch; the embedder
may reconcile explicitly. Application failures after dispatch persist `uncertain`.

Journal writes use exclusive process locking, private permissions, fsync of file,
atomic rename and directory fsync. Missing/corrupt existing records fail closed.
Initial default limits are 1024 inbox records, 16 MiB serialized journal, and
65,536-byte request/results. Records are retained permanently within those bounds;
there is no silent eviction, and overload rejects new IDs before acceptance.
Expired messages are rejected even if a retained record exists. Disk loss has no
automatic recovery guarantee. A lock only coordinates one local filesystem;
operators must not start independent journals for one Agent.

This provides bounded durable duplicate suppression, not exactly-once effects.
The sender must persist its own original envelope before writing if it needs
restart retry; the embeddable outbox provides save/read with conflict checks.

## Upstream binding and conformance status

Iroh is pinned to 1.2.0 in Cargo. Checked 2026-09-11 against the installed upstream
1.2.0 source (`Endpoint::connect`, `Connection::remote_id`, `open_bi`, `accept_bi`)
and the [Iroh endpoint documentation](https://docs.iroh.computer/concepts/endpoints).
The version-specific docs.rs pages were unavailable during the check; local pinned
upstream source is the implementation authority. [Iroh's connection example](https://github.com/n0-computer/iroh/blob/v1.2.0/iroh/examples/connect.rs)
shows explicit ALPN and authenticated connection/stream use.

Rust tests and published vectors accompany this implementation. `cargo test
--test native_core` includes real direct-Iroh exchanges with an independently
implemented TypeScript parser, encoder, and state machine through the raw framing
bridge, plus service, signature, replay, and mandatory-feature rejection cases.
Live Sui identity resolution and streaming-extension conformance remain separate
integration evidence; a second encoder alone is not full peer conformance.

## Reproducible checks and remaining limits

Run `npm ci`, `cargo test --locked --test native_core`, and
`cargo run --quiet --bin native-core -- vectors`. The cross-language tests require
Node with the repository's `tsx` dependency and local UDP connectivity; they need
no RPC, funds, relay, model backend, or external application credentials.

| Requirement | Automated evidence |
|---|---|
| Qualified authority, separate keys, leases, signed envelope strictness | `strict_encoding_signature_authority_and_bounds` |
| Exact feature selection and transcript binding | `feature_negotiation_rejects_downgrades_and_ambiguous_lists`, `signed_welcome_must_bind_exact_hello_and_feature_selection` |
| Bounded stream framing | `malformed_frame_lengths_rejected_before_body_read` |
| Durable acceptance, uncertain dispatch, duplicate/conflict, limits, disk loss | `durable_restart_uncertain_dispatch_conflicts_and_capacity` |
| Symmetric free service dispatch, descriptions, saved outbox, real reconnect | `real_iroh_unpaid_services_symmetric_exchange_and_restart_retry` |
| Negotiated extension uses the same generic inbox | `negotiated_extension_uses_same_unpaid_delivery_engine` |
| Independent parser/encoder/peer over Iroh | `independent_typescript_peer_over_real_iroh` |
| Both independent peer processes restart, reconnect, and recover one saved logical request | `independent_peers_restart_both_processes_and_recover_saved_request` |
| Published signatures, decoded message bodies, and linked commitments | `published_vectors_verify_and_bind_handshake_and_receipt` |

This PoC does not claim exhaustive malformed-input fuzzing, interoperable storage
formats, instantaneous chain revocation, distributed writers, unbounded retention,
automatic external-effect reconciliation, or a released standard. Disk durability
is checked through journal reopen/corruption/loss paths; power-failure injection
on real storage hardware is separate evidence.
