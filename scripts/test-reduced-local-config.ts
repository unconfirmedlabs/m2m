/** Serialized reduced-local operator boundary. No credentials, chain calls, or
 * live worker are used; serve is checked only for its truthful blocked HTTP. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readDemoHostConfig } from './agent-demo-server.js';
import type { AgentServiceConfig } from './agent-services.js';

const repo = resolve(process.cwd());
const conversation = '55'.repeat(32);
const agents = {
  buyer: { network: [116, 101, 115, 116, 110, 101, 116], package_id: `0x${'11'.repeat(32)}`, domain: `0x${'22'.repeat(32)}`, agent: `0x${'33'.repeat(32)}` },
  provider: { network: [116, 101, 115, 116, 110, 101, 116], package_id: `0x${'11'.repeat(32)}`, domain: `0x${'22'.repeat(32)}`, agent: `0x${'44'.repeat(32)}` },
};
const serviceConfig: AgentServiceConfig = {
  version: 1,
  budget: { max_total_mist: '100000', max_channel_deposit_mist: '100000', max_turn_mist: '40000', max_outstanding_mist: '1024', max_requests: 2, deadline_ms: '4102444800000', output_tranche_bytes: 256 },
  deposit_mist: '100000', price: { input_rate: '0', output_rate: '1', denominator: '1' }, allowed_hosts: ['example.com'],
};
const descriptor = { version: 1, kind: 'responses-tools-v1', model: 'gpt-5.6-luna', reasoning: 'xhigh' } as const;

async function freePort(): Promise<number> {
  const server = http.createServer(); await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address(); assert(address && typeof address !== 'string'); const port = address.port;
  await new Promise<void>(resolveClose => server.close(() => resolveClose())); return port;
}
async function protectedFile(path: string, value = 'aa'.repeat(32)): Promise<void> { await writeFile(path, value, { mode: 0o600 }); }
function configFor(state: string, role: 'coordinator' | 'provider', coordinatorPort: number, providerPort: number) {
  const common = { topology: 'reduced-local-v1', version: 1, role, state_dir: state, conversation, network: 'testnet', config: serviceConfig, runtime: descriptor, agents,
    projection_state_dir: join(state, 'projection'), static_dir: join(repo, 'ui/agent-demo/dist'), bind_host: '127.0.0.1', port: role === 'coordinator' ? coordinatorPort : providerPort,
    provider_base_url: `http://127.0.0.1:${providerPort}`, observer_token_file: join(state, 'observer.token') };
  return role === 'coordinator' ? { ...common, public_origin: `http://127.0.0.1:${coordinatorPort}`, wallet_file: join(state, 'wallet.key'), viewer_token_file: join(state, 'viewer.token'), operator_token_file: join(state, 'operator.token') }
    : { ...common, model_api_key_file: join(state, 'model.key'), search_api_key_file: join(state, 'search.key') };
}
function run(command: string, args: string[]): void {
  const result = spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
}
async function waitHealth(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null);
    if (response) { assert.equal(response.status, 200); assert.deepEqual(await response.json(), { version: 1, status: 'unavailable' }); return; }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
  }
  assert.fail('local blocked serve did not bind');
}
async function serve(entry: string, importTsx: boolean, config: string, port: number): Promise<void> {
  const args = importTsx ? ['--import', 'tsx', entry, 'serve', '--config', config] : [entry, 'serve', '--config', config];
  const child = spawn(process.execPath, args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  const output: Buffer[] = []; child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => output.push(chunk));
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  let healthy = false;
  try {
    await Promise.race([waitHealth(port), exited.then(([code, signal]) => { throw Error(`serve exited code=${code} signal=${signal}: ${Buffer.concat(output).toString('utf8')}`); })]);
    healthy = true;
    assert.equal(Buffer.concat(output).length, 0);
  }
  finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
    const [code, signal] = child.exitCode !== null || child.signalCode !== null ? [child.exitCode, child.signalCode] : await exited; clearTimeout(timeout);
    if (healthy) { assert.equal(signal, null); assert.equal(code, 0); }
  }
}

const root = await mkdtemp(join(tmpdir(), 'm2m-reduced-local-'));
try {
  for (const [entry, importTsx] of [['scripts/reduced-live-demo.ts', true], ['dist/agent-demo/scripts/reduced-live-demo.js', false]] as const) {
    const variantRoot = join(root, importTsx ? 'source' : 'compiled');
    const coordinatorState = join(variantRoot, 'coordinator-state'); const providerState = join(variantRoot, 'provider-state');
    await mkdir(coordinatorState, { recursive: true, mode: 0o700 }); await mkdir(providerState, { recursive: true, mode: 0o700 });
    const coordinatorPort = await freePort(); const providerPort = await freePort();
    const coordinatorConfig = join(variantRoot, 'coordinator.json'); const providerConfig = join(variantRoot, 'provider.json');
    await writeFile(coordinatorConfig, JSON.stringify(configFor(coordinatorState, 'coordinator', coordinatorPort, providerPort)), { mode: 0o600 });
    await writeFile(providerConfig, JSON.stringify(configFor(providerState, 'provider', coordinatorPort, providerPort)), { mode: 0o600 });
    await protectedFile(join(coordinatorState, 'observer.token'), '33'.repeat(32));
    await protectedFile(join(coordinatorState, 'viewer.token'), '11'.repeat(32));
    await protectedFile(join(coordinatorState, 'operator.token'), '22'.repeat(32));
    await protectedFile(join(providerState, 'observer.token'), '44'.repeat(32));
    const coordinator = await readDemoHostConfig(coordinatorConfig); const provider = await readDemoHostConfig(providerConfig);
    assert.equal(coordinator.topology, 'reduced-local-v1'); assert.equal(provider.topology, 'reduced-local-v1');
    assert.equal(coordinator.bind_host, '127.0.0.1'); assert.equal(provider.bind_host, '127.0.0.1'); assert.notEqual(coordinator.state_dir, provider.state_dir);
    assert.equal(coordinator.public_origin, `http://127.0.0.1:${coordinatorPort}`);
    const lowerConfigPath = join(variantRoot, 'coordinator-lower.json');
    const lower = JSON.parse(JSON.stringify(configFor(coordinatorState, 'coordinator', coordinatorPort, providerPort)));
    lower.config.deposit_mist = '50000'; lower.config.budget.max_total_mist = '50000'; lower.config.budget.max_channel_deposit_mist = '50000'; lower.config.budget.max_turn_mist = '20000'; lower.config.budget.max_outstanding_mist = '512'; lower.config.budget.max_requests = 1;
    await writeFile(lowerConfigPath, JSON.stringify(lower), { mode: 0o600 }); assert.equal((await readDemoHostConfig(lowerConfigPath)).config.budget.max_requests, 1);
    const badConfigPath = join(variantRoot, 'coordinator-bad.json'); const bad = JSON.parse(JSON.stringify(lower)); bad.config.price = { input_rate: '1', output_rate: '9', denominator: '10' }; await writeFile(badConfigPath, JSON.stringify(bad), { mode: 0o600 });
    await assert.rejects(readDemoHostConfig(badConfigPath), /invalid_host_config/);
    await run(`${entry} coordinator init`, importTsx ? ['--import', 'tsx', entry, 'init', '--config', coordinatorConfig] : [entry, 'init', '--config', coordinatorConfig]);
    await run(`${entry} provider init`, importTsx ? ['--import', 'tsx', entry, 'init', '--config', providerConfig] : [entry, 'init', '--config', providerConfig]);
    for (const state of [coordinatorState, providerState]) {
      const projection = JSON.parse(await readFile(join(state, 'projection', 'projection.json'), 'utf8')) as { events?: unknown[] };
      assert.deepEqual(projection.events, []);
    }
    await Promise.all([serve(entry, importTsx, coordinatorConfig, coordinatorPort), serve(entry, importTsx, providerConfig, providerPort)]);
  }
  console.log('reduced local serialized/source/compiled init+blocked-serve: ok');
} finally { await rm(root, { recursive: true, force: true }); }
