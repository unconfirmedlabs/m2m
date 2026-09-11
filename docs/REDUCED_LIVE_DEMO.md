# Reduced live research demo

Status: **authoritative first-demo specification**, accepted scope replacement
2026-09-11. This document supersedes the two-LLM completion criteria in
[LIVE_DEMO_PROPOSAL.md](LIVE_DEMO_PROPOSAL.md), the Fly/agent-services application
plans, and their completion ledger. It does not supersede native wire, signing,
identity or settlement contracts. Pipeline: Astra medium specification → Luna
xhigh implementation → Astra medium review. The specification pass itself changed no implementation; the subsequent Luna
implementation is recorded in
[validation/reduced-live-demo-implementation-2026-09-11.md](validation/reduced-live-demo-implementation-2026-09-11.md).
That record does not establish live acceptance.

[GitHub issue #1](https://github.com/unconfirmedlabs/m2m/issues/1) was read on
2026-09-11; it already permits a deterministic coordinator. Its broader protocol,
recovery and multi-policy requirements remain follow-on work where excluded below.
The issue was not edited. Historical reviews remain evidence at their recorded
hashes; inspect current code and reproduce relevant findings before closing them.

## Participants, workflow and topology

- The human operator supplies research questions, approves a fixed spending cap,
  submits any follow-up, and explicitly closes the channel.
- `local.nozomi.sui` is deterministic buyer software. It forwards the user's exact
  prompt, serializes requests and mechanically replenishes credit within limits.
  It never invokes an LLM, invents a follow-up or evaluates answer quality to pay.
- `research.nozomi.sui` is the provider: one real `gpt-5.6-luna`, reasoning `xhigh`,
  through the existing candidate `responses-tools-v1` adapter. It chooses bounded
  search/fetch calls and produces streamed text with citations. This explicitly
  uses the Responses adapter, not the original Codex text-worker runtime.

Run two separate native Linux processes on the existing local host, each with its
own private durable role root and one writer per Agent. Use the existing Rust
`native-bridge` and real Iroh between them; no in-process exchange substitutes.
The browser reaches a loopback authenticated HTTP control/event service (an SSH
port forward is sufficient from the operator's Mac). HTTP is for UI/control only;
research requests, responses and signed payment messages traverse Iroh. Sui
identity, funding and close use **public testnet**, never a local chain substitute.
Model/search APIs are real external dependencies. Same-host execution is an
operator deployment choice, not independent-business or cross-region evidence.
Fly, containers and browser-native Iroh are not first-demo dependencies.

The concrete experiment is two user-driven research turns under one deposit,
with a restart between turns and one explicit close. Against a composition that
funds each request separately, measure funding transaction count, incremental
credit during a response, retained request/channel state and exact refund. This
is a technical coordination experiment; no customer-demand claim is established.

## Frozen behavior

1. Preflight validates testnet network/package/domain, both SuiNS leaves and their
   valid parent, pinned qualified AgentRefs, fresh controller/operational authority
   and distinct transport/economic keys. Names must actually resolve; labels alone
   do not pass. Existing agreements retain their original authority snapshots.
2. Establish authenticated Iroh and exchange a signed unpaid echo before funding.
   Validate the provider's accepted runtime/profile and tool-isolation evidence
   before admitting funding. Missing credentials/model access/search or validation
   fails visibly; never select fixtures, another model or an old text-only run.
3. The operator starts one conversation. Pin the exact offer, policy, limits,
   destinations, opening nonce and signers; fund exactly one cumulative channel.
   Do not automatically replace it or fund again on restart/retry.
4. Each user submission gets a durable request ID and exact prompt commitment
   before dispatch. Only one request runs at a time. Use
   `service.research.conversation.v2` over `payment.sui.streaming.v1`, retaining
   existing canonical bytes, domains, receipts and sequence meanings.
5. Reuse the two-counter policy `[input_utf8_bytes, output_utf8_bytes]` with rates
   `[0, 1]`, denominator `1`: one MIST per delivered output byte, zero input fee.
   Both counters remain present. Price is the existing cumulative integer ceiling
   formula; do not change codecs or count tokens, SSE framing or transport packets.
   Default output credit tranche is 256 bytes. Set deposit/total cap to 100,000
   MIST, per-turn cap to 40,000 MIST, outstanding exposure cap to 1,024 MIST, and
   maximum new requests to two. These are demo values, not commercial pricing.
   Operator limits may be lowered before opening; require enough credit/deadline
   for the accepted run, pin the resulting config, and never increase it mid-run.
6. Buyer signs an initial bounded credit; provider persists/acknowledges it before
   work. As checkpointed bytes arrive, buyer signs higher cumulative credits
   referencing that request/checkpoint. Provider delivery never exceeds acknowledged
   credit. Acceptance requires at least two increases after the initial credit
   **during one unfinished live response**, evidenced by ordered events. A short
   answer that does not exercise this is an incomplete gate, not permission to pad
   or script output. Never wait for final-answer approval to pay.
7. Retain existing bounded web policy: at most three searches and eight fetches per
   request, five search results, 128 KiB per response, 512 KiB total received,
   64 KiB extracted text, allowlisted HTTPS with address/redirect checks. Keep the
   provider's resolved `responsesLimits('provider')` caps, including 120-second
   duration and 32-KiB output, and persist all effective limits/fingerprints.
   Only registered `web_search`/`web_fetch` tools may dispatch. No shell, filesystem
   or arbitrary-network model tools. Source text is untrusted. Upstream API costs,
   reasoning and generated-but-undelivered bytes are separate from the bill.
8. After turn one has a durable terminal receipt with continuation ready, leave
   the channel open. Stop both processes cleanly, wait for local writers to quiesce,
   then reopen the same roots. Compare identity, channel, nonce, request ID/hash,
   receipt, checkpoints, credits, budget and model predecessor before/after.
   Replay the completed request with zero new model/search calls, credit or funding;
   then submit one new user follow-up on the same channel. This proves a controlled
   between-turn restart, not automatic recovery of in-flight model execution.
9. After turn two, explicit Close obtains the final signed checkpoint/consent and
   calls existing exact settlement. Confirm the Sui transaction and read the channel
   independently. Show unknown/pending until confirmed; never infer settlement from
   an HTTP response, signed credit or animation.

Deposit is locked escrow, authorization is a cumulative redeemable ceiling, and
delivered value is the exact checkpointed byte price. They are not interchangeable.
The provider's existing unilateral rights can expose outstanding authorized value;
cooperative close settles exact delivered value. Preserve redemption/expiry/refund
paths, but live demonstrations of each are deferred. On uncertainty, stop new work
and credit, retain journals and surface operator reconciliation; do not silently
retry external work or declare cancellation/refund complete. No guarantee of useful
research, fair exchange, token-level compute backpressure or proved model execution.

## Thin UI and acceptance gates

Reuse React/Tailwind and existing authenticated events/reducers. Show user prompts,
streamed provider text, clickable ledger-backed citations, connection/request state,
deposit, cumulative authorized value, delivered bytes/value, confirmed redeemed
value, locked remainder, refund and settlement digest/status. Label the buyer
“user-driven coordinator.” Controls required: Submit, status and explicit Close;
restart is an operator process action. Disable submission while busy/uncertain or
closed. Hide autonomous-planning and deferred failure controls in this profile.
No hidden reasoning, fabricated activity, cumulative-credit summation or secrets.

| Gate | Exact pass condition and retained evidence |
|---|---|
| RD-0: safe live provider | Reviewed current adapter/profile; real no-payment Luna xhigh tool round trip and retained-context follow-up; observed allowed dispatch and rejected disallowed dispatch, finite deadlines/byte/tool/API budgets. Corrected harness must correlate calls/results/predecessors; constant sentinel booleans or submitted schemas alone are insufficient. Missing dependency fails before funding. |
| RD-1: identity/transport | Fresh testnet parent/leaf and Agent/key verification; both process/root identities and actual Iroh admission records; signed unpaid echo with no channel yet. Record direct/relay only if observed. |
| RD-2: paid research | One confirmed funding digest/channel; unseen operator prompt, actual search plus at least one successful source fetch, response citing that ledger entry; signed initial credit plus at least two mid-response increases, acks and output checkpoints. Independently reconstruct UTF-8 bytes and cumulative prices; every checkpoint within acknowledged credit and every credit within caps. |
| RD-3: controlled restart | Actual process exit/new PIDs and retained-root reopen between turns; identical economic/request state and zero external effects on completed replay; successful live user follow-up on that same channel with retained provider conversation predecessor. Exactly one funding transaction for both turns. |
| RD-4: UI and exact close | Browser against the actual backend shows both turns/citations and correct distinct amounts through restart and explicit close. Independent read-only Sui verification matches channel/offer/signers, successful terminal transaction, payee proceeds and buyer refund; total provider receipts + refund = original deposit, terminal locked amount = 0. For this run with no interim redemption, provider proceeds = final delivered byte price. Account for gas separately. |
| RD-5: review | Astra medium reviews current implementation, relevant regressions and fresh RD-0–4 evidence. No live gate can pass using old Codex, localnet, fixture, UI-mock or legacy Fly evidence. |

A small bounded event history is sufficient. Prefer cursor polling using existing
paged source/projection interfaces if SSE replay cannot safely handle the actual
two-turn history. Do not truncate accounting evidence or accept a blank connected
UI. Support UI reconnect across this run without duplicated text or money; large
history stress support is deferred, not ordinary two-turn replay correctness.

The run bundle must record UTC timestamps, source/lockfile hashes, effective runtime
and budget config, nonsecret topology/pins, request IDs, actual model/tool call
metadata, citation ledger, signed offers/credits/acks/checkpoints/receipts, exact
output bytes, restart comparisons, browser evidence, Sui digests/raw observations
and a read-only verifier report. Keep private journals/credentials separate from
sanitized shareable artifacts. Independent amount/signature reconstruction must
not merely echo UI totals; this is bounded verification, not new interoperability
or production-readiness evidence.

## Implementation tranche and dependency order

Pre-implementation inspection on 2026-09-11 found that `openAgentWorker` still
threw `agent_tool_runtime_unvalidated` and the demo runtime still called
`AgentCoordinator.run`. The implementation record documents the replacements on
this reduced path. `agent-services.ts` and the original coordinator remain intact
for compatibility. `AgentServiceClient.execute` owns request budget admission and
mechanical incremental credit; the reduced path keeps `BudgetLedger` without using
the coordinator's model/planner.

| Order | Required implementation / reuse | Old work outside this path |
|---|---|---|
| 1. Provider gate | Revalidate current `responses-transport.ts`, `responses-worker.ts`, `test-responses-live.ts` against the [bounded adapter review](validation/responses-live-probe-review-2026-09-11.md): ordinary coalesced SSE, terminal replay/continuation and live-harness proof obligations. Current source contains later repairs; records alone neither prove they remain broken nor accept them. Run RD-0, then enable only the reviewed provider profile through the production factory. | Second-LLM R15 and coordinator-specific model tests are not factory-enablement prerequisites for this profile. Original Codex AS-20 gate remains intact. No direct-worker bypass of production gating. |
| 2. Deterministic composition | Add a small explicit reduced-demo entry point/supervisor using `AgentServiceHost`, `ResearchConversationService`, `AgentServiceClient`, `BudgetLedger`, `DurableAgentExchange`, `StreamingEngine`, `StreamingChain`, `NativePeer`/`IrohBridge`, `BoundedWebTools` and `DemoComponents`. Adapt existing lifecycle/control plumbing for direct user submissions and separate role roots. | Remove `AgentCoordinator`, its worker factory/profile and automatic planning from this runtime path; keep their files, tests and historical journals. Do not resurrect the legacy fixed-file or tool-disabled native demo as the research service. |
| 3. Identity and retained state | Reuse `native-setup.ts`, `native-names.ts`, native authority checks and transaction journals. Enforce explicit create/reopen, role-wide locks, immutable model/tool/key/config pins and safe errors. Verify separate-root locator and initialization repairs (L01/L02); fix relevant L03–L05 and setup SR01–SR04 before using those paths for testnet. Reuse export only if needed for role-root preparation. | Generalized Fly secret/export automation and automatic recovery at every interrupted setup/worker boundary are deferred. Missing/ambiguous setup state may fail closed for manual reconciliation; it must never trigger new signing/funding automatically. |
| 4. UI/evidence | Reuse `agent-demo-server.ts`, auth/projection/event-contract modules and `ui/agent-demo` where useful. Bind controls directly to the deterministic supervisor. Fix current H02 evidence serialization/requested-channel binding if present on reused paths; verify valid native terminal receipts end to end. Add minimal polling if necessary for bounded replay. | H03 very-large-history SSE work, expanded failure dashboard, split-screen polish and unused hosted lifecycle features are deferred. Do not delete their review records. |
| 5. Prove then run | Add meaningful deterministic-supervisor, retained replay/budget, startup-gate and close/evidence regressions. Run typecheck, relevant runtime/service/boot/UI/accounting checks plus native compatibility checks; record exact commands and hashes. Then provision/validate names and execute RD-1–4 on testnet, followed by RD-5. | No new protocol, Move ABI, pricing engine or wire schemas needed. Do not expand this tranche into generalized autonomous orchestration. |

Relevant defect records remain in the [L1 review](validation/agent-demo-l1-first-run-review-2026-09-11.md),
[setup review](validation/agent-demo-setup-rereview-2026-09-11.md),
[H02/H03 review](validation/agent-demo-l2-rereview-2026-09-11.md) and
[progress ledger](AGENT_DEMO_PROGRESS.md). A deferred feature does not excuse a
reachable budget, authority, secret-disclosure or state-corruption defect. Scope
it out by removing the runtime entry path or fail closed, not by waiving safety.
Preserve [native/legacy compatibility](NATIVE_COMPATIBILITY.md), exact signed bytes,
Agent/controller/key distinctions, configurable generic service policies and unpaid
messaging. This tranche changes application composition, not those contracts.

## Operator inputs and explicit deferrals

Required protected inputs: an OpenAI API credential authorized for the exact model,
Brave credential, testnet funding/controller and parent-name authority wallet paths,
separate per-role transport/economic key files, writable private state roots and
UI bearer credential. Required nonsecret inputs: testnet RPC/package/domain and
Agent/name pins, allowed fetch hosts relevant to the user's topic, prompt/follow-up,
absolute work/close/refund deadlines compatible with the existing offer contract,
and the pinned budget config above. Validate wallet authority and fresh name state;
the old preflight is not current provisioning evidence. Report missing inputs as
blocked gates; never copy secrets into prompts, logs, source or evidence. The exact
implemented commands are recorded in the implementation validation record and the
deployment runbook; provisioning and live acceptance remain operator dependencies.

Explicitly deferred: second LLM coordinator, Fly/cross-region deployment,
exhaustive live cancellation/pause/disconnect/expiry/redemption demonstrations,
automatic recovery at every crash boundary, very large SSE history, multiple live
pricing policies, channel replacement, many simultaneous conversations and broad
UI polish. Existing tests and failure records stay. The chosen controlled restart
and fail-closed uncertainty handling are mandatory. No unavoidable design choice
remains; credentials, testnet provisioning and live acceptance remain operator and
execution dependencies.
