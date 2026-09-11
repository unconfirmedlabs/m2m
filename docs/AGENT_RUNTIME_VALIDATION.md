# Responses runtime: validation in progress

Checked 2026-09-11. This is working-tree evidence, not a released runtime or a
successful live demo. Requirements and row definitions are in
[the runtime contract](AGENT_RUNTIME_SPEC.md) and
[R01–R15](AGENT_RUNTIME_IMPLEMENTATION.md).

## Current gate

The production `openAgentWorker` factory remains
`agent_tool_runtime_unvalidated`. The original Codex AS-20 gate is unchanged.
No OpenAI API or Brave secret-file path has been supplied. No actual Responses
inference, standalone R14 probe, two-live-agent R15 exchange or Fly deployment
has run during this implementation pass. Do not convert the retained Codex
authentication into an API key.

The first candidate was handed off by Luna `xhigh`; Astra's
[frozen-code review](validation/responses-runtime-astra-review-2026-09-11.md)
reproduced twelve groups of blocking failures. Luna handed off a repaired,
frozen candidate; root's local suites pass, but Astra's ongoing independent
re-review has reproduced further blockers. This is not acceptance of all twelve
finding groups.
An interim happy-path worker test and SSE parser test do **not** establish the
R02–R12 failure/recovery matrix. In particular, the documented `--live` and
`--live-continue` entrypoints require explicit live implementations or fixed
failure guards; an ordinary fixture test must never run under those flags and
be presented as live acceptance. The current entrypoints explicitly fail
`live_probe_unimplemented`; the live probe itself remains to be implemented.

## Observed shared checks

- `npm run typecheck`: passed at approximately 07:33 UTC on the handed-off runtime.
- `npx tsx scripts/test-agent-coordinator.ts`: passed, but Astra subsequently
  reproduced the three missing coordinator cases below. This is not acceptance.
- `npm run agent-demo-vectors`: passed after the confirmed-terminal exposure
  correction. These are arithmetic/replay oracles, not UI/runtime evidence.
- `npm run agent-runtime-integration-tests`: an earlier fixture passed the narrow
  coordinator/worker uncertainty/recovery seam. An unresolved
  research result produced one model request and no continuation; explicit
  `worker.reconcile` reused the same callback and research request, then made
  one continuation; completed coordinator replay made no new calls. This is
  preliminary fixture evidence. Astra found that extra API event fields and
  unobserved GET fallback weakened the result. Root removed invented event
  fields, retained the full qualified callback identity, and asserted exact
  callback/retrieval counts. That stricter test initially **failed**: an ordinary
  completed stream performed one recovery GET instead of zero. On the repaired
  frozen candidate below, it now passes with zero unnecessary recovery GETs,
  retained callback/request identities, one continuation after explicit recovery,
  and no new effects on completed replay. Neither result establishes full runtime
  acceptance. This test does not cover
  actual Iroh/Sui or a hosted recovery control. The lifecycle implementation
  must invoke explicit known-request reconciliation; `worker.run` alone returns
  retained uncertainty and is not a retry permit.
- `cargo build --locked --release --bin native-bridge --jobs 2`: passed. The
  release checksum and unchanged Cargo lock checksum are recorded in
  [the preflight report](validation/agent-demo-preflight-2026-09-11.json).

## Repaired candidate under independent review

At approximately 08:34 UTC, root independently ran these commands to completion
with exit code 0:

- `npm run agent-runtime-tests`
- `npm run agent-runtime-integration-tests`
- `npx tsc --noEmit --pretty false`

Candidate SHA-256 hashes, rechecked at 08:39 UTC:

| File under `scripts/` | SHA-256 |
|---|---|
| `agent-runtime.ts` | `a3967367c1636451af3cdd205762215a5ff440c3fb89a13b3e55f13ecce79943` |
| `responses-transport.ts` | `39abef131766390d8a904cd812acb0e7f1f3b2c797091c2fede81d6f11a42443` |
| `responses-worker.ts` | `abb99ae39eaa65b04a4d904999b5d47683d3e5e4ca19ff2794e2c0b2fed7d24b` |
| `test-responses-transport.ts` | `42b93875f5d5eb65f875fcf6effd6150ee25df1081bb8e0ffe16a9652be1008f` |
| `test-responses-worker.ts` | `4e9626e71e1fb737aa5f5ff120f0840150e9b677c8e6c3aa9bb88073f851dc38` |

These are local transport, worker and coordinator-seam tests with controlled
dependencies, including real local HTTP and process-crash paths. They are not
actual model inference, search, Iroh/Sui, hosted lifecycle or browser integration
evidence. Astra is reviewing the exact failure variants and permanent coverage
against RR01–RR12. R14 remains unimplemented and the production gate stays closed.

At approximately 08:45 UTC Astra reported additional reproduced failures on these
same hashes: a trickled JSON response exceeds the total timeout, some discarded
HTTP bytes are not charged, stream and event size bounds are conflated, malformed
output can dispatch tools or leave unreopenable state, and downstream rejection
does not durably prevent effects during explicit reconciliation. Its consolidated
artifact was subsequently frozen in the
[new-hash Astra re-review](validation/responses-runtime-astra-rereview-2026-09-11.md).
Its ten NR-01–10 correction groups were returned to Luna, with exact failing
regressions required before implementation edits. Additional actual child-crash
probes reproduce duplicate continuation/callback effects and invented empty
recovery input; same-request overlapping calls duplicate a handler; lost-ack
cancellation can incorrectly clear uncertainty. These findings supersede any
inference of broad acceptance from the green baseline. The next repair is active.

## Review work still requiring corrected evidence

Astra independently reproduced these shared coordinator failures and returned
them to Luna:

1. Cancel during an awaited worker factory could acknowledge cancellation and
   nevertheless invoke `worker.run` after that factory resolved.
2. An uncertain `worker.cancel` result was discarded and surfaced as cancelled,
   including same-task replay, without terminal model-execution evidence.
3. A rejected worker shutdown promise remained cached, preventing a later safe
   retry even when the local worker could quiesce.

The repair must also test an actual persistence operation queued behind a delayed
storage gate. The previous delayed-promise-only test did not prove that case.
Luna's repaired coordinator and tests were handed off separately. Astra verified
the original three repairs and real queued-persist regression, but reproduced
two further cancellation/reopen variants. A stopped task could return completed
despite a pending paid call; cancelling a reopened uncertain task before its
lazy worker existed could falsely return cancelled. See C4/C5 in the
[coordinator/setup review](validation/agent-demo-coordinator-setup-review-2026-09-11.md).
Luna repaired C4/C5 and Astra verified those exact cases. Astra then reproduced
the additional C5b held-recovery-factory/shutdown variant on the previous handoff.
The corrected coordinator hashes `70fb5d361dd942479c897353df1078956c62d03cf7d84255d0c64bd202b5ca98`
and test hash `65d831d19401cb7b2e4c7f82ec562d082ad17b66ed8ef42f9005cd7fd383ca58`
pass Astra's exact C5b timing/reopen probe, the never-launched positive case and
the full coordinator suite. Reverting only that guard in an isolated copy fails
the checked-in regression in 11/11 runs. Its stopped-flag wait is less precise
than the independent current-transition barrier, but no undetected regression
was demonstrated. This accepts those bounded coordinator repairs, not the
separately changing model runtime, hosted lifecycle or live inference.
See the separate new-hash result in the
[coordinator/UI review](validation/agent-demo-coordinator-ui-review-2026-09-11.md).

Root's interim runtime checks identified a separate set of required corrections:
live SSE must expose the acknowledged response ID before stream completion;
byte charging must be awaited and ordered; effective execution configuration must
be validated; raw API JSON must retain duplicate-key detection and bounds;
Unicode/prototype edge cases must be rejected safely; and journal writer/reader
limits and explicit create/reopen semantics must agree. Their final status must
be established from actual adversarial tests, not
from this checklist or the existence of parser/worker code.

Astra's first frozen-code fault probes independently reproduced:

- `response.created` falls through into unknown-event handling; happy-path
  fixtures pass via GET snapshot fallback rather than streamed handling.
- A lost continuation acknowledgement permits duplicate continuation POSTs.
- A stalled stream survives the deadline and can dispatch a host effect afterward.
- Confirmed cancellation is surfaced as uncertain; a policy-invalid
  acknowledgement loses the known response ID needed to cancel it.
- Invalid output structure can reach a registered host handler.
- Shutdown does not join an external cancel; a released worker can reconcile
  and mutate after another instance acquires the same state lock.
- Explicit recovery exceeds its persisted limit and makes next reopen fail;
  multiple conversations can launch concurrently in one worker root.
- Reopen after a real process crash at the acknowledged-ID boundary launches a
  fresh request instead of recovering the known response.
- The production HTTP parser accepts duplicate keys, an escaped unpaired
  surrogate and over-deep JSON, and dispatches a pre-aborted request.
- Inherited object properties bypass schema membership and unsafe response-map
  lookup permits prototype mutation from a response identifier.

The independent review artifact and corrected regression matrix must close these
findings before an isolated live probe. Passing smoke tests cannot lift the gate.

At approximately 07:42 UTC, root reran `npm run native-tests` and
`npm run agent-services-tests`; both passed. These protect the existing
native/payment and explicit fixture-service behavior, not the new runtime's
unimplemented/failed acceptance rows. The initial setup test passed only its
unused-helper fixtures; that evidence did not establish the production setup
guards. The subsequent L0 candidate now calls the helper from the real CLI and
passes root's local setup suite, including a separate actual NativeChain.execute
mocked-SDK journal check. Independent review is still required before provisioning;
the actual per-role export remains unimplemented in this slice.

Official OpenAI documentation guided the response-ID/cursor boundary: a streaming
background response can be resumed from its saved ID and event sequence, provided
it was created as streaming. This makes durable early acknowledgement important
to this host's recovery contract. Stored-context retention is an additional
project-policy dependency. [Background mode](https://developers.openai.com/api/docs/guides/background).
The stricter fixture follows the documented item/event identifiers.
[Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events),
checked 2026-09-11.

## Next acceptance sequence

Finish the deterministic failure matrix and shared integration, then obtain
Astra review of the corrected implementation. Only then run the isolated,
credentialed, no-payment R14 probe and review its actual callback, isolation,
restart and replay evidence. Factory enablement follows that evidence; real
Iroh/Sui research and Fly/browser gates remain separate required work.
