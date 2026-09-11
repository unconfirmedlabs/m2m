# Research service over native streaming v1

Experimental issue #1 adapter binding, 2026-09-11. The named coordinator requests
research from the provider over `extension.payment.sui.streaming.v1`. Both endpoints
also support unpaid echo/hash messages. See [core](NATIVE_CORE_SPEC.md),
[economics](STREAMING_V1_SPEC.md), and [Codex worker](CODEX_WORKER.md).

The initial live policy meters `input_utf8_bytes` and `output_utf8_bytes`. It counts
the original prompt once when dispatch begins, and cumulative response bytes once
when committed to the durable delivery journal. Retransmission does not count
again. New work may charge its own input, including repeated text; byte pricing
has no cache discount. Hidden prompts, reasoning, backend retries, tools and
transport overhead add no units. Output includes the worker's agent-message
content, in event order; tool payloads are not response bytes. A record policy
and separate input/cached-input/output price vectors test the generic engine.

This choice follows the live Codex observation: token usage arrived after visible
output. Token-level delivery or compute backpressure is not established. The
provider buffers generated output within configured byte/time limits, releases
only credit-authorized byte slices, and requests interruption on cancellation or
the worker's configured duration/output limit. Credit exhaustion pauses delivery,
not backend generation; there is no separate exhaustion-triggered compute timer.
Backend work already incurred may exceed paid delivery.
Upstream cost is a separate provider concern. Signed usage authenticates the
provider report; it proves neither execution nor answer correctness.

Request commitment is BLAKE2b-256 of ordered BCS `(purpose: bytes =
"m2m/research/request/v1", channel: address, conversation: bytes32, request: bytes32,
sequence: u64, input: bytes, model: bytes = "gpt-5.6-luna", reasoning: bytes =
"xhigh")`. JSON request fields are `version: 1`, `conversation`, `request` (64
lowercase hex digits), `sequence` (canonical decimal), and `prompt` (UTF-8 string,
at most 16 KiB). The initial service permits one request per funded channel;
continuations require a new channel and the same persisted Agent/conversation
mapping. The standalone worker supports and has demonstrated that mapping across
process restarts. The composed CLI currently isolates a worker per run and has not
yet integrated cross-channel conversation continuity. The generic engine
independently supports multiple sequential requests.

Extension contents are strict JSON commands. `credit` contains `request` and
buyer-signed `credit`; it persists provider acknowledgement before returning an
`ack`. `start` carries the request hash and is legal only after that credit. The
buyer sends it after persisting the acknowledgement. Dispatch goes through the
worker's durable request/turn mapping; repeated starts never create new work.

`poll` carries request hash and last accepted output-byte offset as a decimal
string. It returns the next saved output/checkpoint, a newly credit-gated slice,
or a waiting status. The envelope signs the provider's progress and reported
usage. New credits bind the latest checkpoint; polling resumes saved delivery
before new output is generated. Equal-offset final checkpoints carry provider
close consent after completion, failure or cancellation. No final-answer approval
or usefulness judgement is required. `cancel` persists an interruption request;
it is retried after restart until confirmed. Before dispatch, cancellation produces
a zero-use close without starting a worker. After dispatch, already produced
output may still be drained within the acknowledged ceiling; cancellation is not
a revocation of signed credit. Already committed delivery remains billable.
Provider-reported upstream token
usage, delivered units, authorized ceilings, and redeemed Sui amount remain distinct.

Caller responsibilities: independently resolve both Agent authorities, negotiate
the exact feature, reconcile Channel state/terms/deadlines before starting and
every extension operation, hold one writer lock per side, persist outgoing
requests, and replay before generating fresh authorization. The server never
accepts peer-provided snapshots as chain evidence. On restart it reconciles the
known worker; uncertain execution cannot be restarted automatically.

Core envelopes are retried with their original message ID and timestamps while
valid, rebinding only the explicitly permitted session/transport generation. An
expired envelope is never extended in place. The composed client may send a new,
correlated core message for the same application operation: persisted opening
nonce, identical credit/sequence, worker request ID, or output cursor. The service's
own durable idempotency reconciles that operation; an uncertain generic core
dispatch is never blindly executed again under its old ID. Saved acknowledgements
and output checkpoints remain recoverable after work expiry or channel close;
these reads cannot authorize new work. Unknown execution remains an error after
bounded reconciliation attempts.
