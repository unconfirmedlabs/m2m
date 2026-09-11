# Reduced live demo implementation validation — 2026-09-11

Status: **local implementation complete; RD-0–RD-5 unverified**. This is the
Luna xhigh implementation record for the authoritative
[reduced live demo specification](../REDUCED_LIVE_DEMO.md). No live model call,
protected credential read, public-testnet mutation, SuiNS write, Fly mutation,
or fabricated live evidence was performed in this environment.

Checked at 2026-09-11T14:21:46Z and later local test runs. Environment: Node
22.23.2, Cargo 1.97.1. The existing Rust/native and fixture tests below are
explicitly not live acceptance. The deterministic coordinator does not require a
model credential; only the provider receives the protected model key.

## Correction checkpoint — Luna xhigh pass

The eight RDA correction findings were addressed locally without editing the
review report or using credentials, live Responses, Sui mutation, or Fly. The
important boundary remains honest: `ACCEPTED_RESPONSES_EVIDENCE_DIGEST` is
intentionally unset in this checkout, so the production Responses worker rejects
the exact fabricated R14 artifact and every unreviewed profile. The structural
artifact parser and fixture probe remain useful tests, but neither is RD-0
evidence.

- Initialization now rejects every surviving role-root artifact except its own
  lock file, handles `lstat`/directory errors fail closed, and creates the
  mandatory projection journal. A fresh init → projection reopen is covered for
  both roles.
- `reduced-local-v1` is an explicit serialized boundary for two ordinary local
  processes: separate protected state roots, loopback binds/origins, a built UI,
  and source plus compiled CLI init/blocked-serve checks. The legacy Fly-shaped
  parser remains a separate compatibility path.
- Post-close public economy retains signed/reserved history, reports redeemed
  value only from observed terminal chain state, and leaves pending/unknown
  settlement explicit. Durable running/uncertain tasks, exhausted budgets,
  paused spending, and closed channels now block task admission before an
  accepted record is created; exact completed replay is local-only.
- SSE replay/live cutover now closes the subscription boundary before flushing
  the live marker; the backpressure tail-event regression is H07. H08 covers
  runtime-shaped terminal and uncertain economy snapshots through HTTP.
- The reduced application boundary enforces input `0`, output `1`, denominator
  `1`, tranche `256`, and non-increasing limits while generic service/codec
  configurability remains unchanged.

The repeated `agent-runtime-tests` `worker_lock` failure reported by Astra was
not reproducible in this checkout: the suite passed five consecutive complete
runs, including the child crash/reopen rows, and no deterministic lock lifecycle
defect was identified. No unrelated lock change was made. The exact remaining
limitation is that the earlier failure cannot be independently explained without
the original environment or a new reproduction.

## Implemented boundary

- `scripts/reduced-demo-supervisor.ts` is the coordinator path. It has no model,
  tool, planner, autonomous retry, or answer-quality payment decision. It durably
  records the user request ID/prompt and delegates payment/research continuity to
  the existing `AgentServiceClient`.
- `scripts/reduced-demo-init.ts` and `scripts/reduced-live-demo.ts` provide the
  effect-free role initializer and exact `init`/`serve` entrypoint. The initializer
  creates no keys or chain state, creates the projection journal, and refuses any
  surviving role conversation artifact other than its lock.
- The production provider path remains the existing Responses adapter. It now
  requires a protected, bounded, secret-free R14 evidence file before opening a
  live worker; missing or invalid evidence fails closed. The fixture worker remains
  available only through injected automated tests.
- Production boot re-resolves `local.nozomi.sui` and `research.nozomi.sui` through
  `NativeNames.resolve`, binds the current parent/leaf/authority result to the
  exported snapshot, checks the local role's transport/economic key pins, and
  preserves unpaid Iroh echo before funding.
- The live harness now records the response ID that generated each function call
  and checks continuation `previous_response_id` against that exact predecessor.
- Existing native codecs, Move ABI, `AgentServiceClient`, `StreamingEngine`,
  `BudgetLedger`, `AgentServiceHost`, `BoundedWebTools`, Iroh bridge, and event
  contracts remain the authorities. H02 evidence now binds the requested channel;
  H03 replay is paced through bounded SSE writes; setup recovery requires the exact
  submitted journal and an independent initialization marker.
- The deploy build includes `reduced-live-demo.js` and `reduced-demo-init.js` in
  the image. The operator commands are:

  ```sh
  node /app/scripts/reduced-live-demo.js init --config /data/m2m/host.json
  node /app/scripts/reduced-live-demo.js serve --config /data/m2m/host.json
  ```

  For an ordinary same-host run, use two serialized `topology:
  reduced-local-v1` configs with distinct protected `state_dir` and
  `projection_state_dir` roots, loopback ports, and `ui/agent-demo/dist` as
  `static_dir`; the source and compiled entrypoints accept the same `init` and
  `serve --config /absolute/path` contract.

## Local commands and results

Every command in this table completed with exit code 0 during this pass.

| Command | Result and scope |
|---|---|
| `npm run typecheck` | PASS; TypeScript strict check |
| `npm run reduced-demo-tests` | PASS; deterministic exact-ID replay, uncertainty retry, prompt conflict, request cap, and effect-free two-role initialization |
| `npm run native-tests` | PASS; native identity/peer/Iroh, codecs, streaming, worker, research, schemas, and examples |
| `npm run vectors` | PASS; independent core signed-byte vectors |
| `npm run channel-vectors` | PASS; independent channel BCS/hash/signature vectors |
| `npm run channel-journals` | PASS; channel journal recovery |
| `npm run message-examples` | PASS; 23 examples, 3 Rust message-example tests |
| `npm run agent-services-tests` | PASS; existing service/coordinator/client/recovery tests and explicit offline fixtures; live enablement still refuses without real dependencies |
| `npm run agent-runtime-tests` | PASS in five consecutive reruns; strict Responses transport/worker and adversarial recovery tests; fixture/process-boundary scope |
| `npm run agent-runtime-integration-tests` | PASS; uncertainty/recovery/replay seam; fixture scope |
| `npm run agent-demo-boot-tests` | PASS; component/boot/runtime gates, separate role roots, real local native bridge and unpaid echo; fixture chain/worker |
| `npm run agent-demo-host-tests` | PASS; auth, projection, provider client and HTTP |
| `npm run agent-demo-event-contract-tests` | PASS; public events/snapshots/evidence contracts |
| `npm run agent-demo-vectors` | PASS; exact price, cumulative ceilings, UTF-8 and unknown settlement states; fixtures only |
| `npm run agent-demo-economic-fixture-tests` | PASS; signed credit/Ack/checkpoint/reopen/replay accounting; fixtures only |
| `npm run agent-demo-public-fixture-tests` | PASS; public pins/signatures/cursors/budget replay; fixtures only |
| `npm run agent-demo-ui-contract-tests` | PASS; browser reducer and event-boundary regressions |
| `npm run agent-demo-ui-http-tests` | PASS; real UI/API client against an explicitly injected runtime fixture; no live inference/payments |
| `npx tsx scripts/test-agent-demo-http-recovery.ts` | PASS; H01–H09 host regressions, including tail-event cutover, terminal/unknown economy, and visible task admission |
| `npm run agent-demo-reduced-local-tests` | PASS; built UI, serialized reduced-local configs, fresh init, projection reopen, and concurrent two-role blocked serve for source and compiled entrypoints without credentials |
| `npm run agent-demo-contract-browser-tests` | PASS; Chromium contract checks against explicit fixture data |
| `npm run agent-demo-layout-browser-tests` | PASS; desktop/mobile layout and no-overlap checks against explicit fixture data |
| `npm --prefix ui/agent-demo run smoke` | PASS; production gate, dashboard, and exact pending-intent retry, 3/3 tests |
| `npx tsx scripts/test-agent-demo-setup.ts` | PASS; setup authority, initialization marker, exact-journal recovery and ABI-sender checks; fixture/mock chain scope |
| `npm run agent-demo-build` | PASS; server/operator ESM build and React/Vite production build |
| `npm run agent-demo-production-boundary-tests` | PASS; production UI negative-backend cases and artifact-boundary checks |
| `git diff --check` | PASS |

The native suite includes local real-Iroh/native-bridge behavior where its output
says so; it is not public-testnet, live Responses, or two-process demo evidence.
The UI/HTTP and economic positives are intentionally labeled fixtures and are not
promoted to RD-2–RD-4 evidence.

## Build hashes

The following hashes were captured after the passing build. They are content
hashes, not release signatures.

| Artifact | SHA-256 |
|---|---|
| `dist/agent-demo/scripts/agent-demo-server.js` | `fd5baa8ae37098b3bc6f2da76b4d327ed7c505b49665dc01b7e0351269c2ead0` |
| `dist/agent-demo/scripts/reduced-demo-init.js` | `4221dff4f16bdb802868f4360d0ab22c202c519bbd235ef0ebf6b1df2d20d855` |
| `dist/agent-demo/scripts/reduced-live-demo.js` | `d755c74c2674a9c1f25ceb26449b48dab40292a867ceea4405b04a2f6b41b8ef` |
| `dist/agent-demo/scripts/reduced-demo-supervisor.js` | `ac67b66e674d5ae6bfe4b93150ffcc5ea6bd0b7f55ddabce325f6da60d28ce36` |
| `ui/agent-demo/dist/assets/index-CqTJsgQN.js` | `40a0b214b831741cbbf0dc7f0c084a4799d966fdeaa398b364c01c8fe8418ff9` |
| `ui/agent-demo/dist/assets/index-DX-Ntsrv.css` | `4688d54fe5da636a229ee4fdc7d4ca8fbbbddd64765db208fe5b1f71baa2d738` |
| `ui/agent-demo/dist/index.html` | `fb46aec7d88503f091ffc692ff4ebbdd5b5de481f812e6cbd6ce40ca08311f26` |

Key implementation-source hashes at the same checkpoint:

| Source | SHA-256 |
|---|---|
| `scripts/agent-demo-runtime.ts` | `9b6b2438f10b31e87b9f3aa95322c5793ebf927a3ec72d531b9209aee2f9e261` |
| `scripts/agent-runtime.ts` | `57ce53609ff16c8a14ce53aca6dd876b3d9686d92f02252ae73852a9a3fcd082` |
| `scripts/agent-demo-event-contract.ts` | `daac5f9a0a7f7c2217801bfb6b2073fb81ac8cf2c0e9eb31a5ae5c8cfbda9220` |
| `scripts/agent-demo-auth.ts` | `0330f874ea779e67b957893c4b5c84170bc4a140fedf5e5f8ddc10531459f3ab` |
| `scripts/test-responses-live.ts` | `b20b10e49f7e2bc6c9b8de1e280d61ae251d305aaaf44211bd053a10a0f3da2f` |
| `scripts/reduced-demo-supervisor.ts` | `b54150efafd5d63772ce97d7c4ba89195c9885c6846804cd7a4f1488a506c89c` |
| `scripts/reduced-demo-init.ts` | `755123b37ed827b18f80688f0762b8afb1bb6e478519411abcae791b6adba6b4` |
| `scripts/reduced-live-demo.ts` | `f2fe67ba9446c9351d6ba72433268d8706b72b5cd8fc5349dedf39dfae1cf6ff` |
| `scripts/agent-demo-server.ts` | `f1fc50242bdc126a257742a77da03df6c38bc58fe7137de08a5e8e13109535e6` |
| `scripts/agent-demo-evidence.ts` | `643bbb22df838568f4f3ceebc848b00f22b3d660231a85928197f0eb338986ff` |
| `scripts/native-setup.ts` | `010ff10510c52eabdcb50f9febeed9081792884e77ecc3e57f7449b3f1bae95b` |
| `scripts/native-setup-helper.ts` | `52e9725110fd78d4f81491131630a01a35fa7ea6fd09d4902a408331f05c37c1` |
| `scripts/agent-demo-export.ts` | `2eb2c96d452993140c18f2409e3cfbb815c38923aef625c1205342b3134f5534` |
| `scripts/test-reduced-demo.ts` | `434a6602542e092435938db7f383cc77861d6935103bc45f3523acb58b93b4e7` |
| `scripts/test-agent-demo-http-recovery.ts` | `6bb00f15629b153427ee6bef595af2b6f92786d6e7109d28c95266053d219caf` |
| `scripts/test-reduced-local-config.ts` | `47ded1cf5fdef1f4e7759829b6c2e8c64ba4eb60081d60cdae33c8630c53d287` |
| `deploy/agent-demo/build.mjs` | `580fec883716ae57008a72b689a41f7334a314287ff29f5ef2051bab212f7fef` |
| `package.json` | `e43a5a4164370d81c237b2adf755676849ae4462b19038d0633524d0a92f6582` |

## RD gate status and genuine blockers

| Gate | Status | Reason |
|---|---|---|
| RD-0 safe live provider | **UNVERIFIED / fail closed** | No protected API credential, real Luna xhigh round trip, current tool-isolation evidence, or accepted secret-free retained evidence file is available here. No compiled acceptance digest exists; even a structurally valid local artifact is rejected by the production worker with `agent_tool_runtime_unvalidated`. |
| RD-1 identity/transport | **UNVERIFIED** | No validated exported testnet role roots, current SuiNS leaf/parent authority, protected per-role keys, or actual two-process public-testnet Iroh run is available here. |
| RD-2 paid research | **UNVERIFIED** | No public-testnet funding/controller authority, live provider, Brave credential, or real user prompt/citation/checkpoint run. No chain state was mutated. |
| RD-3 controlled restart | **UNVERIFIED** | No live two-process turn-one restart and same-channel turn-two follow-up. Local supervisor/client replay tests are not this gate. |
| RD-4 UI/exact close | **UNVERIFIED** | No actual browser against the live backend, independently read Sui close, provider proceeds/refund conservation, or terminal digest. |
| RD-5 review | **UNVERIFIED** | Parent Astra verification is still required against current source hashes and any future live evidence. |

Required external inputs are protected Luna/OpenAI model access, Brave/search
access, public-testnet RPC/package/domain and controller funding wallet, separate
transport/economic role keys, testnet Agent/SuiNS authority, Iroh endpoint
availability, a secret-free accepted R14 evidence artifact, private writable role
volumes, and operator/UI credentials. None are fabricated or written to the
repository by this pass. Do not run the public setup/funding commands until the
operator has validated those exact inputs and accepted the resulting cost/state
changes.
