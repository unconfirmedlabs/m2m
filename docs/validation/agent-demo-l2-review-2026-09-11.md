# Astra L2 critical-path review — 2026-09-11

Status: **return the six bounded corrections below to Luna before another host
acceptance run**. Auth A01–A03 pass at the new hashes. This is a local,
fixture-injected review of the real HTTP/projection/client modules, not live
L1, model, Iroh, Sui, Fly or investor-demo acceptance.

## Frozen inputs and executed evidence

The five supplied source/auth-test hashes matched both before and after review:

| File under scripts/ | SHA-256 |
| --- | --- |
| agent-demo-auth.ts | 7ab7eae75af1efed7cc22fe562a4220c6549fb1ec3134dca3d95b43efb038c73 |
| test-agent-demo-auth.ts | ebd9de868dd3d048a2f01549c37d66bc12335e24c8823a9f54921981d7c6b587 |
| agent-demo-server.ts | 729684a74b38fc290ec8d5d7f6df73b2976bcdd60fbc732e5ae022c4d5787022 |
| agent-demo-projection.ts | b0d0b516858aa87931b0aa0f769da4794b661c809f0650a8776a37103cc364f9 |
| agent-demo-provider-client.ts | 9b203f0b31c490daf79566fac6c0cab11024aa7ccec40401394b33b85c4e791f |

Owner tests also executed successfully:

```sh
npx tsx scripts/test-agent-demo-auth.ts
npx tsx scripts/test-agent-demo-http.ts
npx tsx scripts/test-agent-demo-projection.ts
npx tsx scripts/test-agent-demo-provider-client.ts
```

Observed test hashes: HTTP faa349f99aae5cfa1cf689043092bb320527ec8cad7d9b0f8766b97b3153e7f6;
projection ff2693230d5e058f93f8b5a68e43079a25ecb7e5083e0989cb29d06a8b329158;
provider a68a198f15fa24b7035949af8f046b495656dad0cabb0420a924bac09d783d3d.
These owner tests are small ordinary-path checks, not the complete F08–F11 matrix.

Independent probes used actual `openDemoHttp` and `DemoProjection`, generated
constant test bearer tokens, temporary real journals, loopback HTTP, and
`createPublicSessionFixture()`. The injected handle exposes detached fixture
status/identities/economy, a contiguous source event list with correct per-role
cursors, real subscriber callbacks, a ready publication cursor derived from
that list, and a counted fake submit. Its source page filters after each role
cursor, takes the requested limit, and correctly reports high water/has_more.
Independent host probes omit providerBaseUrl, so they perform no private polling
or external requests. The owner HTTP test itself configures a fixture private
provider URL; its green result does not prove that provider service exists.

## Auth A01–A03: narrow accepted correction

Independent assertions passed for all three original failures and nearby valid
cases:

- Provider construction requires observer-only configuration; adding viewer,
  operator or public-origin properties is rejected. Canonical zero/nonzero
  private replay cursors are accepted; missing, malformed, duplicate and extra
  query parameters are rejected. Provider public/mutation routes stay forbidden.
- Returned principals expose only role/clientAddress, with no reachable owner
  or serialized bearer state. Assignment/redefinition of role fails; viewer,
  copied/forged and another instance's principals cannot admit controls.
- A genuine operator admits controls; eight SSE leases are allowed, the ninth
  is denied, and idempotent release restores the allowance.

This accepts the corrected auth object/route gate only. HTTP callers must still
use that gate and independently validate every response they serialize.

## H01 — honest provider host cannot start

Source: server startup around lines 309–327. Catch-up and live ingestion are
unconditionally pinned to source coordinator, even for runtime.role provider.

Minimum failing test:

1. Use an honest provider handle whose events page has source provider and the
   fixture's provider research/host records.
2. Call openDemoHttp with only observerToken and a fresh projection directory.
3. Assert it starts and serves authenticated private status/events/locator.

Actual: construction rejects `invalid_event` before listening. Production
bootstrap consequently takes its blocked-host path. No provider ready service
can be established through this path.

Required: role-correct source replay/subscription (or the specified private
provider-only path), preserving the separate source namespace. Add real local
HTTP positives for all three observer routes and negative public/control routes;
do not relabel provider records as coordinator evidence.

## H02 — evidence response bypasses the public sanitizer

Source: server evidence route around line 422 directly serializes
`await runtime.evidence(channel)`.

Minimum failing test: replace only the injected evidence getter with:

```js
async channel => ({
  version: 1, conversation: fixture.pins.conversation, channel,
  private_key: 'TEST_FIXTURE_PRIVATE_DO_NOT_PUBLISH',
  raw_model: { reasoning: 'TEST_FIXTURE_REASONING' }
})
```

Authenticated viewer GET of the selected channel returns HTTP 200 containing
both sentinels. This is a concrete missing output boundary, not evidence that
production L1 currently returns real secrets.

Required: exact bounded DemoEvidence construction/validation, including nested
public structures and pinned conversation/requested channel, before serialization.
Reject unexpected fields with a fixed error and zero sentinel disclosure.
Add the corresponding valid public evidence positive. Preserve the division:
L1 supplies retained verified economic evidence; a stateless sanitizer cannot
manufacture cryptographic or historical verification. Also keep the private
locator's public shape exact when wiring that route; its current direct clone
was inspected but not independently fault-probed in this bounded tranche.

## H03 — SSE skips every retained event after the first replay page

Source: server streamEvents around lines 445–447 calls
`projection.replay(after)` once; its default limit is 256.

Minimum failing test:

1. Clone a valid coordinator model_text fixture into 300 records with contiguous
   canonical IDs 1–300 and explicitly labeled test text.
2. Open the actual host with those durable source records.
3. GET events with Last-Event-ID equal to conversation:0; collect until live.

Actual: HTTP 200, exactly 256 agent_event frames, last ID conversation:256, then
stream_status live with high_water 300. No subsequent source event is needed to
demonstrate that records 257–300 were silently omitted.

Required: bounded replay paging through the captured cut before live, coupled
to buffered live delivery with exact dedupe/cursor continuity. Apply the same
bounded backpressure path to replay/status/live frames; do not solve the count
bug by loading unbounded history. Assert all 300 IDs once and in order, reconnect
from 256 yields 257–300, and append during replay is neither lost nor duplicated.

## H04 — projection failure blocks reads but still admits new work

Source: session/status check projectionFailure, but POST controls around
line 416 calls runtime.submit without that admission predicate.

Minimum failing test:

1. Start the healthy coherent fixture host.
2. Through its actual subscribed source callback emit an existing valid
   coordinator-source host record cloned with id 99, creating a source gap.
3. Await the ingestion rejection being observable through GET status.
4. Submit a genuine operator task with valid Origin, JSON and fresh 64-hex ID.

Actual: status returns 409; task returns 202 accepted; counted runtime.submit
is invoked once.

Required: a poisoned/unavailable canonical publication must prevent new-effect
admission, with a fixed truthful readiness failure and zero new task/funding/
resume effects. Preserve explicitly authorized protective cancellation/pause
behavior and durable recovery; do not put every safety control behind an
indefinite blanket gate. Add failure/recovery and unchanged-control-ID assertions
at the actual HTTP/handle seam, not only a detached admission helper.

## H05 — startup replay/subscription cutover loses a source record

Source: initial replay awaits projection saves before subscribing to the source.

Minimum controlled test:

1. Initial source contains only coordinator model_text id 1.
2. On the first runtime.events call, construct the correct final page for id 1,
   then queueMicrotask to durably append/emit valid id 2 before returning it.
3. Start the actual host and request session.

Actual: source publication cursor is coordinator 2, but session is 409 not_ready.
The event was emitted before the subscriber was installed and no local periodic
catch-up imports it. The honest snapshot equality guard correctly refuses to
fabricate a complete cut; startup transport ordering stranded that guard.

Required: subscribe/buffer, capture and drain replay, then merge under the
serialized dedupe boundary described in L2. Assert readiness eventually includes
both records once, no reset/relabel of the cursor, and an append at the final
page boundary remains present after projection reopen.

## H06 — an open SSE prevents graceful host close

Source: returned close calls server.close but never closes active SSE responses;
production waits for that close before runtime shutdown.

Minimum controlled test: open authenticated SSE, read its first frame, call
app.close without cancelling the reader, and observe completion. Actual close
is still pending after 100 ms; cancelling the reader immediately lets it finish.
The source confirms that no close path ends the response, so this is not a claim
that 100 ms itself is the required graceful-shutdown deadline.

Required: track and stop streaming responses/subscriptions/leases on host close,
settle pending drain waits on disconnect, and complete within the specified
shutdown grace so the owning runtime shutdown can run. Add an active-stream
close test that does not use client disconnect as the condition enabling cleanup.

## Positive boundaries and explicit limits

The actual owner projection test accepts all 19 coherent fixture records,
separates coordinator/provider host cursors, rejects changed duplicates and
gaps, bounds replay, rejects a future cursor, and reopens retained history.
The actual owner HTTP test covers ordinary authenticated bootstrap/status,
accepted task/control lookup, unauthorized/query rejection, static index delivery
and a first SSE chunk. It does not boot a provider, fetch evidence, replay over
256 events, interleave a source append during startup, poison then submit, or
close with an active stream; those omissions explain why its green smoke result
does not cover H01–H06.

The private client test checks ordinary source/status/locator shapes, observer
header/no cookie, and one malformed response. Static inspection also finds fixed
error mapping, body/response bounds, redirect denial, HTTPS-public-origin auth,
built-root traversal checks, no source maps, and no runtime fixture fallback.
These are narrower positives, not complete adversarial or container acceptance.

No changing L1/runtime/UI implementation was reviewed as frozen. Provider-status
materialization at projection S, producer publication fences after real economic
saves, actual blocked image boot, full static asset allowlist behavior, body
deadlines/backpressure under real stalled sockets, complete operator replay
semantics, and live model/transport/chain evidence remain integration acceptance
work. Do not describe this return as a general redesign or a complete threat
model; fix and regress the six reproduced boundary defects first.
