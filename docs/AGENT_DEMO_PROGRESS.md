# Live investor demo: completion ledger

Updated 2026-09-11. The user authorized autonomous work through an
Astra `xhigh` specification → Luna `xhigh` implementation → Astra `xhigh` review
pipeline. Completion means the real [demo requirements](LIVE_DEMO_PROPOSAL.md)
and the remaining named-testnet requirements of GitHub issue #1 are verified;
passing fixtures, a rendered mockup, or a deployable image alone is insufficient.

## Usage-interruption recovery (2026-09-11)

Recovered the substantive local transcript from session
`01a08e1a-a948-7172-a3e9-e5acc566a142`; the supplied recovery-session ID
`01a09012-330c-76e1-a2c0-bcee4cb0c7b8` had only two summary requests in local
input history. The substantive session ended with usage-limit errors while
runtime corrections and the new operator export were unfinished.

On resumption, TypeScript checking passed, but the real-local-Iroh separate-root
boot regression reproduced both L01 (missing coordinator ticket) and L02
(reopen before first start: `journal_missing`). L01 now saves the validated
endpoint atomically in the coordinator's private root, compares the full provider
AgentRef and refreshes provider authorization before writing/connecting. The
`ticket` boot case passes with no inference or funding; wrong domain,
configuration and endpoint key reject before ticket creation or connection.
This is a bounded local correction, pending independent review.

L02 now has a durable [component initialization registry](AGENT_DEMO_COMPONENTS_SPEC.md).
Restart before first connection passes with separate-root real local Iroh.
Missing budget/coordinator/worker/registry state rejects before worker or
connection callbacks; missing exchange/stream/client state also rejects without
another funding callback. The explicit chain-stub test initializes a first
channel after restart, then reopens both retained roles and their original
client/channel/budget with one total funding callback and no inference.
Interrupted-constructor tests preserve an actual BudgetLedger reservation and
reject missing partial results. These local corrections await independent
review. Complete init/export, L03–L05, live adapter validation and deployment
remain outstanding; the production model gate remains closed.
The [local recovery validation record](validation/agent-demo-initialization-recovery-2026-09-11.json)
captures the source hashes, passing commands and explicit limits, including the
unproven automatic peer-loss/relisten timing. The boot/recovery suite,
agent-services suite, TypeScript check and production server build pass.

## Required end state

| Deliverable | Evidence needed | Current evidence/status |
|---|---|---|
| Narrow live model adapter | Actual registered tool calls, disallowed dispatch rejection, continued conversation, cancellation/recovery and bounded spending/API usage | Latest bounded review returned coalesced SSE, completed-replay continuation and live-probe assertions to Luna; no live call; production stays gated |
| Two genuine research agents | Real model-selected questions/follow-ups, actual search/fetch/citations, no canned answer or fixture fallback | Not run; model and search credentials not currently supplied |
| Continuing paid conversation | Multiple requests, incremental signed credit, exact delivered-byte accounting, explicit close, retry/restart recovery | Existing real Iroh/Sui localnet evidence uses fixture inference; repeat with live inference required |
| Named testnet identities | Valid parent ownership/lifecycle, both leaves resolving to pinned native Agents, separate operational keys | Parent verified read-only; leaves absent and controller wallet path missing |
| Two Fly Machines | One role per Machine, persistent private state, actual Iroh exchange, recovery without new identity/deposit/work | Fly access verified; native deployment not created |
| Tailwind split-screen UI | Rendered browser checks and interaction with the real authenticated backend; sanitized replayable events | Shared validator installed in API/reducer; 23 UI tests, 13 root regressions, six production-browser failure cases and desktop/mobile layout pass. Actual DemoApi + HTTP host replay/control test passes with explicitly injected runtime; live browser evidence pending |
| Honest payment display | Authorized, delivered, redeemed, remaining/refunded amounts kept distinct; independently checked chain state | Existing engine/accounting tests, no live browser evidence yet |
| Real controls and failures | Start, cancel, spending pause, reconnect, explicit settlement, unavailable credentials and uncertain execution | Existing local controls cover a subset; hosted lifecycle/HTTP/control tests required |
| Independent final review | Astra review of implemented code, test coverage and live evidence against frozen requirements | Pending |

## Current preflight

The [read-only preflight](validation/agent-demo-preflight-2026-09-11.json) records
available Fly access and the current SuiNS parent/leaf state. No mainnet request,
public-chain transaction, Fly resource creation or unrelated-app modification was
performed. API/search credentials and the controlling wallet must be supplied as
protected operator inputs; do not paste secrets into source, chat, prompts or logs.
Existing Codex authentication is not treated as an OpenAI API key.

A real HTTPS-only probe also found a Node pinned-DNS callback mismatch that
injected HTTP tests did not cover. Luna repaired the production request builder
and added a real Node networking regression using that same builder. Production
bounded fetches of Fly and Iroh robots.txt now succeed with citation records;
the regression passed independent Astra review. The sampled Fly/Iroh HTML bodies exceed
the existing 128-KiB fetch cap independently; the Fly documentation fetch correctly
reports `limit_exceeded`. No LLM, search or payment was involved in this probe.

Implementation contracts are [runtime](AGENT_RUNTIME_IMPLEMENTATION.md) and
[Fly/UI](FLY_AGENT_DEMO_IMPLEMENTATION.md). Their acceptance matrices distinguish
offline tests, standalone live adapter acceptance, actual two-LLM research and
the deployed investor demonstration. A production runtime gate remains in place
until the standalone live adapter evidence and Astra review pass.

The shared [accounting/replay vectors](../tests/agent-demo/README.md) pass their
independent oracle check (`npm run agent-demo-vectors`). UI and backend reducers
must still consume them through actual implementations; this check is not F10–F13
acceptance. `npm run agent-runtime-tests` is wired to the new runtime smoke test files;
the repaired candidate passes root's local suites, but Astra's ongoing re-review
has reproduced additional timeout, byte-accounting, output-validation and
cancellation/recovery failures. Its
[consolidated ten-group correction](validation/responses-runtime-astra-rereview-2026-09-11.md)
is frozen and returned to Luna with failing-regression-first instructions.
The [runtime validation log](AGENT_RUNTIME_VALIDATION.md) records the reproduced
coordinator review failures and outstanding adapter checks; passing the current
smoke tests does not establish runtime acceptance. The stricter root runtime seam
now passes its zero-unnecessary-recovery-GET assertion on the repaired candidate. The
[UI validation log](AGENT_DEMO_UI_VALIDATION.md) distinguishes the initially
failed checks, corrected narrow passes and further independent review blockers.
The shared [event contract](AGENT_DEMO_EVENTS_SPEC.md) now has a root-coordinated
neutral helper API. The E1–E7 and subsequent ER corrections have been reviewed;
its additive event literals alone do not demonstrate emitters.
The helper's five returned correction groups now pass on hash `8c3cae326f41…`,
including all seven actual Chromium checks. Astra's
[bounded re-review](validation/agent-demo-event-contract-er-rereview-2026-09-11.md)
accepts that boundary for real L1/L2/UI integration without claiming host or live
acceptance. L2 authentication A01–A03 is accepted at its corrected hashes.
The [bounded actual-host review](validation/agent-demo-l2-review-2026-09-11.md)
returned H01–H06 (provider startup, evidence output boundary, replay paging,
failed-publication admission, startup cutover and SSE shutdown) for correction.
Root is checking the container and browser-to-host path in parallel.
Root also added a coherent full public test session around the signed economic
fixture: `npm run agent-demo-public-fixture-tests` checks pins, signatures, source
cursors, byte reconstruction and amounts with no chain or live-agent claims.

The initial separate-wallet provisioning handoff required correction: tests
exercised an unused helper; fresh controller preflight and immutable setup
authority pins were incomplete. These are recorded with the
coordinator findings in the [Astra setup review](validation/agent-demo-coordinator-setup-review-2026-09-11.md).
Root confirmed the real CLI rejects mainnet selection and invalid name-wallet
option combinations before key reads, and importing it does not execute setup.
Those narrow positive checks do not establish the production-path guards. Luna's
new frozen L0 candidate now calls the helper from the real CLI, adds all-existing
Agent preflight and admission pins, and passes root's local setup suite including
a separate actual NativeChain.execute mocked-SDK replay check. Astra review is
complete: [four bounded setup corrections](validation/agent-demo-setup-rereview-2026-09-11.md)
remain around missing initialized recovery state, operational-key pins and fixed
error output. Per-role export acceptance remains pending the real hosted composition.

Root reran `npm run native-tests` and `npm run agent-services-tests` at
approximately 07:42 UTC; both passed, including the explicit fixture-payment
and crash cases. Agent-services passed again at approximately 08:11 UTC after
the additive local event type change and coordinator corrections. Live inference
and new hosted lifecycle remain separate gates. The
[new Astra review](validation/agent-demo-coordinator-ui-review-2026-09-11.md)
freezes C5b and U1–U6 against the reviewed hashes; later source edits still need
their own independent acceptance, not inherited green status. Astra's subsequent
new-hash C5b review passes the exact shutdown/reopen probe and verifies that
reverting its guard makes the checked-in regression fail in 11/11 isolated runs.

At approximately 08:58 UTC root again completed both `npm run native-tests` and
`npm run agent-services-tests` with exit code 0. The native parsing/signing,
streaming-engine, research, replay and existing service tests remain green,
including their explicitly labeled fixture payment/crash cases and early live
enablement refusal. No live-model or hosted-runtime acceptance follows from
these regression passes.

By approximately 09:03 UTC the broader
[foundation/compatibility rerun](validation/agent-demo-foundation-regressions-2026-09-11.json)
also passed: 45 Rust tests (2 explicitly ignored legacy-provider integrations),
29 native streaming Move tests, 25 legacy Move tests and existing independent
signature/message/recovery vectors. The native suite includes actual Iroh and
independent TypeScript peer exchanges, not live inference or new Sui transactions.

## Deployment preparation (not deployed)

The proposed bounded layout is coordinator in `iad`, provider in `ams`, each
with one shared vCPU, 1024 MiB RAM and one 1-GiB volume in a new app. This makes
the Iroh check cross-region; direct versus relay still requires actual observation.
App/Machine/volume IDs and image digest are not allocated yet. The existing PoC
app remains out of scope.

Fly's region-specific table, checked 2026-09-11, lists $5.70/30 days for the
`iad` Machine and $5.92 for `ams`; two volumes add $0.30/month. Approximately
$11.92/month is a compute/storage baseline if continuously running, not a total
demo quote. Model/search usage, egress, stopped root filesystems and snapshots
are separate. Volumes remain billable when stopped. Recheck before creation.
[Fly pricing](https://fly.io/docs/about/pricing/).

The [deployment packaging](../deploy/agent-demo/README.md) now includes pinned
multi-stage images, deny-by-default BuildKit contexts and two role templates.
Both TOMLs pass Fly's strict configuration validator. A complete candidate image
has built; import-safe nonroot execution passes. This is not ready-host/live
acceptance. The candidate's actual production command also passes the explicit
network-disabled blocked-boot test: static HTTP 200, unauthenticated API 401,
authenticated readiness/funding 503, no manufactured economic state, clean
SIGTERM. The [UI/HTTP integration record](validation/agent-demo-ui-host-integration-2026-09-11.json)
records the separate actual browser-client/reducer/HTTP path with an injected
test runtime. A temporary local Docker 29.8.0 / Buildx 0.37.0 builder is running on a
private Unix socket using verified available sudo namespace support. Its bridge
stage has built and its real executable runs as UID 1000 with networking disabled.
The [container preparation record](validation/agent-demo-container-preparation-2026-09-11.json)
captures these bounded results. The production UI and locked production-dependency stages also build; actual SDK
imports pass under the same nonroot/network-disabled test. Image snapshots must
be rebuilt after owner corrections; a mid-edit missing-module build failure is
not acceptance of the previous image. No system daemon installation or remote
builder was needed.

The NR01–10 runtime correction handoff now passes root's `agent-runtime-tests`
and `agent-runtime-integration-tests` on worker hash `325bfdc20c2d…` and transport
hash `407fddd38d18…`. The [subsequent NR09/R14 review](validation/responses-live-probe-review-2026-09-11.md)
narrows the outstanding adapter corrections to three demonstrated seams plus
the live-probe proof obligations. L1 now has an implemented handle; direct
lifecycle acceptance tests are being completed. L2 H01–H06 repairs and the
adapter repairs run concurrently. Production/live gates remain intact.

Local Node 22.23.2, Cargo 1.97.1 and flyctl 0.4.101 are available. The locked
release build of `native-bridge` passed; its checksum is recorded in the preflight
report and its CLI includes relay support. This is build evidence, not a
container or cross-Machine exchange. Cached
Playwright Chromium binaries are present for UI validation. The initial rootless
user-namespace attempt failed at UID-map write; the later explicitly local
sudo-backed temporary builder above works. No remote builder or extra Fly
resource was created.

The new adapter is an explicit runtime decision above m2m. Iroh, Sui, separate
transport/economic keys, signed economic bytes, original text-worker behavior and
durable outstanding agreement rights are preserved. Old Codex journals must not
be relabeled as new adapter state. No hidden fallback or reduced acceptance claim
is permitted when a live dependency is missing.
