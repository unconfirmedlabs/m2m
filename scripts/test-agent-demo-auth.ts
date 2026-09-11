import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  DEMO_MAX_BODY_BYTES, DEMO_MAX_CONTROL_ATTEMPTS, DEMO_MAX_FAILED_AUTH_GLOBAL,
  DEMO_MAX_FAILED_AUTH_PER_CLIENT, DEMO_MAX_SSE_CLIENTS, DemoAuth, DemoAuthConfigError,
  DemoAuthError,
} from './agent-demo-auth.js';
import { encodeSourceCursor } from './agent-demo-event-contract.js';

const viewer = randomBytes(32).toString('hex');
const operator = randomBytes(32).toString('hex');
const observer = randomBytes(32).toString('hex');
let now = 1_000;

function makeRequest(options: {
  url?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  rawHeaders?: string[];
  remoteAddress?: string;
} = {}): IncomingMessage {
  const headers = options.headers ?? {};
  const rawHeaders = options.rawHeaders ?? Object.entries(headers).flatMap(([key, value]) => value === undefined ? [] : [[key, ...(Array.isArray(value) ? value : [value])]]).flat(2) as string[];
  return {
    url: options.url ?? '/api/v1/session', method: options.method ?? 'GET', headers,
    rawHeaders, socket: { remoteAddress: options.remoteAddress ?? '198.51.100.4' },
  } as unknown as IncomingMessage;
}

function auth(overrides: Partial<ConstructorParameters<typeof DemoAuth>[0]> = {}): DemoAuth {
  return new DemoAuth({ role: 'coordinator', publicOrigin: 'https://demo.example', providerHost: 'provider.internal:8081', viewerToken: viewer, operatorToken: operator, observerToken: observer, nowMs: () => now, ...overrides } as ConstructorParameters<typeof DemoAuth>[0]);
}
function bearer(token: string): Record<string, string> { return { Host: 'demo.example', Authorization: `Bearer ${token}` }; }
function expectCode(code: DemoAuthError['code'], action: () => unknown): void {
  assert.throws(action, (error: unknown) => error instanceof DemoAuthError && error.code === code && !error.message.includes(viewer) && !error.message.includes(operator) && !error.message.includes(observer));
}
function expectConfig(action: () => unknown): void { assert.throws(action, (error: unknown) => error instanceof DemoAuthConfigError && error.code === 'invalid_auth_config'); }

function run(): void {
  const instance = auth();
  const viewerRequest = makeRequest({ headers: bearer(viewer) });
  const operatorRequest = makeRequest({ method: 'POST', url: '/api/v1/controls', headers: { ...bearer(operator), Origin: 'https://demo.example', 'Content-Type': 'application/json', 'Content-Length': '2' } });
  const providerRequest = makeRequest({ url: '/internal/v1/status', headers: { Host: 'provider.internal:8081', Authorization: `Bearer ${observer}` } });
  assert.equal(instance.authorize(viewerRequest).role, 'viewer');
  assert.equal(instance.authorize(operatorRequest).role, 'operator');
  expectCode('forbidden', () => instance.authorize(providerRequest, 'provider'));
  const providerOnly = new DemoAuth({ role: 'provider', providerHost: 'provider.internal:8081', observerToken: observer, nowMs: () => now });
  assert.equal(providerOnly.authorize(providerRequest, 'provider').role, 'observer');
  assert.equal(providerOnly.authorize(makeRequest({ url: '/internal/v1/events?after=' + encodeSourceCursor({ coordinator: '0', research: '0', host: '0' }), headers: { Host: 'provider.internal:8081', Authorization: `Bearer ${observer}` } }), 'provider').role, 'observer');
  assert.equal(instance.assertBodyLength(operatorRequest), 2);

  // Role crossing, exact host/origin, strict route/method and credential placement.
  expectCode('forbidden', () => instance.authorize(makeRequest({ method: 'POST', url: '/api/v1/controls', headers: { ...bearer(viewer), Origin: 'https://demo.example', 'Content-Type': 'application/json' } })));
  expectCode('forbidden', () => instance.authorize(makeRequest({ headers: { Host: 'provider.internal:8081', Authorization: `Bearer ${observer}` } })));
  expectCode('forbidden', () => instance.authorize(makeRequest({ url: '/internal/v1/status', headers: { Host: 'provider.internal:8081', Authorization: `Bearer ${operator}` } }), 'provider'));
  expectCode('forbidden', () => instance.authorize(makeRequest({ headers: { ...bearer(viewer), Host: 'wrong.example' } })));
  expectCode('forbidden', () => instance.authorize(makeRequest({ method: 'POST', url: '/api/v1/controls', headers: { ...bearer(operator), Origin: 'https://wrong.example', 'Content-Type': 'application/json' } })));
  expectCode('forbidden', () => instance.authorize(makeRequest({ method: 'POST', url: '/api/v1/controls', headers: { ...bearer(operator), Origin: 'https://demo.example', 'Content-Type': 'text/plain' } })));
  expectCode('forbidden', () => instance.authorize(makeRequest({ method: 'POST', url: '/api/v1/controls', headers: { ...bearer(operator), 'Content-Type': 'application/json' } })));
  assert.equal(instance.authorize(makeRequest({ method: 'POST', url: '/api/v1/controls', headers: { ...bearer(operator), Origin: 'https://demo.example', 'Content-Type': 'application/json', 'X-Forwarded-Host': 'wrong.example' } })).role, 'operator');
  expectCode('not_found', () => instance.authorize(makeRequest({ url: '/api/v1/session?token=' + viewer, headers: bearer(viewer) })));
  expectCode('not_found', () => instance.authorize(makeRequest({ url: '/api/v1/unknown', headers: bearer(viewer) })));
  expectCode('not_found', () => instance.authorize(makeRequest({ method: 'POST', url: '/api/v1/session', headers: { ...bearer(operator), Origin: 'https://demo.example', 'Content-Type': 'application/json' } })));
  expectCode('forbidden', () => instance.authorize(makeRequest({ url: '/api/v1/evidence/0x' + 'a'.repeat(64), headers: { ...bearer(viewer), Origin: 'https://evil.example' } })));
  expectCode('forbidden', () => instance.authorize(makeRequest({ url: '/internal/v1/status', headers: { Host: 'provider.internal:8081', Authorization: `Bearer ${observer}`, Origin: 'https://demo.example' } }), 'provider'));
  expectCode('unauthorized', () => instance.authorize(makeRequest({ headers: { Host: 'demo.example' } })));
  expectCode('unauthorized', () => instance.authorize(makeRequest({ headers: { ...bearer(viewer), Cookie: 'token=' + viewer } })));
  expectCode('invalid_request', () => instance.authorize(makeRequest({ headers: { Host: 'demo.example' }, rawHeaders: ['Host', 'demo.example', 'Authorization', `Bearer ${viewer}`, 'Authorization', `Bearer ${viewer}`] })));

  // Constructor rejects malformed/equal protected credentials and endpoints.
  expectConfig(() => auth({ publicOrigin: 'http://demo.example' }));
  expectConfig(() => auth({ publicOrigin: 'https://demo.example/path' }));
  expectConfig(() => auth({ providerHost: 'provider.internal' }));
  expectConfig(() => auth({ providerHost: 'provider.internal:0' }));
  expectConfig(() => auth({ providerHost: 'http://provider.internal:8081' }));
  expectConfig(() => auth({ viewerToken: 'short' }));
  expectConfig(() => auth({ operatorToken: 'z'.repeat(64) }));
  expectConfig(() => auth({ observerToken: viewer }));
  expectConfig(() => new DemoAuth({ role: 'provider', providerHost: 'provider.internal:8081', observerToken: observer, viewerToken: viewer } as never));

  // Body limits are checked from the untrusted framing header before buffering.
  expectCode('body_too_large', () => instance.authorize(makeRequest({ method: 'POST', url: '/api/v1/controls', headers: { ...bearer(operator), Origin: 'https://demo.example', 'Content-Type': 'application/json', 'Content-Length': String(DEMO_MAX_BODY_BYTES + 1) } })));
  expectCode('invalid_request', () => instance.authorize(makeRequest({ method: 'POST', url: '/api/v1/controls', headers: { ...bearer(operator), Origin: 'https://demo.example', 'Content-Type': 'application/json', 'Content-Length': '-1' } })));

  // Valid operator control attempts are limited independently of auth failures.
  const controls = auth(); const controlPrincipal = controls.authorize(operatorRequest);
  for (let index = 0; index < DEMO_MAX_CONTROL_ATTEMPTS; index += 1) controls.admitControl(controlPrincipal);
  expectCode('rate_limited', () => controls.admitControl(controlPrincipal));

  // SSE admission is global, bounded and idempotently releasable.
  const sse = auth(); const ssePrincipal = sse.authorize(viewerRequest); const leases = Array.from({ length: DEMO_MAX_SSE_CLIENTS }, () => sse.admitSse(ssePrincipal));
  assert.equal(sse.sseCount(), DEMO_MAX_SSE_CLIENTS);
  expectCode('sse_limit', () => sse.admitSse(ssePrincipal));
  leases[0].release(); leases[0].release(); assert.equal(sse.sseCount(), DEMO_MAX_SSE_CLIENTS - 1);
  sse.admitSse(ssePrincipal).release(); assert.equal(sse.sseCount(), DEMO_MAX_SSE_CLIENTS - 1);
  expectCode('forbidden', () => sse.admitControl({ role: 'operator', clientAddress: 'forged' }));

  // Invalid credentials consume only the trusted socket address bucket, never
  // X-Forwarded-For.  Both per-client and global windows expire deterministically.
  const failed = auth();
  for (let index = 0; index < DEMO_MAX_FAILED_AUTH_PER_CLIENT; index += 1) expectCode('unauthorized', () => failed.authenticate(makeRequest({ remoteAddress: '198.51.100.8', headers: { Host: 'demo.example', Authorization: `Bearer ${'f'.repeat(64)}`, 'X-Forwarded-For': '203.0.113.8' } })));
  expectCode('rate_limited', () => failed.authenticate(makeRequest({ remoteAddress: '198.51.100.8', headers: { Host: 'demo.example', Authorization: `Bearer ${'f'.repeat(64)}` } })));
  now += 60_001;
  expectCode('unauthorized', () => failed.authenticate(makeRequest({ remoteAddress: '198.51.100.8', headers: { Host: 'demo.example', Authorization: `Bearer ${'f'.repeat(64)}` } })));
  const global = auth();
  for (let index = 0; index < DEMO_MAX_FAILED_AUTH_GLOBAL; index += 1) expectCode('unauthorized', () => global.authenticate(makeRequest({ remoteAddress: `198.51.100.${(index % 200) + 1}`, headers: { Authorization: `Bearer ${'e'.repeat(64)}` } })));
  expectCode('rate_limited', () => global.authenticate(makeRequest({ remoteAddress: '203.0.113.250', headers: { Authorization: `Bearer ${'e'.repeat(64)}` } })));
  now += 60_001;
  expectCode('unauthorized', () => global.authenticate(makeRequest({ remoteAddress: '203.0.113.250', headers: { Authorization: `Bearer ${'e'.repeat(64)}` } })));

  process.stdout.write('agent demo auth tests: ok\n');
}

run();
