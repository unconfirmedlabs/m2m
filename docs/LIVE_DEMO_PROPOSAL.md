# Live two-agent investor demo

Updated 2026-09-11 from the user's explicit requirements. Accepted demo behavior:
Tailwind split screen; local/user agent on the left, research agent on the right;
both make real LLM decisions and exchange real m2m messages and channel payments.
A system prompt guides and bounds the local agent. Answers, follow-up requests,
timing and payment totals may differ on every run. No canned responses, replayed
success path, simulated transport, mock ledger, or hidden fixture fallback.
Deterministic fixtures remain useful **only in tests**.

The architecture below is a recommendation, not a deployed app. The original
[validated CLI](NATIVE_VALIDATION.md) has a programmed coordinator and a live
Codex text worker. The subsequent [agent-services scope](AGENT_SERVICES_SPEC.md)
implements the two-agent tool-loop plumbing and conversation binding locally; its
[validation record](AGENT_SERVICES_VALIDATION.md) separates injected-inference
payment tests from live acceptance. The real adapter probe failed the safe-tool
gate, so production live profiles refuse to start before funding. Full two-LLM
research has not run; the investor demo is not yet working end to end.

## Runtime recommendation

Use a React/Tailwind browser UI with two real Linux Fly Machines, one per Agent.
A small authenticated control/event service launches sessions, applies operator
limits, and streams sanitized durable events to the UI. Agent-to-Agent traffic
continues over Iroh; the UI connection does not impersonate that transport.
Sui testnet supplies actual identity/funding/settlement. Each machine retains its
keys, channel journals, worker state and event cursor on persistent storage.
Enforce one active writer per Agent; restarting a machine must recover its state,
not provision a fresh identity or deposit. Machines are an operator isolation
choice, not evidence of independently controlled businesses.

Browser containerization is possible for some runtimes, but not a drop-in host
for these native Rust and Codex executables. WebContainers support JavaScript and
WebAssembly and reject unported native binaries/addons; see their
[native-code limitation](https://webcontainers.io/guides/troubleshooting), checked
2026-09-11. Iroh has browser/Wasm support (also present in this repository's pinned
Iroh 1.2.0 source); a future browser coordinator is possible but requires a real
port and browser-specific key/storage/transport validation. The
[Iroh browser introduction](https://www.iroh.computer/blog/iroh-0-33-0-browsers-and-discovery-and-0-RTT-oh-my)
describes the earlier relay-backed implementation; it is not a current universal
direct-connect guarantee. Fly provides API-controlled Linux VMs and persistent
volumes; see [Machines overview](https://fly.io/docs/machines/overview/), checked
2026-09-11. Native m2m on Fly and cloud Codex authentication still require their
own deployment validation; legacy Fly evidence does not establish them.

## Real agency with enforceable limits

The person supplies a task and budget. The local LLM receives an operator-owned
system prompt describing its role, allowed research service, evidence standards,
budget, deadline and stopping rules. It can choose questions, assess the returned
material, request further investigation, or stop. The backend gives it narrow
tools for those actions, not shell access, raw wallet keys, or arbitrary payments.

Prompts guide behavior; deterministic code enforces recipient allowlists, total
and per-channel budgets, maximum outstanding credit, time limits, unit-policy
validation, concurrency and cancellation. A model cannot overrule those guards.
Credit replenishment may be mechanical within a deliberately authorized budget;
the UI must distinguish a model decision from protocol automation. Exact payment
for delivered usage never waits for the local model to approve the answer.

The intended research LLM independently handles received tasks. The implemented,
currently live-gated profile provides separately bounded Brave search and
allowlisted HTTPS fetch with a
durable citation ledger; the original text adapter remains tool-disabled by
default. Returned pages and peer text are untrusted data, not new system authority.
Provider API cost and generated-but-undelivered output remain separate from
m2m's billable delivered units. Keep the issue's Luna `xhigh` research binding;
the coordinator is explicitly bound to the same model/effort for this first scope.

The separately negotiated `service.research.conversation.v2` binding supports
multiple requests on one channel. A turn receipt is not a final channel
checkpoint. An explicit replacement after confirmed settlement preserves the
conversation and worker threads while using a fresh channel opening nonce.

## What the screen shows

Two panels show each Agent's name, connection state, task, public action/status
messages, received/sent text, and current work. Show brief explicit action
explanations, not hidden model reasoning. A shared channel strip shows:

- Sui deposit locked and the actual opening transaction.
- Cumulative signed authorization and current outstanding prepayment exposure.
- Delivered units and their exact cumulative policy price.
- Confirmed redeemed value and remaining locked funds.
- Exact close or expiry outcome, refund, transaction status and digest.

Do not add cumulative credits together or label a signed authorization "transferred
onchain." Report gas separately from channel value. Animate only events that
actually happened; use append-only IDs/cursors so a UI reconnect cannot duplicate
money, text, or work. A read-only verifier can check displayed signatures and Sui
objects independently of the animation.

Start, cancel, spending-pause and disconnect/reconnect controls must affect real
processes/authorization. Do not inject a fake failure or force a successful story
without labeling a deliberate operator action. On quota, budget, model, network
or chain failure, show that failure and its genuine recovery/settlement state.
Recorded sessions may be offered separately with an unmistakable replay label,
never substituted for a live run.

## Completion gates

1. Finish the named testnet deployment and real channel settlement.
2. Implement the live coordinator tool loop, hard budgets, conversation continuity
   and research-source tools; verify adversarial inputs and exhausted budgets.
3. Add durable event projection and the Tailwind UI against actual runtime events.
4. Deploy two Fly Machines with private credentials, persistent recovery and
   authenticated controls; verify real Iroh connectivity, not a browser relay mock.
5. Run unseen audience prompts repeatedly. Require invariant payment/recovery
   checks, not identical answers or an identical number/order of messages.

This would demonstrate genuine autonomous coordination and economic enforcement.
It would not by itself prove customer demand, production readiness, correct
research, profitable pricing, or verifiable model execution.
