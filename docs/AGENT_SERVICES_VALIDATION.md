# Agent services: runner and validation

Checked 2026-09-11. This records implementation and incomplete live acceptance of
the first two runtime milestones for the [Fly/Tailwind demo](LIVE_DEMO_PROPOSAL.md):
bounded live agent tools and continuing conversations. The authoritative scope is
[AS-01–31](AGENT_SERVICES_SPEC.md), with
the [implementation interfaces and T01–T19 gates](AGENT_SERVICES_IMPLEMENTATION.md).
The native v1 economic statement encodings, Move contracts and original research
binding are unchanged. The v2 service requires explicit feature negotiation.

## Implemented runtime and live gate

`scripts/agent-services.ts` composes one role per process. The coordinator profile
defines `research`, `follow_up`, `budget` and `stop`; the provider profile defines
bounded Brave search and allowlisted HTTPS fetch. Both target Codex 0.154.0 with
`gpt-5.6-luna` at `xhigh`.

**Production live roles currently fail with `agent_tool_runtime_unvalidated`
before identity, chain or funding operations.** The worker independently rejects
live `agentProfile` startup without an explicit injected RPC adapter. The tested
Codex configurations did not satisfy AS-20's tool-isolation boundary. There is no
CLI override or automatic backend/knowledge-only/fixture fallback. Only explicit
test-harness injection currently exercises the composed runtime.

Payment authorization is a separate deterministic host action, never a model
tool accepting arbitrary recipients, rates or keys.

A request can renew cumulative credit while preserving its input baseline.
Multiple terminal request receipts can share a funded channel. Only an explicit
operator close obtains the provider's final checkpoint and submits exact Sui
settlement. A new operator task, model completion, stdin EOF or shutdown does
not silently open or close a channel.

The runner currently accepts preconfigured loopback **localnet only**. It does not
provision identities, deploy to Fly, start an HTTP service, render a UI or mutate
public testnet. Persistent protected worker directories are referenced by role
manifests; moving them requires preserving the files, not recreating empty state.
The present local worker locations are temporary-directory allocations, so they
must be migrated to persistent Fly volumes before deployment.

## Intended local operator setup — blocked pending AS-20

The following is the retained operator interface, not a presently working live
quickstart. Supplying credentials does not remove the enablement gate. Once a
safe adapter has been independently validated, these inputs will be required.

Use the existing [native localnet setup](NATIVE_QUICKSTART.md), preserving its
chain state and separate transport/economic keys. Create an operator JSON file:

```json
{
  "version": 1,
  "budget": {
    "max_total_mist": "100000",
    "max_channel_deposit_mist": "12000",
    "max_turn_mist": "10000",
    "max_outstanding_mist": "2000",
    "max_requests": 4,
    "deadline_ms": "<future Unix timestamp in milliseconds>",
    "output_tranche_bytes": 1024
  },
  "deposit_mist": "12000",
  "price": { "input_rate": "3", "output_rate": "7", "denominator": "10" },
  "allowed_hosts": ["fly.io", "docs.sui.io", "www.iroh.computer"]
}
```

Replace the timestamp placeholder with a future decimal string. The immutable
config must be identical when restarting this conversation. Prices are MIST per
UTF-8 byte with the stated denominator, not token billing. Search results may
name other hosts; fetching them still requires an exact operator allowlist match.
The current fetch implementation deliberately supports only public IPv4 targets.

Supply `M2M_CODEX_AUTH_FILE` (an operator-owned credential file outside the repo)
or `M2M_CODEX_API_KEY` to both roles. Supply `M2M_BRAVE_API_KEY` to the provider.
Do not put credential contents into command arguments, task text or checked-in
configuration. Run these separately, with the same 64-lowercase-hex conversation:

```sh
npm run agent-services -- --role provider --state .m2m/native-localnet \
  --conversation <64hex> --config /private/operator.json
npm run agent-services -- --role coordinator --state .m2m/native-localnet \
  --conversation <64hex> --config /private/operator.json \
  --wallet /private/localnet-controller.json
```

The provider reports `provider_ready` on stderr before the coordinator connects.
Coordinator stdin accepts NDJSON; generate a fresh 64-hex ID for each operator
operation, retaining a task's original ID and prompt for retry:

```json
{"op":"task","id":"<64hex>","prompt":"Research my question using official sources."}
{"op":"status","id":"<different64hex>"}
{"op":"cancel","id":"<different64hex>"}
{"op":"close","id":"<different64hex>"}
{"op":"shutdown","id":"<different64hex>"}
```

Cancellation stops new purchases and requests interruption, then drains/reconciles
authorized work; an acknowledgement is not a terminal receipt. Uncertain work
blocks replacement. After confirmed terminal settlement, restarting with
`--previous-channel <closed-channel-id>` explicitly authorizes a fresh opening
within the same retained budget and conversation. Without that flag, a restart
does not reserve a replacement deposit.

Stdout contains sanitized durable public events. Their cursor is the tuple
`(conversation, role, id)`, not a globally ordered ID across machines. Private
worker/tool/transaction journals are not UI data. The current CLI stores public
history locally; an authenticated replay/subscription API remains a later demo
milestone. Hidden reasoning and fetched page bodies are not public events.

## Validation evidence and limits

The original native regression suite and the new ordinary deterministic suite
have passed during integration. They use injected workers/backends and do not
establish successful live research:

```sh
npm run typecheck
npm run native-tests
npm run agent-services-tests
```

Separate opt-in checks:

```sh
npx tsx scripts/test-agent-services.ts --localnet \
  --state .m2m/native-localnet --wallet /private/localnet-controller.json
npx tsx scripts/test-agent-services.ts --live-adapter
npx tsx scripts/test-agent-services.ts --live-research \
  --state .m2m/native-localnet --wallet /private/localnet-controller.json
```

`--localnet` injects inference only: its Iroh bridge processes, economic
signatures, channel funding and settlement are real localnet operations.
`--live-adapter` is intended to exercise a real model's bounded host tool and
resumed thread; its allowance is a probe value, not a payment. It currently stops
at the live gate. `--live-research` additionally requires both model and Brave
credentials and never substitutes a fixture; it also cannot bypass the gate.

The [retained localnet report](validation/agent-services-local-2026-09-11.json)
records a successful real-Iroh/two-process run: two requests on each of two
sequential channels, both roles restarted before first settlement, a closed
restart without an implicit deposit, and explicit replacement with continuing
worker mapping. Each 12,000-MIST deposit settled to **850 MIST paid and 11,150
MIST refunded**, excluding gas. The test independently queried the resulting
Sui channel objects. Inference was an explicitly injected deterministic worker.

Separate offline fault tests drop responses after credit, delivery and completion,
then reopen both application/engine sides. The pre-start credit fault executes
zero research turns and pays zero; delivery and completion faults retain one
execution and settle their respective delivered-byte prices. A real-signature
native-peer/inbox test with memory transport verifies stable application IDs
across expired-core retries, semantic dedupe and retained response proof.
Pre-signature cancellation tests pause an actual durable budget reservation:
cancellation prevents signing while preserving the money/count reservation, and
the next credited request has no sequence gap. Peer error text cannot forge this
trusted no-dispatch result.

These checks cover key T13a–T17 paths across separate harnesses. They do not claim
an exhaustive process-kill matrix for every transition over real Iroh, or a Fly
Machine recovery test. Bounded journal headroom is deliberately conservative;
the conversation outbox is compactly encoded and never evicts economic evidence.

Full live two-LLM web research has **not been run**: AS-20/T18 remains blocked and
a Brave credential was not supplied. Do not present deterministic branching
tests or the adapter probe as completion of T19. Fly deployment, Tailwind UI, named public-testnet
settlement, production reliability, customer demand and correct research remain
outside this validation claim.

## Live adapter blocker

The actual Codex 0.154.0 / Luna `xhigh` adapter probe completed two distinct turns
on one retained thread but invoked **zero host callbacks**. Its public output
reported that the budget tool's code-mode host was disabled. Thus T18 failed;
thread continuation alone is not evidence of a working agent tool loop.

Separate bounded probes enabled code mode and the bundled local host. Required
callbacks then worked, but the model's tool surface also exposed built-in
`apply_patch`. Enabling `disable_in_process_fallback` and trying native/root
namespace exclusion did not establish the required boundary. No such configuration
was enabled in the production worker. These are findings about the tested
configurations, not proof that every possible Codex configuration is unsuitable.

The [official app-server documentation](https://learn.chatgpt.com/docs/app-server)
describes experimental dynamic tools and their router. The
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
describes namespace exclusion for nested guidance/executor exposure; it does not
establish removal from direct tool schemas and dispatch. Read-only write denial,
a clean nested tool list, model refusal, or interruption after an event is not
proof of registered-only dispatch. Checked 2026-09-11 against the installed schema
and the bounded probes above.

Any follow-up retaining this adapter must first specify and prove:

- A separate immutable opt-in routing configuration at launch/start/resume,
  included in the profile fingerprint; the original text-worker defaults stay unchanged.
- A local stdio host with no remote listener or in-process fallback, actual new
  and resumed-thread callbacks, and exact saved-result replay.
- Registered-only tools in both nested and direct dispatch. Controlled sentinel
  probes must test prohibited filesystem/process/network access without exposing
  real credentials. Do not broaden item allowlists merely to pass a probe.
- Strict host dispatch validation, durable serialized limits, cancellation with
  no late effects, and bounded shutdown when the router or host stalls.

Alternatively, an operator-authorized adapter evaluation/migration can assess a
runtime with enforceable tool allowlisting. That is a new specification decision,
not permission to silently switch to NanoCodex, another backend/model, or weaker
isolation. Iroh, Sui, host spending limits, recovery and signed economic meanings
remain unchanged. T19 follows only after T18 and the required credentials.
