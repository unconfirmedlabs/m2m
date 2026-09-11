# Demo component initialization and recovery

2026-09-11: implemented local correction for the L02 initialization review.
Independent review and live/Fly validation remain pending. This is private demo
runtime state, not a change to m2m wire messages, signing or settlement.

The coordinator initializes budget, coordinator, worker, exchange, streaming
engine and client at different points. Process-level `create:false` does not
mean all those components already exist. Each role now retains a private
`components.json` beside its runtime manifest under the existing runtime lock.

The version-1 registry pins role, conversation, configuration hash and whether
explicit test dependencies were used. Entries pin component names and fixed
relative journal locations. Each channel has separate stream/client entries.
Worker entries require both `responses-worker.json` and its initialized marker;
injected lifecycle-test workers retain explicitly labeled stub files at those
same locations. The production path rejects a registry marked as test state.
This does not complete L05's runtime/profile/limits fingerprint requirements.

## Creation and crash behavior

| Retained state | Permitted behavior |
|---|---|
| Registry exists, component has no entry or files | Persist `initializing`, then call the constructor with `create:true` |
| `initializing`, all required files exist | Call the real constructor with `create:false` to validate/reuse the result; persist `ready` only on success |
| `ready`, all required files exist | Reopen with `create:false`; never create an empty replacement |
| Any recorded component file is missing | Reject with `journal_missing` before worker/connect/funding admission |
| Unrecorded component already has files | Reject; do not infer an implicit migration |
| Registry or an immutable path/provenance pin is missing or changed | Reject reopening |
| Registry write fails | Poison the in-process registry; do not admit further initialization |

Constructor success and the durable `ready` write both precede use of a new
component. Interrupted initialization with a missing/partial result fails
closed: it is not automatically repaired, since file loss cannot be ruled out.
Retain the original private state for reconciliation; deleting state or starting
a new conversation is not recovery of an outstanding agreement. A complete
constructor result can be reopened without changing reservations or IDs even
when the ready-marker write was interrupted.

One narrow exception permits retry of the factory's known credential-preflight
errors and `agent_tool_runtime_unvalidated`: when no worker artifact exists,
remove only that new worker intent. This lets an operator correct a missing
credential without stranding unused state. It does not admit a model call or
bypass the gate. Other constructor failures retain their intent for reconciliation.

Every recorded component is checked when the role opens, and before connection,
funding and task admission. A restored funded engine is not a restored research
client: reconnect also reopens the exchange/client against the original binding,
without another funding call. Initialization itself does not request work,
authorize credits, fund, close or refund.

## Compatibility and evidence

Older experimental demo runtime directories without this registry are refused;
there is no automatic migration. Preserve those directories and their economic
rights. The standalone agent-services runner and original PoC/native journals
keep their existing formats and recovery paths. The unfinished export/init CLI
must produce this registry through the runtime initialization contract before
ordinary production boot; the existing export alone does not do that.

`npm run agent-demo-boot-tests` runs the component crash-boundary tests, actual
separate-root local-Iroh startup/loss tests and bounded injected runtime suite.
The funding test uses an explicit chain stub, a real signed provider offer and
the actual exchange/engine/client. It verifies one funding callback across
retained-role restart, not a Sui transaction or live inference. Interrupted
constructor tests use actual BudgetLedger journals and retained reservations;
they are deterministic failure-boundary tests, not power-loss durability tests.
