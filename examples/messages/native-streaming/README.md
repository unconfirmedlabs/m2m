# Experimental native streaming wire corpus

These are deterministic, signed examples of `payment.sui.streaming.v1` carried
over the native `m2m/core/1` envelope. They use synthetic Agent references,
`test-vector` network, generation zero, and time `1800000000000` ms. They do not
represent a deployed channel, current authority, a live Codex response, or a
submitted settlement. All keys are public test keys; economic seeds match the
streaming unit-test fixtures, and separate transport seeds keep their authority
distinct. No credentials, operator keys, or private payloads are included.

The [streaming contract](../../../docs/STREAMING_V1_SPEC.md),
[research binding](../../../docs/NATIVE_RESEARCH_SPEC.md), and
[core contract](../../../docs/NATIVE_CORE_SPEC.md) define the implemented meanings.
The corpus is separate from legacy escrow/channel examples and from live evidence.

Run from the repository root:

```sh
npx tsx scripts/native-streaming-examples.ts --check
```

This verifies 32 complete signed core envelopes; the matching hello/welcome/session
transcript; every economic statement's signature and exact BCS bytes; full schema
validation; and engine/service transitions for credit, start, exhaustion, renewal,
final consent, replay, cancellation, and expected rejections. Python `jsonschema`
is required, as for the existing message-example checks. Use `--write` to
regenerate the public artifacts. The check starts neither a chain client nor
Codex; it uses a deterministic worker and temporary public-data journals.

`vectors.json` records envelope filenames, purposes, public keys, exact BCS bytes,
hashes, correlation references, and expected branch results. For each wire file,
`.body.json` decodes `message.payload`; `.content.json` additionally decodes the
extension content or receipt result. These companion files are diagnostic views,
not extra fields sent on the wire. The standalone [economic statements](economic-statements.json)
include Offer, Credit, Ack, and Checkpoint (ordinary and final) with their independent
economic signatures. `settlement-witness.json` contains the existing buyer Credit
and provider final Checkpoint used by `channel::close_exact`; it is explicitly an
unsubmitted transaction input artifact, not another wire message or chain receipt.

| Files | Meaning and runtime path |
|---|---|
| `00`–`03` | Hello, welcome, confirm, ready with matching challenges, feature selection, qualified parties, and session hash. NativePeer performs this admission. |
| `10-offer`, `11-funded` | Offer request/response and funding notice/response shapes emitted and handled by `native-demo.ts`. Their chain state is synthetic in this corpus. |
| `12-credit`, `13-start` | Buyer credit, provider durable Ack, and explicit backend start. Responses are produced by the actual ResearchService and StreamingEngine with a deterministic worker. |
| `14-delivery`, `15-exhausted` | A signed 32-byte delivery checkpoint consumes the initial output ceiling; the next poll returns `waiting/credit_exhausted`. No further output is released. |
| `16-renew`, `17-final` | Renewal binds the previous checkpoint; the next delivery carries provider final close consent at exact measured usage. The buyer supplies no new answer-acceptance signature. |
| `20-identical-credit-replay` | The same logical core request is served from NativeInbox's saved receipt; a dispatch counter verifies it does not execute twice. |
| `21-final-frozen-output-replay` | A new poll recovers previously persisted output and its original economic signature after the provider has frozen its final checkpoint. This checks saved service records, not a live chain reconnect. |
| `30-cancel-before-start`, `31-cancelled-final` | An alternative history branching immediately after `12-credit`: cancellation is confirmed before dispatch, followed by zero-unit final consent and zero exact usage charge. |
| `40-economic-signature-tamper` | Valid outer transport signature, invalid inner economic signature. Core admission must not grant spending authority. |
| `41-core-signature-tamper` | Invalid outer signature, rejected before application dispatch. |
| `42-core-conflicting-replay` | Validly signed changed content reuses an existing logical ID; NativeInbox rejects the conflict. |
| `43-credit-after-final` | A valid next economic credit is rejected by the provider's durably frozen channel engine. |

The main and cancellation histories are mutually exclusive. They intentionally
reuse synthetic parties/channel IDs to show alternative outcomes; their final
checkpoints must never be combined into one real channel history. Negative cases
are labeled in the manifest and must not be treated as successful examples.

The [streaming schema](../../../schemas/native-streaming-v1.schema.json) strictly
validates decoded command/response shapes and economic statements, including the
full decimal u64 range and rejection of extra fields. The
[core schema](../../../schemas/native-core-v1.schema.json) validates the full
outer envelopes and decoded core bodies. Runtime checks additionally enforce
signatures, BCS/domain references, UTF-8 byte limits, price equations, unit-vector
alignment, authority, and state transitions; schema acceptance alone proves none
of those properties. Fixture generation exercises the service/engine paths named
above. Process restart, real Iroh transport, live chain settlement, and Codex meter
observations require their separately recorded integration evidence.
