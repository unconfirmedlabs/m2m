# Responses runtime NR01–10: bounded correction re-review

Checked 2026-09-11. **One exact returned transport case still fails: NR09's
multi-frame SSE limit.** The other named reproduction cases below now pass.
Return that narrow transport correction and permanent regression; do not reopen
a general design/audit tranche. Production remains gated and R14 remains
unimplemented. This is not blanket AR/R01–15 or live-demo acceptance.

Implementation and owner tests were read-only. No real credentials, inference,
web research, Iroh/Sui activity, payments, provisioning or deployment occurred.
HTTP probes redirected only the transport's HTTPS request constructor to a local
Node HTTP server, preserving its real iterator/parser/charging implementation.
Worker probes used actual private temporary journals and the production worker.

## Frozen provenance

All five hashes matched before and after the review:

| File under `scripts/` | SHA-256 |
| --- | --- |
| `agent-runtime.ts` | `a3967367c1636451af3cdd205762215a5ff440c3fb89a13b3e55f13ecce79943` |
| `responses-transport.ts` | `407fddd38d18d4c665baa5eab345edddb1342e0ecb3590d08c22ec7b2f79b5ed` |
| `responses-worker.ts` | `325bfdc20c2db37f7c9e3d6a6441cc9a9a58071c1ee901b7e7be73513fd601b4` |
| `test-responses-transport.ts` | `6d277cb8282da4c8473263a5a2242d634d2b8cf06eb476244851061d735ba808` |
| `test-responses-worker.ts` | `673933db11a29de04b4291994f205ccae87b1ddf5de35f5ca0d9b94dfc218a53` |

Compared against the exact NR01–10 cases in
[the preceding re-review](responses-runtime-astra-rereview-2026-09-11.md).
The OpenAI Docs skill was used first; current primary documentation still
describes saved response-ID/sequence-cursor recovery and explicit cancellation.
No undocumented convenience event field was made mandatory by this review.
[Background Responses documentation](https://developers.openai.com/api/docs/guides/background),
opened 2026-09-11.

## Actual commands and seam evidence

Passed independently:

```sh
npm run agent-runtime-tests
npm run agent-runtime-integration-tests
```

The latter is still the actual coordinator/Responses worker with explicitly
injected model transport, ResearchPort and budget bindings: unresolved callback
does not continue, explicit exact-reference recovery retains callback/request
identities, one continuation occurs, completed replay causes no new effects, and
the valid complete streams require zero unnecessary recovery GETs. It does not
prove crash, real API, Iroh or chain behavior.

Both `tsx scripts/test-responses-worker.ts --live` and `--live-continue` again
fail with `live_probe_unimplemented`. Neither is a passing live check; the
unchanged production factory gate must remain intact.

## Named corrected cases

The independent harness reused the owner test's fixture producer definitions via
in-memory transpilation with its autorun removed; it did not modify that test or
replace worker implementation. It added the exact original initial-stream gap,
held-immediately-after-ack and actual HTTP probes, and varied crash recovery
entrypoints. Results are separated from broad acceptance claims.

| Group | Actual narrow result |
| --- | --- |
| NR01, acknowledged successor crash | Real child exit after successor response.created, durable reopen, then both original `run` replay and separate `reconcile` variant pass: complete successor via one GET, zero new continuation POSTs. Saved pending-result fields have been consumed at acknowledgement. |
| NR02, nonrecoverable pending callback | Checked-in real child crash inside handler passes run replay without another handler/POST. Independent fresh-reopen **direct reconcile first** variant also passes with zero handler/POST; it does not rely on run first converting pending to uncertain. |
| NR02, prepared request crash | Real child exit after prepared save, before create intent: reconciliation submits exactly the saved `review prompt`, not an empty invented input. |
| NR03, lost successor acknowledgement | Cancel remains uncertain and targets no predecessor. A different new request gets conversation_busy, both before and after shutdown/reopen/reconcile. Creates remain exactly two and cancellation targets remain empty. |
| NR04, same-key concurrent callback | Hold actual handler; same-key run and reconcile both reject worker_busy. Before release there is one handler and one initial create, not two callbacks. Checked-in simultaneous reconcile guard also passes. |
| NR05, four original complete-output faults | Unknown function, present nonterminal message status, empty message ID and empty call ID each return uncertain, accept zero new bytes, invoke zero handlers and reopen honestly as uncertain. These rows do not establish every full argument/schema variant. |
| NR06, retained prefix | Dropped content, changed item type and insertion before retained item reject as uncertain while retaining only original abc/3 bytes. Negative content index rejects before any text. |
| NR06, original initial-stream gap | Created sequence 0 followed directly by delta sequence 2 now performs one GET, no second create, and completes from the available valid snapshot with abc. Owner resumed-stream gap regression also passes. |
| NR07, consumer stop | Consumer false and throwing-consumer variants persist the canonical tombstone, cancel exactly held-1, finish cancelled, and remain cancelled after shutdown/reopen/reconcile with no host callbacks/new creates. |
| NR07, first acknowledgement publication | Hold immediately after created and before any text. Consumer and saved journal both contain launching then running; saved state is running with zero text bytes. This is stronger than waiting until the owner's held-after-text fixture. |
| NR08, maxEvents 4 | Three-message response returns uncertain, actual saved state is uncertain with three events, and reopened status is uncertain. No transient completed success is reported. |
| NR10, generation-byte exhaustion | Actual saved generation count 100 plus independent terminal-control charge 1 produces confirmed cancelled fixture state; cancellation count one; reopened status cancelled; no generation refill. |

These results accept the named reproduction fixes, not every previously listed
write/fsync, argument, deadline, terminal-metadata, authority or recovery matrix.
The broader unclaimed rows in the preceding artifact are not silently promoted
to passing evidence by this short critical-path review.

## NR09 residual — P1: per-event limit is still applied to total SSE bytes

`responses-transport.ts:318–330` increments one `received` total and rejects it
above `maxResponseBytes` without excluding streaming requests. This is still the
exact prior failure. Eight separate valid 15-byte SSE frames under a 60-byte
single-event/retrieved-response bound produce:

```json
{"events":4,"charged":75,"error":"response_body_limit","expectedEvents":8,"individualFrameBytes":15}
```

Minimum executable local reproduction from repository root (no external call):

```sh
node --import tsx --input-type=module <<'JS'
import http from 'node:http';
import https from 'node:https';
import { OpenAIResponsesTransport } from './scripts/responses-transport.ts';
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  let i = 0;
  const timer = setInterval(() => {
    response.write('data: ' + JSON.stringify({ n: i++ }) + '\n\n');
    if (i === 8) { clearInterval(timer); response.end(); }
  }, 5);
  response.on('close', () => clearInterval(timer));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const original = https.request;
https.request = (options, callback) => http.request({ ...options,
  protocol: 'http:', hostname: '127.0.0.1', port, agent: false }, callback);
const transport = new OpenAIResponsesTransport({ apiKey: 'EXPLICIT_TEST_FIXTURE',
  maxRequestBytes: 4096, maxResponseBytes: 60,
  requestTimeoutMs: 500, streamIdleTimeoutMs: 500 });
let events = 0, charged = 0, error;
try {
  const stream = await transport.create({ model: 'fixture' }, {
    clientRequestId: 'fixture', signal: new AbortController().signal,
    chargeReceivedBytes: async n => { charged += n; },
  });
  for await (const event of stream) events++;
} catch (failure) { error = failure.code; }
finally {
  transport.close(); https.request = original;
  await new Promise(resolve => server.close(resolve));
}
console.log(JSON.stringify({ events, charged, error }));
JS
```

Expected: all eight frames and 120 charged bytes, no error. Preserve bounded SSE
frame/parser and queue handling, the ordinary JSON body bound and the worker's
separate durable total-byte allowance; do not remove total request accounting.
The permanent owner suite lacks this exact small-cap multi-frame regression.

Other original NR09 rows are repaired and were independently re-probed through
the actual HTTP implementation:

- Immediate JSON headers followed by 8-ms trickle, request timeout 20 ms / idle
  30 ms: retrieve and cancel both reject request_timeout (29 ms and 23 ms in this
  run), rather than finishing the approximately 100-ms response.
- Oversized single JSON chunk: response_body_limit after charging 267 bytes,
  not zero.
- Single 400 error response: provider_rejected after charging 24 bytes, not zero.

Add the missing failing regression, repair the streaming/ordinary-body scope of
the size check, preserve those passing cases, and freeze for a short targeted
confirmation. R14/live credentials and the separate real L1/L2/Fly vertical slice
remain independent gates; this review neither designs nor bypasses them.
