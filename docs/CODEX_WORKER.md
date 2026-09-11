# Codex text-worker adapter

Implemented 2026-09-11 in [codex-worker.ts](../scripts/codex-worker.ts), with
[deterministic tests](../scripts/test-codex-worker.ts). This is a replaceable
execution adapter above m2m, with no dependency on Iroh, Sui, a payment signer, or
an LLM-specific core message. It currently answers bounded text questions from
model knowledge by default. Built-in web research, plugins, and arbitrary
service-selected workspaces remain disabled. The opt-in `agentProfile` interface
implements bounded host-tool registration for the separately versioned
[agent-services binding](AGENT_SERVICES_SPEC.md), but **live enablement is gated**
by `agent_tool_runtime_unvalidated`: tested tool-routing configurations did not
establish registered-only tool exposure. Only explicitly injected test adapters
can currently open this profile; the default text worker is unchanged. See the
[failed live-adapter gate](AGENT_SERVICES_VALIDATION.md#live-adapter-blocker).
A successful text-only probe
is evidence of the narrower adapter,
not a validated research product, independently verified model execution, or
token-level payment backpressure.

## Checked integration contract

Checked against the installed `codex-cli 0.154.0` on 2026-09-11. Startup rejects a
different version. The installed `codex app-server generate-ts` schema was used to
check the request, turn, sandbox, content, and usage fields. App-server is still
marked experimental by that CLI. Its JSON messages use stdio; initialization
precedes thread operations, turns stream item notifications, `thread/read` supports
recovery, and `turn/interrupt` requests cancellation.
[Official app-server documentation](https://learn.chatgpt.com/docs/app-server)

The opt-in profile enables experimental dynamic tools on `thread/start` only;
`thread/resume` restores those tools from the existing thread rather than passing
an unsupported registration field. Host-side dispatch validates thread/turn/call
identity, persists the call before effects and retains exact results for replay.
Profile fingerprints, tool limits and recovery policy are immutable across a
thread. The original tool-disabled adapter tests remain a compatibility gate.

The model is fixed to `gpt-5.6-luna` with reasoning effort `xhigh`; this reasoning
setting is listed for the model. There is no automatic model substitution on
quota, availability, or policy failures.
[Official Luna model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna)

The installed schema uses `sandbox: "read-only"` for `thread/start` and
`sandboxPolicy: { type: "readOnly", networkAccess: false }` for `turn/start`.
These are different enum representations. The adapter verifies the effective
thread model, effort, directory, approval policy, read-only/no-network sandbox,
and absence of instruction-file sources before launching a turn.

## Embedding and local sidecar

```ts
import { CodexWorker } from './scripts/codex-worker.js';

const worker = await CodexWorker.open({
  stateDir: '/private/provider-state/text-worker',
  // authFile: operator-controlled credential file; never a peer-supplied field.
});
try {
  const record = await worker.run({
    agent: 'qualified-buyer-Agent-reference',
    conversationId: 'conversation-1',
    requestId: 'request-1',
    prompt: 'Explain how duplicate request suppression works.',
  }, async event => {
    // Persist/replay this index in the caller's delivery journal. For paid
    // content, acquire acknowledged credit BEFORE passing bytes to Iroh.
    // Returning false requests cancellation. Awaiting does not pause Codex.
    console.log(event.type, event.index);
  });
  console.log(record.state);
} finally {
  worker.close();
}
```

`CodexWorker.open()` also accepts an `AppServerRpc` implementation for a replacement
backend or deterministic test. `status(ref)` reads a saved record, `cancel(ref)`
requests interruption, and `reconcile(ref)` reads the recorded external execution.
`run(request, consumer, afterEvent)` replays only event indices greater than
`afterEvent` (default `-1`). A replay returns the saved execution; changed content
under the same Agent/conversation/request reference fails with
`request_content_conflict`. One active turn per conversation is enforced; each
state directory has an exclusive process lock. The caller must authenticate and
pin the qualified Agent reference before invoking this local interface.

For a Rust or other host process:

```sh
npx tsx scripts/codex-worker.ts /private/provider-state/text-worker
```

Write one JSON object per stdin line:

```json
{"op":"run","request":{"agent":"qualified-buyer-Agent-reference","conversationId":"conversation-1","requestId":"request-1","prompt":"Explain duplicate requests."},"afterEvent":-1}
```

The sidecar returns `{ "op": "event", "event": ... }` lines and then
`{ "op": "result", "record": ... }`. `status`, `cancel`, and `reconcile` take the
same `request` reference without `prompt`; `cancel` can arrive while a run is
active. Sidecar errors expose fixed codes, not raw upstream diagnostics. The
local interface is not an m2m wire contract; the communication SDK signs,
authenticates, and correlates the actual network messages. The sidecar's state
and result records are internal provider records and must not be forwarded as
the research profile's public response wholesale.

## Persistence and uncertain execution

The journal binds the buyer Agent, conversation, and request to a prompt
commitment, random client message ID, Codex thread, and Codex turn. Prompts are
hashed in the adapter journal; Codex's own private thread store contains the
submitted prompt and output. Both stores belong to the provider's protected state.
Every externally reported event has a stable per-request index and is persisted
using file fsync, atomic rename, and directory fsync before the callback fires.

Before the sole `turn/start` call, a `launching` record is durably written with the
known preexisting turn IDs and submitted-input commitment. A disconnect or crash
can leave this record uncertain. Recovery reads the saved thread and selects the
known turn ID, or uniquely matches a new turn's stored user input to the saved
commitment. It never issues another `turn/start` for an uncertain launch. An
unmatched or ambiguous result remains `uncertain` and blocks a new turn in that
conversation. This is duplicate suppression with explicit uncertainty, not an
exactly-once guarantee for external execution.

Recovered output must extend each saved item's exact text prefix. A contradictory
prefix is an error. Partial output survives cancellation and disconnect. A resumed
in-progress turn retains the original duration deadline. A saved, unconfirmed
cancellation is reissued on reconciliation; an in-memory guard suppresses only
simultaneous interrupt calls, not recovery retries. Lost token telemetry is
reported as missing; `thread/read` output text is never retokenized to reconstruct
it. A later turn whose prior total is unknown reports `requestUsage: null`, even
if a new thread-wide total is available.

## Metering and payment boundary

| Adapter record/event | Meaning | Economic use |
|---|---|---|
| `content.delta` | A newly produced assistant-text fragment | The caller may deliver it only within acknowledged credit |
| `producedUtf8Bytes` | Cumulative UTF-8 bytes observed in this request | Candidate byte-service quantity; not evidence of network delivery |
| `usage.threadTotal` | Codex-reported cumulative thread counters | Upstream telemetry, including prior turns |
| `usage.lastModelOperation` | Codex-reported last model-operation counters | Not necessarily the entire m2m request |
| `usage.requestUsage` | Thread total minus the saved pre-turn total, or `null` | Provider-reported request usage; not independently verified billing evidence |
| `completed`, `failed`, `cancelled`, `uncertain` | External execution status | No implicit buyer acceptance or payment authorization |

Cached input and reasoning output are subcategories of input and output. The
adapter preserves each counter separately and never adds reasoning output a
second time. It validates nonnegative safe integers, subset bounds, and monotonic
totals. Duplicate usage notifications are suppressed. Late telemetry from an old
request cannot replace a newer request's accounting baseline.

The native streaming extension owns acknowledged credits, delivered units,
checkpoints, price arithmetic, delivery replay, close, and redemption. It must
define any byte policy explicitly and must not advertise bytes as tokens. A
provider selling tokens needs an agreed usage-evidence policy and adequate
preauthorization for usage that arrives after output. The adapter does not choose
the sale price or insert a final-answer acceptance prerequisite.

The worker continues to read and persist bounded backend events while a callback
waits for credit. Waiting on the callback is therefore delivery backpressure only.
Backend work and token costs can accrue before a usage notification or cancellation
confirmation. The provider bears generated-but-undelivered overshoot; it cannot
increase the buyer's authorization to cover that overshoot.

## Execution restrictions

The adapter creates a private Codex home underneath its private state directory,
separate from the default worker workspace. It refuses ambient config, instruction,
custom skill, plugin, or hook files in that home. The CLI creates its own bundled
`skills/.system` directory on startup; that directory is allowed when reopening.
Workspace ancestor `.codex/config.toml` and `.codex/hooks.json` files are rejected
before app-server startup so project configuration cannot add ambient tools.
Shell, browser, computer, image, plugin,
app, MCP, subagent, skill discovery, memory, and hook features are disabled. Child
process environment inheritance is limited to `PATH`, locale, its private Codex
home, and an explicitly supplied API key if used. Model prompts never receive
controller, economic, or transport keys. Child stderr is discarded, and incoming
server requests for tools, permissions, login, or user input are denied.

The defaults are 60 seconds per request, 256 KiB produced text, a 64 KiB prompt,
and 3 seconds to confirm interruption. Configured duration cannot exceed five
minutes. A stalled interrupt closes the child and records uncertainty; process
termination cannot prove that already submitted remote computation stopped.
Thread setup uses a bounded RPC timeout and does not launch an expired request.
The text bound is a local observation bound, not an upstream token or spend cap.

These controls rely on the pinned Codex executable honoring its configuration;
they are not an OS isolation boundary against a compromised executable. A provider
deploying this beyond a local PoC should run under a dedicated OS/container identity
with its intended egress policy. The worker's backend connection itself requires
network access even though model-invoked network tools are disabled. Relevant
upstream configuration includes feature switches, project-instruction limits,
and default app/tool restrictions.
[Official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

The optional `M2M_CODEX_AUTH_FILE` sidecar setting names an operator-owned auth
file copied privately into this isolated home; its contents are never printed.
Alternatively, `M2M_CODEX_API_KEY` is passed directly to the child environment.
Neither setting is read from a peer request. Protect the state directory as
credential-bearing data, exclude it from source control and backups intended for
public sharing, and retain it for recovery as long as work may remain uncertain.

## Validation observed on 2026-09-11

`npx tsc --noEmit` and `npx tsx scripts/test-codex-worker.ts` passed. Deterministic
fake app-server tests cover duplicate/conflicting requests, durable reopening,
conversation continuation, UTF-8 output bytes, total-versus-last-operation usage,
duplicate/foreign usage, missing usage after recovery, a completed turn whose
launch response was lost, an unreconcilable launch that never restarts, partial
output cancellation, duration expiry, output caps, exact partial-output recovery,
interrupt retry after process restart, invalid counters, and rejection of a
mismatched effective model before dispatch. The research-service integration test
in `scripts/test-native-research.ts` additionally exercises these events against
the real streaming engine with acknowledged byte ceilings and signed checkpoints.

A real synthetic `gpt-5.6-luna` / `xhigh` request completed using 0.154.0. Timings
below are from the durable adapter journal relative to request creation; observed
callback completion was approximately 5.994 seconds.

| Observation | Result |
|---|---:|
| First persisted text | 3.266 s |
| Last persisted text | 5.897 s |
| Persisted text fragments | 151 |
| Produced UTF-8 bytes | 893 |
| Usage notifications | 1, at 5.989 s |
| Completed state | 5.992 s |
| Input tokens | 2,515 |
| Cached/cache-write input tokens | 0 / 0 |
| Output tokens | 195 |
| Reasoning output tokens (included in output) | 38 |
| Total tokens | 2,710 |

For this run, all visible text preceded the single usage notification. This
supports incremental text delivery and turn-level observed usage, with no claim
of token-level credit enforcement. This was a synthetic local adapter call,
separate from any paid Iroh/Sui integration demonstration. An initial setup probe
used the documentation's sandbox spelling and was rejected before a turn was
launched; using the installed schema spelling above resolved that mismatch.

A second synthetic turn after closing and reopening both the worker and app-server
completed in 3.572 seconds. Retrying the original request returned its unchanged
record without dispatch. The follow-up reused the saved thread and had a distinct
turn ID: 167 UTF-8 output bytes, 26 text fragments, and one usage event. The adapter
subtracted the saved 2,710-token baseline and attributed 2,814 tokens to the new
request (2,770 input; 44 output, including 12 reasoning). Reopening also confirmed
the CLI-generated `skills/.system` directory described above must be allowed in
the isolated home; custom skill paths remain rejected.

To repeat a bounded synthetic probe, provide a fresh private directory through
`M2M_CODEX_PROBE_STATE_DIR` and run
`npx tsx scripts/test-codex-worker.ts --live`, with one of the credential settings
above. It prints status, event timings, byte lengths, and usage totals; it does not
print prompt/response text, thread IDs, credentials, or backend error messages.
Run `--live-continue` with the same probe state directory to verify a saved-request
replay and follow-up after process restart. In this environment the explicit auth
source was `M2M_CODEX_AUTH_FILE=/home/bl/.codex2/auth.json`; other operators must
provide their own credential-file path. The adapter never imports that directory's
configuration or plugins.
