import type { DemoControl, DemoControlRecord, DemoEvent, DemoSessionResponse, DemoSnapshot, SourceCursor } from './types.js';
import type { DemoValidationPins } from '../../../scripts/demo-types.js';
import { canonicalDemoJson, parseDemoJson, validateDemoControl, validateDemoControlRecord, validateDemoEvent, validateDemoSessionResponse, validateDemoSnapshot, validateDemoStreamStatus } from '../../../scripts/agent-demo-event-contract.js';
import { snapshotPins } from './contract.js';

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_JSON_BYTES = 1_048_576;
const MAX_SSE_FRAME_BYTES = 128 * 1024;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEX_ID = /^[0-9a-f]{64}$/;

export class DemoApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

type EventListener = (event: DemoEvent) => void;
type StatusListener = (state: 'connected' | 'failed' | 'disconnected', error?: string) => void;

function errorCode(value: unknown, fallback: string): string {
  // Only expose the finite public error vocabulary.  Backend code fields are
  // untrusted input and may contain private exception text or credentials.
  const publicCodes = new Set([
    'already_initialized', 'backend_unavailable', 'backend_context_unavailable',
    'backend_launch_uncertain', 'budget_policy_conflict', 'budget_uncertain',
    'channel_mismatch', 'channel_not_bound', 'channel_not_open',
    'conversation_busy', 'coordinator_closed', 'credit_not_monotonic',
    'deadline_expired', 'delivered_mismatch', 'deposit_exceeded',
    'funding_conflict', 'funding_limit', 'invalid_agent', 'invalid_argument',
    'invalid_budget_limits', 'invalid_channel_binding', 'invalid_config',
    'invalid_control', 'invalid_event', 'invalid_event_cursor',
    'invalid_receipt', 'invalid_request', 'invalid_task', 'invalid_tool_arguments',
    'limit_exceeded', 'output_tranche_limit', 'outstanding_limit',
    'projection_conflict', 'projection_gap', 'projection_limit',
    'provider_start_failed', 'provider_unavailable', 'recovery_limit',
    'refund_not_eligible', 'request_limit_exceeded', 'runtime_error',
    'runtime_profile_mismatch', 'search_unconfigured', 'settlement_uncertain',
    'spending_paused', 'storage_failure', 'tool_result_uncertain',
    'transport_closed', 'turn_limit', 'uncertain_execution', 'unknown_request',
    'unknown_tool', 'waiting_for_credit', 'worker_shutdown_uncertain',
    'cancelled_before_dispatch', 'budget_rejected', 'deadline_exceeded',
    'publication_pending', 'publication_failed', 'unauthorized',
  ]);
  const candidate = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as { code?: unknown }).code : undefined;
  if (typeof candidate === 'string' && publicCodes.has(candidate)) return candidate;
  return /^http_5(?:\d\d)$/.test(fallback) ? 'backend_unavailable' : fallback;
}

function own(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DemoApiError(502, 'invalid_control_response');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new DemoApiError(502, 'invalid_control_response');
  return value as Record<string, unknown>;
}
function exact(value: unknown, expected: readonly string[]): Record<string, unknown> {
  const result = own(value); const actual = Object.keys(result).sort(); const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) throw new DemoApiError(502, 'invalid_control_response');
  return result;
}
async function readBoundedText(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number.isFinite(Number(declared)) && Number(declared) > limit) throw new DemoApiError(response.status, 'response_too_large');
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > limit) throw new DemoApiError(response.status, 'response_too_large');
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new DemoApiError(response.status, 'response_too_large');
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(joined); }
  catch { throw new DemoApiError(response.status, 'invalid_utf8'); }
}

async function asJson(response: Response): Promise<unknown> {
  const text = await readBoundedText(response, MAX_JSON_BYTES);
  try { return text ? parseDemoJson(text, MAX_JSON_BYTES) : null; }
  catch { throw new DemoApiError(response.status, 'invalid_json'); }
}

interface ParsedFrame { type: string; id: string | null; data: string; }

/** A line parser which retains a CR at a chunk boundary. */
class SseParser {
  private line = '';
  private lines: string[] = [];
  private pendingCr = false;
  private size = 0;

  push(text: string): ParsedFrame[] {
    const frames: ParsedFrame[] = [];
    let index = 0;
    if (this.pendingCr) {
      this.pendingCr = false;
      if (text[index] === '\n') index += 1;
      else this.finishLine(frames);
    }
    for (; index < text.length; index += 1) {
      const character = text[index];
      if (character === '\n' && this.pendingCr) {
        // The CRLF pair may be wholly contained in this chunk or split
        // across two chunks; either way it terminates exactly one line.
        this.pendingCr = false;
      } else if (character === '\r') {
        this.finishLine(frames); this.pendingCr = true;
      } else if (character === '\n') {
        this.finishLine(frames);
      } else {
        this.line += character; this.size += new TextEncoder().encode(character).byteLength;
        if (this.size > MAX_SSE_FRAME_BYTES) throw new DemoApiError(413, 'event_frame_limit');
      }
    }
    return frames;
  }

  finish(): ParsedFrame[] {
    const frames: ParsedFrame[] = [];
    if (this.pendingCr) { this.pendingCr = false; this.finishLine(frames); }
    if (this.line || this.lines.length) throw new DemoApiError(502, 'truncated_event_frame');
    return frames;
  }

  private finishLine(frames: ParsedFrame[]): void {
    this.lines.push(this.line); this.line = '';
    if (this.lines.at(-1) === '') {
      const frame = parseSseFrame(this.lines.slice(0, -1).join('\n'));
      this.lines = []; this.size = 0;
      if (frame) frames.push(frame);
    }
  }
}

function parseSseFrame(frame: string): ParsedFrame | null {
  let type = 'message'; let id: string | null = null; const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const split = line.indexOf(':');
    const field = split < 0 ? line : line.slice(0, split);
    const value = split < 0 ? '' : line.slice(split + 1).replace(/^ /, '');
    if (field === 'event') {
      if (type !== 'message') throw new DemoApiError(502, 'invalid_event_frame');
      type = value;
    } else if (field === 'id') {
      if (id !== null) throw new DemoApiError(502, 'invalid_event_frame');
      id = value;
    } else if (field === 'data') data.push(value);
  }
  if (!data.length && type === 'message' && id === null) return null;
  if (type !== 'message' && type !== 'agent_event' && type !== 'stream_status') throw new DemoApiError(502, 'invalid_event_frame');
  if ((type === 'agent_event' || type === 'stream_status') && id !== null && type === 'stream_status') throw new DemoApiError(502, 'invalid_event_frame');
  if (type === 'agent_event' && id === null) throw new DemoApiError(502, 'invalid_event_frame');
  return { type, id, data: data.join('\n') };
}

function parsedEvent(frame: ParsedFrame, pins: DemoValidationPins): DemoEvent {
  const conversation = pins.conversation;
  if (frame.type !== 'agent_event' || frame.id === null) throw new DemoApiError(502, 'invalid_event_frame');
  const match = new RegExp(`^${conversation}:([0-9]+)$`).exec(frame.id);
  if (!match || !DECIMAL.test(match[1])) throw new DemoApiError(502, 'invalid_event_cursor');
  let event: DemoEvent;
  try { event = validateDemoEvent(parseDemoJson(frame.data, MAX_SSE_FRAME_BYTES), pins); }
  catch { throw new DemoApiError(502, 'invalid_event_payload'); }
  if (event.sequence !== match[1]) throw new DemoApiError(502, 'invalid_event_cursor');
  return event;
}

function strictControlResponse(value: unknown, pins: DemoValidationPins, expectedId?: string, expectedCommand?: DemoControl['command']): DemoControlRecord {
  const body = exact(value, ['version', 'record']);
  if (body.version !== 1) throw new DemoApiError(502, 'invalid_control_response');
  let record: DemoControlRecord;
  try { record = validateDemoControlRecord(body.record, pins); }
  catch { throw new DemoApiError(502, 'invalid_control_response'); }
  if (expectedId && record.id !== expectedId) throw new DemoApiError(502, 'invalid_control_response');
  if (expectedCommand && canonicalDemoJson(record.command) !== canonicalDemoJson(expectedCommand)) throw new DemoApiError(502, 'control_reply_mismatch');
  return record;
}

export interface EventSubscription { abort(): void; done: Promise<void> }

export class DemoApi {
  private token: string | null = null;
  private streamAbort: AbortController | null = null;
  private unauthorized: (() => void) | null = null;
  private generation = 0;
  private pins: DemoValidationPins | undefined;
  private readonly requestControllers = new Set<AbortController>();
  private readonly fetcher: typeof fetch;
  constructor(private readonly origin = '', fetcher?: typeof fetch) {
    // Resolve the ambient fetch at request time so embedded callers/tests can
    // install an authenticated same-origin transport after module load.
    this.fetcher = fetcher ?? ((input, init) => globalThis.fetch(input, init));
  }

  setUnauthorizedHandler(handler: (() => void) | null): void { this.unauthorized = handler; }
  authenticate(token: string): void {
    if (!token || token.length > 4096) throw new Error('invalid_token');
    for (const controller of this.requestControllers) controller.abort();
    this.generation += 1;
    this.streamAbort?.abort(); this.pins = undefined;
    this.token = token;
  }
  logout(): void { this.token = null; this.pins = undefined; this.generation += 1; this.streamAbort?.abort(); this.streamAbort = null; for (const controller of this.requestControllers) controller.abort(); }
  hasSession(): boolean { return this.token !== null; }

  private headers(json = false): HeadersInit {
    if (!this.token) throw new DemoApiError(401, 'authentication_required');
    return { Authorization: `Bearer ${this.token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const requestGeneration = this.generation; this.requestControllers.add(controller);
    const timer = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const forwardAbort = () => controller.abort();
    init.signal?.addEventListener('abort', forwardAbort, { once: true });
    let response: Response;
    try {
      response = await this.fetcher(`${this.origin}${path}`, { ...init, signal: controller.signal, credentials: 'omit', redirect: 'error', headers: { ...this.headers(Boolean(init.body)), ...init.headers } });
      if (response.status === 401) { this.logout(); this.unauthorized?.(); throw new DemoApiError(401, 'unauthorized'); }
      let parsed: unknown;
      try { parsed = await asJson(response); }
      catch (error) { if (error instanceof DemoApiError) throw error; throw new DemoApiError(response.status, 'invalid_json'); }
      if (!response.ok) {
        const code = errorCode(parsed, `http_${response.status}`);
        throw new DemoApiError(response.status, code);
      }
      if (requestGeneration !== this.generation) throw new DemoApiError(0, 'stale_session');
      return parsed as T;
    } catch (error) {
      if (error instanceof DemoApiError) throw error;
      if (requestGeneration !== this.generation) throw new DemoApiError(0, 'stale_session');
      if (controller.signal.aborted && !init.signal?.aborted) throw new DemoApiError(0, 'request_timeout');
      throw new DemoApiError(0, 'network_unavailable');
    } finally {
      globalThis.clearTimeout(timer); init.signal?.removeEventListener('abort', forwardAbort); this.requestControllers.delete(controller);
    }
  }

  async session(): Promise<DemoSessionResponse> {
    const value = await this.request<unknown>('/api/v1/session');
    try {
      const response = validateDemoSessionResponse(value, this.pins);
      this.pins = snapshotPins(response.snapshot);
      return response;
    } catch { throw new DemoApiError(502, 'invalid_session'); }
  }
  async status(): Promise<DemoSnapshot> {
    const value = await this.request<unknown>('/api/v1/status');
    try {
      const response = exact(value, ['version', 'conversation', 'snapshot', 'high_water']);
      const snapshot = validateDemoSnapshot(response.snapshot, this.pins);
      if (response.version !== 1 || response.conversation !== snapshot.conversation || response.high_water !== snapshot.projection_sequence) throw new Error('invalid_status');
      this.pins = snapshotPins(snapshot);
      return snapshot;
    } catch { throw new DemoApiError(502, 'invalid_snapshot'); }
  }
  async control(control: DemoControl): Promise<DemoControlRecord> {
    if (!this.pins) throw new DemoApiError(409, 'session_unavailable');
    let command: DemoControl;
    try { command = validateDemoControl(control); } catch { throw new DemoApiError(400, 'invalid_control'); }
    const response = await this.request<unknown>('/api/v1/controls', { method: 'POST', body: JSON.stringify(command) });
    return strictControlResponse(response, this.pins, command.id, command.command);
  }
  async controlStatus(id: string, command?: DemoControl['command']): Promise<DemoControlRecord> {
    if (!this.pins) throw new DemoApiError(409, 'session_unavailable');
    return strictControlResponse(await this.request<unknown>(`/api/v1/controls/${encodeURIComponent(id)}`), this.pins, id, command);
  }

  subscribe(after: SourceCursor, onEvent: EventListener, onStatus: StatusListener, signal?: AbortSignal, lastEventId = after.coordinator): EventSubscription {
    this.streamAbort?.abort();
    const controller = new AbortController(); this.streamAbort = controller;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const done = this.readEvents(after, lastEventId, controller.signal, onEvent, onStatus).finally(() => {
      signal?.removeEventListener('abort', abort); if (this.streamAbort === controller) this.streamAbort = null;
    });
    return { abort, done };
  }

  private async readEvents(after: SourceCursor, lastEventId: string, signal: AbortSignal, onEvent: EventListener, onStatus: StatusListener): Promise<void> {
    void after;
    const streamGeneration = this.generation;
    try {
      const pins = this.pins;
      if (!pins) throw new DemoApiError(409, 'session_unavailable');
      const response = await this.fetcher(`${this.origin}/api/v1/events`, { credentials: 'omit', redirect: 'error', signal,
        headers: { ...this.headers(), Accept: 'text/event-stream', 'Last-Event-ID': lastEventId } });
      if (response.status === 401) { this.logout(); this.unauthorized?.(); throw new DemoApiError(401, 'unauthorized'); }
      if (!response.ok || !response.body) {
        const parsed = await asJson(response).catch(() => null);
        const code = errorCode(parsed, `http_${response.status}`);
        throw new DemoApiError(response.status, code);
      }
      const conversation = lastEventId.split(':')[0];
      if (!HEX_ID.test(conversation) || conversation !== pins.conversation) throw new DemoApiError(502, 'invalid_event_conversation');
      onStatus('connected');
      const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true }); const parser = new SseParser();
      while (!signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (streamGeneration !== this.generation) return;
        for (const frame of parser.push(decoder.decode(chunk.value, { stream: true }))) {
          if (frame.type === 'agent_event') onEvent(parsedEvent(frame, pins));
          else if (frame.type === 'stream_status') {
            try { validateDemoStreamStatus(parseDemoJson(frame.data, MAX_SSE_FRAME_BYTES), conversation); }
            catch { throw new DemoApiError(502, 'invalid_stream_status'); }
          } else if (frame.type !== 'message') throw new DemoApiError(502, 'invalid_event_frame');
        }
      }
      if (!signal.aborted) {
        for (const frame of parser.push(decoder.decode())) if (frame.type === 'agent_event') onEvent(parsedEvent(frame, pins));
        for (const frame of parser.finish()) if (frame.type === 'agent_event') onEvent(parsedEvent(frame, pins));
        onStatus('disconnected');
      }
    } catch (error) {
      if (signal.aborted) return;
      const code = error instanceof DemoApiError ? error.code : 'stream_unavailable';
      if (error instanceof DemoApiError && error.status === 401) { this.logout(); this.unauthorized?.(); }
      onStatus('failed', code);
    }
  }
}
