import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { decodeSourceCursor } from './agent-demo-event-contract.js';

/** Fixed public failures.  No request value is ever included in an error. */
export type DemoAuthCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'sse_limit'
  | 'body_too_large'
  | 'invalid_request'
  | 'invalid_auth_config';

export class DemoAuthError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 413 | 429;
  readonly code: Exclude<DemoAuthCode, 'invalid_auth_config'>;

  constructor(code: Exclude<DemoAuthCode, 'invalid_auth_config'>) {
    super(code);
    this.name = 'DemoAuthError';
    this.code = code;
    this.status = code === 'unauthorized' ? 401
      : code === 'not_found' ? 404
        : code === 'body_too_large' ? 413
          : code === 'rate_limited' || code === 'sse_limit' ? 429
            : code === 'invalid_request' ? 400 : 403;
  }
}

export class DemoAuthConfigError extends Error {
  readonly code = 'invalid_auth_config' as const;
  constructor() { super('invalid_auth_config'); this.name = 'DemoAuthConfigError'; }
}

export type DemoAuthScope = 'public' | 'provider';
export type DemoAuthRole = 'viewer' | 'operator' | 'observer';

export interface DemoAuthPrincipal {
  readonly role: DemoAuthRole;
  /** The socket address only; forwarded headers are intentionally ignored. */
  readonly clientAddress: string;
}

export interface DemoSseLease {
  readonly principal: DemoAuthPrincipal;
  release(): void;
}

export interface DemoCoordinatorAuthOptions {
  role: 'coordinator';
  /** The exact public origin (HTTPS, or reduced-local loopback HTTP), with no path, query, or fragment. */
  publicOrigin: string;
  /** The exact private Host header used by the provider listener. */
  providerHost: string;
  viewerToken: string;
  operatorToken: string;
  observerToken: string;
  /** Reduced-local operator mode may use an HTTP loopback origin only. */
  allowLoopbackHttp?: boolean;
  nowMs?: () => number;
}
export interface DemoProviderAuthOptions {
  role: 'provider';
  /** Provider exposes only its private observer surface. */
  publicOrigin?: never;
  providerHost: string;
  observerToken: string;
  viewerToken?: never;
  operatorToken?: never;
  nowMs?: () => number;
}
export type DemoAuthOptions = DemoCoordinatorAuthOptions | DemoProviderAuthOptions;

export const DEMO_MAX_BODY_BYTES = 20 * 1024;
export const DEMO_REQUEST_TIMEOUT_MS = 5_000;
export const DEMO_MAX_SSE_CLIENTS = 8;
export const DEMO_MAX_CONTROL_ATTEMPTS = 60;
export const DEMO_MAX_FAILED_AUTH_PER_CLIENT = 20;
export const DEMO_MAX_FAILED_AUTH_GLOBAL = 100;
export const DEMO_RATE_WINDOW_MS = 60_000;

const TOKEN_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-f]{64}$/;
const PRIVATE_PATH_PREFIX = '/internal/v1/';
const PUBLIC_PATH_PREFIX = '/api/v1/';

type HeaderName = 'authorization' | 'cookie' | 'content-type' | 'host' | 'origin' | 'content-length';
type Route = {
  scope: DemoAuthScope;
  roles: readonly DemoAuthRole[];
  mutation: boolean;
  sse: boolean;
};

const PUBLIC_READ: Route = { scope: 'public', roles: ['viewer', 'operator'], mutation: false, sse: false };
const PUBLIC_EVENTS: Route = { scope: 'public', roles: ['viewer', 'operator'], mutation: false, sse: true };
const PUBLIC_CONTROL: Route = { scope: 'public', roles: ['operator'], mutation: true, sse: false };
const PROVIDER_READ: Route = { scope: 'provider', roles: ['observer'], mutation: false, sse: false };
const PROVIDER_EVENTS: Route = { scope: 'provider', roles: ['observer'], mutation: false, sse: true };

function configBad(): never { throw new DemoAuthConfigError(); }
function authBad(code: Exclude<DemoAuthCode, 'invalid_auth_config'>): never { throw new DemoAuthError(code); }

function exactOrigin(value: unknown, allowLoopbackHttp = false): { origin: string; host: string } {
  if (typeof value !== 'string' || value.length > 512 || /[\u0000-\u0020\u007f]/.test(value)) return configBad();
  let parsed: URL;
  try { parsed = new URL(value); } catch { return configBad(); }
  if ((parsed.protocol !== 'https:' && !(allowLoopbackHttp && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && !!parsed.port)) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.origin !== value) return configBad();
  return { origin: parsed.origin, host: parsed.host };
}

function exactPrivateHost(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || /[\u0000-\u0020\u007f]/.test(value) || value.includes('/') || value.includes('?') || value.includes('#') || value.includes('@')) return configBad();
  let parsed: URL;
  try { parsed = new URL(`http://${value}`); } catch { return configBad(); }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || !parsed.port || parsed.hostname === '' || parsed.port === '0') return configBad();
  if (parsed.host !== value.toLowerCase()) return configBad();
  return parsed.host;
}

function secret(value: unknown): Buffer {
  if (typeof value !== 'string' || !TOKEN_RE.test(value) || /^0+$/.test(value)) return configBad();
  return Buffer.from(value, 'hex');
}

function requestUrl(request: IncomingMessage): URL {
  const raw = request.url;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8_192 || !raw.startsWith('/')) return authBad('not_found');
  let parsed: URL;
  try { parsed = new URL(raw, 'http://m2m.invalid'); } catch { return authBad('not_found'); }
  if (parsed.origin !== 'http://m2m.invalid' || parsed.hash) return authBad('not_found');
  return parsed;
}

function providerAfter(parsed: URL): void {
  const values = parsed.searchParams.getAll('after');
  if (values.length !== 1 || parsed.searchParams.size !== 1 || !values[0]) return authBad('invalid_request');
  try { decodeSourceCursor(values[0]); } catch { return authBad('invalid_request'); }
}

function rawHeaderValues(request: IncomingMessage, name: HeaderName): string[] {
  const lower = name.toLowerCase();
  const raw = request.rawHeaders;
  if (Array.isArray(raw) && raw.length > 0) {
    const values: string[] = [];
    for (let index = 0; index + 1 < raw.length; index += 2) if (raw[index].toLowerCase() === lower) values.push(raw[index + 1]);
    return values;
  }
  const value = request.headers[lower];
  if (Array.isArray(value)) return [...value];
  return typeof value === 'string' ? [value] : [];
}

function oneHeader(request: IncomingMessage, name: HeaderName): string | null {
  const values = rawHeaderValues(request, name);
  if (values.length > 1) return authBad('invalid_request');
  return values[0] ?? null;
}

function clientAddress(request: IncomingMessage): string {
  const address = request.socket?.remoteAddress;
  return typeof address === 'string' && address.length > 0 && address.length <= 128 ? address : 'unknown';
}

function method(request: IncomingMessage): string {
  return typeof request.method === 'string' ? request.method : '';
}

function route(request: IncomingMessage): Route {
  const parsed = requestUrl(request);
  const path = parsed.pathname;
  const verb = method(request);
  if (path === '/api/v1/session' || path === '/api/v1/status') {
    if (verb !== 'GET') return authBad('not_found');
    if (parsed.search) return authBad('not_found');
    return PUBLIC_READ;
  }
  if (path === '/api/v1/events') {
    if (verb !== 'GET') return authBad('not_found');
    if (parsed.search) return authBad('not_found');
    return PUBLIC_EVENTS;
  }
  if (path === '/api/v1/controls') {
    if (verb !== 'POST') return authBad('not_found');
    if (parsed.search) return authBad('not_found');
    return PUBLIC_CONTROL;
  }
  if (/^\/api\/v1\/controls\/[0-9a-f]{64}$/.test(path) || /^\/api\/v1\/evidence\/0x[0-9a-f]{64}$/.test(path)) {
    if (verb !== 'GET') return authBad('not_found');
    if (parsed.search) return authBad('not_found');
    return PUBLIC_READ;
  }
  if (path === `${PRIVATE_PATH_PREFIX}status` || path === `${PRIVATE_PATH_PREFIX}locator`) {
    if (verb !== 'GET') return authBad('not_found');
    if (parsed.search) return authBad('not_found');
    return PROVIDER_READ;
  }
  if (path === `${PRIVATE_PATH_PREFIX}events`) {
    if (verb !== 'GET') return authBad('not_found');
    providerAfter(parsed);
    return PROVIDER_EVENTS;
  }
  if (path.startsWith(PUBLIC_PATH_PREFIX) || path.startsWith(PRIVATE_PATH_PREFIX)) return authBad('not_found');
  return authBad('not_found');
}

function validContentType(request: IncomingMessage): boolean {
  const value = oneHeader(request, 'content-type');
  return value !== null && value.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

function contentLength(request: IncomingMessage): number | null {
  const value = oneHeader(request, 'content-length');
  if (value === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) authBad('invalid_request');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) authBad('body_too_large');
  return parsed;
}

const principalOwners = new WeakMap<object, DemoAuth>();
class Principal implements DemoAuthPrincipal {
  readonly role!: DemoAuthRole;
  readonly clientAddress!: string;
  constructor(owner: DemoAuth, role: DemoAuthRole, clientAddress: string) {
    Object.defineProperty(this, 'role', { value: role, enumerable: true, writable: false, configurable: false });
    Object.defineProperty(this, 'clientAddress', { value: clientAddress, enumerable: true, writable: false, configurable: false });
    principalOwners.set(this, owner);
  }
}

export class DemoAuth {
  readonly role: 'coordinator' | 'provider';
  readonly publicOrigin: string | null;
  readonly publicHost: string | null;
  readonly providerHost: string;
  private readonly secrets!: ReadonlyArray<{ role: DemoAuthRole; value: Buffer }>;
  private readonly nowMs!: () => number;
  private readonly failedByClient = new Map<string, number[]>();
  private failedGlobal: number[] = [];
  private controlAttempts: number[] = [];
  private sseClients = 0;

  constructor(options: DemoAuthOptions) {
    this.role = options.role;
    const origin = options.role === 'coordinator' ? exactOrigin(options.publicOrigin, options.allowLoopbackHttp === true) : null;
    this.publicOrigin = origin?.origin ?? null;
    this.publicHost = origin?.host ?? null;
    this.providerHost = exactPrivateHost(options.providerHost);
    const observer = secret(options.observerToken);
    if (options.role === 'provider') {
      if (Object.prototype.hasOwnProperty.call(options, 'viewerToken') || Object.prototype.hasOwnProperty.call(options, 'operatorToken') || Object.prototype.hasOwnProperty.call(options, 'publicOrigin')) return configBad();
      this.secrets = [{ role: 'observer', value: observer }];
    } else {
      const viewer = secret(options.viewerToken); const operator = secret(options.operatorToken);
      if (viewer.equals(operator) || viewer.equals(observer) || operator.equals(observer)) return configBad();
      this.secrets = [{ role: 'viewer', value: viewer }, { role: 'operator', value: operator }, { role: 'observer', value: observer }];
    }
    this.nowMs = options.nowMs ?? (() => Date.now());
    const now = this.nowMs();
    if (!Number.isFinite(now) || now < 0) return configBad();
  }

  /** Check only the bearer credential and return no secret material. */
  authenticate(request: IncomingMessage): DemoAuthPrincipal {
    const address = clientAddress(request);
    const cookie = oneHeader(request, 'cookie');
    const authorization = oneHeader(request, 'authorization');
    const candidate = authorization !== null && authorization.startsWith('Bearer ') && authorization.length <= 128
      ? authorization.slice(7) : null;
    const candidateBytes = candidate !== null && TOKEN_RE.test(candidate) ? Buffer.from(candidate, 'hex') : Buffer.alloc(32);
    let matched: DemoAuthRole | null = null;
    for (const expected of this.secrets) {
      const equal = candidateBytes.length === expected.value.length && timingSafeEqual(candidateBytes, expected.value);
      if (equal) matched = expected.role;
    }
    if (cookie !== null || matched === null) {
      this.recordFailed(address);
      return authBad('unauthorized');
    }
    return new Principal(this, matched, address);
  }

  /** Authenticate and apply the exact public/private route policy. */
  authorize(request: IncomingMessage, expectedScope?: DemoAuthScope): DemoAuthPrincipal {
    const selected = route(request);
    if (expectedScope !== undefined && selected.scope !== expectedScope) return authBad('forbidden');
    if ((this.role === 'coordinator' && selected.scope !== 'public') || (this.role === 'provider' && selected.scope !== 'provider')) return authBad('forbidden');
    const principal = this.authenticate(request) as Principal;
    const host = oneHeader(request, 'host');
    const expectedHost = selected.scope === 'public' ? this.publicHost : this.providerHost;
    if (host !== expectedHost || !selected.roles.includes(principal.role)) return authBad('forbidden');
    const origin = oneHeader(request, 'origin');
    if (selected.scope === 'public') {
      if (origin !== null && origin !== this.publicOrigin) return authBad('forbidden');
      if (selected.mutation && (origin !== this.publicOrigin || !validContentType(request))) return authBad('forbidden');
    } else if (origin !== null) return authBad('forbidden');
    if (selected.mutation) this.assertBodyLength(request);
    return principal;
  }

  /** Enforce the fixed body bound before the HTTP host buffers any bytes. */
  assertBodyLength(request: IncomingMessage): number | null {
    const length = contentLength(request);
    if (length !== null && length > DEMO_MAX_BODY_BYTES) return authBad('body_too_large');
    return length;
  }

  /** Consume one valid operator control attempt. */
  admitControl(principal: DemoAuthPrincipal): void {
    this.assertPrincipal(principal);
    if (principal.role !== 'operator') return authBad('forbidden');
    const now = this.clock(); this.controlAttempts = this.recent(this.controlAttempts, now);
    if (this.controlAttempts.length >= DEMO_MAX_CONTROL_ATTEMPTS) return authBad('rate_limited');
    this.controlAttempts.push(now);
  }

  /** Reserve one bounded SSE slot. Release is idempotent for finally blocks. */
  admitSse(principal: DemoAuthPrincipal): DemoSseLease {
    this.assertPrincipal(principal);
    if (this.sseClients >= DEMO_MAX_SSE_CLIENTS) return authBad('sse_limit');
    this.sseClients += 1;
    let released = false;
    return { principal, release: () => { if (!released) { released = true; this.sseClients -= 1; } } };
  }

  sseCount(): number { return this.sseClients; }

  private assertPrincipal(principal: DemoAuthPrincipal): asserts principal is Principal {
    if (!(principal instanceof Principal) || principalOwners.get(principal) !== this) return authBad('forbidden');
  }

  private clock(): number {
    const value = this.nowMs();
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  private recent(values: number[], now: number): number[] {
    return values.filter(value => now >= value && now - value < DEMO_RATE_WINDOW_MS);
  }

  private recordFailed(address: string): void {
    const now = this.clock();
    const client = this.recent(this.failedByClient.get(address) ?? [], now);
    const global = this.recent(this.failedGlobal, now);
    if (client.length >= DEMO_MAX_FAILED_AUTH_PER_CLIENT || global.length >= DEMO_MAX_FAILED_AUTH_GLOBAL) return authBad('rate_limited');
    client.push(now); global.push(now); this.failedByClient.set(address, client); this.failedGlobal = global;
  }
}
