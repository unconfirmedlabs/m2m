# Agent demo UI: validation in progress

Checked 2026-09-11. Requirements are FD-13–21 in the
[Fly demo contract](FLY_AGENT_DEMO_SPEC.md) and the
[L3 assignment](FLY_AGENT_DEMO_IMPLEMENTATION.md). No live browser/backend,
model, research, Iroh, Sui or Fly acceptance is claimed here.

## Initial handoff evidence

Root independently ran the handed-off UI at approximately 07:34–07:37 UTC:

- `npm test` in `ui/agent-demo`: 4 files / 12 tests passed.
- `npm run build`: TypeScript and Vite production bundle passed.
- `npm run smoke`: one Playwright login-screen test passed.

The screenshot and smoke test show only the unauthenticated login screen, not
the split-screen dashboard. Existing HTTP fixtures do not render an authenticated
dashboard or demonstrate control/reconnect/payment behavior. The initial green
checks do not establish L3 completion. Production code has no fixture fallback;
fixture-only tests must retain that boundary.

## Root regression findings

`npm run agent-demo-ui-contract-tests` directly exercises the actual browser API,
event reducer and accounting helper with explicitly injected test inputs. All
seven checks failed on the initial handoff:

1. A missing projection sequence is accepted and advances the browser cursor.
2. One projection sequence can identify two different source records.
3. Provider-origin bytes are accepted as buyer-verified delivery.
4. A terminal label clears exposure even with nonempty or unknown channel funds.
5. Splitting CRLF at network-chunk boundaries loses an otherwise valid SSE frame.
6. SSE frame ID is not checked against conversation/payload sequence.
7. Malformed durable frames are silently skipped before later events are accepted.

These regressions are root-owned and are not a full browser or schema suite.
Fixtures never call a real API or move value. Corrections must satisfy the actual
contract as well as these assertions.

Static inspection also found required behaviors missing or disconnected:

- Delivery entries use side `research`, but the right panel filters for `provider`.
- Economic/runtime/control events do not update the live dashboard; a one-time
  status fetch after a command cannot maintain an ongoing payment display.
- Login starts after snapshot high water with no retained transcript history.
- The pending command ID is saved only after a successful POST response; lost
  responses permit a new command ID on the next click. Pending status is polled once.
- Finite API calls and SSE buffers are unbounded; logout/401 do not reset all
  React session state and retained text/control state.
- Pre-fund terms, locked value, transaction digest/gas, waiting-for-credit state,
  identity details and receipt citations need the contract's actual display.

Luna has the bounded correction assignment, including actual authenticated
dashboard tests with a visible fixture banner at desktop and mobile widths.
Independent Astra review follows the corrected handoff. No fixture should be
promoted into the investor-demo path to make these tests pass.

## Shared signed economic input

Root added `tests/agent-demo/economic-session.json`, checked by
`npm run agent-demo-economic-fixture-tests` through the actual `StreamingEngine`.
It supplies valid signed offer/credits/checkpoints, two credit windows, byte-exact
split-UTF-8 delivery, replay and journal-reopen assertions. This replaces the
need for cast-only dummy economic objects in UI/HTTP tests. It is not a complete
HTTP snapshot or a live session. Final checkpoint consent is explicitly separate
from chain confirmation; the bundle has no chain observation, refund or real
transaction digest. Consumers must retain the visible test-fixture boundary.

## Corrected handoff: further review required

At approximately 07:57 UTC root independently reran the seven boundary checks;
all passed. Luna's corrected handoff also passes 13 unit tests, build and three
browser checks in Astra's independent rerun. These checks are narrow evidence,
not L3 acceptance. Astra's further probes found missing strict consumption,
snapshot/history coupling, fail-stop latching, complete terminal-evidence checks,
and correct tool/receipt presentation. The
[Astra UI/coordinator review](validation/agent-demo-coordinator-ui-review-2026-09-11.md)
records exact cases and frozen hashes.

Root inspected both authenticated dashboard screenshots at desktop/mobile widths.
They do show the two panels, but the mocked captures lack a TEST FIXTURE banner
and call synthetic output live. The browser fixture uses incomplete/noncanonical
identity/task/digest records and mismatched pricing rather than the shared signed
input; mobile overflow is also visible. These captures are not live evidence
and must be replaced by an explicitly labeled, coherent harness.

Root supplied `tests/agent-demo/public-session.ts` and its independent coherence
oracle to avoid parallel incomplete fixture schemas. Its unknown chain state
must remain unknown, and shared helper validation must be installed in actual
API/reducer consumers after its independent review. The new additive event
type vocabulary alone does not establish any production emitter or consumer.

At approximately 08:08 UTC root extended the actual API/reducer/accounting
regression suite to 13 checks. The original seven still pass; these six fail:

1. Forbidden provider delivery must fail without advancing the replay cursor.
2. A sequence failure must remain latched until explicit recovery.
3. History at or below the snapshot cut must not animate new activity.
4. Refresh must not install another conversation or configuration.
5. Empty funds without known paid amount/digest/observation must retain exposure.
6. Valid partial UTF-8 must remain pending, not be flagged malformed mid-request.

These assertions use the shared coherent public fixture where full records are
needed. They do not exhaust Astra's additional privacy, controls, refresh-race,
citations, authorization-expiry and rendered-layout findings.

## Current partial correction and production-boundary check

The [bounded local report](validation/agent-demo-ui-local-2026-09-11.json)
records these observed checks, exact hashes and remaining failures.

At approximately 08:46 UTC root reran the current UI: all 13 root contract
regressions pass, along with 5 unit-test files / 20 tests, the UI TypeScript/Vite
production build, and root TypeScript. This is an intermediate source state,
not a completed U1–U6 handoff. Strict shared-helper integration is still pending
its E1–E7 correction/re-review; passing these checks does not close the broader
Astra matrix.

Root added `npm run agent-demo-production-boundary-tests`. It uses the installed
Vite 8.3.0 build API with the actual production configuration and output options,
suppresses artifact writes only, and checks the returned runtime graph, imports,
assets, source-map absence and known fixture/private sentinels. It also checks
the configured public directory because copied static files need not appear in
the returned in-memory bundle. Only explicitly approved UI/shared modules and
React runtime dependencies are admitted. Real-path checks reject fixture/backend
imports and symlink targets outside that allowlist. This is a bounded graph and
sentinel check, not proof of arbitrary secret absence or a container inspection.
[Vite JavaScript API](https://vite.dev/guide/api-javascript#build),
[build output options](https://vite.dev/config/build-options#build-write),
checked 2026-09-11 against the installed API declarations.

The exact compiled assets are served from memory on loopback under the required
self-only script/style/connect CSP. Real Chromium (Playwright 1.63.0) passes all
five negative-backend cases: JSON 503, HTML 404, malformed JSON 503, HTML 401 and
connection loss. Every case displays an error and retains the login gate, sends
exactly one authenticated session GET without cookies/query credentials, sends
no control or event request, stores nothing in local/session storage, and makes
no backend request after reload. No external page request, uncaught page error
or CSP violation is observed. No successful session or fixture financial data is
injected, and no dashboard screenshot/live inference/payment is claimed.

The ordinary on-disk production build independently emitted identical SHA-256
assets to the in-memory tested output:

| Asset | Bytes | SHA-256 |
|---|---:|---|
| `assets/index-D2L6Mqo8.js` | 257082 | `096a032bdb9b9988ae8891f4c08fdedbe4c11d5b3cf77598a3b28def793f0499` |
| `assets/index-m39o14wQ.css` | 16541 | `5df5e0a48ec86cf7ae08cc0a9932e839892f52033078b957ad16ab4ab2d9142b` |
| `index.html` | 479 | `7a6e697a695f925438eb527fbd6a86627054815b76ab2d1723bfd8ba1f6eae24` |

The root audit script hash is
`02a230c21716b6844388901b01e65c409658bee1abecd29b9c101df2dec905f2`;
UI lockfile hash is
`f24b8a3941b80dc2a8e3bc2c48d2a1b50f6cadc1b7b3469ca5d38ca8a8b75288`.
The command reports exact included source/config hashes and rejects concurrent
changes during its checks. This supports the production-build/missing-backend
portion of F13, not real authenticated backend, snapshot/replay or F14 image
acceptance. No fresh dependency install or lockfile reproducibility pass is
implied by using already-installed pinned dependencies.

### Rendered fixture rerun: mobile clipping remains

At approximately 08:48 UTC root reran `npm --prefix ui/agent-demo run smoke`:
all three browser tests pass. Root inspected the resulting 1440px and 390px
dashboard screenshots. Both now visibly label TEST FIXTURE, use the coherent
shared session and preserve unknown chain/refund values. These supersede the
earlier unlabeled captures as fixture evidence only; neither is a live demo.

The mobile screenshot still clips the Iroh status pills. Root added and ran
`npm run agent-demo-layout-browser-tests` against a fresh in-memory production
build and explicit loopback fixture backend. Desktop layout passes. At 390px,
document scrollWidth is 390 and both panel right edges are 370, but the local
status pill ends at 388.640625 and the research status pill at 438.609375.
The latter is almost 49 pixels beyond the viewport. Root's permanent assertion
fails: a status label must fit inside its panel and viewport without overlapping
the Agent name. Global `overflow-x: clip` hides the overflow but does not make
that information readable. Luna has the measured U6 correction; the root test
remains failing until actual layout is fixed. No controls, live requests or
payments execute in this viewer-only fixture probe.

At approximately 09:05 UTC the new UI correction passes that exact layout test.
Both 390px status pills now end at 352 inside their panels' right edge 370;
desktop still passes and neither Agent heading overlaps its status. Observed
App hash `f8ed379cc3a78fe9c93b4bba86894b5df586aceb7eaa130aa9387f77407ace10`
and stylesheet hash
`90d1319fa0f6fe7e6f1e49ea54c5ca1b9c3036f31c9604cf6bd633f3bda370e4`.
This is narrow mobile-layout correction evidence, not full UI acceptance.

### Expanded production failure probe: raw backend code is displayed

At approximately 09:07 UTC root added a sixth case to the production-boundary
command: an actual loopback HTTP 503 with
`{version:1,code:'TEST_ONLY_BACKEND_PRIVATE_DETAILS'}`. The compiled UI renders
that entire test sentinel as its error. The existing first five cases still
complete, then the new privacy assertion fails. This is synthetic error input,
not a disclosed real secret. Both finite/SSE paths use an `errorCode` helper
that returns arbitrary strings; the UI owner has the bounded correction to
retain documented fixed codes and use a generic failure for untrusted values.
Raw exception/private text must not become a public error code (FD-13).

Current root test SHA-256 is
`1ee73433a5d9a83b92a42362f340560b2d899c64ab326d4568a93ccc0ea6f679`.
The earlier five-case pass/asset hashes remain historical evidence for that
earlier script and UI; the current expanded command is **failing**, not green.

At approximately 09:09 UTC root independently reran the expanded command after
the UI correction: all six cases pass, including the raw-code case now returning
the bounded `backend_unavailable` display. The API hash is
`8d63e78f9faa070aa77755b970d84ace3b1f55e1ee4208fd9d8b6754c41dba4c`;
App/style hashes match the mobile correction above and reducer hash is
`5c49293935993c2f3741fda5c8c3c256f846380cb2c9c66044b9b23da0b00ede`.
The 13 root UI contract checks also pass. This closes the measured finite-error
sentinel regression, not every SSE error/HTTP shape or authentication lifecycle
case. Shared-helper installation and the broader U1–U6 review remain separate.
