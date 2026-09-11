import { canonicalDemoJson, decodeSourceCursor, encodeSourceCursor, parseDemoJson, validateDemoRoleStatus, validateDemoSourcePage } from './agent-demo-event-contract.js';
import { isIP } from 'node:net';
import type { DemoLocator, DemoRoleStatus, DemoValidationPins, SourceCursor, SourceEventPage } from './demo-types.js';

const TOKEN_RE = /^[0-9a-f]{64}$/;
const MAX_RESPONSE_BYTES = 1_048_576;
const ID_RE = /^[0-9a-f]{64}$/;

export type DemoProviderCode = 'invalid_provider_config' | 'provider_unavailable' | 'provider_timeout' | 'invalid_provider_response' | 'provider_response_too_large' | 'unauthorized';
export class DemoProviderError extends Error {
  constructor(readonly code: DemoProviderCode) { super(code); this.name = 'DemoProviderError'; }
}
export interface DemoProviderClientOptions {
  baseUrl: string;
  observerToken: string;
  conversation: string;
  pins: DemoValidationPins;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

function bad(code: DemoProviderCode): never { throw new DemoProviderError(code); }
function exact(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('invalid_provider_response');
  const object = value as Record<string, unknown>; const actual = Object.keys(object).sort(); const fields = [...expected].sort();
  if (actual.length !== fields.length || actual.some((key, index) => key !== fields[index])) return bad('invalid_provider_response');
  return object;
}
function fixedBase(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 512) return bad('invalid_provider_config');
  let parsed: URL;
  try { parsed = new URL(value); } catch { return bad('invalid_provider_config'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || !parsed.port) return bad('invalid_provider_config');
  return parsed;
}
function id(value: unknown): string { if (typeof value !== 'string' || !ID_RE.test(value)) return bad('invalid_provider_response'); return value; }
async function boundedText(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) return bad('provider_response_too_large');
  if (!response.body) {
    const text = await response.text(); if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) return bad('provider_response_too_large'); return text;
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; total += part.value.byteLength; if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); return bad('provider_response_too_large'); } chunks.push(part.value); }
  } finally { reader.releaseLock(); }
  try { return new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks.map(item => Buffer.from(item)), total)); } catch { return bad('invalid_provider_response'); }
}

export class DemoProviderClient {
  private readonly base: URL;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  constructor(private readonly options: DemoProviderClientOptions) {
    this.base = fixedBase(options.baseUrl);
    if (typeof options.observerToken !== 'string' || !TOKEN_RE.test(options.observerToken) || typeof options.conversation !== 'string' || !ID_RE.test(options.conversation)) bad('invalid_provider_config');
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 5_000)) bad('invalid_provider_config');
    this.fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  async status(): Promise<DemoRoleStatus> {
    const value = await this.get('/internal/v1/status'); const r = exact(value, ['version', 'conversation', 'source', 'status']);
    if (r.version !== 1 || r.conversation !== this.options.conversation || r.source !== 'provider') return bad('invalid_provider_response');
    try { return validateDemoRoleStatus(r.status, { ...this.options.pins, source: 'provider' }); } catch { return bad('invalid_provider_response'); }
  }

  async locator(): Promise<DemoLocator> {
    const value = await this.get('/internal/v1/locator'); const r = exact(value, ['version', 'conversation', 'source', 'locator']);
    if (r.version !== 1 || r.conversation !== this.options.conversation || r.source !== 'provider' || !r.locator) return bad('invalid_provider_response');
    const locator = r.locator as Record<string, unknown>; if (locator.version !== 1 || locator.conversation !== this.options.conversation || locator.configuration_hash !== this.options.pins.configuration_hash) return bad('invalid_provider_response');
    if (canonicalDemoJson(locator.provider) !== canonicalDemoJson(this.options.pins.agents.provider)) return bad('invalid_provider_response');
    const endpoint = exact(locator.endpoint, ['id', 'addrs']); id(endpoint.id); if (!Array.isArray(endpoint.addrs) || endpoint.addrs.length > 32) return bad('invalid_provider_response');
    for (const address of endpoint.addrs) {
      const item = address && typeof address === 'object' && !Array.isArray(address) ? address as Record<string, unknown> : null;
      if (!item || Object.keys(item).length !== 1) return bad('invalid_provider_response');
      if ('Relay' in item) { if (typeof item.Relay !== 'string') return bad('invalid_provider_response'); let relay: URL; try { relay = new URL(item.Relay); } catch { return bad('invalid_provider_response'); } if (relay.protocol !== 'https:' || relay.username || relay.password || relay.search || relay.hash || (relay.port && relay.port !== '443')) return bad('invalid_provider_response'); }
      else if ('Ip' in item) { if (typeof item.Ip !== 'string' || (!/^\[[0-9a-f:]+\]:[1-9][0-9]*$/i.test(item.Ip) && !/^[0-9.]+:[1-9][0-9]*$/.test(item.Ip))) return bad('invalid_provider_response'); const host = item.Ip.startsWith('[') ? item.Ip.slice(1, item.Ip.indexOf(']')) : item.Ip.slice(0, item.Ip.lastIndexOf(':')); if (isIP(host) === 0) return bad('invalid_provider_response'); }
      else return bad('invalid_provider_response');
    }
    return structuredClone(r.locator) as DemoLocator;
  }

  async events(after: SourceCursor): Promise<SourceEventPage> {
    const cursor = encodeSourceCursor(after);
    const value = await this.get(`/internal/v1/events?after=${encodeURIComponent(cursor)}`); const r = exact(value, ['version', 'conversation', 'source', 'page']);
    if (r.version !== 1 || r.conversation !== this.options.conversation || r.source !== 'provider') return bad('invalid_provider_response');
    try { return validateDemoSourcePage(r.page, { ...this.options.pins, source: 'provider' }); } catch { return bad('invalid_provider_response'); }
  }

  private async get(path: string): Promise<unknown> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.base).toString(), { method: 'GET', redirect: 'error', signal: controller.signal, credentials: 'omit', headers: { Authorization: `Bearer ${this.options.observerToken}`, Accept: 'application/json' } });
      const contentType = response.headers.get('content-type'); if (contentType !== null && contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return bad('invalid_provider_response');
      const body = await boundedText(response);
      if (response.status === 401) return bad('unauthorized');
      if (!response.ok) return bad('provider_unavailable');
      try { return parseDemoJson(body, MAX_RESPONSE_BYTES); } catch { return bad('invalid_provider_response'); }
    } catch (error) {
      if (error instanceof DemoProviderError) throw error;
      if (controller.signal.aborted) return bad('provider_timeout');
      return bad('provider_unavailable');
    } finally { clearTimeout(timer); }
  }
}
