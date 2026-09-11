import https from 'node:https';
import { TextDecoder } from 'node:util';

export type ResponsesEvent = Record<string, unknown>;
export type ResponsesSnapshot = Record<string, unknown>;
export type ResponsesCreateBody = Record<string, unknown>;

export interface ResponsesHttpOptions {
  signal: AbortSignal;
  chargeReceivedBytes(count: number): void | Promise<void>;
}

export type ResponsesTransportErrorKind = 'definite' | 'uncertain';

export class ResponsesTransportError extends Error {
  constructor(readonly code: string, readonly kind: ResponsesTransportErrorKind) {
    super(code);
    this.name = 'ResponsesTransportError';
  }
}

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Strict bounded parser shared by all production JSON response paths. */
export function parseResponsesJson(text: string, maxDepth = 32, maxEntries = 32768): unknown {
  if (!validUnicode(text)) throw new ResponsesTransportError('invalid_unicode', 'uncertain');
  let index = 0;
  let entries = 0;
  const whitespace = () => { while (/^[\t\n\r ]$/.test(text[index] ?? '')) index++; };
  const parseString = (): string => {
    const start = index;
    if (text[index++] !== '"') throw new ResponsesTransportError('malformed_json', 'uncertain');
    let escaped = false;
    for (; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (escaped) {
        if (code === 0x75) {
          const hex = text.slice(index + 1, index + 5);
          if (!/^[0-9a-f]{4}$/iu.test(hex)) throw new ResponsesTransportError('malformed_json', 'uncertain');
          index += 4;
        } else if (![0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].includes(code)) {
          throw new ResponsesTransportError('malformed_json', 'uncertain');
        }
        escaped = false;
        continue;
      }
      if (code === 0x5c) { escaped = true; continue; }
      if (code === 0x22) {
        index++;
        let value: unknown;
        try { value = JSON.parse(text.slice(start, index)); } catch { throw new ResponsesTransportError('malformed_json', 'uncertain'); }
        if (typeof value !== 'string' || !validUnicode(value)) throw new ResponsesTransportError('invalid_unicode', 'uncertain');
        return value;
      }
      if (code < 0x20) throw new ResponsesTransportError('malformed_json', 'uncertain');
    }
    throw new ResponsesTransportError('malformed_json', 'uncertain');
  };
  const parseValue = (depth: number): unknown => {
    if (depth > maxDepth) throw new ResponsesTransportError('json_depth_limit', 'uncertain');
    whitespace();
    const character = text[index];
    if (character === '"') return parseString();
    if (character === '{') {
      index++;
      const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const keys = new Set<string>();
      whitespace();
      if (text[index] === '}') { index++; return object; }
      for (;;) {
        whitespace();
        const key = parseString();
        if (keys.has(key)) throw new ResponsesTransportError('duplicate_json_key', 'uncertain');
        keys.add(key);
        if (++entries > maxEntries) throw new ResponsesTransportError('json_entries_limit', 'uncertain');
        whitespace();
        if (text[index++] !== ':') throw new ResponsesTransportError('malformed_json', 'uncertain');
        Object.defineProperty(object, key, { value: parseValue(depth + 1), enumerable: true, configurable: true, writable: true });
        whitespace();
        if (text[index] === '}') { index++; return object; }
        if (text[index++] !== ',') throw new ResponsesTransportError('malformed_json', 'uncertain');
      }
    }
    if (character === '[') {
      index++;
      const array: unknown[] = [];
      whitespace();
      if (text[index] === ']') { index++; return array; }
      for (;;) {
        if (++entries > maxEntries) throw new ResponsesTransportError('json_entries_limit', 'uncertain');
        array.push(parseValue(depth + 1));
        whitespace();
        if (text[index] === ']') { index++; return array; }
        if (text[index++] !== ',') throw new ResponsesTransportError('malformed_json', 'uncertain');
      }
    }
    if (text.startsWith('true', index)) { index += 4; return true; }
    if (text.startsWith('false', index)) { index += 5; return false; }
    if (text.startsWith('null', index)) { index += 4; return null; }
    const number = text.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (number) {
      index += number[0].length;
      const value = Number(number[0]);
      if (!Number.isFinite(value)) throw new ResponsesTransportError('malformed_json', 'uncertain');
      return value;
    }
    throw new ResponsesTransportError('malformed_json', 'uncertain');
  };
  const result = parseValue(0);
  whitespace();
  if (index !== text.length) throw new ResponsesTransportError('malformed_json', 'uncertain');
  return result;
}

function bodyJson(value: unknown, maxBytes: number): string {
  let text: string;
  try { text = JSON.stringify(value); } catch { throw new ResponsesTransportError('invalid_request_body', 'definite'); }
  if (typeof text !== 'string' || !validUnicode(text) || Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new ResponsesTransportError('request_body_limit', 'definite');
  }
  return text;
}

function validatePathId(value: string): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || !validUnicode(value) || /[/?#\u0000-\u001f\u007f]/u.test(value)) {
    throw new ResponsesTransportError('invalid_response_id', 'definite');
  }
}

function definiteStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429;
}

class SseDecoder {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private pending = '';
  private data: string[] = [];
  private eventBytes = 0;
  constructor(private readonly maxEventBytes: number) {}

  feed(chunk: Uint8Array): ResponsesEvent[] {
    try { this.pending += this.decoder.decode(chunk, { stream: true }); }
    catch { throw new ResponsesTransportError('invalid_utf8', 'uncertain'); }
    const events: ResponsesEvent[] = [];
    for (;;) {
      const position = this.pending.indexOf('\n');
      if (position < 0) break;
      let line = this.pending.slice(0, position);
      this.pending = this.pending.slice(position + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line) { const event = this.flush(); if (event) events.push(event); continue; }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') {
        this.eventBytes += Buffer.byteLength(value, 'utf8') + 1;
        if (this.eventBytes > this.maxEventBytes) throw new ResponsesTransportError('sse_event_limit', 'uncertain');
        this.data.push(value);
      }
    }
    if (Buffer.byteLength(this.pending, 'utf8') > this.maxEventBytes) throw new ResponsesTransportError('sse_frame_limit', 'uncertain');
    return events;
  }

  finish(): ResponsesEvent[] {
    try { this.pending += this.decoder.decode(); } catch { throw new ResponsesTransportError('invalid_utf8', 'uncertain'); }
    if (this.pending.length) throw new ResponsesTransportError('truncated_sse_frame', 'uncertain');
    const event = this.flush();
    return event ? [event] : [];
  }

  private flush(): ResponsesEvent | undefined {
    if (!this.data.length) { this.eventBytes = 0; return undefined; }
    const text = this.data.join('\n');
    this.data = [];
    this.eventBytes = 0;
    if (text === '[DONE]') return undefined;
    const value = parseResponsesJson(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ResponsesTransportError('malformed_sse_event', 'uncertain');
    return value as ResponsesEvent;
  }
}

export function parseResponsesSse(chunks: Iterable<Uint8Array>, maxEventBytes = 2 * 1024 * 1024): ResponsesEvent[] {
  const parser = new SseDecoder(maxEventBytes);
  const events: ResponsesEvent[] = [];
  for (const chunk of chunks) events.push(...parser.feed(chunk));
  events.push(...parser.finish());
  return events;
}

export interface ResponsesTransport {
  create(body: ResponsesCreateBody, options: ResponsesHttpOptions & { clientRequestId: string }): Promise<AsyncIterable<ResponsesEvent>>;
  retrieve(responseId: string, options: ResponsesHttpOptions): Promise<ResponsesSnapshot>;
  resume(responseId: string, startingAfter: number, options: ResponsesHttpOptions): Promise<AsyncIterable<ResponsesEvent>>;
  cancel(responseId: string, options: ResponsesHttpOptions): Promise<ResponsesSnapshot>;
  close(): void;
}

interface OpenedResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  bytes: AsyncIterable<Uint8Array>;
}

/** Direct HTTPS; no redirects, proxy inheritance, retries, or alternate origin. */
export class OpenAIResponsesTransport implements ResponsesTransport {
  private readonly apiKey: string;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly streamIdleTimeoutMs: number;
  private closed = false;
  private readonly requests = new Set<() => void>();

  constructor(options: { apiKey: string; maxRequestBytes: number; maxResponseBytes: number; requestTimeoutMs: number; streamIdleTimeoutMs: number }) {
    if (!options.apiKey || !validUnicode(options.apiKey) || /[\u0000-\u001f\u007f]/u.test(options.apiKey)) throw new ResponsesTransportError('invalid_api_key', 'definite');
    for (const value of [options.maxRequestBytes, options.maxResponseBytes, options.requestTimeoutMs, options.streamIdleTimeoutMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new ResponsesTransportError('invalid_transport_limits', 'definite');
    }
    this.apiKey = options.apiKey;
    this.maxRequestBytes = options.maxRequestBytes;
    this.maxResponseBytes = options.maxResponseBytes;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs;
  }

  private open(method: 'POST' | 'GET', path: string, body: string | undefined, options: ResponsesHttpOptions, headers: Record<string, string> = {}, stream = false): Promise<OpenedResponse> {
    if (this.closed) return Promise.reject(new ResponsesTransportError('transport_closed', 'definite'));
    if (options.signal.aborted) return Promise.reject(new ResponsesTransportError('request_aborted', 'uncertain'));
    if (body !== undefined && Buffer.byteLength(body, 'utf8') > this.maxRequestBytes) return Promise.reject(new ResponsesTransportError('request_body_limit', 'definite'));
    const controller = new AbortController();
    let abortAction: (() => void) | undefined;
    const abort = () => { controller.abort(); abortAction?.(); };
    options.signal.addEventListener('abort', abort, { once: true });
    let settled = false;
    return new Promise<OpenedResponse>((resolve, reject) => {
      let headerTimer: NodeJS.Timeout | undefined;
      let totalTimer: NodeJS.Timeout | undefined;
      let outerAbort: (() => void) | undefined;
      let abortResponse: (() => void) | undefined;
      const fail = (error: ResponsesTransportError) => {
        if (settled) return;
        settled = true;
        if (headerTimer) clearTimeout(headerTimer);
        if (totalTimer) clearTimeout(totalTimer);
        options.signal.removeEventListener('abort', abort);
        if (outerAbort) this.requests.delete(outerAbort);
        reject(error);
      };
      const req = https.request({
        protocol: 'https:', hostname: 'api.openai.com', port: 443, method, path,
        headers: { authorization: `Bearer ${this.apiKey}`, accept: headers.accept ?? 'application/json', ...headers,
          ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body, 'utf8') }) },
        agent: false, rejectUnauthorized: true, signal: controller.signal,
      }, response => {
        if (headerTimer) clearTimeout(headerTimer);
        if (settled) { response.resume(); return; }
        const status = response.statusCode ?? 0;
        response.pause();
        let queue: Buffer[] = [];
        let queuedBytes = 0;
        // Node's readable chunk boundary is not an SSE frame boundary. Keep
        // a separately bounded stream queue with enough headroom for a
        // coalesced network chunk; SseDecoder still enforces maxResponseBytes
        // on each decoded event and the worker charges every byte.
        const streamQueueLimit = Math.max(this.maxResponseBytes, 64 * 1024);
        let received = 0;
        let ended = false;
        let failure: ResponsesTransportError | undefined;
        let wake: (() => void) | undefined;
        let idleTimer: NodeJS.Timeout | undefined;
        let chargeChain = Promise.resolve();
        let iteratorClosed = false;
        const stop = () => { iteratorClosed = true; response.destroy(); req.destroy(); wake?.(); wake = undefined; };
        const cleanup = () => { if (idleTimer) clearTimeout(idleTimer); this.requests.delete(stop); if (outerAbort) this.requests.delete(outerAbort); options.signal.removeEventListener('abort', abort); };
        const signalFailure = (error: ResponsesTransportError) => {
          if (failure || ended) return;
          failure = error;
          if (totalTimer) clearTimeout(totalTimer);
          response.destroy();
          req.destroy();
          wake?.();
          wake = undefined;
        };
        abortResponse = () => signalFailure(new ResponsesTransportError('request_aborted', 'uncertain'));
        const armIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => signalFailure(new ResponsesTransportError('stream_idle_timeout', 'uncertain')), this.streamIdleTimeoutMs);
          idleTimer.unref();
        };
        const iterator: AsyncIterable<Uint8Array> = {
          [Symbol.asyncIterator]: () => ({
            next: async (): Promise<IteratorResult<Uint8Array>> => {
              while (!queue.length && !ended && !failure) await new Promise<void>(resolveWake => { wake = resolveWake; });
              await chargeChain;
              if (failure) { cleanup(); throw failure; }
              if (!queue.length) { cleanup(); return { done: true, value: undefined }; }
              const part = queue.shift()!;
              queuedBytes -= part.byteLength;
              if (!iteratorClosed) { response.resume(); armIdle(); }
              return { done: false, value: part };
            },
            return: async (): Promise<IteratorResult<Uint8Array>> => { stop(); await chargeChain; cleanup(); return { done: true, value: undefined }; },
            throw: async (error?: unknown): Promise<IteratorResult<Uint8Array>> => { stop(); await chargeChain; cleanup(); throw error; },
          } as AsyncIterator<Uint8Array>),
        };
        response.on('data', (chunk: Buffer | string) => {
          response.pause();
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          received += part.byteLength;
          chargeChain = chargeChain.then(async () => {
            if (failure || iteratorClosed) return;
            try { await options.chargeReceivedBytes(part.byteLength); }
            catch { signalFailure(new ResponsesTransportError('received_bytes_rejected', 'uncertain')); return; }
            if (failure || iteratorClosed) return;
            // `maxResponseBytes` bounds a finite JSON body.  A streamed
            // response is bounded per SSE frame by SseDecoder; applying the
            // finite-body total here would reject an otherwise valid long
            // response after enough small frames.  queuedBytes remains a
            // backpressure bound while a consumer is stalled.
            if (!stream && received > this.maxResponseBytes) { signalFailure(new ResponsesTransportError('response_body_limit', 'uncertain')); return; }
            queue.push(part);
            queuedBytes += part.byteLength;
            if (queuedBytes > (stream ? streamQueueLimit : this.maxResponseBytes)) { signalFailure(new ResponsesTransportError('response_body_limit', 'uncertain')); return; }
            wake?.();
            wake = undefined;
          }).catch(() => signalFailure(new ResponsesTransportError('received_bytes_rejected', 'uncertain')));
          void chargeChain.finally(() => { if (!failure && !iteratorClosed) response.resume(); });
        });
        response.on('end', () => {
          void chargeChain.finally(() => { ended = true; if (idleTimer) clearTimeout(idleTimer); if (totalTimer) clearTimeout(totalTimer); wake?.(); wake = undefined; });
        });
        response.on('error', () => signalFailure(new ResponsesTransportError('response_read_failed', 'uncertain')));
        this.requests.add(stop);
        settled = true;
        armIdle();
        if (!stream) { totalTimer = setTimeout(() => signalFailure(new ResponsesTransportError('request_timeout', 'uncertain')), this.requestTimeoutMs); totalTimer.unref(); }
        resolve({ status, headers: response.headers, bytes: iterator });
        response.resume();
      });
      req.on('error', () => { if (!settled) fail(new ResponsesTransportError(controller.signal.aborted ? 'request_timeout' : 'request_failed', 'uncertain')); else abortResponse?.(); });
      headerTimer = setTimeout(() => { controller.abort(); fail(new ResponsesTransportError('header_timeout', 'uncertain')); }, this.requestTimeoutMs);
      headerTimer.unref();
      outerAbort = () => { controller.abort(); abortResponse?.(); req.destroy(); };
      abortAction = () => { abortResponse?.(); req.destroy(); };
      this.requests.add(outerAbort);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  private async body(result: OpenedResponse): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const part of result.bytes) { total += part.byteLength; if (total > this.maxResponseBytes) throw new ResponsesTransportError('response_body_limit', 'uncertain'); chunks.push(Buffer.from(part)); }
    return Buffer.concat(chunks);
  }

  private async closeBody(result: OpenedResponse): Promise<void> {
    try {
      for await (const _chunk of result.bytes) { /* bounded iterator charges before yielding */ }
    } catch { /* provider error bodies are never surfaced */ }
  }

  private async checkStatus(result: OpenedResponse): Promise<void> {
    if (result.status >= 200 && result.status < 300) return;
    await this.closeBody(result);
    const kind: ResponsesTransportErrorKind = definiteStatus(result.status) ? 'definite' : 'uncertain';
    throw new ResponsesTransportError(kind === 'definite' ? 'provider_rejected' : 'provider_unresolved', kind);
  }

  private events(result: OpenedResponse): AsyncIterable<ResponsesEvent> {
    const parser = new SseDecoder(this.maxResponseBytes);
    const source = result.bytes;
    return (async function* (): AsyncIterable<ResponsesEvent> {
      for await (const chunk of source) for (const event of parser.feed(chunk)) yield event;
      for (const event of parser.finish()) yield event;
    })();
  }

  async create(body: ResponsesCreateBody, options: ResponsesHttpOptions & { clientRequestId: string }): Promise<AsyncIterable<ResponsesEvent>> {
    const encoded = bodyJson(body, this.maxRequestBytes);
    if (!options.clientRequestId || options.clientRequestId.length > 256 || !validUnicode(options.clientRequestId) || /[\u0000-\u001f\u007f]/u.test(options.clientRequestId)) throw new ResponsesTransportError('invalid_client_request_id', 'definite');
    const result = await this.open('POST', '/v1/responses', encoded, options, { accept: 'text/event-stream', 'x-client-request-id': options.clientRequestId }, true);
    await this.checkStatus(result);
    return this.events(result);
  }

  async retrieve(responseId: string, options: ResponsesHttpOptions): Promise<ResponsesSnapshot> {
    validatePathId(responseId);
    const result = await this.open('GET', `/v1/responses/${encodeURIComponent(responseId)}`, undefined, options);
    await this.checkStatus(result);
    let value: unknown;
    try { value = parseResponsesJson(new TextDecoder('utf-8', { fatal: true }).decode(await this.body(result))); }
    catch (error) { if (error instanceof ResponsesTransportError) throw error; throw new ResponsesTransportError('malformed_response', 'uncertain'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ResponsesTransportError('malformed_response', 'uncertain');
    return value as ResponsesSnapshot;
  }

  async resume(responseId: string, startingAfter: number, options: ResponsesHttpOptions): Promise<AsyncIterable<ResponsesEvent>> {
    validatePathId(responseId);
    if (!Number.isSafeInteger(startingAfter) || startingAfter < 0) throw new ResponsesTransportError('invalid_sequence', 'definite');
    const result = await this.open('GET', `/v1/responses/${encodeURIComponent(responseId)}?stream=true&starting_after=${startingAfter}`, undefined, options, { accept: 'text/event-stream' }, true);
    await this.checkStatus(result);
    return this.events(result);
  }

  async cancel(responseId: string, options: ResponsesHttpOptions): Promise<ResponsesSnapshot> {
    validatePathId(responseId);
    const result = await this.open('POST', `/v1/responses/${encodeURIComponent(responseId)}/cancel`, '{}', options);
    await this.checkStatus(result);
    let value: unknown;
    try { value = parseResponsesJson(new TextDecoder('utf-8', { fatal: true }).decode(await this.body(result))); }
    catch (error) { if (error instanceof ResponsesTransportError) throw error; throw new ResponsesTransportError('malformed_response', 'uncertain'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ResponsesTransportError('malformed_response', 'uncertain');
    return value as ResponsesSnapshot;
  }

  close(): void { this.closed = true; for (const abort of [...this.requests]) abort(); this.requests.clear(); }
}
