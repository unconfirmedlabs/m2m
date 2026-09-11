import type { AgentPublicEvent } from '../../../scripts/agent-events.js';
import type { DemoEvent, DemoSnapshot, DemoUiState, DeliveryStream, TranscriptEntry, VisibleCitation } from './types.js';
import { validateDemoEvent, validateDemoSnapshot } from '../../../scripts/agent-demo-event-contract.js';
import { snapshotPins } from './contract.js';

const BYTE = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 255;

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) ? value as Record<string, unknown> : null;
}

function stable(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const object = record(value); if (!object) return '';
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
}

function safeCitations(value: unknown): VisibleCitation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const citation = record(item);
    if (!citation || typeof citation.title !== 'string' || typeof citation.url !== 'string' || Object.keys(citation).some(key => !['id', 'url', 'title', 'retrieved_at_ms', 'content_hash', 'source'].includes(key))) return [];
    try {
      const url = new URL(citation.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) return [];
      return [{ title: citation.title.slice(0, 240), url: url.href, source: typeof citation.source === 'string' ? citation.source.slice(0, 120) : undefined }];
    } catch { return []; }
  });
}

function bytes(value: unknown): number[] | null {
  return Array.isArray(value) && Object.keys(value).length === value.length && value.every(BYTE) ? value as number[] : null;
}

function decodeChunks(chunks: number[][], finalize = false): { text: string; malformed: boolean; pending: number[] } {
  const all = chunks.flat();
  for (let pendingLength = 0; pendingLength <= 3; pendingLength += 1) {
    if (pendingLength > all.length) break;
    const cut = all.length - pendingLength;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text: string;
    try {
      text = decoder.decode(Uint8Array.from(all.slice(0, cut)), { stream: true });
      decoder.decode(Uint8Array.from(all.slice(cut)), { stream: true });
    } catch { continue; }
    try {
      decoder.decode();
      if (pendingLength === 0) return { text, malformed: false, pending: [] };
      continue;
    } catch {
      if (pendingLength > 0) return finalize ? { text: '', malformed: true, pending: [] } : { text, malformed: false, pending: all.slice(cut) };
    }
  }
  if (finalize) return { text: '', malformed: true, pending: [] };
  return { text: '', malformed: true, pending: [] };
}

function copyDelivery(value: DeliveryStream): DeliveryStream {
  return { chunks: value.chunks.map(chunk => [...chunk]), seen: [...value.seen], text: value.text, outputBytes: value.outputBytes, malformed: value.malformed, pending: value.pending ? [...value.pending] : [] };
}

function deliveryFor(state: DemoUiState, request: string): DeliveryStream {
  return state.deliveries[request] ?? { chunks: [], seen: [], text: '', outputBytes: '0', malformed: false };
}

function message(event: DemoEvent, side: TranscriptEntry['side'], kind: TranscriptEntry['kind'], text: string, citations: VisibleCitation[] = []): TranscriptEntry {
  return { id: `${event.source}:${event.event.role}:${event.event.id}`, side, kind, text, atMs: event.event.at_ms, request: event.event.request, citations };
}

function publicText(data: Record<string, unknown>): string | null {
  if (typeof data.text === 'string') return data.text;
  if (typeof data.message === 'string') return data.message;
  const result = record(data.result);
  return result && typeof result.text === 'string' ? result.text : null;
}

function toolText(event: DemoEvent): string | null {
  const data = event.event.data; const name = typeof data.name === 'string' ? data.name : null;
  const args = record(data.arguments);
  if (name === 'web_search' && args && typeof args.query === 'string') return `web_search: ${args.query}`;
  if (name === 'web_fetch' && args && typeof args.url === 'string') return `web_fetch: ${args.url}`;
  if (name === 'research' || name === 'follow_up') return name;
  return name;
}
function requestText(event: DemoEvent): string | null {
  const request = record(event.event.data.request);
  return request && typeof request.prompt === 'string' ? `Research request: ${request.prompt}` : null;
}

function citationsFromData(data: Record<string, unknown>): VisibleCitation[] {
  const receipt = record(data.receipt);
  const result = record(data.result);
  const nestedReceipt = result ? record(result.receipt) : null;
  return safeCitations(data.citations ?? receipt?.citations ?? nestedReceipt?.citations);
}

function enrichCitations(next: DemoUiState, request: string | null, citations: VisibleCitation[]): void {
  if (!request || citations.length === 0) return;
  next.transcript = next.transcript.map(entry => entry.request === request ? { ...entry, citations } : entry);
}

function applyEvent(state: DemoUiState, event: DemoEvent): DemoUiState {
  if (state.sync === 'failed') return state;
  if (!/^(0|[1-9][0-9]*)$/.test(event.sequence)) return { ...state, browser: 'failed', browserError: 'invalid_event_cursor' };
  const sequence = BigInt(event.sequence);
  const sourceKey = `${event.source}:${event.event.role}:${event.event.id}`;
  if (state.seenEventKeys.includes(sourceKey)) {
    const prior = state.events.find(item => `${item.source}:${item.event.role}:${item.event.id}` === sourceKey);
    if (prior && stable(prior) !== stable(event)) return { ...state, browser: 'failed', sync: 'failed', browserError: 'event_conflict' };
    return state;
  }
  const priorSequence = state.events.find(item => item.sequence === event.sequence);
  if (priorSequence) return { ...state, browser: 'failed', sync: 'failed', browserError: 'event_conflict' };
  const expected = BigInt(state.lastSequence) + 1n;
  if (sequence !== expected) return { ...state, browser: 'failed', sync: 'failed', browserError: 'event_gap' };
  if (event.source === 'provider' && event.event.type === 'delivery') return { ...state, browser: 'failed', sync: 'failed', browserError: 'provider_delivery_untrusted' };
  const historical = state.replayCut !== null && sequence <= BigInt(state.replayCut);
  const next: DemoUiState = {
    ...state,
    events: [...state.events, event],
    seenEventKeys: [...state.seenEventKeys, sourceKey],
    lastSequence: event.sequence,
    refreshRequested: state.refreshRequested,
    transcript: [...state.transcript],
    deliveries: { ...state.deliveries },
    iroh: { ...state.iroh },
    newActivity: historical ? state.newActivity : true,
    sync: historical ? state.sync : 'live',
  };
  const data = event.event.data;
  const text = publicText(data);
  const citations = citationsFromData(data);
  if (event.event.type === 'model_text' && text && event.source === 'coordinator') next.transcript.push(message(event, 'coordinator', 'answer', text, citations));
  if (event.event.type === 'tool_started') {
    const side = event.source === 'provider' ? 'research' : 'coordinator';
    next.transcript.push(message(event, side, 'action', toolText(event) ?? 'Bounded research action.', citations));
  }
  if (event.event.type === 'request_started' && event.source === 'coordinator') {
    const requestSummary = requestText(event); if (requestSummary) next.transcript.push(message(event, 'coordinator', 'action', requestSummary, citations));
  }
  if (event.event.type === 'tool_result' && text && event.source === 'coordinator' && !['operator.task', 'research', 'follow_up'].includes(String(data.name))) next.transcript.push(message(event, 'coordinator', 'status', text, citations));
  if (event.event.type === 'turn_terminal' && event.source === 'coordinator') enrichCitations(next, event.event.request, citations);
  if ((event.event.type === 'channel_final' || event.event.type === 'settlement') && event.source === 'coordinator' && citations.length) {
    next.transcript.push(message(event, 'coordinator', 'status', text ?? 'Terminal receipt evidence recorded.', citations));
  }
  // A provider can describe its own output, but only the coordinator's
  // buyer-verified delivery event is admissible to the paid transcript.
  if (event.event.type === 'delivery' && event.source === 'coordinator') {
    const output = bytes(data.output);
    const request = event.event.request ?? sourceKey;
    if (output) {
      const stream = copyDelivery(deliveryFor(next, request));
      if (!stream.seen.includes(event.event.id)) {
        stream.seen.push(event.event.id);
        stream.chunks.push(output);
        stream.outputBytes = (BigInt(stream.outputBytes) + BigInt(output.length)).toString();
        const decoded = decodeChunks(stream.chunks);
        stream.text = decoded.text;
        stream.malformed = decoded.malformed;
        stream.pending = decoded.pending;
        next.deliveries[request] = stream;
        if (stream.malformed) { next.browser = 'failed'; next.sync = 'failed'; next.browserError = 'invalid_utf8'; }
        if (stream.text) {
          const deliveryId = `delivery:${request}`;
          const entry = message(event, 'research', 'delivery', stream.text, citations);
          entry.id = deliveryId;
          const prior = next.transcript.findIndex(item => item.id === deliveryId);
          if (prior >= 0) next.transcript[prior] = entry;
          else next.transcript.push(entry);
        }
      }
    }
  }
  if (event.event.type === 'turn_terminal' && event.source === 'coordinator' && event.event.request) {
    const stream = next.deliveries[event.event.request];
    if (stream) {
      const finalized = decodeChunks(stream.chunks, true);
      if (finalized.malformed || finalized.pending.length) { next.browser = 'failed'; next.sync = 'failed'; next.browserError = 'invalid_utf8'; }
      else { stream.text = finalized.text; stream.pending = []; }
    }
  }
  if (!historical && (event.event.type as string) === 'connection') {
    const connection = record(data.connection);
    if (connection && typeof connection.state === 'string') next.iroh[event.source] = connection.state;
  }
  if (!historical && ['authorization', 'checkpoint', 'chain_observation', 'control', 'runtime', 'settlement', 'channel_final', 'budget', 'funding'].includes(event.event.type as string)) {
    next.refreshRequested = true;
  }
  return next;
}

export function initialUiState(snapshot: DemoSnapshot | null = null): DemoUiState {
  if (snapshot) snapshot = validateDemoSnapshot(snapshot);
  return {
    snapshot, events: [], transcript: [], deliveries: {}, seenEventKeys: [], browser: 'disconnected', browserError: null,
    iroh: { coordinator: snapshot?.roles.coordinator.connection.state ?? 'unknown', provider: snapshot?.roles.provider?.connection.state ?? 'unknown' },
    newActivity: false, lastSequence: '0', refreshRequested: false, sync: snapshot ? 'replaying' : 'replaying', replayCut: snapshot?.projection_sequence ?? null,
  };
}

export function replaceSnapshot(state: DemoUiState, snapshot: DemoSnapshot): DemoUiState {
  try { snapshot = validateDemoSnapshot(snapshot, state.snapshot ? snapshotPins(state.snapshot) : undefined); }
  catch { return { ...state, browser: 'failed', sync: 'failed', browserError: 'snapshot_mismatch' }; }
  if (state.snapshot && (state.snapshot.conversation !== snapshot.conversation || state.snapshot.configuration_hash !== snapshot.configuration_hash)) return { ...state, browser: 'failed', sync: 'failed', browserError: 'snapshot_mismatch' };
  const cut = snapshot.projection_sequence;
  return { ...state, snapshot, replayCut: cut, refreshRequested: false, sync: state.sync === 'failed' ? 'failed' : (state.lastSequence !== '0' && BigInt(state.lastSequence) > BigInt(cut) ? 'live' : 'replaying'), iroh: state.events.length ? state.iroh : { coordinator: snapshot.roles.coordinator.connection.state, provider: snapshot.roles.provider?.connection.state ?? 'unknown' } };
}

export function applyDemoEvent(state: DemoUiState, event: DemoEvent): DemoUiState {
  if (!state.snapshot) return { ...state, browser: 'failed', sync: 'failed', browserError: 'snapshot_unavailable' };
  try { event = validateDemoEvent(event, snapshotPins(state.snapshot)); }
  catch { return { ...state, browser: 'failed', sync: 'failed', browserError: 'invalid_event_payload' }; }
  return applyEvent(state, event);
}

export function appendSourceEvent(state: DemoUiState, source: DemoEvent['source'], event: AgentPublicEvent): DemoUiState {
  return applyDemoEvent(state, { version: 1, source, sequence: state.lastSequence, event });
}

export function setBrowserState(state: DemoUiState, browser: DemoUiState['browser'], error: string | null = null): DemoUiState {
  if (state.sync === 'failed' && browser !== 'failed') return state;
  const sync = browser === 'failed' ? 'failed' : ((browser === 'connected' && state.replayCut === '0' && state.lastSequence === '0') || browser === 'disconnected' ? 'live' : state.sync);
  return { ...state, browser, sync, browserError: error };
}

export function clearNewActivity(state: DemoUiState): DemoUiState { return { ...state, newActivity: false }; }

export function clearRefreshRequest(state: DemoUiState): DemoUiState { return { ...state, refreshRequested: false }; }
