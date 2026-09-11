import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { parseResponsesSse, ResponsesTransportError, OpenAIResponsesTransport, type ResponsesEvent } from './responses-transport.js';

function bytes(text: string): Uint8Array[] {
  const encoded = new TextEncoder().encode(text); const chunks: Uint8Array[] = [];
  for (let i = 0; i < encoded.length; i += 2) chunks.push(encoded.slice(i, i + 2));
  return chunks;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void; reject(error?: unknown): void } {
  let resolve!: (value: T | PromiseLike<T>) => void; let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

async function tests(): Promise<void> {
  const parserEvents = parseResponsesSse(bytes(': comment\r\ndata: {"type":"response.output_text.delta","delta":"hé"}\r\n\r\ndata: {"type":"response.completed","ok":true}\r\n\r\n'));
  assert.equal(parserEvents.length, 2); assert.equal(parserEvents[0].delta, 'hé'); assert.equal(parserEvents[1].type, 'response.completed');
  assert.throws(() => parseResponsesSse([new Uint8Array([100, 97, 116, 97, 58, 32, 0xff])]), (error: unknown) => error instanceof ResponsesTransportError && error.code === 'invalid_utf8');
  assert.throws(() => parseResponsesSse(bytes('data: {"x":\n')), (error: unknown) => error instanceof ResponsesTransportError && (error.code === 'malformed_json' || error.code === 'truncated_sse_frame'));
  assert.throws(() => parseResponsesSse(bytes(`data: ${JSON.stringify({ x: 'x'.repeat(100) })}\n\n`), 16), (error: unknown) => error instanceof ResponsesTransportError && (error.code === 'sse_event_limit' || error.code === 'sse_frame_limit'));
  assert.deepEqual(parseResponsesSse(bytes(': keepalive\n\n')), []);

  const serverMode = { kind: 'stream' as 'stream' | 'multi-frame' | 'coalesced-frame' | 'duplicate' | 'unicode' | 'deep' | 'slow' | 'slow-body' | 'oversized' | 'error', requests: 0, chunks: 0 };
  const server = http.createServer((request, response) => {
    serverMode.requests++;
    if (serverMode.kind === 'slow') { setTimeout(() => response.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"slow"}'), 75); return; }
    if (serverMode.kind === 'slow-body') { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"id":"slow-body","x":"'); let parts = 0; const timer = setInterval(() => { if (++parts === 12) { clearInterval(timer); response.end('"}'); } else response.write('x'); }, 8); return; }
    if (serverMode.kind === 'oversized') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(`{"id":"oversized","x":"${'x'.repeat(256)}"}`); return; }
    if (serverMode.kind === 'error') { response.writeHead(400, { 'content-type': 'application/json' }); response.end('{"error":"fixture"}'); return; }
    if (serverMode.kind === 'multi-frame') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      let index = 0;
      const timer = setInterval(() => {
        if (response.destroyed) { clearInterval(timer); return; }
        const frame = `data: {"n":${index}}\n\n`;
        if (Buffer.byteLength(frame, 'utf8') !== 15) { clearInterval(timer); response.destroy(new Error('fixture_frame_size')); return; }
        response.write(frame); serverMode.chunks++;
        if (++index === 8) { clearInterval(timer); response.end(); }
      }, 3);
      return;
    }
    if (serverMode.kind === 'coalesced-frame') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const frames = Array.from({ length: 8 }, (_, index) => `data: {"n":${index}}\n\n`);
      assert.equal(frames.every(frame => Buffer.byteLength(frame, 'utf8') === 15), true);
      response.end(frames.join('')); serverMode.chunks++;
      return;
    }
    if (request.url?.endsWith('/cancel')) {
      let body = '{"id":"cancelled","status":"cancelled"}';
      if (serverMode.kind === 'duplicate') body = '{"id":"cancelled","id":"changed"}';
      if (serverMode.kind === 'unicode') body = '{"id":"cancelled","x":"\\ud800"}';
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(body); return;
    }
    if (request.url?.startsWith('/v1/responses/') && request.method === 'GET') {
      let body = '{"id":"retrieved","status":"completed"}';
      if (serverMode.kind === 'duplicate') body = '{"id":"retrieved","id":"changed"}';
      if (serverMode.kind === 'unicode') body = '{"id":"retrieved","x":"\\ud800"}';
      if (serverMode.kind === 'deep') { body = '{"x":'; for (let i = 0; i < 40; i++) body += '{"x":'; body += '0'; for (let i = 0; i < 41; i++) body += '}'; }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(body); return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const first = 'data: {"type":"response.created"}\n\n'; const second = 'data: {"type":"response.completed"}\n\n';
    response.write(first); serverMode.chunks++;
    setTimeout(() => { if (!response.destroyed) { response.write(second); serverMode.chunks++; response.end(); } }, serverMode.kind === 'stream' ? 75 : 1);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const httpsModule = https as unknown as { request: typeof https.request };
  const originalRequest = httpsModule.request;
  httpsModule.request = ((options: unknown, callback: unknown) => {
    const input = { ...(options as Record<string, unknown>), protocol: 'http:', hostname: '127.0.0.1', port, agent: false };
    return (http.request as unknown as (options: unknown, callback: unknown) => unknown)(input, callback);
  }) as typeof https.request;
  try {
    const make = (requestTimeoutMs = 100, streamIdleTimeoutMs = 200) => new OpenAIResponsesTransport({ apiKey: 'fixture-key', maxRequestBytes: 64 * 1024, maxResponseBytes: 64 * 1024, requestTimeoutMs, streamIdleTimeoutMs });
    const options = (signal = new AbortController().signal, charged: number[] = []) => ({ signal, chargeReceivedBytes: async (count: number) => { charged.push(count); } });

    serverMode.kind = 'duplicate'; const duplicate = make(); await assert.rejects(() => duplicate.retrieve('retrieved', options()), (error: unknown) => error instanceof ResponsesTransportError && error.code === 'duplicate_json_key'); duplicate.close();
    serverMode.kind = 'unicode'; const unicode = make(); await assert.rejects(() => unicode.retrieve('retrieved', options()), (error: unknown) => error instanceof ResponsesTransportError && error.code === 'invalid_unicode'); unicode.close();
    serverMode.kind = 'deep'; const deep = make(); await assert.rejects(() => deep.retrieve('retrieved', options()), (error: unknown) => error instanceof ResponsesTransportError && error.code === 'json_depth_limit'); deep.close();

    const aborted = new AbortController(); aborted.abort(); const beforeAbort = serverMode.requests; const pre = make(); await assert.rejects(() => pre.retrieve('retrieved', options(aborted.signal)), /request_aborted/); assert.equal(serverMode.requests, beforeAbort); pre.close();

    // Header timeout is distinct from a healthy long-lived stream: after the
    // headers arrive, the 15s-style request timer never kills SSE generation.
    serverMode.kind = 'stream'; const charged: number[] = []; const streamTransport = make(20, 200); const stream = await streamTransport.create({ model: 'fixture' }, { ...options(new AbortController().signal, charged), clientRequestId: 'fixture-request' }); const streamEvents: ResponsesEvent[] = [];
    for await (const event of stream) streamEvents.push(event); assert.equal(streamEvents.length, 2); assert.ok(charged.length > 0); assert.ok(charged.reduce((a, b) => a + b, 0) > 0); streamTransport.close();
    // A streamed response uses the cap per SSE frame, while durable byte
    // accounting still charges every frame. Eight valid 15-byte frames must
    // therefore pass a 60-byte finite-body cap and charge 120 bytes.
    serverMode.kind = 'multi-frame'; const multiFrameBytes: number[] = []; const multiFrameTransport = new OpenAIResponsesTransport({ apiKey: 'fixture-key', maxRequestBytes: 64 * 1024, maxResponseBytes: 60, requestTimeoutMs: 100, streamIdleTimeoutMs: 200 }); const multiFrameStream = await multiFrameTransport.create({ model: 'fixture' }, { ...options(new AbortController().signal, multiFrameBytes), clientRequestId: 'multi-frame-request' }); const multiFrameEvents: ResponsesEvent[] = [];
    for await (const event of multiFrameStream) multiFrameEvents.push(event); assert.equal(multiFrameEvents.length, 8); assert.deepEqual(multiFrameEvents.map(event => event.n), [0, 1, 2, 3, 4, 5, 6, 7]); assert.equal(multiFrameBytes.reduce((sum, count) => sum + count, 0), 120); multiFrameTransport.close();
    serverMode.kind = 'coalesced-frame'; const coalescedBytes: number[] = []; const coalescedTransport = new OpenAIResponsesTransport({ apiKey: 'fixture-key', maxRequestBytes: 64 * 1024, maxResponseBytes: 60, requestTimeoutMs: 100, streamIdleTimeoutMs: 200 }); const coalescedStream = await coalescedTransport.create({ model: 'fixture' }, { ...options(new AbortController().signal, coalescedBytes), clientRequestId: 'coalesced-frame-request' }); const coalescedEvents: ResponsesEvent[] = [];
    for await (const event of coalescedStream) coalescedEvents.push(event); assert.equal(coalescedEvents.length, 8); assert.deepEqual(coalescedEvents.map(event => event.n), [0, 1, 2, 3, 4, 5, 6, 7]); assert.equal(coalescedBytes.reduce((sum, count) => sum + count, 0), 120); coalescedTransport.close();
    serverMode.kind = 'stream';
    const chargeGate = deferred<void>(); const gatedCharges: number[] = []; let chargeCalls = 0; const gatedTransport = make(100, 500); const gatedStream = await gatedTransport.create({ model: 'fixture' }, { signal: new AbortController().signal, chargeReceivedBytes: async count => { chargeCalls++; gatedCharges.push(count); if (chargeCalls === 1) await chargeGate.promise; }, clientRequestId: 'gated-charge-request' }); const gatedIterator = gatedStream[Symbol.asyncIterator](); const gatedFirst = gatedIterator.next(); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(chargeCalls, 1); let yieldedBeforeCharge = false; void gatedFirst.then(() => { yieldedBeforeCharge = true; }); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(yieldedBeforeCharge, false); chargeGate.resolve(); assert.equal((await gatedFirst).done, false); while (!(await gatedIterator.next()).done) {} assert.ok(gatedCharges.length > 0); gatedTransport.close();
    const midStreamAbort = new AbortController(); const abortTransport = make(100, 500); const abortStream = await abortTransport.create({ model: 'fixture' }, { ...options(midStreamAbort.signal), clientRequestId: 'abort-request' }); const abortIterator = abortStream[Symbol.asyncIterator](); assert.equal((await abortIterator.next()).done, false); midStreamAbort.abort(); await assert.rejects(() => abortIterator.next(), /request_aborted|response_read_failed/i); abortTransport.close();
    serverMode.kind = 'slow'; const slow = make(20, 200); await assert.rejects(() => slow.retrieve('slow', options()), (error: unknown) => error instanceof ResponsesTransportError && error.code === 'header_timeout'); slow.close();

    serverMode.kind = 'slow-body'; const slowBody = make(20, 30); await assert.rejects(() => slowBody.retrieve('slow-body', options()), (error: unknown) => error instanceof ResponsesTransportError && error.code === 'request_timeout'); slowBody.close(); const slowCancel = make(20, 30); await assert.rejects(() => slowCancel.cancel('cancelled', options()), (error: unknown) => error instanceof ResponsesTransportError && error.code === 'request_timeout'); slowCancel.close();
    serverMode.kind = 'oversized'; const oversizedBytes: number[] = []; const oversized = new OpenAIResponsesTransport({ apiKey: 'fixture-key', maxRequestBytes: 64 * 1024, maxResponseBytes: 60, requestTimeoutMs: 100, streamIdleTimeoutMs: 200 }); await assert.rejects(() => oversized.retrieve('oversized', options(new AbortController().signal, oversizedBytes)), (error: unknown) => error instanceof ResponsesTransportError && error.code === 'response_body_limit'); assert.ok(oversizedBytes.reduce((sum, count) => sum + count, 0) > 0); oversized.close();

    serverMode.kind = 'error'; const errorBytes: number[] = []; const errorTransport = make(); await assert.rejects(() => errorTransport.retrieve('retrieved', options(new AbortController().signal, errorBytes)), (error: unknown) => error instanceof ResponsesTransportError && error.code === 'provider_rejected'); assert.ok(errorBytes.reduce((sum, count) => sum + count, 0) > 0); errorTransport.close();
    serverMode.kind = 'stream'; const cancellation = make(); const snapshot = await cancellation.cancel('cancelled', options()); assert.equal(snapshot.status, 'cancelled'); cancellation.close();
    serverMode.kind = 'duplicate'; const badCancel = make(); await assert.rejects(() => badCancel.cancel('cancelled', options()), (error: unknown) => error instanceof ResponsesTransportError && error.code === 'duplicate_json_key'); badCancel.close();

    serverMode.kind = 'stream'; const closeTransport = make(100, 500); const held = await closeTransport.create({ model: 'fixture' }, { ...options(), clientRequestId: 'close-request' }); const iterator = held[Symbol.asyncIterator](); const first = await iterator.next(); assert.equal(first.done, false); closeTransport.close(); await assert.rejects(() => iterator.next(), /request|response|closed|aborted/i);
  } finally {
    httpsModule.request = originalRequest;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  console.log('Responses transport: strict SSE/JSON, actual HTTP routing, charge ordering, pre-abort, header/stream timeout separation, non-2xx cleanup and close wakeup passed (fixture-only).');
}

await tests();
