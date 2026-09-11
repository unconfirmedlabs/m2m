/** TEST ONLY. Run mounted read-only in the candidate image with --network none
 * and an ephemeral /data tmpfs. This deliberately has no initialized agents,
 * keys or wallets. A truthful blocked host is the only acceptable result.
 */
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

assert.equal(process.getuid(), 1000);
assert.equal(process.cwd(), '/app');
assert.deepEqual(await readdir('/data'), [], 'use an empty ephemeral test mount');
await import('/app/scripts/agent-demo-server.js');
await mkdir('/data/m2m', { mode: 0o700 });
const ref = byte => ({ network: [...new TextEncoder().encode('testnet')], package_id: '0x' + '01'.repeat(32), domain: '0x' + '02'.repeat(32), agent: '0x' + byte.repeat(32) });
const config = {
  version: 1, role: 'coordinator', state_dir: '/data/m2m', conversation: '05'.repeat(32), network: 'testnet',
  config: { version: 1, budget: { max_total_mist: '100000', max_channel_deposit_mist: '100000', max_turn_mist: '40000', max_outstanding_mist: '1024', max_requests: 2, deadline_ms: '4102444800000', output_tranche_bytes: 256 }, deposit_mist: '100000', price: { input_rate: '0', output_rate: '1', denominator: '1' }, allowed_hosts: ['example.com'] },
  runtime: { version: 1, kind: 'responses-tools-v1', model: 'gpt-5.6-luna', reasoning: 'xhigh' }, agents: { buyer: ref('03'), provider: ref('04') },
  projection_state_dir: '/data/m2m/projection', static_dir: '/app/ui', bind_host: '0.0.0.0', port: 8080,
  provider_base_url: 'http://test-only-provider.internal:8081', public_origin: 'https://127.0.0.1:8080',
  wallet_file: '/data/m2m/wallet-missing',
  viewer_token_file: '/data/m2m/viewer', operator_token_file: '/data/m2m/operator', observer_token_file: '/data/m2m/observer',
};
for (const [file, byte] of [['viewer', '11'], ['operator', '22'], ['observer', '33']]) await writeFile(`/data/m2m/${file}`, byte.repeat(32), { mode: 0o600 });
await writeFile('/data/m2m/host.json', JSON.stringify(config), { mode: 0o600 });
const child = spawn(process.execPath, ['/app/scripts/agent-demo-server.js', '--config', '/data/m2m/host.json'], { stdio: ['ignore', 'pipe', 'pipe'] });
const exit = once(child, 'exit'); const output = [];
child.stdout.on('data', bytes => output.push(bytes)); child.stderr.on('data', bytes => output.push(bytes));
const get = (path, headers = {}) => fetch(`http://127.0.0.1:8080${path}`, { headers, redirect: 'error', signal: AbortSignal.timeout(1000) });
try {
  let health;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, 'production command exited before readiness listener');
    health = await get('/healthz').catch(() => null);
    if (health) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(health); assert.deepEqual(await health.json(), { version: 1, status: 'unavailable' });
  const index = await get('/'); assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy'), /connect-src 'self'/);
  const html = await index.text(); assert.match(html, /<script[^>]+src="\/assets\/[^" ]+\.js"/);
  const unauthenticated = await get('/api/v1/session'); assert.equal(unauthenticated.status, 401);
  const blocked = await get('/api/v1/session', { Authorization: 'Bearer ' + '11'.repeat(32) });
  assert.equal(blocked.status, 503); assert.deepEqual(await blocked.json(), { version: 1, code: 'backend_unavailable' });
  const mutation = await fetch('http://127.0.0.1:8080/api/v1/controls', { method: 'POST', headers: { Authorization: 'Bearer ' + '22'.repeat(32), Origin: config.public_origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, id: '06'.repeat(32), command: { op: 'fund', configuration_hash: '07'.repeat(32), previous_channel: null } }), signal: AbortSignal.timeout(1000) });
  assert.equal(mutation.status, 503); assert.deepEqual(await mutation.json(), { version: 1, code: 'backend_unavailable' });
  const files = await readdir('/data/m2m', { recursive: true });
  assert(!files.some(file => /(?:manifest|initialized|runtime\.json|\.tx\.json|key\.json|wallet)/.test(file)), 'blocked boot manufactured durable/economic state');
  assert.equal(Buffer.concat(output).length, 0, 'protected boot must not log config or raw errors');
  const modules = await readdir('/app/scripts');
  assert(!modules.some(file => /(?:test|fixture|setup|example)/.test(file)));
  assert((await readFile('/app/ui/index.html', 'utf8')).length > 0);
  console.log(JSON.stringify({ mode: 'candidate-image-blocked-boot', uid: process.getuid(), imported: true, static_http: 200, unauthenticated_http: 401, authenticated_readiness_http: 503, funding_http: 503, project_modules: modules.length, network: 'none', live_agents: false, payments: false }));
} finally {
  child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  const [code, signal] = await exit; clearTimeout(timeout);
  assert.equal(signal, null, 'host exceeded graceful shutdown'); assert.equal(code, 0);
}
