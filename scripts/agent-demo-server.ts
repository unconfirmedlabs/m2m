import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DemoAuth, DemoAuthError, type DemoAuthPrincipal } from './agent-demo-auth.js';
import { DemoProjection } from './agent-demo-projection.js';
import { DemoProviderClient, DemoProviderError } from './agent-demo-provider-client.js';
import { sanitizeDemoEvidence, sanitizeDemoLocator } from './agent-demo-evidence.js';
import { canonicalDemoJson, parseDemoJson, validateDemoControl, validateDemoControlRecord, validateDemoSnapshot, validateDemoSourcePage, validateDemoRoleStatus, decodeSourceCursor } from './agent-demo-event-contract.js';
import { strictJson } from './native-peer.js';
import type { AgentRef } from './native-chain.js';
import type { AgentRuntimeDescriptor } from './agent-runtime.js';
import type { AgentServiceConfig } from './agent-services.js';
import type { DemoControl, DemoControlRecord, DemoEvent, DemoRuntimeHandle, DemoSessionResponse, DemoSnapshot, DemoValidationPins, MachineRole, SourceCursor, U64 } from './demo-types.js';

const MAX_BODY_BYTES = 20 * 1024;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_SSE_BUFFER_BYTES = 256 * 1024;
const ID_RE = /^[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-f]{64}$/;

export interface DemoHttpOptions {
  runtime: DemoRuntimeHandle;
  config: AgentServiceConfig;
  projectionStateDir: string;
  createProjection: boolean;
  publicOrigin?: string;
  bindHost: string;
  port: number;
  viewerToken?: string;
  operatorToken?: string;
  observerToken: string;
  providerBaseUrl?: string;
  staticDir?: string;
  network?: 'testnet' | 'localnet';
}

type HttpResult = { server: Server; close(): Promise<void> };
type ApiRequest = IncomingMessage & { bodyRead?: Promise<Buffer> };
const SAFE_CODES = new Set([
  'unauthorized', 'forbidden', 'not_found', 'body_too_large', 'rate_limited', 'sse_limit', 'invalid_request', 'invalid_event_cursor',
  'future_cursor', 'projection_gap', 'projection_conflict', 'projection_limit', 'projection_corrupt', 'projection_pin_mismatch',
  'control_conflict', 'not_ready', 'projection_not_ready', 'invalid_evidence', 'request_timeout', 'response_too_large', 'provider_unavailable', 'runtime_error',
  'journal_missing', 'storage_failure', 'backend_unavailable', 'invalid_control', 'control_not_allowed', 'channel_mismatch', 'funding_uncertain',
  'uncertain_execution', 'budget_uncertain', 'channel_not_open', 'limit_exceeded', 'conversation_busy', 'spending_paused', 'funding_uncertain', 'settlement_uncertain', 'worker_shutdown_uncertain',
]);

/** Protected production bootstrap. Secrets are file paths, never inline values. */
export type DemoHostConfig = {
  version: 1;
  topology: 'fly-v1' | 'reduced-local-v1';
  role: MachineRole;
  state_dir: string;
  conversation: string;
  network: 'testnet' | 'localnet';
  config: AgentServiceConfig;
  runtime: AgentRuntimeDescriptor;
  agents: { buyer: AgentRef; provider: AgentRef };
  projection_state_dir: string;
  static_dir: string;
  bind_host: string;
  port: number;
  provider_base_url: string;
  public_origin?: string;
  model_api_key_file?: string;
  search_api_key_file?: string;
  wallet_file?: string;
  viewer_token_file?: string;
  operator_token_file?: string;
  observer_token_file: string;
};

function fixed(code: string): never { throw new Error(code); }
function own(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fixed('invalid_host_config');
  return value as Record<string, unknown>;
}
function exactConfig(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const object = own(value); const actual = Object.keys(object).sort(); const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fixed('invalid_host_config');
  return object;
}
function noPlaceholders(value: unknown, depth = 0): void {
  if (depth > 16) fixed('invalid_host_config');
  if (typeof value === 'string' && (value.startsWith('CHOOSE_') || value.length === 0)) fixed('invalid_host_config');
  if (Array.isArray(value)) { for (const item of value) noPlaceholders(item, depth + 1); return; }
  if (value && typeof value === 'object') for (const item of Object.values(value)) noPlaceholders(item, depth + 1);
}
function hostPath(value: unknown, stateRoot: string, allowOutside = true): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') || value.includes('..')) fixed('invalid_host_config');
  const path = resolve(value); if (!allowOutside && (path !== stateRoot && !path.startsWith(`${stateRoot}/`))) fixed('invalid_host_config');
  return path;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !ID_RE.test(value)) fixed('invalid_host_config');
  return value;
}
function address(value: unknown): string {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)) fixed('invalid_host_config');
  return value;
}
function agentRef(value: unknown): AgentRef {
  const object = exactConfig(value, ['network', 'package_id', 'domain', 'agent']);
  if (!Array.isArray(object.network) || object.network.length < 1 || object.network.length > 64 || object.network.some(item => !Number.isInteger(item) || (item as number) < 0 || (item as number) > 255)) fixed('invalid_host_config');
  address(object.package_id); address(object.domain); address(object.agent);
  return structuredClone(object) as unknown as AgentRef;
}
function agentConfig(value: unknown): AgentServiceConfig {
  const object = exactConfig(value, ['version', 'budget', 'deposit_mist', 'price', 'allowed_hosts']);
  if (object.version !== 1 || !Array.isArray(object.allowed_hosts) || object.allowed_hosts.length < 1 || object.allowed_hosts.length > 32 || object.allowed_hosts.some(item => typeof item !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(item) || item.includes('..'))) fixed('invalid_host_config');
  const budget = exactConfig(object.budget, ['max_total_mist', 'max_channel_deposit_mist', 'max_turn_mist', 'max_outstanding_mist', 'max_requests', 'deadline_ms', 'output_tranche_bytes']);
  const price = exactConfig(object.price, ['input_rate', 'output_rate', 'denominator']);
  for (const field of ['deposit_mist'] as const) if (typeof object[field] !== 'string' || !/^(0|[1-9][0-9]*)$/.test(object[field] as string)) fixed('invalid_host_config');
  for (const field of ['max_total_mist', 'max_channel_deposit_mist', 'max_turn_mist', 'max_outstanding_mist', 'deadline_ms'] as const) if (typeof budget[field] !== 'string' || !/^(0|[1-9][0-9]*)$/.test(budget[field] as string)) fixed('invalid_host_config');
  for (const field of ['input_rate', 'output_rate', 'denominator'] as const) if (typeof price[field] !== 'string' || !/^(0|[1-9][0-9]*)$/.test(price[field] as string)) fixed('invalid_host_config');
  // These are the reduced application terms. Generic AgentServiceConfig
  // remains configurable; only this serialized reduced-demo boundary fixes
  // the public demo's price and upper bounds.
  if (object.deposit_mist === '0' || price.input_rate !== '0' || price.output_rate !== '1' || price.denominator !== '1' ||
      budget.max_requests !== 1 && budget.max_requests !== 2 || budget.output_tranche_bytes !== 256 ||
      [budget.max_total_mist, budget.max_channel_deposit_mist, budget.max_turn_mist, budget.max_outstanding_mist].some(value => value === '0') ||
      BigInt(object.deposit_mist as string) > 100_000n || BigInt(budget.max_total_mist as string) > 100_000n ||
      BigInt(budget.max_channel_deposit_mist as string) > 100_000n || BigInt(budget.max_turn_mist as string) > 40_000n ||
      BigInt(budget.max_outstanding_mist as string) > 1_024n ||
      BigInt(budget.max_channel_deposit_mist as string) > BigInt(budget.max_total_mist as string) ||
      BigInt(object.deposit_mist as string) > BigInt(budget.max_channel_deposit_mist as string)) fixed('invalid_host_config');
  return structuredClone(object) as unknown as AgentServiceConfig;
}
function runtimeDescriptor(value: unknown): AgentRuntimeDescriptor {
  const object = exactConfig(value, ['version', 'kind', 'model', 'reasoning']);
  if (object.version !== 1 || object.kind !== 'responses-tools-v1' || object.model !== 'gpt-5.6-luna' || object.reasoning !== 'xhigh') fixed('invalid_host_config');
  return structuredClone(object) as unknown as AgentRuntimeDescriptor;
}
function privateUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512) fixed('invalid_host_config');
  let url: URL; try { url = new URL(value); } catch { fixed('invalid_host_config'); }
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.port || url.port === '0') fixed('invalid_host_config');
  return value;
}
function publicOrigin(value: unknown, local = false, port?: number): string {
  if (typeof value !== 'string' || value.length > 512) fixed('invalid_host_config');
  let url: URL; try { url = new URL(value); } catch { fixed('invalid_host_config'); }
  if ((!local && url.protocol !== 'https:') || (local && (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== String(port))) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin !== value) fixed('invalid_host_config');
  return value;
}
async function protectedDirectory(path: string): Promise<void> {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isDirectory() || (metadata.mode & 0o077) !== 0) fixed('invalid_host_config');
}
async function builtUi(path: string): Promise<void> {
  const directory = await lstat(path).catch(() => null);
  if (!directory || directory.isSymbolicLink() || !directory.isDirectory()) fixed('invalid_host_config');
  const metadata = await lstat(join(path, 'index.html')).catch(() => null);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isFile()) fixed('invalid_host_config');
}
async function protectedToken(path: string): Promise<string> {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata || !metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || metadata.size > 256) fixed('credential_unavailable');
  let value: string; try { value = await readFile(path, 'utf8'); } catch { fixed('credential_unavailable'); }
  value = value.endsWith('\r\n') ? value.slice(0, -2) : value.endsWith('\n') ? value.slice(0, -1) : value;
  if (!/^[0-9a-f]{64}$/.test(value) || /^0+$/.test(value)) fixed('credential_unavailable');
  return value;
}
export async function readDemoHostConfig(path: string): Promise<DemoHostConfig> {
  if (!isAbsolute(path) || path.includes('\0') || path.includes('..')) fixed('invalid_host_config');
  const metadata = await lstat(path).catch(() => null); if (!metadata || !metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || metadata.size > 256 * 1024) fixed('invalid_host_config');
  let value: unknown; try { value = strictJson(await readFile(path, 'utf8')); } catch { fixed('invalid_host_config'); }
  noPlaceholders(value); const root = own(value);
  if (root.role !== 'coordinator' && root.role !== 'provider') fixed('invalid_host_config');
  const role = root.role as MachineRole;
  const common = ['version', 'role', 'state_dir', 'conversation', 'network', 'config', 'runtime', 'agents', 'projection_state_dir', 'static_dir', 'bind_host', 'port', 'provider_base_url', 'observer_token_file'];
  const topology = root.topology === undefined ? 'fly-v1' : root.topology === 'reduced-local-v1' ? 'reduced-local-v1' : fixed('invalid_host_config');
  const topologyFields = topology === 'reduced-local-v1' ? ['topology'] : [];
  const expected = role === 'coordinator' ? [...topologyFields, ...common, 'public_origin', 'wallet_file', 'viewer_token_file', 'operator_token_file'] : [...topologyFields, ...common, 'model_api_key_file', 'search_api_key_file'];
  const object = exactConfig(value, expected);
  if (object.version !== 1 || object.network !== 'testnet' || typeof object.bind_host !== 'string' ||
      (topology === 'fly-v1' && (role === 'coordinator' ? object.bind_host !== '0.0.0.0' || object.port !== 8080 : object.bind_host !== 'fly-local-6pn' || object.port !== 8081)) ||
      (topology === 'reduced-local-v1' && (object.bind_host !== '127.0.0.1' || !Number.isSafeInteger(object.port) || (object.port as number) < 1 || (object.port as number) > 65_535))) fixed('invalid_host_config');
  const stateDir = hostPath(object.state_dir, topology === 'fly-v1' ? '/data/m2m' : '/tmp/m2m'); if (topology === 'fly-v1' && stateDir !== '/data/m2m') fixed('invalid_host_config');
  const projectionDir = hostPath(object.projection_state_dir, stateDir, false); if (projectionDir !== join(stateDir, 'projection')) fixed('invalid_host_config');
  const staticDir = hostPath(object.static_dir, stateDir); if (topology === 'fly-v1' && staticDir !== '/app/ui') fixed('invalid_host_config');
  if (topology === 'reduced-local-v1') { await protectedDirectory(stateDir); await builtUi(staticDir); }
  id(object.conversation); privateUrl(object.provider_base_url); if (topology === 'reduced-local-v1') {
    try { const privateEndpoint = new URL(object.provider_base_url as string); if (privateEndpoint.hostname !== '127.0.0.1') fixed('invalid_host_config'); } catch { fixed('invalid_host_config'); }
  }
  if (role === 'coordinator') publicOrigin(object.public_origin, topology === 'reduced-local-v1', object.port as number);
  const agents = exactConfig(object.agents, ['buyer', 'provider']); const parsedAgents = { buyer: agentRef(agents.buyer), provider: agentRef(agents.provider) };
  const config = agentConfig(object.config); const runtime = runtimeDescriptor(object.runtime);
  const result: DemoHostConfig = { version: 1, topology, role, state_dir: stateDir, conversation: object.conversation as string, network: 'testnet', config, runtime, agents: parsedAgents,
    projection_state_dir: projectionDir, static_dir: staticDir, bind_host: object.bind_host as string, port: object.port as number, provider_base_url: object.provider_base_url as string,
    public_origin: role === 'coordinator' ? object.public_origin as string : undefined, model_api_key_file: role === 'provider' ? hostPath(object.model_api_key_file, stateDir) : undefined,
    search_api_key_file: role === 'provider' ? hostPath(object.search_api_key_file, stateDir) : undefined,
    wallet_file: role === 'coordinator' ? hostPath(object.wallet_file, stateDir) : undefined,
    viewer_token_file: role === 'coordinator' ? hostPath(object.viewer_token_file, stateDir, topology === 'fly-v1') : undefined,
    operator_token_file: role === 'coordinator' ? hostPath(object.operator_token_file, stateDir, topology === 'fly-v1') : undefined,
    observer_token_file: hostPath(object.observer_token_file, stateDir, topology === 'fly-v1') };
  if (topology === 'reduced-local-v1') {
    result.wallet_file = role === 'coordinator' ? hostPath(object.wallet_file, stateDir, false) : undefined;
    result.model_api_key_file = role === 'provider' ? hostPath(object.model_api_key_file, stateDir, false) : undefined;
    result.search_api_key_file = role === 'provider' ? hostPath(object.search_api_key_file, stateDir, false) : undefined;
  }
  return result;
}
function safeCode(error: unknown): string {
  const value = error instanceof Error ? error.message : '';
  return SAFE_CODES.has(value) ? value : 'runtime_error';
}
function statusFor(code: string): number {
  if (code === 'unauthorized') return 401;
  if (code === 'forbidden') return 403;
  if (code === 'not_found') return 404;
  if (code === 'body_too_large') return 413;
  if (code === 'rate_limited' || code === 'sse_limit') return 429;
  if (code === 'projection_gap' || code === 'projection_conflict' || code === 'control_conflict' || code === 'not_ready' || code === 'projection_not_ready' ||
      code === 'uncertain_execution' || code === 'budget_uncertain' || code === 'channel_not_open' || code === 'limit_exceeded' || code === 'conversation_busy' || code === 'spending_paused' || code === 'funding_uncertain' || code === 'settlement_uncertain' || code === 'worker_shutdown_uncertain') return 409;
  if (code === 'invalid_request' || code === 'invalid_event_cursor') return 400;
  if (code === 'projection_corrupt' || code === 'projection_pin_mismatch' || code === 'journal_missing' || code === 'runtime_error') return 503;
  return 503;
}
async function finite<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('request_timeout')), 5_000); })]);
  } finally { if (timer) clearTimeout(timer); }
}
function sendJson(response: ServerResponse, status: number, value: unknown): void {
  let text: string;
  try { text = JSON.stringify(value); } catch { text = JSON.stringify({ version: 1, code: 'runtime_error' }); status = 503; }
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) { status = 503; text = JSON.stringify({ version: 1, code: 'response_too_large' }); }
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  response.end(text);
}
function sendError(response: ServerResponse, status: number, code: string): void { sendJson(response, status, { version: 1, code }); }

function routePath(request: IncomingMessage): string {
  const raw = request.url;
  if (typeof raw !== 'string' || raw.length > 8_192 || !raw.startsWith('/')) return '';
  try { return new URL(raw, 'http://m2m.invalid').pathname; } catch { return ''; }
}
function requestId(path: string): string | null {
  const match = /^\/api\/v1\/controls\/([0-9a-f]{64})$/.exec(path); return match?.[1] ?? null;
}
function evidenceAddress(path: string): string | null {
  const match = /^\/api\/v1\/evidence\/(0x[0-9a-f]{64})$/.exec(path); return match?.[1] ?? null;
}
function configuredPrivateHost(value: string | undefined, bindHost: string, port: number): string {
  if (!value) return `${bindHost}:${port}`;
  try { const parsed = new URL(value); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || !parsed.port) fixed('invalid_auth_config'); return parsed.host; }
  catch { fixed('invalid_auth_config'); }
}
function pinsFor(runtime: DemoRuntimeHandle, config: AgentServiceConfig): DemoValidationPins {
  const status = runtime.status(); const identities = runtime.identities();
  return { conversation: runtime.conversation, configuration_hash: status.configuration_hash, config: structuredClone(config), agents: { buyer: structuredClone(identities.coordinator.agent), provider: structuredClone(identities.provider.agent) } };
}

async function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  const declared = request.headers['content-length'];
  if (Array.isArray(declared)) throw new DemoAuthError('invalid_request');
  if (declared !== undefined && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new DemoAuthError('body_too_large');
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    length += part.length; if (length > MAX_BODY_BYTES) throw new DemoAuthError('body_too_large'); chunks.push(part);
  }
  return Buffer.concat(chunks, length);
}
function parseControl(body: Buffer, pins: DemoValidationPins): DemoControl {
  if (body.length === 0) throw new DemoAuthError('invalid_request');
  try { return validateDemoControl(parseDemoJson(body.toString('utf8'), MAX_BODY_BYTES)); }
  catch { throw new DemoAuthError('invalid_request'); }
}
function sameCursor(left: SourceCursor, right: SourceCursor): boolean {
  return left.coordinator === right.coordinator && left.research === right.research && left.host === right.host;
}
function snapshot(runtime: DemoRuntimeHandle, projection: DemoProjection, config: AgentServiceConfig, network: 'testnet' | 'localnet', provider: { status: ReturnType<DemoRuntimeHandle['status']> | null; observedAt: U64 | null }): DemoSnapshot {
  const publication = runtime.publication(); if (publication.state !== 'ready') throw new Error(publication.code ?? 'publication_pending');
  if (!sameCursor(publication.cursor, projection.cursor('coordinator'))) throw new Error('not_ready');
  const pins = pinsFor(runtime, config); const status = runtime.status(); const identities = runtime.identities();
  const value: DemoSnapshot = { version: 1, conversation: runtime.conversation, mode: 'live', network,
    configuration_hash: status.configuration_hash, config: structuredClone(config),
    identities: structuredClone(identities), roles: { coordinator: runtime.role === 'coordinator' ? structuredClone(status) : structuredClone(status), provider: provider.status ? structuredClone(provider.status) : null },
    provider_observed_at_ms: provider.observedAt, selected_channel: runtime.selectedChannel(), channels: structuredClone(runtime.economy()),
    projection_sequence: projection.highWater(), available_controls: [...runtime.availableControls()] };
  try { return validateDemoSnapshot(value, pins); } catch { throw new Error('projection_not_ready'); }
}

function sseFrame(event: string, data: unknown, id?: string): Buffer {
  const prefix = id === undefined ? '' : `id: ${id}\n`;
  return Buffer.from(`${prefix}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`, 'utf8');
}
function parseLastEventId(request: IncomingMessage, conversation: string): U64 {
  const value = request.headers['last-event-id'];
  if (Array.isArray(value)) throw new DemoAuthError('invalid_request');
  if (value === undefined || value === '') return '0';
  const match = new RegExp(`^${conversation}:([0-9]+)$`).exec(value); if (!match || !/^(0|[1-9][0-9]*)$/.test(match[1])) throw new Error('invalid_event_cursor');
  return match[1] as U64;
}

async function openBlockedHttp(config: DemoHostConfig, tokens: { viewer?: string; operator?: string; observer: string }): Promise<HttpResult> {
  const privateHost = configuredPrivateHost(config.provider_base_url, config.bind_host, config.port);
  const auth = config.role === 'coordinator'
    ? new DemoAuth({ role: 'coordinator', publicOrigin: config.public_origin ?? '', providerHost: privateHost, viewerToken: tokens.viewer ?? '', operatorToken: tokens.operator ?? '', observerToken: tokens.observer, allowLoopbackHttp: config.topology === 'reduced-local-v1' })
    : new DemoAuth({ role: 'provider', providerHost: privateHost, observerToken: tokens.observer });
  const staticRoot = resolve(config.static_dir);
  const server = http.createServer((request, response) => {
    const path = routePath(request);
    if (path === '/healthz') { if (request.method !== 'GET') return sendError(response, 404, 'not_found'); return sendJson(response, 200, { version: 1, status: 'unavailable' }); }
    if (path.startsWith('/api/v1/') || path.startsWith('/internal/v1/')) {
      try { auth.authorize(request, config.role === 'coordinator' ? 'public' : 'provider'); }
      catch (error) { if (error instanceof DemoAuthError) return sendError(response, error.status, error.code); return sendError(response, 403, 'forbidden'); }
      return sendError(response, 503, 'backend_unavailable');
    }
    if (request.method !== 'GET' || !path) return sendError(response, 404, 'not_found');
    const requested = path === '/' ? '/index.html' : path;
    if (requested.includes('..') || requested.includes('/.') || requested.endsWith('.map')) return sendError(response, 404, 'not_found');
    const file = resolve(staticRoot, `.${requested}`); if (relative(staticRoot, file).startsWith('..')) return sendError(response, 404, 'not_found');
    void realpath(file).then(real => {
      if (relative(staticRoot, real).startsWith('..')) return sendError(response, 404, 'not_found');
      return readFile(real).then(bytes => {
        if (bytes.length > MAX_RESPONSE_BYTES) return sendError(response, 404, 'not_found');
        const type = real.endsWith('.html') ? 'text/html; charset=utf-8' : real.endsWith('.js') ? 'text/javascript; charset=utf-8' : real.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); response.end(bytes);
      });
    }).catch(() => sendError(response, 404, 'not_found'));
  });
  server.requestTimeout = 5_000;
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(config.port, config.bind_host, resolveListen); });
  return { server, close: async () => { await new Promise<void>(resolveClose => { if (!server.listening) return resolveClose(); server.close(() => resolveClose()); }); } };
}

export async function openDemoHttp(options: DemoHttpOptions): Promise<HttpResult> {
  if (!options.runtime || options.runtime.role !== 'coordinator' && options.runtime.role !== 'provider' || !Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535 || typeof options.bindHost !== 'string' || !options.observerToken) fixed('invalid_config');
  const privateHost = configuredPrivateHost(options.providerBaseUrl, options.bindHost, options.port || 8081);
  const pins = pinsFor(options.runtime, options.config);
  const projection = await DemoProjection.open({ stateDir: options.projectionStateDir, create: options.createProjection, conversation: options.runtime.conversation, pins });
  let stopping = false;
  let projectionFailure: string | null = null;
  let providerStatus: ReturnType<DemoRuntimeHandle['status']> | null = null;
  let providerObservedAt: U64 | null = null;
  let providerTimer: NodeJS.Timeout | undefined;
  let providerWork: Promise<void> | undefined;
  const activeStreams = new Set<() => void>();
  const sourceError = (error: unknown): string => {
    const code = safeCode(error);
    return code.startsWith('projection_') ? code : 'projection_not_ready';
  };
  const sourceRole = options.runtime.role;
  type RuntimeEvent = Parameters<DemoRuntimeHandle['subscribe']>[0] extends (event: infer E) => void ? E : never;
  const ingestSource = async (event: RuntimeEvent): Promise<void> => {
    try { await projection.ingest({ source: sourceRole, event }); }
    catch (error) { projectionFailure = sourceError(error); throw error; }
  };
  // Recover source events before the HTTP surface is advertised. Runtime event
  // publication is authoritative; subscribe first so an append at the replay
  // boundary is buffered rather than stranded between the two operations.
  const pendingSource: RuntimeEvent[] = [];
  let sourceReady = false;
  let sourceQueue: Promise<void> = Promise.resolve();
  let unsubscribeRuntime: () => void = () => {};
  try {
    unsubscribeRuntime = options.runtime.subscribe(event => {
      if (!sourceReady) { pendingSource.push(event); return; }
      sourceQueue = sourceQueue.then(() => ingestSource(event)).catch(() => {});
    });
    let cursor = projection.cursor(sourceRole);
    let replayComplete = false;
    for (let batch = 0; batch < 64; batch += 1) {
      const page = validateDemoSourcePage(options.runtime.events(cursor, 256), { ...pins, source: sourceRole });
      for (const event of page.events) await ingestSource(event);
      const next = projection.cursor(sourceRole);
      if (!page.has_more) { replayComplete = true; break; }
      if (sameCursor(next, cursor)) throw new Error('projection_gap');
      cursor = next;
    }
    if (!replayComplete) throw new Error('projection_gap');
    // Drain events emitted while the last source page was being returned. The
    // loop also catches an event queued by a microtask after the final ingest.
    while (pendingSource.length > 0) await ingestSource(pendingSource.shift()!);
    sourceReady = true;
  } catch (error) {
    unsubscribeRuntime();
    await projection.close();
    throw error;
  }
  const providerClient = options.runtime.role === 'coordinator' && options.providerBaseUrl
    ? new DemoProviderClient({ baseUrl: options.providerBaseUrl, observerToken: options.observerToken, conversation: options.runtime.conversation, pins })
    : undefined;
  const refreshProvider = async (): Promise<void> => {
    if (!providerClient || stopping || providerWork) return;
    providerWork = (async () => {
      try {
        const status = await providerClient.status();
        let cursor = projection.cursor('provider');
        for (let batch = 0; batch < 64; batch += 1) {
          const page = await providerClient.events(cursor);
          for (const event of page.events) await projection.ingest({ source: 'provider', event });
          const next = projection.cursor('provider');
          if (!page.has_more) {
            if (sameCursor(next, status.cursor)) { providerStatus = status; providerObservedAt = String(Date.now()); }
            break;
          }
          if (sameCursor(next, cursor)) break;
          cursor = next;
        }
      } catch (error) {
        if (error instanceof DemoProviderError) { /* stale provider state is retained on a private-link failure */ }
        else projectionFailure = sourceError(error);
      } finally { providerWork = undefined; }
    })();
    await providerWork;
  };
  if (providerClient) {
    const poll = async (): Promise<void> => {
      if (stopping) return;
      await refreshProvider();
      if (!stopping) providerTimer = setTimeout(() => { void poll(); }, 500);
    };
    void poll();
  }
  const stopBackground = async (): Promise<void> => {
    stopping = true;
    if (providerTimer) clearTimeout(providerTimer);
    for (const stop of [...activeStreams]) stop();
    unsubscribeRuntime();
    await providerWork?.catch(() => {});
  };
  let auth: DemoAuth;
  try {
    auth = options.runtime.role === 'coordinator'
      ? new DemoAuth({ role: 'coordinator', publicOrigin: options.publicOrigin ?? '', providerHost: privateHost, viewerToken: options.viewerToken ?? '', operatorToken: options.operatorToken ?? '', observerToken: options.observerToken, allowLoopbackHttp: options.publicOrigin?.startsWith('http://127.0.0.1:') === true })
      : new DemoAuth({ role: 'provider', providerHost: privateHost, observerToken: options.observerToken });
  } catch (error) { await stopBackground(); await projection.close(); throw error; }
  const staticRoot = options.staticDir ? resolve(options.staticDir) : null;
  const server = http.createServer((request, response) => { void handle(request as ApiRequest, response); });
  server.requestTimeout = 5_000;
  const handle = async (request: ApiRequest, response: ServerResponse): Promise<void> => {
    const path = routePath(request);
    if (path === '/healthz') { if (request.method !== 'GET') return sendError(response, 404, 'not_found'); return sendJson(response, 200, { version: 1, status: 'ok' }); }
    if (path.startsWith('/api/v1/') || path.startsWith('/internal/v1/')) {
      let principal: DemoAuthPrincipal;
      try { principal = auth.authorize(request, options.runtime.role === 'coordinator' ? 'public' : 'provider'); }
      catch (error) { if (error instanceof DemoAuthError) return sendError(response, error.status, error.code); return sendError(response, 403, 'forbidden'); }
      try {
        if (options.runtime.role === 'provider' && path === '/internal/v1/status') {
          const status = validateDemoRoleStatus(options.runtime.status(), { ...pins, source: 'provider' });
          return sendJson(response, 200, { version: 1, conversation: options.runtime.conversation, source: 'provider', status });
        }
        if (options.runtime.role === 'provider' && path === '/internal/v1/locator') {
          const locator = options.runtime.locator(); if (!locator) return sendError(response, 503, 'provider_unavailable');
          return sendJson(response, 200, { version: 1, conversation: options.runtime.conversation, source: 'provider', locator: sanitizeDemoLocator(locator, pins) });
        }
        if (options.runtime.role === 'provider' && path === '/internal/v1/events') {
          const parsed = new URL(request.url ?? '', 'http://m2m.invalid'); const encoded = parsed.searchParams.get('after'); if (!encoded) return sendError(response, 400, 'invalid_event_cursor');
          const after = decodeSourceCursor(encoded); const page = validateDemoSourcePage(options.runtime.events(after, 256), { ...pins, source: 'provider' });
          return sendJson(response, 200, { version: 1, conversation: options.runtime.conversation, source: 'provider', page });
        }
        if (path === '/api/v1/session') {
          if (projectionFailure) throw new Error(projectionFailure);
          const value: DemoSessionResponse = { version: 1, access: principal.role === 'operator' ? 'operator' : 'viewer', snapshot: snapshot(options.runtime, projection, options.config, options.network ?? 'testnet', { status: providerStatus, observedAt: providerObservedAt }) };
          return sendJson(response, 200, value);
        }
        if (path === '/api/v1/status') {
          if (projectionFailure) throw new Error(projectionFailure);
          const value = { version: 1, conversation: options.runtime.conversation, snapshot: snapshot(options.runtime, projection, options.config, options.network ?? 'testnet', { status: providerStatus, observedAt: providerObservedAt }), high_water: projection.highWater() };
          return sendJson(response, 200, value);
        }
        if (path === '/api/v1/controls' && request.method === 'POST') {
          auth.admitControl(principal); const body = await readBoundedBody(request); const control = parseControl(body, pins);
          // A source/projection poison is a fail-closed admission boundary for
          // new effects. Cancellation and an explicit spending pause remain
          // available as protective controls so an operator can recover safely.
          if (projectionFailure && !(control.command.op === 'cancel' || (control.command.op === 'spending' && control.command.paused))) {
            return sendError(response, 409, projectionFailure);
          }
          const record = await finite(options.runtime.submit(control));
          return sendJson(response, 202, { version: 1, record: validateDemoControlRecord(record, pins) });
        }
        const control = requestId(path);
        if (control !== null) { const record = options.runtime.control(control as string); if (!record) return sendError(response, 404, 'not_found'); return sendJson(response, 200, { version: 1, record: validateDemoControlRecord(record, pins) }); }
        const channel = evidenceAddress(path);
        if (channel !== null) {
          const rawEvidence = await finite(options.runtime.evidence(channel));
          const evidence = sanitizeDemoEvidence(rawEvidence, pins, options.runtime, options.network ?? 'testnet', channel);
          return sendJson(response, 200, evidence);
        }
        if (path === '/api/v1/events') return streamEvents(request, response, principal);
        return sendError(response, 404, 'not_found');
      } catch (error) {
        if (error instanceof DemoAuthError) return sendError(response, error.status, error.code);
        const code = safeCode(error); return sendError(response, statusFor(code), code === 'runtime_error' ? 'runtime_error' : code);
      }
    }
    return serveStatic(request, response, path);
  };
  const streamEvents = async (request: IncomingMessage, response: ServerResponse, principal: DemoAuthPrincipal): Promise<void> => {
    let after: U64;
    try { after = parseLastEventId(request, options.runtime.conversation); if (BigInt(after) > BigInt(projection.highWater())) throw new DemoAuthError('rate_limited'); }
    catch (error) { if (error instanceof DemoAuthError) sendError(response, error.code === 'rate_limited' ? 409 : error.status, error.code === 'rate_limited' ? 'future_cursor' : error.code); else sendError(response, 400, 'invalid_event_cursor'); return; }
    let lease; try { lease = auth.admitSse(principal); } catch (error) { if (error instanceof DemoAuthError) sendError(response, error.status, error.code); else sendError(response, 429, 'sse_limit'); return; }
    let queued: Buffer[] = []; let queuedBytes = 0; let writing = false; let closed = false;
    let pendingWrite: (() => void) | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | undefined;
    const buffered: DemoEvent[] = [];
    let bufferedBytes = 0;
    let replaying = true;
    const seen = new Set<string>();
    const bufferedSeen = new Set<string>();
    let nextSequence = BigInt(after) + 1n;
    const queueFrame = (frame: Buffer): boolean => {
      if (closed) return false;
      if (queuedBytes + frame.length > MAX_SSE_BUFFER_BYTES) { stop(); return false; }
      queued.push(frame); queuedBytes += frame.length; return true;
    };
    const enqueueEvent = (event: DemoEvent): void => {
      if (closed) return;
      const sequence = BigInt(event.sequence);
      if (sequence <= BigInt(after) || seen.has(event.sequence)) return;
      if (sequence !== nextSequence) throw new Error('projection_gap');
      seen.add(event.sequence); nextSequence = sequence + 1n;
      queueFrame(sseFrame('agent_event', event, `${options.runtime.conversation}:${event.sequence}`));
    };
    const cleanup = () => {
      if (closed) return;
      closed = true; unsubscribe?.(); unsubscribe = undefined; lease.release();
      if (heartbeat) clearInterval(heartbeat);
      pendingWrite?.(); pendingWrite = undefined;
      activeStreams.delete(stop);
      queued = []; buffered.length = 0; queuedBytes = 0; bufferedBytes = 0;
    };
    const stop = () => { cleanup(); if (!response.writableEnded) response.end(); };
    const write = (frame: Buffer) => new Promise<void>(resolveWrite => {
      if (closed || response.writableEnded) return resolveWrite();
      if (response.write(frame)) return resolveWrite();
      pendingWrite = resolveWrite;
    });
    const flush = async () => {
      if (writing || closed) return;
      writing = true;
      try { while (queued.length && !closed) { const frame = queued.shift()!; queuedBytes -= frame.length; await write(frame); } }
      catch { stop(); }
      finally { writing = false; }
    };
    const onDrain = () => { const resolveWrite = pendingWrite; pendingWrite = undefined; resolveWrite?.(); };
    const onClose = () => cleanup();
    response.on('drain', onDrain);
    request.on('aborted', stop); response.on('close', onClose); response.on('error', stop);
    unsubscribe = projection.subscribe(event => {
      if (closed) return;
      if (replaying) {
        if (bufferedSeen.has(event.sequence)) return;
        const frameSize = sseFrame('agent_event', event, `${options.runtime.conversation}:${event.sequence}`).length;
        if (bufferedBytes + frameSize > MAX_SSE_BUFFER_BYTES) { stop(); return; }
        bufferedSeen.add(event.sequence); buffered.push(event); bufferedBytes += frameSize;
      } else { try { enqueueEvent(event); void flush(); } catch { stop(); } }
    });
    activeStreams.add(stop);
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
    const highWater = projection.highWater();
    try {
      if (!queueFrame(sseFrame('stream_status', { version: 1, conversation: options.runtime.conversation, state: 'replaying', high_water: highWater }))) return;
      await flush();
      let cursor = after;
      while (!closed && BigInt(cursor) < BigInt(highWater)) {
        const page = projection.replay(cursor, 256);
        if (page.length === 0) throw new Error('projection_gap');
        let advanced = false;
        for (const event of page) {
          if (BigInt(event.sequence) > BigInt(highWater)) break;
          enqueueEvent(event); cursor = event.sequence; advanced = true;
          await flush();
          if (closed) return;
        }
        if (!advanced) throw new Error('projection_gap');
      }
      // Queue the live marker and flip the subscription synchronously before
      // the first await. A publication during marker backpressure is then
      // queued after the marker instead of being stranded in buffered[].
      while (!closed && buffered.length > 0) {
        buffered.sort((left, right) => Number(BigInt(left.sequence) - BigInt(right.sequence)));
        const pending = buffered.splice(0, buffered.length);
        bufferedBytes = 0;
        for (const event of pending) { enqueueEvent(event); await flush(); if (closed) return; }
      }
      if (!queueFrame(sseFrame('stream_status', { version: 1, conversation: options.runtime.conversation, state: 'live', high_water: projection.highWater() }))) return;
      replaying = false;
      bufferedSeen.clear(); bufferedBytes = 0;
      await flush();
      if (closed) return;
      heartbeat = setInterval(() => { if (!closed) { queueFrame(Buffer.from(': heartbeat\n\n')); void flush(); } }, 15_000);
    } catch { stop(); }
  };
  const serveStatic = async (request: IncomingMessage, response: ServerResponse, path: string): Promise<void> => {
    if (request.method !== 'GET' || !staticRoot || !path || path.startsWith('/api/') || path.startsWith('/internal/')) return sendError(response, 404, 'not_found');
    const requested = path === '/' ? '/index.html' : path;
    if (requested.includes('..') || requested.includes('/.') || requested.endsWith('.map')) return sendError(response, 404, 'not_found');
    const file = resolve(staticRoot, `.${requested}`); if (relative(staticRoot, file).startsWith('..')) return sendError(response, 404, 'not_found');
    try { const real = await realpath(file); if (relative(staticRoot, real).startsWith('..')) return sendError(response, 404, 'not_found'); const bytes = await readFile(real); if (bytes.length > MAX_RESPONSE_BYTES) return sendError(response, 404, 'not_found'); const type = real.endsWith('.html') ? 'text/html; charset=utf-8' : real.endsWith('.js') ? 'text/javascript; charset=utf-8' : real.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream'; response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); response.end(bytes); }
    catch { sendError(response, 404, 'not_found'); }
  };
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(options.port, options.bindHost, resolveListen); });
  return { server, close: async () => { await stopBackground(); await new Promise<void>(resolveClose => { if (!server.listening) return resolveClose(); server.close(() => resolveClose()); }); await projection.close(); } };
}

/** Production-only adapter. It accepts no dependency/factory override. */
export async function runDemoServer(configPath: string): Promise<void> {
  const config = await readDemoHostConfig(configPath);
  const stateMetadata = await lstat(config.state_dir).catch(() => null);
  if (!stateMetadata?.isDirectory() || stateMetadata.isSymbolicLink()) fixed('state_directory_missing');
  if ((stateMetadata.mode & 0o077) !== 0) fixed('state_directory_permissions');
  const { role, state_dir: stateDir, conversation, config: serviceConfig, runtime: descriptor, agents } = config;
  const observerToken = await protectedToken(config.observer_token_file);
  const viewerToken = config.viewer_token_file ? await protectedToken(config.viewer_token_file) : undefined;
  const operatorToken = config.operator_token_file ? await protectedToken(config.operator_token_file) : undefined;
  const configurationHash = createHash('sha256').update(canonicalDemoJson({ config: serviceConfig, agents }), 'utf8').digest('hex');
  const providerPins: DemoValidationPins = { conversation, configuration_hash: configurationHash, config: structuredClone(serviceConfig), agents: structuredClone(agents) };
  const providerClient = role === 'coordinator' ? new DemoProviderClient({ baseUrl: config.provider_base_url, observerToken, conversation, pins: providerPins }) : undefined;
  // Keep the static HTTP/auth/projection surface importable while runtime
  // preflight is unavailable; production startup still requires this exact
  // L1 module before opening the live handle.
  let runtime: DemoRuntimeHandle;
  try {
    const { openDemoRuntime } = await import('./agent-demo-runtime.js');
    runtime = await openDemoRuntime({ role, stateDir, conversation, create: false, config: serviceConfig, runtime: descriptor, network: config.network, agents, reduced: config.topology === 'reduced-local-v1',
      walletFile: config.wallet_file, modelApiKeyFile: config.model_api_key_file, searchApiKeyFile: config.search_api_key_file, providerGateFile: join(stateDir, 'responses-live-evidence.json'),
      providerLocator: providerClient ? () => providerClient.locator() : undefined });
  } catch {
    // Preflight failures never become a fake handle or a ready snapshot. Keep
    // the real static login and authenticated fixed-code readiness boundary up.
    const blocked = await openBlockedHttp(config, { viewer: viewerToken, operator: operatorToken, observer: observerToken });
    let stopping = false;
    const shutdown = async (): Promise<void> => { if (stopping) return; stopping = true; await blocked.close(); };
    process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
    process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
    await new Promise<void>(() => {});
    return;
  }
  let app: HttpResult | undefined;
  try {
    app = await openDemoHttp({ runtime, config: serviceConfig, projectionStateDir: config.projection_state_dir, createProjection: false,
      publicOrigin: config.public_origin, bindHost: config.bind_host, port: config.port, viewerToken, operatorToken, observerToken,
      providerBaseUrl: config.provider_base_url, staticDir: config.static_dir, network: config.network });
  } catch {
    await runtime.shutdown().catch(() => {});
    // Projection/auth/storage preflight is also a readiness gate. Preserve the
    // real static/auth boundary instead of exiting or manufacturing a view.
    const blocked = await openBlockedHttp(config, { viewer: viewerToken, operator: operatorToken, observer: observerToken });
    let stopping = false;
    const shutdown = async (): Promise<void> => { if (stopping) return; stopping = true; await blocked.close(); };
    process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
    process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
    await new Promise<void>(() => {});
  }
  let stopping = false;
  const shutdown = async (): Promise<void> => { if (stopping) return; stopping = true; await app!.close(); await runtime.shutdown(); };
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
  process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
  await new Promise<void>(() => {});
}

function configArgument(argv: string[]): string {
  if (argv.length !== 2 || argv[0] !== '--config' || typeof argv[1] !== 'string' || !isAbsolute(argv[1])) fixed('invalid_host_config');
  return argv[1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runDemoServer(configArgument(process.argv.slice(2))).catch(() => { process.exitCode = 1; });
}
