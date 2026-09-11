# Fly-hosted live agent demo contract

Status: implementation specification, checked 2026-09-11; no deployment or live
acceptance is claimed here. Specification: Astra `xhigh`; implementation: Luna
`xhigh`; review: Astra `xhigh`. This implements the accepted
[investor demo behavior](LIVE_DEMO_PROPOSAL.md), above the existing
[agent-services contract](AGENT_SERVICES_SPEC.md). Exact entrypoints, ownership
and validation gates are in [the implementation plan](FLY_AGENT_DEMO_IMPLEMENTATION.md).
The separately specified [agent runtime](AGENT_RUNTIME_SPEC.md) owns model
selection, tool isolation, model API requests and private model recovery.

## 1. Scope and trust

**FD-01.** A person submits an unseen research question to `local.nozomi.sui`.
That coordinator LLM can purchase research from `research.nozomi.sui`, assess
returned evidence, ask follow-ups and stop within a fixed host-enforced budget.
The research LLM uses the existing bounded search/fetch tools. The concrete
baseline is the current CLI: its deterministic/localnet tests establish useful
plumbing, but its live profiles are gated and it has no authenticated browser
control or persistent cloud composition. Measure successful live tool calls,
verified deliveries, bounded signed credit, recovered identities and final Sui
state; identical output, timing or call count is not an acceptance criterion.

**FD-02.** Run one role per Linux Fly Machine in **two new, separate Fly apps**,
with one private volume each. The coordinator also serves the React/Tailwind
assets and public HTTPS control/event API. The provider serves only private
authenticated HTTP status, locator and public-event reads. That HTTP link is
an operator observation/bootstrap link. All unpaid native messages, research
requests/results and signed payment messages use the actual Rust Iroh bridge
and native-core verification. Do not relay these messages through the browser
or introduce an HTTP research dispatcher.

Both roles are operated by the same demonstrator; two Machines do not establish
independent businesses. Browser events trust their authenticated hosts. Verified
economic statements and independently queried Sui objects provide separate
evidence. This deployment does not establish trustworthy research, customer
demand, profitable pricing or production availability.

**FD-03.** Preserve native wire formats, BCS signing bytes, Move entrypoints,
service v2 request hashes, separate transport/economic keys, cumulative billing,
unpaid messaging, cancellation exposure and exact-close conditions. HTTP control
is an application API, not a new m2m protocol feature. Preserve the old Codex
AS-20 gate. Only the explicitly selected, independently validated runtime from
AGENT_RUNTIME_SPEC may run live. No fixture/backend/model fallback, CLI runtime
fixture flag, ambient shell tool, hidden reasoning, or scripted investor path.

## 2. Initialization, identities and state

**FD-04.** Hosting accepts preprovisioned native **testnet** configuration and
both complete AgentRefs, plus only the local role's private keys. Testnet uses
the existing `NativeChain.checkRpcScope`, `checkNetwork`, `validate` and
`NativeNames` implementation; do not add a mainnet option or weaken endpoint
and network checks. The local harness may explicitly select the existing
loopback-localnet path; a Fly deployment manifest cannot select localnet.

Before first admission, resolve the exact expected `local.nozomi.sui` and
`research.nozomi.sui` leaves through the existing parent-registration checks,
compare their qualified AgentRefs to the deployment manifest, validate current
controller/transport/economic authority, and match each local public key to its
Agent. The funding wallet must match the buyer controller; the provider receives
no buyer wallet. Retain the checked public name/parent/controller/generation
snapshot. A changed name target is `identity_changed`, never automatic retargeting.
After initialization, an unavailable alias may be shown stale while the original
pinned Agent is resolved directly, consistent with NATIVE_NAMING_SPEC. Expired or
unavailable economic authority prevents new work/signing. Existing rights follow
their original agreement snapshots and recovery rules.

Provisioning/publishing native objects and registering missing leaves is a
separate operator workflow using existing native setup and exact controller
verification. It is never an HTTP endpoint, boot hook or container release hook.
Do not copy a parent-name wallet into either Machine merely to run the demo.
Different Agent controllers may be used when explicitly provisioned that way.
The present `native-setup.ts` cannot do this separation: its single `--wallet`
publishes/registers both Agents and creates leaves. The implementation adds
explicit `--name-wallet <private-file>` for leaf creation, while `--wallet`
remains the independently funded demo controller/publisher. Verify the name
wallet against the expected parent owner before provisioning; use it only for
the existing `NativeNames.createLeaves` transaction. The demo path requires
the two wallet addresses to differ. Register new Agents directly under the demo
controller using the unchanged `identity::register` ABI; no controller transfer
or new Move entrypoint is needed. Preserve the old CLI default for existing
localnet/PoC users, but do not use that combined-authority mode for this demo.

**FD-05.** Each role has a persistent `/data/m2m` root with private directories
(0700), records (0600), NativeLock, atomic replacement, file/directory fsync and
initialized-component validation. Required durable state includes local keys,
chain/Agent pins, immutable operator config, application manifests, worker/tool
journals, inbox/outbox, all channel engines, budgets, transaction intents/results,
controls, source events and the coordinator's merged event projection. Use a
persistent role worker path outside served assets; never `mkdtemp(tmpdir())`.
Validate real paths are beneath the explicit protected root and reject symlink
escape or a missing mounted volume. No automatic empty initialization of an
existing Agent, conversation or economic component is permitted.

The runtime descriptor and full profile/limit fingerprint specified by
AGENT_RUNTIME_IMPLEMENTATION are immutable manifest fields. A new runtime uses
an explicitly fresh conversation; do not reinterpret Codex worker files as
another backend's state. Missing acknowledged model-response evidence is an
uncertain outcome, never permission for a new model turn. Startup/recovery
must not replenish request counts, deadlines, web limits or funding allowances.

**FD-06.** One live writer owns each role/Agent, even across conversations. A
deploy or Machine restart reopens the same manifest and volume. Do not use
replicas sharing a logical identity with divergent volumes. A lost volume is
`journal_missing`/`recovery_required`; do not replace keys, replay an old backup
as current economic state, or provision another deposit. Stop new signing and
reconcile retained counterpart/onchain evidence under a separate recovery plan.
Backups are private, contain keys, and must not enter static assets or reports.

## 3. Explicit controls and funding

**FD-07.** Refactor the current `runAgentServices` composition into an embeddable
lifecycle handle; retain its CLI as a thin adapter. HTTP must not launch arbitrary
commands or depend on parsing stderr to discover process state. The handle can
be opened without funding or model inference. Its provider side can listen and
publish a locator after configuration/runtime/identity checks. Its coordinator
side remains ready but disconnected until `start` or explicit recovery of a
previous start. Readiness checks, GET requests, browser login, SSE reconnection,
container startup, stdin EOF and natural model completion never fund or close.

**FD-08.** Controls use strict duplicate-key/unknown-key rejection, canonical
64-hex operation IDs and decimal-string amounts. Persist the exact validated
intent before action and the resulting status before replying with completion.
The same ID and semantic command returns its retained control record; changed
content returns `control_conflict`. Reconcile an accepted command after crash;
never implement retry by generating a fresh model request or opening nonce.
Do not await a whole LLM task while holding the control admission queue.

| Control | Exact command fields beyond `op` | Required effect |
|---|---|---|
| `start` | none | Validate both roles' readiness and pinned descriptors, establish real Iroh/native session, negotiate both v2/payment features, perform unpaid echo; no funding |
| `fund` | `configuration_hash:ID`, `previous_channel:Address|null` | One deliberate opening under the displayed immutable budget/rates/deposit, with persisted nonce and transaction journal |
| `task` | `prompt:string` | Control ID is the user task ID; launch/resume that exact bounded task after a funded, usable channel exists |
| `cancel` | `task:ID` | Persist cancellation for this task, stop new purchases, interrupt and reconcile/drain already authorized work |
| `spending` | `paused:boolean` | Durably prohibit/permit new credit signatures and new purchases; preserve existing liabilities and original deadlines |
| `disconnect` | none | Persist desired offline state, close the actual coordinator Iroh bridge; automatic reconnect remains disabled |
| `reconnect` | none | Set desired online state, establish a fresh authenticated native session and recover saved operations/known model state |
| `close` | `channel:Address` | Exact explicit final-checkpoint/settlement path for the selected channel; refuse unresolved execution |
| `refund` | `channel:Address` | Submit/reconcile existing Sui expiry refund only after trusted chain time permits it; preserve any unresolved work status |

`task.prompt` follows the current bounded valid-Unicode prompt contract. HTTP
never accepts a path, executable, wallet, arbitrary recipient, RPC URL, model,
rate, grant, raw signature or amount. Config is provisioned privately, frozen and
hashed with the shared canonical encoder. A fund button shows exact testnet
deposit and policy before sending the command; a new channel always needs a
fresh operator command with the confirmed predecessor. No automatic refueling.

**FD-09.** A successful fund command reserves budget before signing, binds the
exact offer/policy/nonce and uses `StreamingChain.fund` with its unchanged opening
mapping and transaction journal. A restart may resubmit/reconcile the **same
already authorized signed transaction**. It may not produce a new opening when
an earlier offer expired, a submission is uncertain or an app was redeployed.
Funding intent must retain the verified offer and nonce before transaction
construction so the provider's short quote lifetime cannot cause silent repricing.
A failed/expired unsubmitted opening remains a visible failure requiring an
explicitly authorized new attempt and existing budget reconciliation.

After close/refund, keep the same conversation and model mapping. `fund` with
the exact `previous_channel` explicitly permits a replacement only when the
existing AS-18 execution and settlement conditions are independently verified.
Its new channel counters reset as specified; conversation budgets do not reset.

**FD-10.** Spending pause is separate from task cancellation. It prevents new
tasks, initial credits and credit renewals after its durable acknowledgement.
Already signed credits can be sent/replayed and already authorized delivery can
drain; the provider's bounded generation may continue. At the next credit need,
the buyer waits for explicit resume, cancellation or the unchanged deadline.
Show that waiting state. Resume creates no new allowance and does not restart a
cancelled, completed or uncertain model turn.

All credit paths, including recovery of unsigned intents, pass a serialized
signing gate shared with pause admission. Budget reservation may precede the
gate; recheck pause/cancellation after awaited guards and before persisting a
new signing intent/invoking `engine.authorize`. If pause wins, no later signature
may occur until resume. If signing wins, its exact retained authorization is
shown before pause is acknowledged. A reservation is not evidence that a credit
was signed, and pause never releases it. The gate must not block cancel/status
behind a waiting model or network operation. Preserve AS-28 typed no-dispatch
rules; do not fabricate terminal receipts to make pause/reconnect easier.

**FD-11.** Disconnect is a real transport action, visibly labeled as an operator
action. It neither cancels the model nor revokes signed credit. Browser stream
loss affects only observation; work continues within its existing authority.
Keep browser, provider-event-link and agent-Iroh connection states separate.
Unknown direct/relay path is displayed as unknown; successful Iroh connection is
not proof of a direct path.

On reconnect, replace only the peer/transport generation; retain outbox operation
IDs, signed statements, request references and known backend response IDs. Fresh
core envelopes after expiry retain the existing application operation identity.
Do not treat lost acknowledgement as no execution. Recovery must finish the
retained operation before admitting another; an uncertain model launch remains
uncertain. Automatic recovery of a previously connected session may retry at
1, 2, 4, 8 and 15 seconds, then report degraded and await explicit reconnect.
Provider relistens with the same identity, bounded backoff and no busy loop; the
current bridge's listener timeout is not a reason to permanently abandon idle
readiness after three timeouts. Model and work deadlines continue throughout.

**FD-12.** Close requires real reconciled terminal receipts and drained/discarded
output, obtains the provider's final signed checkpoint, and calls the existing
exact-close implementation. A no-credit channel uses its existing expiry refund
path, not fabricated zero-use credit. Refund requires independent chain time and
actual permitted chain status; no accelerated clock or fake expiry. Neither
refund nor machine shutdown can erase uncertain external work. Pending/failed
transactions display that state until independent confirmation. Signal shutdown
persists pending controls/cancellation/recovery, interrupts bounded work and exits
within 20 seconds; correctness must survive SIGKILL at any earlier point.
Await an adapter's asynchronous `shutdown()` before releasing enclosing locks.
If local callbacks remain pending at the grace deadline, report
`worker_shutdown_uncertain` and retain the in-process locks until exit; a timeout
must not release them while delayed state changes can still finish.

## 4. Authenticated HTTP and durable events

**FD-13.** The public origin is exactly the configured coordinator HTTPS origin.
Authenticate every API route, including bootstrap, status, evidence and event
replay. Static assets/login contain no task or identity state. Use two random
256-bit bearer secrets: viewer (read) and operator (read/control). The UI accepts
one through a password input and retains it only in memory. Never put tokens in
URLs, local/session storage, analytics, service workers, logs or error messages.
The browser uses authenticated `fetch` streaming for SSE; it does not need
native EventSource query-token workarounds. Tokens are never sent to provider,
model, source URL or Sui endpoints.

Use timing-safe fixed-length token verification. No cookies/CORS or wildcard
origin. Require the configured Host and Origin on browser mutation requests,
JSON Content-Type, no redirects, and strict method/path allowlists. Reject bodies
over 20 KiB before buffering; fixed JSON error codes only. Bind provider reads
on its private 6PN interface and require a third independent bearer secret shared
only with coordinator. Private networking does not replace authentication.
Provider has no private HTTP control, fund, research or transaction endpoints.
Its locator endpoint carries a bounded current Iroh EndpointAddr whose public
key must match fresh pinned provider authorization before use.

**FD-14.** Exact public route prefix is `/api/v1`; one configured conversation is
in scope, so requests cannot choose other state roots or Agent IDs.

| Route | Authority | Response |
|---|---|---|
| `GET /api/v1/session` | viewer/operator | Immutable public config, both named Agent identities, runtime labels, current snapshot and available controls |
| `GET /api/v1/status` | viewer/operator | Current status, last verified economic snapshot and its observation time, event high water |
| `POST /api/v1/controls` | operator | Strict `{version:1,id:ID,command:DemoCommand}`; 202 plus retained control record, or 200 for an already terminal record |
| `GET /api/v1/controls/<id>` | viewer/operator | That operation's durable accepted/running/completed/failed/uncertain record; no private error details |
| `GET /api/v1/events` | viewer/operator | SSE replay then subscription; optional `Last-Event-ID` header |
| `GET /api/v1/evidence/<channel>` | viewer/operator | Bounded sanitized offer/policy/credits/checkpoints, verified public response envelopes needed to correlate receipts, and public chain transaction observations |

Only `/healthz` is unauthenticated: fixed liveness `ok` or `unavailable`, with no
identity/config/prompt detail. It makes no chain/model calls. Separate readiness
in authenticated status explains missing credential, identity, model validation,
storage, transport or chain gates. Read endpoints cannot change economic state.
Default limits: 8 concurrent SSE clients; 60 control attempts/minute per valid
operator token; 20 failed authentication attempts/minute per trusted proxy client
address plus 100/minute global; 5 seconds for finite HTTP requests. Cap connection
and idle-body resources; do not trust arbitrary forwarded headers for identity.

**FD-15.** `AgentEvents` is a durable source journal, **not a sanitizer**: its
current `data: Record<string,unknown>` API accepts arbitrary application objects.
Introduce exhaustive event-type schemas and explicit field construction at
emission/ingestion. Allow public user/model text, tool names/IDs and validated
question/query/source-URL arguments, byte counts, approved citation metadata,
verified statements and fixed status codes. Exclude model hidden reasoning,
raw model responses, fetched page bodies, auth headers, keys, secret-file paths,
environment, command arguments and stack traces. Never spread a private journal
or arbitrary tool result into public data. Provider undelivered output is private;
its panel receives only buyer-verified deliveries. Economic host automation is
labeled host, not attributed to an LLM decision.

Add local-only event types `runtime`, `connection`, `control`, `funding`,
`authorization`, and `chain_observation`; preserve every existing v1 event type
and all native wire schemas. `authorization` contains the actually saved signed
credit (including signature), separate from unsigned budget reservations.
`funding` records public submission/confirmation/failure state and digest.
`chain_observation` is built only from a fresh independently checked Sui object.
Lifecycle events preserve current append-after-durable-state publication order.
The current `AgentCoordinator.event()` suppresses sink errors; the demo path
must explicitly propagate/retain durable-publication failure, block admission
and enter recovery. A swallowed sink failure cannot be reported as complete
success. Public journal capacity is reserved before the corresponding bounded
task starts; callbacks after an economic effect retain an outbox publication
intent that can be completed from the canonical saved evidence on reopen.

**FD-16.** Source identity is `(conversation, machine_role, event.role, event.id)`.
Both Machines may emit `host:1`; those are different events. Coordinator keeps a
private durable projection that wraps every accepted source event with a global
decimal sequence, `source:"coordinator"|"provider"`, and the unchanged validated
source event. It tracks a separate high water for each source and event role.
Duplicate same-origin/same-content input is a no-op; changed content or a gap
poisons that source and disables new admission. Projection arrival order is not
a distributed causal clock; preserve original timestamps and correlation IDs.
No payment amount or text chunk is summed merely because another event arrived.

Provider read API is exactly `GET /internal/v1/status`, `/locator`, and
`/events?after=<base64url canonical source-role cursor>` under its dedicated
token. Poll replay at 500 ms while live (back off when unavailable), maximum
256 events and 1 MiB per response; include source high waters and `has_more`.
Pin source role/conversation/public configuration and validate before ingestion.
Provider HTTP events cannot advance coordinator economic balances: only verified
coordinator economic evidence/chain observations can. Events missed between a
crash and publication are imported from the retained source journals on reopen.

**FD-17.** SSE IDs are `<conversation>:<projection-sequence>` (ASCII, canonical
u64). Emit `event: agent_event` with one JSON projection record per frame. Send
`event: stream_status` at connection and 15-second comment heartbeats; these are
ephemeral and carry no economic deltas or durable IDs. `Last-Event-ID` replays
strictly after the supplied sequence and then follows live appends without a
snapshot/subscribe gap. Invalid, foreign-conversation or future cursors fail
before headers with a fixed 400/409 response, never silently reset to latest.

Persist before publishing. Snapshot API includes its exact projection high
water, so the UI can load it and subscribe after that point. Deduplicate by
projection sequence; assert source identities too. Slow clients may buffer at
most 256 KiB; on overflow close the socket and let durable replay recover. SSE
uses no-store and uncompressed streaming responses; renew authentication at
least every 60 seconds for open connections. Secrets rotated out of memory must
lose access. A browser reload can reauthenticate and rebuild from sequence zero.

Keep existing bounded source journals and a projection cap of 16 MiB / 16,384
records. Do not evict unresolved events or silently truncate history. Reserve
conservative publication headroom before admitting a bounded task; refuse new
work before the journal's remaining capacity cannot cover that task and recovery
events. A full/corrupt journal is a visible readiness failure, not permission to
use an in-memory history. Publish no synthetic success if durable publication
failed after an economic action; recover it from retained canonical evidence.

## 5. UI and accounting

**FD-18.** Build React + TypeScript + Tailwind through Vite. Desktop uses two
equal panels, coordinator left and research right, with a shared channel strip
and task/control area. Small screens stack in the same order. Show name,
qualified Agent ID/details, actual model/runtime label, Iroh state and current
task state. Show real public text/actions, sent question/received response
relationships, actual source citations and bounded status messages. Public
action explanation means emitted public text/tool activity, not model chain of
thought. Render untrusted text as text; no raw HTML or executable Markdown.
Source links permit validated HTTPS, use safe new-tab attributes and disclose
external navigation. Animations follow new durable events, respect reduced
motion and do not replay money movement on reconnect. Accessibility includes
keyboard controls, clear focus, form labels, text state alongside colors and
restrained live announcements.

**FD-19.** The shared strip uses integer/BigInt arithmetic with the existing
policy price function; never floating-point money. Show exact MIST, optionally
SUI decimal formatting. The selected channel has these distinct values:

| Label | Definition/evidence |
|---|---|
| Deposit | Verified opening `offer.deposit`; pending fund is explicitly pending |
| Signed authorization | Latest actual saved signed Credit `cumulative_amount`; do not sum cumulative credits |
| Reserved maximum | BudgetLedger's greatest unsigned-or-signed reserved liability; explicitly different from signed authorization |
| Delivered | Latest verified cumulative checkpoint units and their exact cumulative policy price |
| Outstanding authorization | While terminal settlement is unconfirmed, `max(signed_authorized_mist - delivered_mist, 0)`; zero after independently confirmed close/refund |
| Reserved exposure | While terminal settlement is unconfirmed, `max(reserved_mist - delivered_mist, 0)`; zero after independently confirmed close/refund |
| Redeemed/paid | Independently confirmed channel `redeemed_amount`, including terminal exact close |
| Locked | Independently confirmed channel `funds`; unknown/stale if RPC fails |
| Refunded | Confirmed terminal `deposit - redeemed_amount`, with channel funds zero and the actual terminal digest |
| Gas | Confirmed transaction gas fields, separately identified; never part of delivered price/refund |

Zero prior to first observation means known zero only when established by the
corresponding state; otherwise display unknown. Show last observation time and
pending transaction digest. A signed authorization is immediately redeemable
under the selected advance-payment method; delivered evidence is not required
for that advance. If redeemed value exceeds delivered price, show it honestly
and block incompatible exact close using existing rules. Do not clamp away a
real accounting discrepancy. Keep settled prior-channel spend separate from the
selected channel and retain a channel history selector.

Display-semantics correction, 2026-09-11: confirmed terminal Sui state eliminates
the channel's active redemption exposure; `BudgetLedger.observe` releases its
active reservation to confirmed paid value, and the existing Move channel rejects
further redemption. Preserve historical signed/reserved maxima and delivered/paid
amounts for audit, but do not label their remaining numerical difference current
exposure. Zero exposure requires independently confirmed CLOSED/REFUNDED state
with the checked terminal evidence and empty channel funds. Model completion,
pause/cancel, locally signed final consent, a submitted close, or failed/stale RPC
does not satisfy that condition. Until confirmation retain the conservative
exposure calculation. This changes demo display semantics only, not payment
signatures, budgets, Move ABI or settlement rights.

**FD-20.** UI controls submit real API operations and display pending/terminal
acknowledgements. Disable controls according to authoritative host predicates,
but the server enforces every predicate independently. Show start, fund with
exact terms, send task, cancel, spending pause/resume, Iroh disconnect/reconnect,
explicit close, and expiry refund when permitted. Browser event reconnection is
automatic with the last durable cursor; it is visibly different from the Iroh
disconnect control. Duplicate clicks reuse a pending command ID. Never auto
submit a task, fund, resume spending, close or refill on component mount.

**FD-21.** Tests may compose explicit fixture runtimes and event records and
show a persistent `TEST FIXTURE — no live agents or payments` banner. They are
reachable only from a test harness/build, not a query parameter, environment
toggle accepted by the production runner, demo UI mode or failure fallback.
The production build imports only real same-origin API code. Missing credentials,
quota, backend failures, empty state and disconnected APIs produce honest
disabled/error/unknown UI. A recorded-session product is outside this slice.
Constructor-only runtime injection has the exact typed interface in the
implementation plan and is restricted to explicit loopback-localnet harnesses.
Its manifests retain a test marker that the production path rejects on reopen;
test model/source factories never read ambient model/search credentials. Omitting
chain/bridge overrides in that harness deliberately exercises real localnet Sui
and Iroh while continuing to label the injected inference as a fixture.

## 6. Fly envelope and evidence

**FD-22.** Deployment artifacts target only a manifest of two newly selected
app names, organization, explicit regions, exactly one Machine/app, exactly one
1-GiB volume/app, `shared` CPU, one vCPU and 1024 MiB RAM/Machine. No autoscaler,
HA replica, GPU, dedicated IPv4 purchase, automatic VM upsize or volume extension.
Larger resources need an explicitly revised deployment envelope. Resource limits
are not a dollar-price claim. Record current estimate before creating resources.
Existing unrelated apps, including the legacy m2m Iroh PoC, are out of scope.
All mutating Fly commands use explicit app/config/organization/recorded target
IDs; never infer targets from another directory's `fly.toml`.

Coordinator HTTP binds port 8080 with HTTPS required, autostop `off`, autostart
`false`, bounded HTTP concurrency and streaming idle timeout. Provider declares
no public HTTP/TCP service/IP; private listener binds `fly-local-6pn:8081`.
Both run actual Iroh with relay support enabled and persist its endpoint key.
Current native-bridge accepts `--relay`; the existing local runner omits it.
Use provider locator bootstrap over private authenticated HTTP, verify its
endpoint key, save the bounded ticket privately, then establish Iroh. Do not
claim direct connectivity without instrumentation; encrypted relay traffic is
valid Iroh. Do not add a new Rust protocol or HTTP transport shim for deployment.

Each app receives only its role's secrets. Model and search API secret files use
the adapter's explicit inputs; view/operator tokens go only to coordinator;
private observer token goes to both; provider receives only its own keys and
search/model credentials. No wallet/Fly token/model key in the image, build args,
repository, browser bundle or logs. Build a release bridge with Cargo.lock and
lockfile-pinned JS dependencies in a multi-stage image; run a nonroot host user.
Images contain runtime code, release bridge and built UI, not `.m2m`, key stores,
operator files, model histories or test fixtures.

**FD-23.** Boot has no provisioning/funding/release command. Controlled shutdown
uses SIGTERM with a 30-second Fly best-effort timeout; SIGKILL recovery is tested.
Deployment updates the recorded Machine/volume with a single-writer replacement
strategy; refuse creation of an extra writer/empty volume. Keep autostop off
during the bounded demonstration; Iroh/background model activity is not an HTTP
traffic-based liveness guarantee. Operator end-of-run stops the two recorded
Machines only after reviewing channel/recovery state and retains volumes and
journals. No cleanup automatically destroys apps, disks or state. Do not auto
fund Sui or provider API accounts.

**FD-24.** Completion requires all FD validation rows in the implementation
plan, including real model isolation/continuation, real search/fetch, two Fly
Machines, named testnet identities, an independently checked opening and exact
settlement/refund, browser replay and real transport/process recovery. Offline
UI tests, API availability and fixture/localnet evidence are separately reported.
Do not prefill successes or describe an unrun live row as passed. Missing model,
search, name-controller/funding access or Fly authorization is a concrete live
gate; complete every independent local artifact/test first.

## Checked upstream guidance

The following are living official docs, checked 2026-09-11, not version pins.
Project choices above deliberately describe a bounded demonstration.

- Fly configuration defines service ports, HTTPS, autostop, mounts, VM resources
  and best-effort shutdown; its release-command Machine has no persistent volume.
  [App configuration](https://fly.io/docs/reference/configuration/).
- Fly volumes are local to one host/region, have no built-in replication, and a
  single Machine/volume can lose availability/data. The chosen single-writer demo
  accepts downtime and requires protected backups/recovery instead of claiming HA.
  [Volumes overview](https://fly.io/docs/volumes/overview/).
- Fly app secrets are available to every Machine in an app; changing secrets can
  restart Machines. This motivates separate apps and deliberate staged updates.
  [Secrets](https://fly.io/docs/apps/secrets/).
- Fly private `.internal` DNS and `fly-local-6pn` support the observation link;
  started Machines appear in its address records.
  [Private networking](https://fly.io/docs/networking/private-networking/).
- Proxy autostop is service/traffic based; explicitly disable it for this bounded
  background workflow. [Autostop/autostart](https://fly.io/docs/reference/fly-proxy-autostop-autostart/).
- Tailwind's current Vite integration uses `tailwindcss`, `@tailwindcss/vite` and
  the CSS import. Pin the resolved releases in the UI lockfile when implementing.
  [Tailwind with Vite](https://tailwindcss.com/docs/installation/using-vite).
