# Signed cumulative channel PoC specification

Status: implementation contract, 2026-09-10. User-authorized extension of the
[settlement-method proposal](SETTLEMENT_PROFILES.md); implementation and measured
results must be recorded separately. MUST, MUST NOT, and SHOULD are normative for
this experimental profile. The [implementation plan](CHANNEL_IMPLEMENTATION_PLAN.md)
assigns ownership and acceptance tests.

## Scope and compatibility

One buyer purchases ten sequential fixed-file jobs from one known provider using
one SUI deposit and one cooperative close. Iroh carries signed payment messages
and file bytes; Sui enforces collateral, cumulative redemption, close, and refund.
There is no ZK prover, inference dependency, top-up, multi-provider balance,
bidirectional channel, third-party adjudication, or general task framework.

The core vocabulary distinguishes payment, work, and session messages. The
optional method is exactly `sui.channel.v1`, version `1`, on a new Iroh ALPN
`m2m/payment/1`. Selecting it commits both parties to this specification. Unknown
methods/versions fail before funding; there is no automatic method fallback.
The existing `m2m/fixture/1` ALPN, escrow Move types and entry signatures,
`Quote`/`Acceptance` BCS bytes, nonce table, and JSON semantics remain unchanged.
Deploy a new experimental package/Domain; preserve the previous deployment and
evidence. Move types stay in `exchange`; the new module is `channel`.

The measurable improvement is two economic transactions for ten jobs, excluding
deployment/registration and exceptional redemption/refund, with zero RPC calls
in the established session's ten-job interval. This does not validate demand.

## Authority and trust

The buyer controller funds a channel. The provider controller is its fixed payee;
the buyer controller is its fixed refund destination. Agent IDs identify actors;
their endpoint keys authenticate Iroh peers and sign application messages. The
transaction gas signer has no authority to change destinations or amounts.
Endpoint keys are snapshotted at opening: rotation changes future channels, while
existing authority lasts only for the original deposit and claim deadline.

A credit is **prepayment authorization**. The provider can redeem it without
proving delivery. Honest buyer software allows only one unpaid-for-in-results
job at a time: after issuing one credit it verifies and durably records that
job's exact file before issuing another. Thus outstanding unfulfilled credit is
at most one unit price. Move enforces the deposit, signatures, deadlines, and
monotonic payout; the one-job exposure policy is enforced by the buyer signer,
not by Move. A compromised endpoint can authorize the remaining deposit.
Acknowledgement proves a provider statement of durable receipt, not payout or
quality. Result signatures and hashes authenticate fixture bytes, not arbitrary
computation. A transcript commitment is not a ZK proof or confidentiality guarantee.
Onchain terms, participants, balances, and timing are public. Package upgrade
authority, honest local storage, bounded clock error, and timely chain access
remain explicit trust/availability assumptions.

## Canonical bytes and signed statements

Use the existing raw Ed25519 application-signature rules: sign BCS(struct), with
32-byte public keys and 64-byte signatures, never Sui transaction/personal-message
intents. `H` means BLAKE2b configured for a 32-byte output. `bytes` below means
`vector<u8>` with a BCS length prefix; `address` is 32 fixed bytes. All hashes and
the opening nonce are exactly 32 bytes. All arithmetic is checked `u64` arithmetic.
JSON represents every `u64` as a canonical decimal string; `u8` is a JSON number,
bytes are arrays of integers 0..255, and addresses are normalized 0x + 64 hex
digits. Unknown fields, invalid lengths, noncanonical integers, and unsupported
mandatory values MUST be rejected. Strings in signing purposes are UTF-8 bytes.

The following **flat ordered prefix P** appears first in each of Offer, Credit,
Ack, ResultStatement, and Close. It is not a nested field in JSON or source types:

```text
purpose: bytes,
method: bytes,                 // UTF-8 "sui.channel.v1"
version: u8,                   // 1
network: bytes,                // complete RPC chain identifier, UTF-8, 1..64 bytes
package_id: address,
deployment: address,           // exchange::Domain ID
buyer: address,                // exchange::Agent ID
provider: address,             // exchange::Agent ID
```

For each type concatenate P and its suffix below, in exactly the listed order.
Every receiver checks the complete prefix against the agreement. Signature
verification without checking those bindings is insufficient.

| Type | Exact purpose | Ordered suffix after P |
|---|---|---|
| `Offer` | `m2m/channel/offer/v1` | `buyer_key: bytes, provider_key: bytes, refund: address, payee: address, opening_nonce: bytes, terms_hash: bytes, deposit: u64, offer_expires_ms: u64, work_deadline_ms: u64, claim_deadline_ms: u64` |
| `Credit` | `m2m/channel/credit/v1` | `channel: address, offer_hash: bytes, sequence: u64, cumulative_amount: u64, request_hash: bytes, previous_transcript_hash: bytes` |
| `Ack` | `m2m/channel/ack/v1` | `channel: address, offer_hash: bytes, sequence: u64, cumulative_amount: u64, credit_hash: bytes` |
| `ResultStatement` | `m2m/channel/result/v1` | `channel: address, offer_hash: bytes, request_hash: bytes, credit_hash: bytes, result_hash: bytes` |
| `Close` | `m2m/channel/close/v1` | `channel: address, offer_hash: bytes, final_sequence: u64, final_amount: u64, transcript_hash: bytes` |

The provider signs Offer, Ack, and ResultStatement; the buyer signs Credit. Both
sign exactly the same Close bytes. `Signed<T>` is JSON `{ "payload": T,
"signature": [bytes] }`; a signature is not included in a statement's hash.
`CloseCertificate` is `{ "close": Close, "buyer_signature": [bytes],
"provider_signature": [bytes] }`. Different purposes cannot substitute for one
another even when signed by the same key.

The application and transcript use these complete ordered BCS structures:

```text
FixtureTerms {
  purpose: bytes,               // "m2m/channel/fixture-terms/v1"
  result_hash: bytes,           // H(exact file bytes), <= 64 KiB file
  unit_price: u64,              // > 0 MIST
  max_jobs: u64,                // 1..1000
  max_unfulfilled_jobs: u8,     // exactly 1
}
RequestDescriptor {
  purpose: bytes,               // "m2m/channel/request/v1"
  channel: address,
  terms_hash: bytes,
  request_id: bytes,            // 1..64 ASCII letters/digits/'-'/'_'
  request_sequence: u64,        // starts at 1
}
TranscriptStart {
  purpose: bytes,               // "m2m/channel/transcript-start/v1"
  channel: address,
  offer_hash: bytes,
}
TranscriptStep {
  purpose: bytes,               // "m2m/channel/transcript-step/v1"
  previous_transcript_hash: bytes,
  request_hash: bytes,
  credit_hash: bytes,
  ack_hash: bytes,
  result_statement_hash: bytes,
}
```

`terms_hash = H(BCS(FixtureTerms))`, `offer_hash = H(BCS(Offer))`, and
`request_hash = H(BCS(RequestDescriptor))`. Likewise credit, ack, and result
statement hashes are H of their own BCS. `T0 = H(BCS(TranscriptStart))` and
`Tn = H(BCS(TranscriptStep))` using the preceding completed root and the four
statements for job n. A credit for job n binds `previous_transcript_hash = T(n-1)`.
Raw signatures and JSON ordering do not enter the transcript. This hash scheme
does not reuse the escrow's `m2m/fixture.get/v1` request commitment.

The provider offers FixtureTerms alongside its signed Offer. The buyer requires
the expected file hash, unit price <= its local maximum, the requested job count,
`max_unfulfilled_jobs == 1`, and `deposit >= unit_price * max_jobs`. Any extra
deposit is refunded at close. Move sees the opaque terms commitment; it does not
parse the fixture policy. Defaults are ten jobs, 1000 MIST/job, and 12000 MIST
deposit, demonstrating a 2000 MIST residual refund.

## Opening and Sui state

Before requesting an offer the buyer persists a local session ID, requested
parameters, and a cryptographically random 32-byte `opening_nonce`. Offer retries
with the same buyer/nonce and parameters return the same saved offer; conflicting
parameters fail. An expired unfunded session requires a new explicit session ID,
not silently regenerated terms. The provider persists its offer before sending.

`channel::OpeningKey has copy, drop, store { nonce: vector<u8> }` names a dynamic
field on the buyer Agent UID. Its value is the new Channel's `ID`. Opening MUST
atomically require this field absent, add it, and reserve the exact deposit. It
must never remove or replace that field. This is independent of `Agent.next_nonce`
and `Agent.jobs`. An uncertain open resolves this mapping using its exact type and
BCS key, then compares the entire onchain Offer to the saved offer before any
retry. Only a proven absent dynamic field means absent; RPC failure is unknown.
The same nonce under the same buyer cannot fund a different provider/agreement.

`channel::Channel has key` has this exact ordered storage layout:

```text
id: UID,
offer: Offer,
funds: Balance<SUI>,
redeemed_amount: u64,           // total already transferred to payee
redeemed_sequence: u64,         // highest credit/final sequence enforced onchain
status: u8,                    // 0 OPEN, 1 CLOSED, 2 REFUNDED
terminal_tx: vector<u8>,        // empty while OPEN, TxContext digest when terminal
close_hash: vector<u8>,         // empty except CLOSED: H(BCS(Close))
```

The Channel remains queryable after close/refund; funds are zero at either
terminal state. The opening field also remains. While OPEN,
`funds + redeemed_amount == offer.deposit`. After termination,
`paid_to_payee + refunded_to_buyer == offer.deposit`, excluding gas. Independent
channels mutate their own Channel, not a shared provider balance registry.

Opening reconstructs Offer from live Domain/Agent fields and the supplied scalar
terms, then verifies the provider endpoint signature. It requires the buyer
controller as transaction sender, distinct buyer/provider Agent IDs, matching
deployment membership, valid lengths, absent opening nonce, `deposit > 0`, and a
Coin<SUI> of exactly that value. It checks all these chain-clock conditions:

```text
now < offer_expires_ms < work_deadline_ms < claim_deadline_ms
claim_deadline_ms - work_deadline_ms >= 10_000
claim_deadline_ms - now <= 3_600_000
```

The fixed payee/refund addresses and endpoint snapshots come from the live Agents;
the caller cannot supply alternative authority. Initialize redeemed amount and
sequence to zero, status OPEN, and both digest vectors empty. Quote construction
and transaction submission must use the same exact fields.

## Credits, work, and durable session rules

Admission/open/resume validates the RPC network and Domain, reads the Channel and
chain clock, verifies the saved Offer/terms, and authenticates the remote Iroh key
against its snapshot. A ticket is only routing information. Persist the validated
snapshot and establish a fresh time anchor before permitting new work. A live
connection may use multiple request/response streams without revalidation per
job. After process restart or connection loss, a new session admission MUST
reconcile chain state before new authorization/work; failed reconciliation leaves
state unknown and does not reset sequences or create another channel.

Each role has exactly one writer, protected by the state-directory process lock.
The fixture uses one credit for each job. Request sequence and credit sequence
are different fields with different meanings; this bounded method requires both
to equal n for job n, starting at 1, with no gaps offchain. Credit n has
`cumulative_amount = n * unit_price <= deposit`, n <= max_jobs, and binds that
job's RequestDescriptor hash and preceding transcript. Move can redeem a later
saved credit directly, skipping intermediate redemptions.

For each job:

1. Buyer constructs the descriptor and credit. It MUST finish verification and
   durable storage of job n-1 before issuing n. Persist descriptor and signed
   credit atomically before transmitting; retries send the exact saved statement.
2. Provider verifies the peer, signature, all bindings, next sequence, cumulative
   amount, request uniqueness, time, and preceding transcript. It atomically
   persists the descriptor, credit, and signed Ack before returning the Ack or
   executing work. Ack repeats sequence/amount and commits to that exact credit.
3. Buyer verifies and saves Ack. It requests `work.get` for the saved request hash.
   Provider checks its saved credit, executes the fixed fixture if necessary, and
   validates its output hash/size. Persist bytes, signed ResultStatement, and the
   new transcript root before returning bytes. A retry returns the cached records.
4. Buyer checks the exact expected bytes, result signature and bindings, and the
   computed transcript step. Atomically persist completed job and new root before
   authorizing another job. Repeated delivery never advances the transcript twice.

The provider advances its completed root before delivery; the buyer advances only
after receipt/verification. A lost result therefore creates a recoverable gap:
replay the same credit/Ack and fetch the same cached result. Never guess the new
root or authorize a replacement job. A repeated sequence/request with identical
records returns the saved Ack/result even if newer records exist; conflicting
bytes, request reuse, a skipped sequence, or a second unfulfilled job fail.
Completed jobs, signatures, results, and opening/terminal records are retained
for this PoC. Missing/corrupt journals do not authorize reconstruction by inventing
credits, signatures, or work history.

New credits and new work stop at the work cutoff below. Cached results and Ack
replays remain readable after cutoff/terminal state for authenticated original
peers; they cannot create new credit or execution. A terminal economic result
alone does not establish that all files were received.

## Redemption, cooperative close, and refund

Any gas payer can submit a buyer-signed Credit to `redeem` while status is OPEN
and chain time is strictly before `claim_deadline_ms`. Move reconstructs the full
Credit using immutable channel bindings, verifies the snapshot buyer signature,
and requires `sequence > redeemed_sequence` and
`redeemed_amount < cumulative_amount <= deposit`. It transfers only
`cumulative_amount - redeemed_amount` to the fixed payee, updates both counters,
and leaves status OPEN. A stale/duplicate credit aborts without payment; a client
reconciles state and may report its authorization already covered, rather than
resubmitting for another payout. Request/transcript hashes must have correct
lengths but Move does not claim to verify their offchain semantics.

For cooperative close the buyer first freezes the channel **durably**, recording
its only candidate Close and signature. It MUST stop issuing credits permanently
for this channel. Close has the highest issued sequence/amount and the shared
completed transcript root (T0 and zero/zero when there have been no credits).
Normally the last result has been recovered first. If a final prepaid job remains
unfulfilled, cooperative close is possible only if both local records agree on
the same completed root and highest credit; the prepaid amount is still owed.

The provider serializes Close handling with credit/result handling. It requires
the candidate's highest sequence/amount to equal its highest accepted credit,
and its transcript to equal the provider's completed root. It MUST persist a
frozen state and both signatures before returning `CloseCertificate`. No new
credit or work execution is allowed after either party freezes; cached records
and retransmission of exactly that close remain allowed. Neither process unfreezes
after disconnect, RPC error, or a failed close transaction. A mismatch leaves the
buyer frozen; recover cached work if it brings the same candidate into agreement,
otherwise use the unilateral path. Never sign a second conflicting close.

The buyer persists the certificate before submitting the close transaction. The
provider also retains it and can submit it during recovery. `close` requires
OPEN, chain time < claim deadline, valid signatures by both snapshot keys, correct
domains/hashes, `redeemed_amount <= final_amount <= deposit`, and either:

```text
final_sequence == redeemed_sequence && final_amount == redeemed_amount
or
final_sequence > redeemed_sequence && final_amount > redeemed_amount
```

It pays the unpaid delta, refunds `deposit - final_amount`, sets redeemed counters
to final values, stores H(BCS(Close)) and terminal digest, and transitions to CLOSED
atomically. Zero-valued transfers need not create coins. Signature validity does
not override the monotonic checks: a lower close racing a higher redemption MUST
abort; if close wins first, every later redemption MUST abort as terminal. Honest
freeze rules prevent creation of such a conflicting pair; tests deliberately
construct one. A higher valid close may follow a lower redemption and pays only
the remaining delta.

At or after claim deadline, any gas payer may call `refund` on OPEN. It transfers
only residual funds to the fixed refund address, retains redeemed counters, stores
terminal digest, and sets REFUNDED with empty close_hash. Redeem/close fail at the
exact deadline; refund fails before it. CLOSED/REFUNDED have no further economic
transitions. RPC absence/failure or a peer's claimed digest is never terminal proof.

## Clock anchoring and scheduled recovery

Defaults: offer expires 60 seconds after the sampled chain time, work deadline
300 seconds after it, and claim deadline 60 seconds after work deadline. The
runtime parameters are `work_ms = 300000` and `grace_ms = 60000`; the total default
claim horizon is 360000 ms. Configurable work and grace horizons must each be at
least 10000 ms and satisfy the onchain bounds. Offer expiry is sampled chain time
plus min(60000, work_ms / 2), permitting short explicit test horizons. Recovery grace
is added to the work deadline, not deducted from `work_ms`. Runtime clocks assume
host/chain skew <= 5 seconds and a fresh chain clock sample. Measure the complete
snapshot RPC round trip; reject admission if it exceeds 10 seconds or if returned
chain time differs from local wall time at receipt by more than 10 seconds.

Record monotonic time and wall time when the snapshot arrives. During admission,
set `anchor_upper = max(sample_chain_ms + round_trip_ms, local_wall_ms) + 5000`.
During a live session use `upper_now = max(anchor_upper + monotonic_elapsed_ms,
local_wall_ms + 5000)`. Require `upper_now < work_deadline_ms` for each new credit
and each new work execution. Detect wall/monotonic drift > 5 seconds and freeze
new activity until chain revalidation; do not stretch a deadline after restart.
These guards are conservative operational assumptions, not consensus time proofs.
Move's Clock is authoritative for every economic transition.

The running provider MUST schedule recovery at the work cutoff independently of
new requests. Freeze activity, query the Channel, and submit the saved certificate
if present; otherwise redeem the highest durable credit if it exceeds onchain
redemption. Retry unresolved RPC/transaction attempts at bounded intervals (default
min(5000 ms, grace_ms / 4)) until terminal state or the actual claim
boundary is observed. Bound an individual recovery RPC/transaction wait by the
remaining claim window; a timed-out submission remains an unknown attempt. If a
close conflicts, retain the freeze and try the highest credit after reconciliation.
Reconcile on startup and immediately schedule overdue recovery. The buyer uses
`channel-refund` after the actual chain deadline; automated buyer refund monitoring
is optional for this PoC. A provider redeem command is also available, but manual
invocation alone does not satisfy the provider scheduler requirement.

Established jobs MUST NOT invoke chain reads/writes, including indirect bridge
validation calls. Scheduled recovery starts outside the work interval; admission,
reconnection, close, status, and recovery RPCs are counted separately. A bounded
grace cannot protect against losing every copy of credit, stopping the provider
throughout the grace interval, arbitrary clock failure, or an RPC outage lasting
past expiry. Report this risk and unknown outcomes rather than claiming guaranteed
payment. No new credit is issued merely because a recovery attempt failed.

## Wire contract

Use one bounded JSON request and response per bidirectional QUIC stream; FIN ends
each frame. Keep an admitted connection open across jobs. Maximum frame is 1 MiB,
maximum file is 64 KiB. Reuse handshake/stream timeouts and direct/relay controls
without changing escrow routing. The channel ticket JSON is exactly
`{version: 1, method: "sui.channel.v1", agent: address, endpoint: EndpointAddr}`.

Every message has this envelope; no optional extension fields exist in v1:

```text
Envelope {
  version: u8,                  // 1
  method: string,               // "sui.channel.v1"
  buyer: address,
  provider: address,
  agreement_id: address,        // Channel ID; zero only for offer request/response
  request_id: string,           // descriptor ID for job messages; "" otherwise
  message: Message,             // strict tagged object below
}
```

`Message` uses JSON discriminator `type`. The payment category is the explicit
`payment.*` set; `work.*` and `session.*` have no independent spending authority.
Envelope parties/channel/request must agree with signed payloads or their checked
request-hash preimages. Method/version are also included in every economic signed
statement. An error cannot authorize a downgrade or a fresh deposit.

| Message `type` | Exact remaining fields | Response / semantics |
|---|---|---|
| `payment.offer_request` | `opening_nonce: bytes, result_hash: bytes, jobs: u64, max_unit_price: u64, deposit: u64` | `payment.offer`; provider chooses allowed deadlines and price, jobs must fit provider limit |
| `payment.offer` | `offer: Signed<Offer>, terms: FixtureTerms` | Both parties persist; buyer checks terms before controller funding |
| `session.resume` | no additional fields | `session.ready`; receiver revalidates chain and original peer snapshot |
| `session.ready` | `phase: string, highest_credit: Signed<Credit> or null, completed_jobs: u64, transcript_hash: bytes, certificate: CloseCertificate or null, redeemed_amount: u64` | phase is `active`, `frozen`, `closed`, or `refunded`; a local summary, never standalone economic proof |
| `payment.authorize` | `request: RequestDescriptor, credit: Signed<Credit>` | `payment.acknowledge`; job envelope request_id is descriptor UTF-8 request_id |
| `payment.acknowledge` | `ack: Signed<Ack>` | Durable provider receipt of the bound credit |
| `work.get` | `request_hash: bytes` | `work.result`; requires a saved credit for that exact descriptor |
| `work.result` | `result: Signed<ResultStatement>, bytes: bytes` | Authenticated result; compute transcript from saved request/credit/Ack/result |
| `payment.close` | `close: Signed<Close>` | Buyer proposal; returns `payment.close_acknowledge` after provider freezes |
| `payment.close_acknowledge` | `certificate: CloseCertificate` | Persist before close submission; no payout is implied |
| `payment.settlement` | `digest: string` | Hint after submission; receiver independently reconciles and returns `session.ready` |
| `error` | `code: string, message: string` | Diagnostic, no economic state transition |

Only offer messages may use agreement_id zero. Job message request_id is nonempty;
all other request_id values are empty, except an error echoes its request envelope.
Error codes are `unsupported_version`, `unsupported_method`, `invalid_message`,
`unauthorized`, `conflict`, `budget_exceeded`, `expired`, `frozen`, `terminal`,
`chain_unavailable`, and `internal`. Codes describe rejection; authoritative
economic status still requires chain reconciliation. Unsupported/corrupt frames
may also close the connection without a reply. Limit diagnostic text to 1024 bytes.

## Durable recovery contract

Use private atomic fsync/rename writes and a process lock as in the escrow runtime.
A channel's atomic journal includes immutable offer/terms, nonce and Channel ID,
highest issued/accepted credit, request records, Ack/result records, completed
root/count, freeze candidate/certificate, and economic observation. A write failure
aborts before sending the associated signature or delivering unjournaled work.
The provider's saved offer record must distinguish never-admitted from admitted
and record the Channel ID durably before accepting its first credit. Initializing
T0 is allowed only on that first admission; a missing admitted channel journal
must never be treated as an empty new channel.
Larger result files may be written first and referenced from the journal, but a
committed record must never refer to missing bytes.

| Interrupted boundary | Required recovery |
|---|---|
| Open submitted, reply/Channel ID lost | Resolve original buyer+nonce; compare complete Offer; no new deposit |
| Credit saved, transmission/reply lost | Resend identical credit; recover Ack; no increment |
| Provider saved credit, stopped before result | Reconcile on restart; return saved Ack, execute only if still active/time permits; otherwise preserve redeemable credit |
| Result saved, delivery lost | Return cached identical bytes/statement; each root advances once |
| Buyer saved completed result, stopped | Resume from that root and next sequence after admission |
| Close signature/certificate saved, process stopped | Remain frozen; recover the same certificate or unilateral outcome |
| Redeem/close/refund submitted, response lost | Query retained Channel and transaction journal; unknown stays unknown |
| RPC fails during admission/recovery | No fresh authority or replacement channel; preserve journal and retry |
| RPC fails after admission during normal jobs | Continue only under the cached terms/time policy; no per-job RPC dependency |
| Journal missing/corrupt while channel exists | Refuse new signing/history fabrication; report manual recovery limitation |

Persist transaction digest and signed transaction bytes before submitting. After
unknown submission, reconcile first; resubmitting identical signed bytes is
permitted. A newly built attempt MUST use the original channel/nonce and unchanged
authorization, and only after checking the original transaction/state. Idempotency
must hold even if old and new attempts both execute. Keep attempt history instead
of overwriting unresolved evidence. Never classify a timeout as failed execution.

## Upstream and implementation references

Checked 2026-09-10 against this repository's Iroh 1.2.0, Sui CLI 1.79.0, and
`@mysten/sui` 2.30.0 pins. Dynamic-field names can be typed values and duplicate
names under a parent are rejected; this supports the isolated opening mapping.
[Sui dynamic fields](https://docs.sui.io/develop/objects/dynamic-fields).
Application verification uses the framework's Ed25519 byte-message verifier.
[Sui Ed25519 module](https://docs.sui.io/references/framework/sui_sui/ed25519).
Onchain time comes from the shared Clock's millisecond timestamp.
[Sui Clock module](https://docs.sui.io/references/framework/sui_sui/clock).
Iroh permits application protocols selected through ALPN and bidirectional QUIC
streams. [Iroh QUIC protocols](https://docs.iroh.computer/protocols/using-quic).
These are upstream mechanisms; the payment semantics above are m2m's experiment.
