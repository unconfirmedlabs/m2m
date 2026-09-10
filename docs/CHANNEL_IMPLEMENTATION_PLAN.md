# Spec-driven cumulative-channel implementation plan

Status: implemented and reviewed, 2026-09-10. The user authorized a
signed channel PoC, with Astra xhigh planning, Luna xhigh implementation, and
independent Luna xhigh verification. This document records the interfaces frozen before delegation;
[validation](CHANNEL_VALIDATION.md) records the results and remaining limits. [CHANNEL_SPEC.md](CHANNEL_SPEC.md)
is normative. Changes to its signed bytes, wire variants, storage layout, or
economic conditions require coordinated updates to the spec, implementations,
vectors, and acceptance evidence before merging.

## Deliverable and exclusions

Extend the working fixture with one deposit, ten offchain purchases, cooperative
close, unilateral redemption, and residual refund. Establish the one-job prepaid
exposure bound in the buyer runtime, preserve escrow behavior, and measure the
economic-transaction count, actual RPC calls, gas, and job latency. Use the existing
server and test funds. No GPU, ZK prover, general payment router, or identity-type
migration is needed. Localnet, public testnet, forced relay on one host, and two
actual networks are separate evidence categories.

The parent owns integration and all funded-chain runs. Workers MUST NOT spend
testnet funds, modify deployment records, or run shared-wallet network tests.
Pure/local unit tests and offline builds are appropriate in workers' workspaces.
Do not copy private-source review details or operational keys into public files.

## Work packages and reserved files

| Package / role | Exclusive file ownership | Required output |
|---|---|---|
| A — Luna xhigh Move | `move/m2m/sources/channel.move`, additive accessors in `move/m2m/sources/exchange.move`, `move/m2m/tests/channel_tests.move`, `move/m2m/tests/channel_signing_tests.move` | Enforced state machine, exact structs/entry calls, signed vector and invariant tests |
| B — Luna xhigh Rust protocol | `src/channel_protocol.rs`, `fixtures/channel-signing-vectors.json`, `tests/channel_protocol.rs` | Strict types, canonical bytes, purpose/domain validation, hashes, public deterministic vectors |
| C — Luna xhigh Rust runtime | `src/channel_runtime.rs`, `tests/channel_runtime.rs` | Session driver, Iroh channel transport, private journals, scheduler, restart/replay handling, RPC instrumentation |
| D — Luna xhigh TypeScript | `scripts/channel-codec.ts`, `scripts/channel-chain.ts`, `scripts/verify-channel-vectors.ts`, `scripts/test-channel-economics.ts` | Independent BCS/verifier, typed bridge, idempotent transaction attempts, signed economic-check harness |
| Parent integration and harness | `scripts/setup.ts`, `scripts/channel-demo.py`, `tests/channel_peer_auth.rs`, `src/main.rs`, `src/lib.rs`, `README.md`, `AGENTS.md`, setup/validation docs, `package.json`, schemas, dependencies/lockfiles, deployment/evidence records | CLI/export integration, safe role-wallet reuse in a new deployment directory, schema/harness, all chain runs, final documentation and commit/push |
| Independent Luna xhigh verifier | Read all changes; write findings in its report only unless parent assigns a fix | Reproduce meaningful checks, inspect spec/implementation gaps, review funds/recovery invariants |

The two specification documents are planning-owned. Existing `src/protocol.rs`,
`src/transport.rs`, `src/chain.rs`, `scripts/codec.ts`, `scripts/chain.ts`, old
vectors, and existing escrow tests are compatibility references, not worker edit
targets. Additive exports and CLI flags belong to the parent. Ask the parent for
a small integration hook when compilation needs it; do not independently edit
another package's files. No worker should run `cargo fmt` over unowned files.

## Frozen Move interface (A -> D)

Use the exact Offer/Credit/Close flat structs and Channel storage order in the
spec. `OpeningKey { nonce: vector<u8> }` is public with copy/drop/store abilities.
Offer/Credit/Close have copy/drop/store. Domain and Agent remain exchange types.
The only exchange additions are these `public(package)` functions:

```move
fun domain_network(domain: &Domain): vector<u8>;
fun domain_package(domain: &Domain): address;
fun agent_deployment(agent: &Agent): ID;
fun agent_controller(agent: &Agent): address;
fun agent_endpoint(agent: &Agent): vector<u8>;
fun agent_uid_mut(agent: &mut Agent): &mut UID;
```

They expose existing values to this package only; object::id/id_address supplies
IDs. No field is added, reordered, or removed from an existing struct. `channel`
owns its dynamic-field namespace and performs all controller checks before access.
Do not add an unguarded public entry point that accepts an arbitrary mutable UID.

The exact `channel` public constructors and calls are:

```move
public fun offer(
    domain: &Domain, buyer: &Agent, provider: &Agent,
    opening_nonce: vector<u8>, terms_hash: vector<u8>, deposit: u64,
    offer_expires_ms: u64, work_deadline_ms: u64, claim_deadline_ms: u64,
): Offer;

public fun open(
    domain: &Domain, buyer: &mut Agent, provider: &Agent, payment: Coin<SUI>,
    opening_nonce: vector<u8>, terms_hash: vector<u8>, deposit: u64,
    offer_expires_ms: u64, work_deadline_ms: u64, claim_deadline_ms: u64,
    signature: vector<u8>, clock: &Clock, ctx: &mut TxContext,
);

public fun credit(
    channel: &Channel, sequence: u64, cumulative_amount: u64,
    request_hash: vector<u8>, previous_transcript_hash: vector<u8>,
): Credit;

public fun redeem(
    channel: &mut Channel, sequence: u64, cumulative_amount: u64,
    request_hash: vector<u8>, previous_transcript_hash: vector<u8>,
    signature: vector<u8>, clock: &Clock, ctx: &mut TxContext,
);

public fun close_statement(
    channel: &Channel, final_sequence: u64, final_amount: u64,
    transcript_hash: vector<u8>,
): Close;

public fun close(
    channel: &mut Channel, final_sequence: u64, final_amount: u64,
    transcript_hash: vector<u8>, buyer_signature: vector<u8>,
    provider_signature: vector<u8>, clock: &Clock, ctx: &mut TxContext,
);

public fun refund(channel: &mut Channel, clock: &Clock, ctx: &mut TxContext);
```

Abort-code mapping in `channel`: `EAuthority=0`, `ELength=1`, `EDomain=2`,
`ESignature=3`, `EExpired=4`, `EAmount=5`, `ENonce=6`, `ETerminal=7`,
`ETooEarly=8`, `ESequence=9`, `EDeadline=10`. Explicitly detect an existing opening
key and abort ENonce instead of depending on a framework dynamic-field abort.
Opening reconstruction prevents caller-controlled domains and destinations.
Post-open reconstruction always uses stored Offer values. Test-only helpers may
isolate transitions, but positive/negative real signature paths must also run.

## Frozen Rust protocol interface (B -> C and parent)

Use existing `protocol::{Address, decimal, hash, sign, verify}` where appropriate;
do not change their escrow behavior. Export these public constants and types from
`channel_protocol`:

```rust
pub const ALPN: &[u8] = b"m2m/payment/1";
pub const METHOD: &str = "sui.channel.v1";
pub const VERSION: u8 = 1;
// Public fields follow the exact spec spelling/order and types.
pub struct Offer { /* flat prefix and Offer suffix */ }
pub struct Credit { /* flat prefix and Credit suffix */ }
pub struct Ack { /* flat prefix and Ack suffix */ }
pub struct ResultStatement { /* flat prefix and result suffix */ }
pub struct Close { /* flat prefix and Close suffix */ }
pub struct FixtureTerms { /* full spec structure */ }
pub struct RequestDescriptor { /* full spec structure */ }
pub struct TranscriptStart { /* full spec structure */ }
pub struct TranscriptStep { /* full spec structure */ }
pub struct Signed<T> { pub payload: T, pub signature: Vec<u8> }
pub struct CloseCertificate {
    pub close: Close,
    pub buyer_signature: Vec<u8>,
    pub provider_signature: Vec<u8>,
}
pub struct Ticket {
    pub version: u8, pub method: String,
    pub agent: Address, pub endpoint: iroh::EndpointAddr,
}
pub struct Envelope {
    pub version: u8, pub method: String,
    pub buyer: Address, pub provider: Address,
    pub agreement_id: Address, pub request_id: String, pub message: Message,
}
```

All scalar and signed types derive Clone/Debug/Serialize/Deserialize/PartialEq/Eq
where supported. Vec<u8>, Address, and u64 map literally to spec types, `u64`
using decimal serde. Ticket/Envelope need not implement Eq. Every unsigned signed
type, FixtureTerms, RequestDescriptor, Ticket, and Envelope has
`pub fn validate(&self) -> anyhow::Result<()>`; signed types validate their own
structural/domain constants, while runtime compares contextual bindings and
verifies signatures. Envelope validation must also reject malformed nested bodies.
Derive/implement strict unknown-field rejection at every wire level.

`Message` is an internally tagged serde enum (`type`) with variants named
`OfferRequest`, `Offer`, `Resume`, `Ready`, `Authorize`, `Acknowledge`, `Get`,
`Result`, `Close`, `CloseAcknowledge`, `Settlement`, and `Error`. Give each its
explicit wire name from the spec and exact named fields from the wire table.
Large statement fields may be boxed internally only if their wire representation
is unchanged; notify C of any Box types before integration. The preferred shared
Rust contract uses `Box<Signed<Offer>>` for Message::Offer and
`Box<CloseCertificate>` for close-acknowledgement/Ready certificates; all other
Signed fields are unboxed initially. Ready's certificate is
`Option<Box<CloseCertificate>>`. Runtime can box other large enum variants after
coordination, without changing wire bytes.

Export these canonical helpers, all returning `anyhow::Result<Vec<u8>>`:

```rust
pub fn terms_hash(value: &FixtureTerms) -> Result<Vec<u8>>;
pub fn offer_hash(value: &Offer) -> Result<Vec<u8>>;
pub fn request_hash(value: &RequestDescriptor) -> Result<Vec<u8>>;
pub fn credit_hash(value: &Credit) -> Result<Vec<u8>>;
pub fn ack_hash(value: &Ack) -> Result<Vec<u8>>;
pub fn result_statement_hash(value: &ResultStatement) -> Result<Vec<u8>>;
pub fn transcript_start(channel: Address, offer: &Offer) -> Result<Vec<u8>>;
pub fn transcript_next(
    previous: &[u8], request: &RequestDescriptor, credit: &Credit,
    ack: &Ack, result: &ResultStatement,
) -> Result<Vec<u8>>;
pub fn signing_vectors() -> anyhow::Result<serde_json::Value>;
```

Hash helpers validate structure then hash exact BCS. They are not substitutes for
the runtime's signature and state checks. Constructors beyond this surface may
be added, but C can construct all structs through public fields. Freeze the
public vector JSON shape as `{version: 1, method: "sui.channel.v1", keys: {...},
statements: {...}, hashes: {...}}`: keys has `buyer_public_key` and
`provider_public_key` as lowercase hex; statements contains `terms`, `request`,
`offer`, `credit`, `ack`, `result`, `close`, `transcript_start`, and
`transcript_step`, each `{payload, bcs_hex, hash_hex}` plus `signature_hex` for
single-signed statements and `buyer_signature_hex`/`provider_signature_hex` for
close. hashes contains `transcript_start` and `transcript_final` as hex.
Use public test seeds [1;32]/[2;32], network `test-vector`, addresses [3;32] package,
[4;32] deployment, [5;32] buyer, [6;32] provider, [7;32] refund, [8;32] payee,
[10;32] channel; nonce [9;32], fixture hello.txt, job ID `job-0001`, sequence 1,
price 1000, max_jobs 10, deposit 12000, expiry 1800000060000, work 1800000300000,
claim 1800000360000. Close signs sequence 1, amount 1000, and T1. These seeds are
intentionally public fixtures and MUST NOT fund wallets.

## Frozen TypeScript bridge (D -> C and parent)

Keep existing chain.ts entry behavior unchanged. `channel-codec.ts` independently
defines the ordered BCS schemas above plus Channel and OpeningKey; it may import
base Address/Clock/Domain helpers but MUST NOT consume Rust-generated BCS as its
encoder. Verify signatures independently with Node crypto and hashes with the
pinned library. Golden bytes must agree across Rust, TypeScript, and Move.

`channel-chain.ts` accepts one bounded stdin JSON object and returns one stdout
JSON object, like the existing bridge. It imports/reuses `Chain`, `ChainConfig`,
`key`, and `save`; it MUST NOT require modifying their APIs. Extend via an exported
`ChannelChain extends Chain` with the following methods:

```typescript
channel(id: string): Promise<ChannelView>;
lookupChannel(buyer: string, openingNonce: number[]): Promise<string | null>;
parties(buyer: string, provider: string): Promise<PartiesView>;
snapshot(id: string): Promise<SnapshotView>;
openChannel(offer: OfferData, signature: number[], signer: Ed25519Keypair,
            journal: string): Promise<MutationView>;
redeemChannel(credit: CreditData, signature: number[], signer: Ed25519Keypair,
              journal: string): Promise<MutationView>;
closeChannel(certificate: CloseCertificateData, signer: Ed25519Keypair,
             journal: string): Promise<MutationView>;
refundChannel(id: string, signer: Ed25519Keypair,
              journal: string): Promise<MutationView>;
```

`ChannelView` is parsed Channel BCS plus `terminal_digest: string | null` (Base58
of terminal_tx). Its funds and counters use decimal strings. `PartiesView` is
`{buyer: AgentData, provider: AgentData, timestamp_ms: string}`.
`SnapshotView` is `{channel: ChannelView, timestamp_ms: string}`.
`MutationView` is `{channel: string, digest: string | null, state: ChannelView,
gas: object | null, recovered: boolean}`. Preserve raw gas values returned by the
SDK, without coercion to floating-point numbers. A recovered outcome may have
null gas when original effects are unavailable; do not invent a digest for
nonterminal redemption covered by a later transaction. In that case return
`digest: null` and document coverage through state/recovered.

Every stdin request includes `config` with the unchanged existing Config fields.
Exact actions and additional arguments:

| action | arguments | result |
|---|---|---|
| `channel_parties` | `buyer`, `provider` | PartiesView |
| `channel_lookup` | `buyer`, `opening_nonce` | `{channel: string or null}` |
| `channel_get` | `id` | ChannelView |
| `channel_snapshot` | `id` | SnapshotView |
| `channel_open` | `offer`, `signature`, `signer_file`, `journal` | MutationView |
| `channel_redeem` | `credit`, `signature`, `signer_file`, `journal` | MutationView |
| `channel_close` | `certificate`, `signer_file`, `journal` | MutationView |
| `channel_refund` | `id`, `signer_file`, `journal` | MutationView |

Validate network/Domain/type and object bindings before reporting success.
Channel type is `${package_id}::channel::Channel`; OpeningKey's full type is
`${package_id}::channel::OpeningKey`, BCS is a vector<u8> nonce, and its dynamic
field parent is the buyer Agent ID. Parse its value as ID/address. Only the
SDK's confirmed notExists case means no mapping. Retain complete transaction
attempts before submission; query nonce/channel before retries. On a covered
redemption return recovered state, never report another transfer. On terminal
close check close_hash against the submitted certificate; a refund is a different
outcome. Unknown remains an error with durable unresolved evidence.

The bridge validates once per explicit operation. Runtime C creates a separate
bridge adapter pointing at this script (same stdin/timeout discipline as Chain);
it MUST NOT route channel calls through the hardcoded scripts/chain.ts subprocess.
Count every SDK RPC request at the transport/client boundary in structured stderr
events, including failures and retries; the parent harness must be able to prove
that no bridge/RPC work occurs in the jobs interval. Workers should pin any extra
SDK assumption to inspected installed sources and flag API issues promptly.

## Frozen runtime public API and CLI (C -> parent)

The runtime owns all channel state machines and its new Iroh endpoint/connection
handling. Reuse store, ServiceHandler/FixedFile, and protocol cryptography. Avoid
altering the existing escrow server. It may implement private helper modules
inside channel_runtime.rs. Parent adds module exports and maps CLI to this API:

Parent has also added `transport::endpoint_with_alpns(key: SecretKey, relay: bool,
relay_only: bool, alpns: Vec<Vec<u8>>) -> Result<Endpoint>`. C MUST reuse this
endpoint-construction hook with the channel ALPN; no transport.rs edits are needed.

```rust
pub struct ChannelIdentity {
    pub agent: Address,
    pub chain: crate::chain::Config,
    pub key: iroh::SecretKey,
}
pub struct ServeOptions {
    pub file: PathBuf, pub gas_signer: PathBuf, pub ticket: PathBuf,
    pub unit_price: u64, pub max_jobs: u64,
    pub work_ms: u64, pub grace_ms: u64,
    pub relay: bool, pub relay_only: bool,
    pub fault: Option<String>,
}
pub struct BuyOptions {
    pub provider: Address, pub ticket: PathBuf, pub expected_file: PathBuf,
    pub signer: PathBuf, pub session: String,
    pub jobs: u64, pub deposit: u64, pub max_unit_price: u64,
    pub relay: bool, pub relay_only: bool,
    pub stop_after: Option<String>, pub close: bool,
}
pub async fn serve(store: &Store, identity: &ChannelIdentity,
                   opts: ServeOptions) -> anyhow::Result<()>;
pub async fn buy(store: &Store, identity: &ChannelIdentity,
                 opts: BuyOptions) -> anyhow::Result<serde_json::Value>;
pub async fn status(store: &Store, identity: &ChannelIdentity,
                    session: &str) -> anyhow::Result<serde_json::Value>;
pub async fn close(store: &Store, identity: &ChannelIdentity,
                   session: &str, gas_signer: &Path)
                   -> anyhow::Result<serde_json::Value>;
pub async fn redeem(store: &Store, identity: &ChannelIdentity,
                    channel: Address, gas_signer: &Path)
                    -> anyhow::Result<serde_json::Value>;
pub async fn refund(store: &Store, identity: &ChannelIdentity,
                    session: &str, gas_signer: &Path)
                    -> anyhow::Result<serde_json::Value>;
```

Parent provides the already-locked Store and loaded identity/key. Runtime persists
routing/relay choices needed by close/resume in its session journal. It canonicalizes
signer paths; key values never enter command arguments/logs. `buy(close=true)`
uses its signer for funding and closing gas; the signature authorizing economic
close is still the endpoint's. A caller can instead use `close=false` and the
separate close command with an independent gas wallet. Provider uses its supplied
gas wallet for scheduled redemption/recovery. Expose authorized, completed,
redeemed, residual, and terminal outcomes separately in JSON.

CLI commands to integrate:

| command after `m2m --state DIR` | flags / defaults |
|---|---|
| `channel-serve` | `--file`, `--gas-signer`, `--ticket`, `--unit-price 1000`, `--max-jobs 1000`, `--work-ms 300000`, `--grace-ms 60000`, `--relay`, `--relay-only`, `--fault` |
| `channel-buy` | `--provider`, `--ticket`, `--expected-file`, `--signer`, `--session`, `--jobs 10`, `--deposit 12000`, `--max-unit-price 1000`, `--relay`, `--relay-only`, `--stop-after`, `--no-close` |
| `channel-status` | `--session` |
| `channel-close` | `--session`, `--gas-signer` |
| `channel-redeem` | `--channel`, `--gas-signer` (provider's saved highest credit) |
| `channel-refund` | `--session`, `--gas-signer` |
| `channel-vectors` | none; print public deterministic vectors |

CLI flags map directly to the existing runtime field names: unit-price ->
unit_price, jobs -> jobs, max-unit-price -> max_unit_price, work-ms -> work_ms,
and grace-ms -> grace_ms. The grace is additional to the work horizon, not deducted
from it. This is the original written contract used by the parent integration.
Its 12000 MIST deposit and 60000 ms grace are also used by the fixed signing vector.
Configurable `work_ms` and `grace_ms` each have a 10000 ms minimum; bounded recovery
waits and retry intervals follow the spec using these same parameter names.
The parent coordinates any subsequent contract changes across all workers.

Session IDs use the existing 1..64 safe-ASCII policy. Generated job IDs are
`job-0001` through `job-1000`, stable inside the channel. Repeating channel-buy
with the same session and same parameters resumes; different parameters fail.
`stop_after` choices are `opened`, `credit-saved`, `acknowledged`, `result-saved`,
`close-signed`, `close-certificate`; first-job stops fire once per invocation
before incrementing/replacing any saved record. Provider faults are
`after-credit`, `after-result`, and `after-close-certificate`: close the current
connection after the named durable write and before its response. Harness restarts
without that fault. Faults do not alter cryptographic/economic behavior.

Events on stderr use JSON lines: `channel_admitted`, `channel_jobs_begin`,
`channel_job_complete`, `channel_jobs_end`, `channel_rpc`, `channel_recovery`,
`channel_terminal`. Include channel/session, monotonic elapsed time, sequence and
cumulative amount as applicable. `channel_rpc` includes operation, phase, result,
and call count (including failed requests). The happy interval starts after both
parties finish admission and ends after the tenth result is durably verified,
before close preparation. Recovery and RPC outage tests require an injectable
adapter or actual counting/rejecting RPC transport, not a self-reported zero.

## Implementation order and integration gates

1. Parent distributes this contract to A/B/D in parallel and C once B's public
   types are acknowledged; C can design storage/time/connection logic immediately.
   A/D agree constructor argument order above before any funded test. Parent owns
   lib exports and compile integration hooks so worker file ownership stays clear.
2. B freezes deterministic vectors early; D independently encodes every structure
   and verifies signatures. A adds Move verification of Offer/Credit/Close and
   hash vectors. A mismatch is a contract bug to resolve before funded runs.
3. Parent integrates modules/CLI/schema; all original tests/vectors and new pure
   tests pass. Add `schemas/channel-v1.schema.json`
   matching strict wire fields; validate example frames, including negatives.
4. Parent builds/publishes a fresh local package, registers separate endpoints,
   initializes new state, runs the ten-job demo and economic/recovery matrix.
   Existing deployment directories and evidence are retained. `--wallets-from`
   belongs to parent's setup work; no worker should depend on hardcoded wallet
   addresses or private paths.
5. Parent repeats the bounded happy/recovery set on public testnet using available
   role wallets, then forced relay. Do not label same-host relay as two networks.
6. A separate Luna xhigh verifier reviews the final integrated diff against this
   spec, independently checks signatures/state transitions and traces, and returns
   concrete findings with file/line evidence. Parent fixes findings, reruns affected
   checks, updates evidence, and commits/pushes only the reviewable final result.

## Acceptance matrix

Every row is a required local acceptance condition unless explicitly qualified.
Record executable command, result, and relevant transaction/trace references.
Do not replace signed economic tests with helpers that skip verification.

| ID | Exercise | Required observable result | Primary owner |
|---|---|---|---|
| C01 | Original escrow regression | Old Move suite, Rust tests, TS vectors, wire examples and one exchange still pass; old signed bytes unchanged | Parent / verifier |
| C02 | Independent canonical encoding | Rust/TS agree for all nine structures; Move verifies Offer/Credit/Close signatures and hashes; mutation/purpose/method/network/channel negatives reject | B/D/A |
| C03 | Open authority/terms | Wrong controller, key, domain, payee reconstruction, signature, deposit value, lengths and deadline bounds reject | A/D |
| C04 | Opening replay and lost response | Same buyer/nonce maps to exactly one channel after reply/ID loss; changed offer cannot adopt it; escrow nonce/table untouched | A/C/D/parent |
| C05 | Happy ten-job channel | One Channel, ten exact results, authorized=10000, paid=10000, refund=2000, CLOSED, exactly open+close economic transactions | Parent |
| C06 | Hot-path independence | Count at actual RPC boundary; zero calls between admitted jobs_begin/jobs_end; block RPC after admission and all ten jobs still finish before cutoff | C/parent |
| C07 | Prepaid exposure and input validation | No second unfulfilled job; corrupt result does not cause next credit; price/budget/sequence overflow, skipped/reused/conflicting request/credit rejected | B/C |
| C08 | Peer authentication | Ticket substitution and an unrelated endpoint claiming buyer/provider fail; snapshots permit original funded authority after rotation, new opens reject old key | A/C/D/parent |
| C09 | Credit/Ack crash boundaries | Buyer saved credit, provider saved credit, lost Ack, and both process restarts preserve exact credit and one increment | C/parent |
| C10 | Result crash boundaries | Lost result reply and buyer restart return cached identical result; one transcript advancement; no repeated execution after saved result | C/parent |
| C11 | Monotonic redemption | Redeem seq 2 directly, then seq 3: only deltas paid; duplicate/stale/cross-channel/wrong-purpose/overdeposit/zero-increment credits reject | A/D |
| C12 | Fixed destinations and conservation | Unrelated gas signer cannot redirect payout/refund; prior redemption plus close/refund conserves deposit excluding gas | A/D |
| C13 | Close freeze/restart | No new authorization/work after local close consent, including after process restart/RPC failure; duplicate close returns same certificate/outcome | C/parent |
| C14 | Close race | Higher redemption before lower close makes close abort; lower close first makes later redemption abort; higher close after lower redemption pays delta only | A/D |
| C15 | Exact deadline and grace | Refund fails before claim; close/redeem fail at claim; refund succeeds at claim; runtime stops work before claim and automatically schedules recovery without new peer traffic | A/C/parent |
| C16 | Partial/no jobs | Zero-credit cooperative close refunds all; partially used channel can redeem then refund residual; highest prepaid credit remains claimable if provider never supplies result | A/C/D/parent |
| C17 | Unknown transaction outcomes | Lost open/redeem/close/refund replies reconcile retained state; old/new attempts cannot duplicate payment; missing RPC result never classified as terminal | C/D/parent |
| C18 | Prolonged outage / missing journal | Admission failure preserves state; outage through grace explicitly loses timely-claim guarantee; missing/corrupt journal refuses fresh signing/history fabrication | C/parent |
| C19 | Bounded parsing / versioning | Extra fields, numeric u64 JSON, oversized frames/files, wrong method/version/domain and mismatched envelope/payload reject without funding or credit | B/C/parent |
| C20 | Testnet evidence | Parent records new package/Domain/channel IDs, open/close/refund/redeem digests, net gas and outcome; limitations stay explicit | Parent |
| C21 | Transport evidence | Direct and forced-relay channel flows pass; two actual networks remain unverified until exercised | Parent |
| C22 | Independent review | Separate Luna xhigh findings resolved or explicitly recorded as remaining acceptance failures; no unsupported ZK/fair-exchange/guaranteed-payment claims | Verifier / parent |

The testnet subset must include happy ten jobs, opening/credit/result/close restart
recovery, automatic unilateral claim plus residual refund, and uncertain terminal
recovery. Host-level RPC blocking and malformed-transaction sweeps may be localnet
only. Measure both processes' setup/admission/open/close overhead separately from
per-job latency and per-job RPC count. Record p50/p95/max job time, actual successful
economic transaction count, total net gas (computation + storage - rebate), and
remaining test balances. Report the deposit price separately from gas; do not
infer production costs or customer value from this deterministic fixture.
