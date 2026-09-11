import assert from 'node:assert/strict';
import { createPublicSessionFixture } from '../tests/agent-demo/public-session.js';
import { DemoProviderClient, DemoProviderError } from './agent-demo-provider-client.js';

async function run(): Promise<void> {
  const fixture = createPublicSessionFixture(); let calls: Array<{ url: string; init?: RequestInit }> = [];
  const jsonResponse = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init });
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${'33'.repeat(32)}`);
    assert.equal((init?.headers as Record<string, string>).Cookie, undefined);
    if (url.includes('/status')) return jsonResponse({ version: 1, conversation: fixture.pins.conversation, source: 'provider', status: fixture.snapshot.roles.provider });
    if (url.includes('/locator')) return jsonResponse({ version: 1, conversation: fixture.pins.conversation, source: 'provider', locator: { version: 1, conversation: fixture.pins.conversation, provider: fixture.pins.agents.provider, configuration_hash: fixture.pins.configuration_hash, endpoint: { id: '55'.repeat(32), addrs: [] } } });
    return jsonResponse({ version: 1, conversation: fixture.pins.conversation, source: 'provider', page: { version: 1, conversation: fixture.pins.conversation, source: 'provider', events: fixture.events.filter(item => item.source === 'provider').map(item => item.event), high_water: { coordinator: '0', research: '2', host: '1' }, has_more: false } });
  };
  const client = new DemoProviderClient({ baseUrl: 'http://provider.internal:8081', observerToken: '33'.repeat(32), conversation: fixture.pins.conversation, pins: fixture.pins, fetcher });
  assert.equal((await client.status()).role, 'provider'); assert.equal((await client.locator()).endpoint.id, '55'.repeat(32)); assert.equal((await client.events({ coordinator: '0', research: '0', host: '0' })).source, 'provider'); assert.equal(calls.length, 3); assert.match(calls[2].url, /after=/);
  assert.throws(() => new DemoProviderClient({ baseUrl: 'https://provider.internal', observerToken: '33'.repeat(32), conversation: fixture.pins.conversation, pins: fixture.pins }), (error: unknown) => error instanceof DemoProviderError && error.code === 'invalid_provider_config');
  assert.throws(() => new DemoProviderClient({ baseUrl: 'http://provider.internal:8081', observerToken: 'short', conversation: fixture.pins.conversation, pins: fixture.pins }), (error: unknown) => error instanceof DemoProviderError && error.code === 'invalid_provider_config');
  const malformed = new DemoProviderClient({ baseUrl: 'http://provider.internal:8081', observerToken: '33'.repeat(32), conversation: fixture.pins.conversation, pins: fixture.pins, fetcher: async () => jsonResponse({ private: 'nope' }) });
  await assert.rejects(malformed.status(), (error: unknown) => error instanceof DemoProviderError && error.code === 'invalid_provider_response');
  process.stdout.write('agent demo provider client tests: ok\n');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
