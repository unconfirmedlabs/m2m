# Native streaming v1 contract

Status: experimental implementation contract frozen before implementation on
2026-09-11. This new `m2m_streaming` Move package and `sui.streaming.v1` method
do not alter the legacy escrow or `sui.channel.v1` bytes or agreement rights.
The workflow is a buyer coordinator consuming a provider's bytes, records, or
multi-counter service under one SUI deposit. The measurable target is reusable
accounting and bounded incremental prepayment with no per-unit chain transaction.
It does not establish demand or truthful service metering.

## Authority and immutable terms

`identity::Domain { id: UID, network: vector<u8>, package_id: address }` is
immutable. `network` is the full chain identifier (1–64 UTF-8 bytes); package_id
is the original package defining Domain. A shared
`Agent { id: UID, deployment: ID, controller: address, transport_key: vector<u8>,
economic_key: vector<u8>, generation: u64, expires_ms: u64 }` has one active
transport key and one economic key, both 32 bytes and unequal. Registration and
key replacement require an expiry later than the chain clock. Replacement and
controller transfer require the current controller; each increments generation.
Transport and economic rotation are independent. Controller transfer preserves
the current operational keys until explicitly replaced. Admission checks fresh
Agent state; expiry or later rotations do not revoke funded channel snapshots.

Only the live buyer controller can fund. The offer snapshots both economic keys,
buyer controller as refund destination, and provider controller as payee. Funding
requires both Agents live, distinct, and in the Domain; a provider economic
signature; exact coin value; and a previously unused buyer opening nonce. A
permanent dynamic field `channel::OpeningKey { nonce: vector<u8> } -> ID` on the
buyer records the Channel. Its nonce is not removed after termination. Unknown
funding results must reconcile this exact mapping before retrying.

## Canonical bytes

Raw Ed25519 signs exact BCS structs, without Sui transaction or personal-message
intent. H is BLAKE2b-256 with 32-byte output. `bytes` is BCS `vector<u8>`; `address`
is 32 fixed bytes; `u64` is little endian; vectors have ULEB128 lengths. JSON uses
full lowercase `0x` plus 64 hex digits, canonical decimal strings for u64, and
integer byte arrays. Reject unknown fields, malformed lengths, and noncanonical
integers. Hashes, nonces, and keys are 32 bytes; signatures are 64 bytes.

All economic statements have this flat ordered prefix P:

```text
purpose: bytes, method: bytes, version: u8, network: bytes,
package_id: address, deployment: address, buyer: address, provider: address
```

`method = UTF8("sui.streaming.v1")`, `version = 1`. Each purpose below is UTF-8.
Types concatenate P with their suffix exactly in this order:

| Type | Purpose | Ordered suffix |
|---|---|---|
| Offer | m2m/streaming/offer/v1 | buyer_key: bytes, provider_key: bytes, refund: address, payee: address, opening_nonce: bytes, policy_hash: bytes, deposit: u64, offer_expires_ms: u64, work_deadline_ms: u64, claim_deadline_ms: u64 |
| Credit | m2m/streaming/credit/v1 | channel: address, offer_hash: bytes, sequence: u64, request_sequence: u64, request_hash: bytes, previous_checkpoint: bytes, units: vector<u64>, cumulative_amount: u64 |
| Ack | m2m/streaming/ack/v1 | channel: address, offer_hash: bytes, credit_hash: bytes, sequence: u64 |
| Checkpoint | m2m/streaming/checkpoint/v1 | channel: address, offer_hash: bytes, credit_hash: bytes, sequence: u64, request_sequence: u64, request_hash: bytes, previous_checkpoint: bytes, units: vector<u64>, cumulative_amount: u64, output_hash: bytes, final: bool |

The provider signs Offer, Ack, and Checkpoint; the buyer signs Credit. `final`
means provider consent to permanently close at these delivered counters, not
buyer judgment of the output. `Signed<T> = { payload: T, signature: number[] }`.
H(BCS(statement)) excludes its signature. Initial previous_checkpoint is 32 zero
bytes; later credits bind the latest verified persisted checkpoint hash.

```text
Policy {
  purpose: bytes,              // UTF8("m2m/streaming/policy/v1")
  version: u8,                 // 1
  units: vector<vector<u8>>,   // 1–8 distinct unit names
  rates: vector<u64>,          // same length; zero rates and free policies allowed
  denominator: u64            // positive common denominator
}
PricingPolicy { id: UID, policy: Policy }
```

Unit names are 1–64 ASCII `[a-z0-9._/-]` bytes, and have immutable service-defined
meaning including the meter/evidence convention in the agreed name/version.
Rates can be zero for nonbillable counters, including an entirely free policy.
A funded free channel closes at zero and refunds its entire residual; free core
messaging does not need a channel or deposit. Zero-value credits are valid but
cannot create a positive unilateral redemption. The amount in MIST is
`ceil(sum(units[i] * rates[i]) / denominator)`. Every product and the sum must fit
u128; the rounded quotient must fit u64. Use quotient/remainder rounding to avoid
overflow in `sum + denominator - 1`. Rounding is applied once to cumulative
quantities, never separately per increment or dimension. Policy creation and
funding reject unknown versions or unsupported dimensions. A channel stores the
entire policy; `offer.policy_hash = H(BCS(Policy))`. Immutable PricingPolicy objects
are optional reuse helpers, not replaceable references that can alter a channel.

This implementation registers the following policy-v1 unit meanings. A peer
must reject a unit whose meter/retry/cache rules it does not implement before
funding; accepting arbitrary spellings is a codec capability, not meter support.

| Unit | Exact meter and retry/cache rule |
|---|---|
| input_utf8_bytes | Length of the exact UTF-8 application request bytes dispatched once for a request hash. Replays add zero; a new request, including a cache-served request, counts its own input once. |
| output_utf8_bytes | Length of exact UTF-8 response bytes durably checkpointed for delivery, cumulative across requests. Replay of saved output adds zero; cache-served new requests count their delivered output. Backend generated but undelivered bytes do not count. |
| bytes/v1 | Length of exact opaque bytes durably checkpointed for delivery. Saved delivery replay adds zero; a new delivery request counts bytes even when served from cache. |
| records/v1 | Number of complete service records durably checkpointed for delivery. Each selected service fixes its record framing before funding. Replay adds zero; a new request for a cached record counts that delivery once. |

Input and output token usage from a backend is separate evidence and is not
converted from these byte counters. A new meter, framing, or cache rule requires
a different agreed unit name/version; a runtime must not reinterpret it mid-channel.

## Onchain transitions

```text
Channel {
  id: UID, offer: Offer, policy: Policy, funds: Balance<SUI>,
  redeemed_amount: u64, redeemed_sequence: u64, redeemed_units: vector<u64>,
  status: u8, terminal_tx: vector<u8>, close_hash: vector<u8>
}
```

Status is 0 OPEN, 1 CLOSED, 2 REFUNDED. Funding requires
`now < offer_expires_ms < work_deadline_ms < claim_deadline_ms`, a claim grace of
at least 10 seconds, and at most one hour from funding to claim deadline.

Credit must bind the Channel and Offer; sequence and request_sequence are positive;
its cumulative amount must equal the policy price and not exceed the deposit.
Permissionless `redeem` verifies the snapshotted buyer signature before the claim
deadline. The sequence must exceed redeemed_sequence, every unit counter must be
at least redeemed_units, and amount must exceed redeemed_amount. Only the delta
is paid to the fixed payee. Credit is advance authorization: Move does not prove
delivery, request validity, or a truthful meter. A compromised economic key may
authorize the remaining original deposit until the claim deadline.

Permissionless `close_exact` verifies an existing buyer Credit plus a provider
Checkpoint with `final = true`, matching channel, offer, credit hash, credit
sequence, request sequence/hash, and prior checkpoint. Checkpoint counters must
be componentwise within Credit ceilings; its amount must equal the policy price.
It may pay zero. Its sequence must be at least redeemed_sequence and its amount
at least redeemed_amount; exact close cannot claw back a previously redeemed
advance. It pays the remaining usage delta and refunds residual funds, records
H(BCS(Checkpoint)), and permanently closes. No new buyer acceptance signature is
required. The provider must durably freeze its one final checkpoint before sending
it; neither party issues further credit/delivery after freezing.

At or after claim_deadline, permissionless `refund` returns only remaining funds
to the fixed refund address and permanently marks REFUNDED. Close and redemption
are valid strictly before that boundary; refund is valid at or after it. Terminal
objects and opening nonce mappings remain queryable. While open,
`funds + redeemed_amount = deposit`; at termination,
`total_paid + total_refunded = deposit` excluding gas.

## Durable offchain engine

One writer per role/channel and one active request are supported. Credit sequence
starts at one and increments for each renewal; request_sequence starts at one and
changes only for the next request. Within a request, request_hash remains fixed.
Both the buyer's signed Credit and provider's signed Ack are atomically persisted
before transmission/acknowledgement. A renewal must reference the latest checkpoint,
be monotonic in all unit ceilings, and cover delivered units. A byte-identical
credit retry returns its saved Ack; changed content at the same sequence fails.
No gaps, reused request hashes for a new sequence, or concurrent requests exist.

The provider checks cumulative metering events against all acknowledged ceilings
and persists signed checkpoints/output before exposing output. The buyer verifies
the economic signature, exact bindings, cumulative price and monotonic delivered
counters before persisting receipt. Repeated identical checkpoints are idempotent;
conflicts fail. Insufficient credit pauses output. Meter adapters report actual
usage, including any backend work generated before cancellation; generated but
undelivered work may exceed the authorized window and is the provider's exposure.

On reconnect, replay persisted credit/ack/checkpoint records and reconcile chain
status and current authorization before new work. A checkpoint can be replayed
after deadlines or terminal state because replay does not authorize execution.
A channel journal missing/corrupt/containing uncertain backend dispatch must not
invent previous state or automatically rerun external work. The engine exposes
durable records; its caller owns chain freshness, process locking, transport
admission, backend dispatch reconciliation, and storage retention. Provider usage
and output hashes authenticate claims, not execution correctness or usefulness.

## Compatibility and validation

No conversion from existing endpoint signatures into economic signatures is
defined. Old agreements retain their old verifier, key snapshots, and deadlines.
New participants register separate keys in the new package and negotiate this
method explicitly; unsupported mandatory method/policy versions fail before funding.

The tests exercise bytes and records policies, multi-counter rounding, overflow,
signatures and tampering, replay, credit gating, durable restart, duplicate opening,
rotation, exact close, unilateral redemption, deadline races, and conservation.
Local tests are technical evidence only; live deployment and cross-process evidence
must be recorded separately. The Sui toolchain is pinned by `scripts/sui.sh` to
1.79.0 and the SDK by package.json; implementation relies on the bundled upstream
Sui framework source for Ed25519 verification, BCS, dynamic fields, and balances.

Checked 2026-09-11 against the framework revision pinned in
[`Move.lock`](../move/streaming/Move.lock),
`ae59d7718668b468ce65702ecb0440aa2330f389`: the verifier accepts explicit message,
signature, and public-key byte vectors
([Ed25519 source](https://github.com/MystenLabs/sui/blob/ae59d7718668b468ce65702ecb0440aa2330f389/crates/sui-framework/packages/sui-framework/sources/crypto/ed25519.move));
typed dynamic fields support the permanent nonce mapping
([dynamic-field source](https://github.com/MystenLabs/sui/blob/ae59d7718668b468ce65702ecb0440aa2330f389/crates/sui-framework/packages/sui-framework/sources/dynamic_field.move));
balance split/withdraw provides delta payment and residual refund
([balance source](https://github.com/MystenLabs/sui/blob/ae59d7718668b468ce65702ecb0440aa2330f389/crates/sui-framework/packages/sui-framework/sources/balance.move)).
These are implementation pins, not a claim about a future framework release.

Local validation recorded 2026-09-11:

| Command | Observed result |
|---|---|
| `bash scripts/sui.sh move test --path move/streaming` | 29 passed: independent Move reconstruction of the signed Offer/Credit/Checkpoint vectors, pricing boundaries, live entry rejection paths, authority rotation, duplicate funding, redemption/refund, free and paid exact-close conservation. |
| `npx tsx scripts/test-streaming-codec.ts` | Passed independent Node Buffer BCS versus SDK encoding, raw Ed25519 verification, wrong domains/roles/tampering, strict parsing, bytes/records/multi-counter/free pricing and overflow. |
| `npx tsx scripts/test-streaming-engine.ts` | Passed durable authorization/ack/output ordering, exhausted credit, replay conflicts, restart after lost checkpoint, request-versus-credit sequences, final freeze, corruption rejection, bytes/records/free services. |
| `npx tsc --noEmit` | Passed with the new codec and engine. |

The public deterministic vectors are generated by
[`test-streaming-fixtures.ts`](../scripts/test-streaming-fixtures.ts), checked
independently by the codec test, and reconstructed in Move. To inspect their
hashes and signatures, run the codec test with `--print-vectors`. Seeds are public
test-only data and must never hold funds. State-machine Move tests use test-only
signature-free transition helpers alongside separate real signature vectors;
live PTB tests are needed to establish the complete published entrypoint path.
