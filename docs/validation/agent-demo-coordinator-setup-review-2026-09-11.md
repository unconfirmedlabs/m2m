# Coordinator hotfix and L0 setup: independent Astra review

Checked 2026-09-11 by Astra `xhigh`. Read-only implementation review, with isolated
local fixture probes; no credentials, model requests, chain transactions or Fly
changes. These results do not establish live demo acceptance. Runtime findings
are recorded separately in
[the frozen runtime review](responses-runtime-astra-review-2026-09-11.md).

## Frozen provenance

| File under `scripts/` | SHA-256 |
|---|---|
| `agent-coordinator.ts` | `99bed0a4b5717f3915b082322f3d063a44a76a4d57b966dc1e40573f8a1e31f2` |
| `test-agent-coordinator.ts` | `00a4f52332e9ec0763e332123d32e766b0bc6bfd0bc9c8031a51d8692a9cba0e` |
| `native-setup.ts` | `4c0b5bb557091fdd995d2c8308f73af36ec090067ab7ba538568439358041c15` |
| `native-setup-helper.ts` | `154985a6c18b8619c1901359df90aa6a9fde517c14b475b5283de74f85fdf27d` |
| `test-agent-demo-setup.ts` | `c5dde8300a9b89640deec12e6dc9c513cf2cddc544889e0bb72fe3f397034fff` |

Both commands passed:

```sh
./node_modules/.bin/tsx scripts/test-agent-coordinator.ts
./node_modules/.bin/tsx scripts/test-agent-demo-setup.ts
```

## Coordinator: original fixes verified, two variants still fail

The original three defects are repaired for their exact regression cases:
normal cancel while an initially empty worker factory is held produces zero
`worker.run` calls; a present worker's unresolved cancellation is retained as
uncertain; a rejected worker `shutdown` can be retried after quiescence. The
delayed-storage test now queues an actual `persist` behind its gate, attempts a
competing reopen, and checks that post-shutdown cancel does not write.

### C4 — P1: stopped-task reconciliation bypasses the final pending-operation guard

`agent-coordinator.ts:842–851`, `880–884`.
The new stopped/previously-launched branch accepts a terminal worker record as
terminal task state without requiring the coordinator's paid calls to be terminal.
The trailing `pending` check only controls clearing `activeTask`; it does not
restore uncertain task state. Terminal task replay then returns that false result.

Repro with the actual coordinator/BudgetLedger and fixture worker/ResearchPort:

1. `worker.run` invokes the bound `research` handler with a stable callback ID.
   ResearchPort reserves its request and throws a lost-reply error. Worker returns
   uncertain; coordinator retains the pending paid call.
2. Call coordinator cancel; both port and worker cancellation remain uncertain.
3. Replay the same task. Fixture `worker.reconcile` returns a completed record
   without invoking/reconciling the pending ResearchPort call.

Observed: first result uncertain; replay result completed;
`status.activeTask` remains the task, `status.activeRequest` remains the pending
paid request, but `status.state` is completed. Counts: one worker run, one port
execute, one worker reconcile.

Required assertions: every return branch, including stopped reconciliation and
terminal replay, remains uncertain while any task paid call is pending. A model
terminal record is not a substitute for a validated provider terminal receipt or
trusted no-dispatch proof. Only after exact paid-operation reconciliation may
task terminality and admission change. Preserve zero new worker runs/paid IDs.

### C5 — P1: cancellation after reopen fabricates certainty before the worker exists

`agent-coordinator.ts:892–917`, especially the optional `this.worker` branch.
The durable `launchStarted` distinction is not used when cancelling a reopened
task before its lazy worker has been reconstructed.

Repro:

1. Fixture worker returns uncertain with no paid ResearchPort call; cancel also
   returns uncertain. Shut down the coordinator safely, preserving that state.
2. Reopen the actual coordinator; no worker factory invocation has occurred yet.
3. Call coordinator cancel, then replay the same task.

Observed: before cancel uncertain; after cancel cancelled; task replay cancelled;
only the original worker run occurred. There is no evidence that its prior model
operation stopped. Expected uncertain until the original qualified worker request
has independently known terminal state. Absence of an in-memory worker is not
no-dispatch proof; never start a fresh run to obtain that evidence. Add this exact
reopen/lazy-factory case alongside initial pre-launch cancellation.

Coordinator production event-sink errors are still swallowed at `event`; that is
the previously assigned L1 durable-publication/headroom work, not a new claim
that this cancellation hotfix implemented FD-15/17.

## L0: return requirements before acceptance

### S1 — P1: tests exercise unused orchestration, not the production setup path

`native-setup.ts` only re-exports the helper; `runNativeSetup` never calls
`provisionNativeDemo` or `buildRoleKeyExport`. The helper's claim that the CLI
supplies its real ports is therefore false. `test-agent-demo-setup.ts` imports the
helper directly. Its replay test exercises only the fake `RecordingTransactions`
map, not setup retry or `NativeChain.execute`.

Required bounded repair: one authoritative orchestration path used by the CLI
and tests. Wire the production adapters into that path, or test the actual CLI's
shared implementation; do not keep a parallel test-only setup algorithm. Exercise
the actual signed-transaction journal binding/replay boundary with explicit local
fixtures, including interruption and changed signer rejection, and distinguish
that evidence from a public-chain run. No Move changes or controller transfer.

### S2 — P1: live controller preflight is missing/too late

Production `native-setup.ts:155–158` checks the local identity's controller and
the freshly resolved operational keys, but omits `authorization.controller`.
`NativeChain.resolve` validates Agent/domain/expiry/key separation and returns the
controller; it does not enforce equality to the CLI wallet. Thus unchanged
operational keys under a rotated controller are not rejected by this CLI check.
The helper does check the fresh controller, illustrating S1's divergence.

Both implementations also process roles sequentially rather than preflighting
all existing Agents before any new mutation. A helper probe used an existing
research Agent whose local controller pin matched but whose fresh chain
controller differed, with local Agent creation still needed. Observed one
`register` effect before `Existing research Agent authority mismatch`.

Required assertions: check every preexisting qualified Agent's fresh controller
and both operational keys against the intended inputs before publish/domain/
register/name effects. Rotated-controller/unchanged-key cases and a bad second
role must cause zero mutations. Preserve separate economic and transport keys.

### S3 — P1: setup authority manifest is output, not an immutable recovery pin

`native-setup.ts:168–185` creates and saves `setup-manifest.json` only after all
operations and never reads/compares it during admission. The helper similarly
only calls `saveManifest` at the end. It cannot pin a name-wallet/controller
selection before the first effect or reject a changed selection on retry.

Static concrete case: rerunning an existing separate-wallet setup without name
creation sets `nameWallet = wallet` and can overwrite its saved `name_wallet`
address without checking the existing manifest. Per-operation signer binding is
necessary but does not fix this when an operation is skipped because its objects
already exist. Do not reinterpret existing authority metadata implicitly.

Required repair: protected initialized/versioned setup pins checked before any
mutation, with explicit immutable wallet addresses/mode/network/deployment and
original operation identities; update known results durably, not overwrite pins.
Tests: interruption before/after every effect, exact-input resume, changed wallet
or mode/network rejection before effects, missing/corrupt initialized pins, and
completed no-op rerun preserving the same authority record.

### S4 — acceptance gap: role-export claim is not tied to any real export path

`buildRoleKeyExport` is unused by the CLI. Its test copies chosen sentinel
strings, then checks that an unrelated generated parent secret was not among
them. This only demonstrates the helper's field projection, not selection of
actual role inputs. No production key export was exercised here.

Required evidence: the actual protected per-role export/composition path selects
only that role's separate operational keys, optionally the buyer demo-controller
key, and never the parent or counterpart key. Tie the fixture assertions to that
real path. If export belongs to L1, explicitly leave F14a export acceptance pending
until the shared composition test exists; do not invent a second export workflow.

## Preserved positive boundaries and limits of review

The CLI uses the demo controller for publication/domain/Agent registration and
the explicit name wallet only for the existing leaf operation. Explicit separate
wallets must differ; parent-owner preflight precedes public mutations in that
mode. Testnet/localnet selection rejects mainnet. The checked Move
`identity::register` signature is unchanged and derives controller from
`ctx.sender()`. Existing `NativeNames.createLeaves` checks parent ownership and
rejects a preexisting leaf with another target. None of these positive code checks
establishes that public setup occurred.

Return coordinator C4/C5 to its Luna owner, and S1–S3 plus accurate S4 acceptance
status to the L0 owner. This review tranche is frozen; it makes no code changes
and no deployment/readiness claim.
