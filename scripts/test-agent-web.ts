import assert from 'node:assert/strict';
import { blake2b } from '@noble/hashes/blake2.js';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoundedWebTools, BraveSearchBackend, makePinnedHttpsRequestOptions, type SearchBackend } from './agent-web.js';
import type { AgentToolCall } from './agent-service-types.js';

const ref = { agent: 'test:buyer', conversationId: 'conversation', requestId: 'request-1' };
const call = (name: string, args: unknown, id = `${name}-1`): AgentToolCall => ({ request: ref, threadId: 'thread', turnId: 'turn', callId: id, name, arguments: args, signal: new AbortController().signal });

async function testNodePinnedLookupContract(): Promise<void> {
  // Test-only loopback socket: this never enters the production URL allowlist
  // or private-address resolver.  It catches Node 22's all=true callback path,
  // which rejects a pinned string unless the request forces one IPv4 attempt.
  const server = createServer(socket => { socket.on('error', () => {}); socket.destroy(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  let observed: { hostname: string; all?: boolean; family?: number | 'IPv4' | 'IPv6' } | undefined;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; if (error) reject(error); else resolve(); };
    const requestOptions: HttpsRequestOptions & { autoSelectFamily?: boolean } = { ...makePinnedHttpsRequestOptions(new URL('https://loopback.test/'), '127.0.0.1'), port: address.port };
    const lookup = requestOptions.lookup!;
    requestOptions.lookup = (hostname, lookupOptions, callback) => {
      observed = { hostname, all: lookupOptions.all, family: lookupOptions.family };
      lookup(hostname, lookupOptions, callback);
    };
    assert.equal(requestOptions.servername, 'loopback.test'); assert.equal(requestOptions.rejectUnauthorized, true);
    assert.equal(requestOptions.family, 4); assert.equal(requestOptions.autoSelectFamily, false);
    const request = httpsRequest(requestOptions, () => { request.destroy(); finish(); });
    request.once('error', error => finish((error as NodeJS.ErrnoException).code === 'ERR_INVALID_IP_ADDRESS' ? error : undefined));
    request.setTimeout(2_000, () => request.destroy(new Error('loopback_https_timeout'))); request.end();
  });
  server.close(); await once(server, 'close');
  assert.equal(observed?.hostname, 'loopback.test'); assert.equal(observed?.family, 4); assert.notEqual(observed?.all, true);
}

async function tests(): Promise<void> {
  await testNodePinnedLookupContract();
  const root = mkdtempSync(join(tmpdir(), 'm2m-agent-web-'));
  let searches = 0; let fetches = 0;
  const searchBackend: SearchBackend = { async search(query, options) { searches++; assert.equal(query, 'bounded query'); assert.equal(options.maxBytes, 128 * 1024); return [{ url: 'https://docs.example.test/page', title: 'Docs', snippet: 'A bounded result' }]; } };
  const html = '<html><head><title>Example page</title><style>secret</style></head><body>Hello <b>world</b>. <script>bad()</script></body></html>';
  const httpGet = async (url: URL, options: { signal: AbortSignal; maxBytes: number; lookupAddress?: string }): Promise<any> => { fetches++; assert.equal(url.hostname, 'docs.example.test'); assert.equal(options.maxBytes, 128 * 1024); assert.equal(options.lookupAddress, '93.184.216.34'); return { statusCode: 200, headers: { 'content-type': 'text/html', 'content-encoding': 'identity' }, body: Buffer.from(html) }; };
  try {
    const web = await BoundedWebTools.open({ stateDir: root, searchBackend, allowedHosts: ['docs.example.test'], httpGet: httpGet as any, lookupHost: async () => ['93.184.216.34'] });
    const profile = web.profile(); assert.equal(profile.id, 'm2m-research-web-v2'); assert.deepEqual(profile.recoverableTools, ['web_search', 'web_fetch']);
    const malformedSearch = await profile.handleTool(call('web_search', { query: 'query', extra: false })); assert.equal(malformedSearch.success, false); assert.equal(malformedSearch.text, 'invalid_tool_arguments'); assert.equal(searches, 0);
    const searched = await profile.handleTool(call('web_search', { query: 'bounded query' })); assert.equal(searched.success, true); assert.equal(searches, 1);
    const fetched = await profile.handleTool(call('web_fetch', { url: 'https://docs.example.test/page' })); assert.equal(fetched.success, true); assert.match(fetched.text, /\[?\{"citation"/); assert.equal(fetches, 1);
    const duplicate = await profile.handleTool(call('web_fetch', { url: 'https://docs.example.test/page' })); assert.equal(duplicate.text, fetched.text); assert.equal(fetches, 1);
    const conflict = await profile.handleTool(call('web_fetch', { url: 'https://docs.example.test/other' }, 'web_fetch-1')); assert.equal(conflict.success, false); assert.equal(conflict.text, 'tool_call_conflict'); assert.equal(fetches, 1);
    const invalidUrl = await profile.handleTool(call('web_fetch', { url: 'http://docs.example.test/page' }, 'bad')); assert.equal(invalidUrl.success, false); assert.equal(invalidUrl.text, 'invalid_fetch_url'); assert.equal(fetches, 1);
    assert.equal(web.sources(ref).length, 1); const citation = web.sources(ref)[0]; assert.equal(citation.id, 's1'); assert.equal(citation.url, 'https://docs.example.test/page');
    assert.equal(Buffer.from(citation.content_hash).toString('hex'), '4c555fe0bfff3d9d19b55e2f699cbc853956828fef1be41edd023a1f03d1d970');
    assert.deepEqual(citation.content_hash, Array.from(blake2b(new TextEncoder().encode('Example page Hello world .'), { dkLen: 32 })));
    web.close();
    const reopened = await BoundedWebTools.open({ stateDir: root, searchBackend, allowedHosts: ['docs.example.test'], httpGet: httpGet as any, lookupHost: async () => ['93.184.216.34'] });
    assert.deepEqual(reopened.sources(ref), [citation]); reopened.close();
    await assert.rejects(() => BoundedWebTools.open({ stateDir: root, searchBackend, allowedHosts: ['other.example.test'], httpGet: httpGet as any, lookupHost: async () => ['93.184.216.34'] }), /journal_corrupt/);
    unlinkSync(join(root, 'web.initialized')); await assert.rejects(() => BoundedWebTools.open({ stateDir: root, searchBackend, allowedHosts: ['docs.example.test'], httpGet: httpGet as any, lookupHost: async () => ['93.184.216.34'] }), /journal_missing/);
    const missing = await BoundedWebTools.open({ stateDir: join(root, 'missing'), searchBackend, allowedHosts: ['docs.example.test'], httpGet: httpGet as any, lookupHost: async () => ['93.184.216.34'] }); missing.close(); unlinkSync(join(root, 'missing', 'web.json')); await assert.rejects(() => BoundedWebTools.open({ stateDir: join(root, 'missing'), searchBackend, allowedHosts: ['docs.example.test'], httpGet: httpGet as any, lookupHost: async () => ['93.184.216.34'] }), /journal_missing/);
    const unsafe = await BoundedWebTools.open({ stateDir: join(root, 'unsafe'), searchBackend, allowedHosts: ['private.example.test'], httpGet: httpGet as any, lookupHost: async () => ['10.0.0.2', '93.184.216.34'] });
    const unsafeResult = await unsafe.profile().handleTool(call('web_fetch', { url: 'https://private.example.test/page' }, 'unsafe')); assert.equal(unsafeResult.success, false); assert.equal(unsafeResult.text, 'unsafe_address'); assert.equal(fetches, 1); unsafe.close();
    const redirect = await BoundedWebTools.open({ stateDir: join(root, 'redirect'), searchBackend, allowedHosts: ['docs.example.test'], httpGet: (async () => ({ statusCode: 302, headers: { location: 'https://other.example.test/page' }, body: Buffer.alloc(0) })) as any, lookupHost: async () => ['93.184.216.34'] });
    const redirectResult = await redirect.profile().handleTool(call('web_fetch', { url: 'https://docs.example.test/page' }, 'redirect')); assert.equal(redirectResult.success, false); assert.equal(redirectResult.text, 'host_not_allowed'); redirect.close();
    const malformed = await BoundedWebTools.open({ stateDir: join(root, 'malformed'), searchBackend, allowedHosts: ['docs.example.test'], httpGet: (async () => ({ statusCode: 200, headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, body: Buffer.from('secret') })) as any, lookupHost: async () => ['93.184.216.34'] });
    const compressed = await malformed.profile().handleTool(call('web_fetch', { url: 'https://docs.example.test/page' }, 'compressed')); assert.equal(compressed.success, false); assert.equal(compressed.text, 'compressed_response');
    const nonTextWeb = await BoundedWebTools.open({ stateDir: join(root, 'nontext'), searchBackend, allowedHosts: ['docs.example.test'], httpGet: (async () => ({ statusCode: 200, headers: { 'content-type': 'application/pdf', 'content-encoding': 'identity' }, body: Buffer.from('pdf') })) as any, lookupHost: async () => ['93.184.216.34'] });
    const nonText = await nonTextWeb.profile().handleTool(call('web_fetch', { url: 'https://docs.example.test/page' }, 'nontext')); assert.equal(nonText.success, false); assert.equal(nonText.text, 'unsupported_content_type'); nonTextWeb.close();
    const credentials = await malformed.profile().handleTool(call('web_fetch', { url: 'https://user:pass@docs.example.test/page' }, 'credentials')); assert.equal(credentials.success, false); assert.equal(credentials.text, 'invalid_fetch_url'); malformed.close();
    const oversized = await BoundedWebTools.open({ stateDir: join(root, 'oversized'), searchBackend, allowedHosts: ['docs.example.test'], httpGet: (async () => ({ statusCode: 200, headers: { 'content-type': 'text/plain', 'content-encoding': 'identity' }, body: Buffer.alloc(128 * 1024 + 1) })) as any, lookupHost: async () => ['2001:db8::1'] });
    const reserved = await oversized.profile().handleTool(call('web_fetch', { url: 'https://docs.example.test/page' }, 'reserved')); assert.equal(reserved.success, false); assert.equal(reserved.text, 'unsafe_address'); oversized.close();
    const large = await BoundedWebTools.open({ stateDir: join(root, 'large'), searchBackend, allowedHosts: ['docs.example.test'], httpGet: (async () => ({ statusCode: 200, headers: { 'content-type': 'text/plain', 'content-encoding': 'identity' }, body: Buffer.alloc(128 * 1024 + 1) })) as any, lookupHost: async () => ['93.184.216.34'] });
    const tooLarge = await large.profile().handleTool(call('web_fetch', { url: 'https://docs.example.test/page' }, 'large')); assert.equal(tooLarge.success, false); assert.equal(tooLarge.text, 'limit_exceeded'); large.close();
    let aggregateSearches = 0;
    const aggregateSearch: SearchBackend = { async search() {
      aggregateSearches++;
      if (aggregateSearches <= 2) return Array.from({ length: 5 }, () => ({ url: 'u'.repeat(2048), title: 't'.repeat(256), snippet: 's'.repeat(4096) }));
      return [{ url: 'u', title: 't', snippet: 's'.repeat(1106) }];
    } };
    const aggregate = await BoundedWebTools.open({ stateDir: join(root, 'aggregate'), searchBackend: aggregateSearch, allowedHosts: ['docs.example.test'], httpGet: (async () => ({ statusCode: 200, headers: { 'content-type': 'text/plain', 'content-encoding': 'identity' }, body: Buffer.from('one more source') })) as any, lookupHost: async () => ['93.184.216.34'] });
    const aggregateProfile = aggregate.profile();
    await aggregateProfile.handleTool(call('web_search', { query: 'q' }, 'aggregate-1'));
    await aggregateProfile.handleTool(call('web_search', { query: 'q' }, 'aggregate-2'));
    await aggregateProfile.handleTool(call('web_search', { query: 'q' }, 'aggregate-3'));
    const exhausted = await aggregateProfile.handleTool(call('web_fetch', { url: 'https://docs.example.test/page' }, 'aggregate-fetch'));
    assert.equal(exhausted.success, false); assert.equal(exhausted.text, '');
    const aggregateJournal = JSON.parse(readFileSync(join(root, 'aggregate', 'web.json'), 'utf8'));
    const aggregateRecord = Object.values(aggregateJournal.requests)[0] as any;
    assert.equal(aggregateRecord.toolResultBytes, 64 * 1024 - 4); assert.equal(aggregateRecord.toolResultBytes <= 64 * 1024, true);
    aggregate.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
  assert.throws(() => new BraveSearchBackend({ apiKey: '' }), /search_unconfigured/);
  console.log('Agent web: strict inputs, bounded injected search/fetch, citation persistence, replay/conflict, URL policy and no-key guard passed.');
}
await tests();
