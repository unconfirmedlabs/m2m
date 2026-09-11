/** Root boot regressions: real native-bridge/native handshake, separate role
 * roots, fixture-only chain/worker. No Sui/model/search/Fly calls or funding.
 * Chain funding below is an explicit stub, never Sui settlement evidence.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { openDemoRuntime } from './agent-demo-runtime.js';
import { fixtureWorkerState } from '../tests/agent-demo/fixture-worker-state.js';
import { IrohBridge } from './native-peer.js';
import { save, type AgentRef, type Authorization, type NativeConfig } from './native-chain.js';
import type { AgentProfile, AgentWorker } from './agent-service-types.js';
import type { DemoRuntimeHandle, DemoRuntimeTestDependencies } from './demo-types.js';
import type { StreamingChain } from './native-streaming-chain.js';
import type { ChannelData, OfferData, PolicyData, SignedData } from './streaming-codec.js';

const selected = process.argv[2];
const cases = ['ticket', 'fresh-reopen', 'lost-budget', 'lost-coordinator', 'lost-worker', 'lost-worker-marker', 'lost-registry', 'prefunding-restart'] as const;
type Case = typeof cases[number];
if (process.argv.length > 3 || (selected && !cases.includes(selected as Case))) throw Error('invalid_boot_test_case');
const binary = resolve(process.env.M2M_NATIVE_BRIDGE ?? 'target/release/native-bridge');
await access(binary);
const address = (byte: string) => '0x' + byte.repeat(32);
const native: NativeConfig = { network: 'localnet', rpc_url: 'http://127.0.0.1:9000', chain_id: 'local', package_id: address('01'), domain: address('02') };
const reference = (byte: string): AgentRef => ({ network: [...new TextEncoder().encode('local')], package_id: native.package_id, domain: native.domain, agent: address(byte) });
const agents = { buyer: reference('03'), provider: reference('04') };
const runtime = { version: 1 as const, kind: 'responses-tools-v1' as const, model: 'gpt-5.6-luna' as const, reasoning: 'xhigh' as const };
const config = { version: 1 as const, deposit_mist: '1000', price: { input_rate: '1', output_rate: '2', denominator: '1' }, allowed_hosts: ['example.com'],
  budget: { max_total_mist: '100000', max_channel_deposit_mist: '10000', max_turn_mist: '10000', max_outstanding_mist: '10000', max_requests: 4, deadline_ms: '4102444800000', output_tranche_bytes: 1024 } };
const profile: AgentProfile = { id: 'boot-test-web', baseInstructions: 'TEST ONLY', developerInstructions: 'No inference may run', tools: [], maxToolCalls: 1, maxToolResultBytes: 1024, recoverableTools: [], handleTool: async () => { throw Error('unexpected_tool'); } };
const inertWorker = (effects: { inference: number }): AgentWorker => ({ run: async () => { effects.inference++; throw Error('unexpected_inference'); }, status: () => undefined,
  reconcile: async () => undefined, cancel: async () => { throw Error('unexpected_cancel'); }, close: () => {}, shutdown: async () => {} });

async function check(name: Case) {
  const root = await mkdtemp(join(tmpdir(), 'm2m-boot-contract-'));
  const cRoot = join(root, 'coordinator'), pRoot = join(root, 'provider');
  const keys = { buyer: { transport: Ed25519Keypair.generate(), economic: Ed25519Keypair.generate() }, provider: { transport: Ed25519Keypair.generate(), economic: Ed25519Keypair.generate() } };
  const authorization = (role: 'buyer' | 'provider'): Authorization => {
    const now = Date.now(); return { agent: agents[role], controller: address('05'), generation: '1', read_at_ms: String(now), valid_until_ms: String(now + 30_000), transport_key: [...keys[role].transport.getPublicKey().toRawBytes()], economic_key: [...keys[role].economic.getPublicKey().toRawBytes()] };
  };
  const effects = { funding: 0, workerOpens: 0, inference: 0, connect: 0, ticketPresent: false };
  let fundedChannel: ChannelData | undefined;
  const chain = { validate: async () => ({}), clock: async () => BigInt(Date.now()), resolve: async (ref: AgentRef) => authorization(ref.agent === agents.buyer.agent ? 'buyer' : 'provider'),
    channel: async (id: string) => { assert.equal(id, fundedChannel?.id); return structuredClone(fundedChannel); },
    fund: async (offer: SignedData<OfferData>, policy: PolicyData) => {
      effects.funding++; assert.equal(name, 'prefunding-restart'); assert.equal(fundedChannel, undefined, 'no duplicate funding');
      fundedChannel = { id: address('08'), offer: offer.payload, policy, funds: offer.payload.deposit, redeemed_amount: '0', redeemed_sequence: '0', redeemed_units: ['0', '0'], status: 0, terminal_tx: [], close_hash: [] };
      return fundedChannel.id;
    } } as unknown as StreamingChain;
  const bridges: IrohBridge[] = [];
  let provider: DemoRuntimeHandle | undefined, coordinator: DemoRuntimeHandle | undefined;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; for (const bridge of bridges) bridge.close(); }, 15_000);
  try {
    for (const [state, dir, role] of [[cRoot, 'local', 'buyer'], [pRoot, 'research', 'provider']] as const) {
      await mkdir(join(state, dir), { recursive: true, mode: 0o700 });
      await save(join(state, 'chain.json'), native);
      await save(join(state, dir, 'iroh-key.json'), { secret_key: [...decodeSuiPrivateKey(keys[role].transport.getSecretKey()).secretKey] });
      await save(join(state, dir, 'economic.json'), { secret_key: keys[role].economic.getSecretKey() });
    }
    // Do not provide either role with its counterpart's private directory.
    await assert.rejects(access(join(cRoot, 'research'))); await assert.rejects(access(join(pRoot, 'local')));
    const dependencies: DemoRuntimeTestDependencies = {
      chainFactory: () => chain,
      workerFactory: async options => { effects.workerOpens++; return fixtureWorkerState(options, inertWorker(effects)); },
      webToolsFactory: async () => ({ profile: () => ({ ...profile }), sources: () => [], close: () => {} }),
      bridgeFactory: options => {
        if (options.mode === 'connect') effects.connect++;
        // Real local bridge; relay discovery intentionally disabled in this
        // explicit harness. This is not cross-region/relay acceptance.
        const bridge = new IrohBridge([options.mode, '--key-file', options.keyFile, '--ticket', options.ticketFile], binary);
        bridges.push(bridge); return bridge;
      },
    };
    const common = { conversation: '06'.repeat(32), config, runtime, network: 'localnet' as const, agents, modelApiKeyFile: join(root, 'no-api-key'), dependencies };
    provider = await openDemoRuntime({ ...common, role: 'provider', stateDir: pRoot, create: true });
    const locator = provider.locator(); assert(locator);
    assert.equal(locator.endpoint.id, Buffer.from(keys.provider.transport.getPublicKey().toRawBytes()).toString('hex'));
    let offeredLocator = structuredClone(locator);
    const coordinatorOptions = { ...common, role: 'coordinator' as const, stateDir: cRoot, providerLocator: async () => offeredLocator,
      ...(name === 'prefunding-restart' ? { walletFile: join(cRoot, 'local', 'economic.json') } : {}) };
    coordinator = await openDemoRuntime({ ...coordinatorOptions, create: true });
    if (name === 'fresh-reopen' || name === 'prefunding-restart') { await coordinator.shutdown(); coordinator = undefined; coordinator = await openDemoRuntime({ ...coordinatorOptions, create: false }); }
    if (name === 'ticket') {
      const invalidLocators = [
        { ...locator, provider: { ...locator.provider, domain: address('09') } },
        { ...locator, configuration_hash: '09'.repeat(32) },
        { ...locator, endpoint: { ...locator.endpoint, id: Buffer.from(keys.buyer.transport.getPublicKey().toRawBytes()).toString('hex') } },
      ];
      for (const [index, invalid] of invalidLocators.entries()) {
        offeredLocator = invalid;
        const rejected = await coordinator.submit({ version: 1, id: String(index + 10).repeat(32), command: { op: 'start' } });
        assert.equal(rejected.state, 'failed');
        assert.equal(rejected.code, index === 2 ? 'runtime_error' : 'connection_failed');
        assert.equal(effects.connect, 0);
        await assert.rejects(access(join(cRoot, 'agent-services', common.conversation, 'ticket.json')));
      }
      offeredLocator = structuredClone(locator);
    }
    const result = await coordinator.submit({ version: 1, id: '07'.repeat(32), command: { op: 'start' } });
    const saved = await readFile(join(cRoot, 'agent-services', common.conversation, 'ticket.json'), 'utf8').catch(() => null);
    effects.ticketPresent = saved !== null;
    console.log(JSON.stringify({ case: name, control: result.state, code: result.code, ...effects, timedOut, chain: 'fixture', worker: 'fixture', transport: 'real-local-native-bridge', separate_role_roots: true }));
    assert.equal(timedOut, false); assert.equal(effects.funding, 0); assert.equal(effects.inference, 0);
    assert.equal(result.state, 'completed', `${name}: first unpaid connection must complete`);
    assert(saved); assert.deepEqual(JSON.parse(saved), locator.endpoint);
    const runtimeRoot = join(cRoot, 'agent-services', common.conversation, 'coordinator');
    if (name.startsWith('lost-')) {
      await coordinator.shutdown(); coordinator = undefined;
      const missing = ({ 'lost-budget': 'budget/budget.json', 'lost-coordinator': 'coordinator/coordinator.json',
        'lost-worker': 'worker/responses-worker.json', 'lost-worker-marker': 'worker/responses-worker.initialized', 'lost-registry': 'components.json' } as Record<string, string>)[name]!;
      const path = join(runtimeRoot, missing), original = JSON.parse(await readFile(path, 'utf8'));
      await rm(path);
      const before = { ...effects };
      await assert.rejects(openDemoRuntime({ ...coordinatorOptions, create: false }), /journal_missing/);
      assert.deepEqual(effects, before, 'missing component must reject before worker/connect/funding');
      await assert.rejects(access(path));
      // Restore the exact test artifact to verify failed reopen released locks.
      await save(path, original);
      coordinator = await openDemoRuntime({ ...coordinatorOptions, create: false });
      assert.deepEqual(coordinator.control('07'.repeat(32)), result);
      console.log(JSON.stringify({ case: name, rejected_before_effects: true, restored_same_control: true }));
    }
    if (name === 'prefunding-restart') {
      const funded = await coordinator.submit({ version: 1, id: '20'.repeat(32), command: { op: 'fund', configuration_hash: locator.configuration_hash, previous_channel: null } });
      assert.equal(funded.state, 'completed', JSON.stringify(funded));
      assert.equal(effects.funding, 1); assert.equal(effects.inference, 0);
      const registry = JSON.parse(await readFile(join(runtimeRoot, 'components.json'), 'utf8'));
      for (const component of ['exchange', `stream:${fundedChannel!.id}`, `client:${fundedChannel!.id}`]) assert.equal(registry.entries[component].state, 'ready');
      const before = coordinator.economy();
      await coordinator.shutdown(); coordinator = undefined;
      // Model the crash after a client constructor returned its durable state,
      // but before the supervisor published its ready marker.
      registry.entries[`client:${fundedChannel!.id}`].state = 'initializing';
      await save(join(runtimeRoot, 'components.json'), registry);
      coordinator = await openDemoRuntime({ ...coordinatorOptions, create: false });
      assert.equal(coordinator.selectedChannel(), fundedChannel!.id);
      assert.deepEqual(coordinator.control('20'.repeat(32)), funded);
      assert.deepEqual(coordinator.economy()[0]!.budget, before[0]!.budget);
      assert.equal(effects.funding, 1); assert.equal(effects.inference, 0);
      // Restart both retained role roots explicitly. Automatic QUIC peer-loss
      // detection timing is a separate lifecycle gate, not this init test.
      await provider.shutdown(); provider = undefined;
      provider = await openDemoRuntime({ ...common, role: 'provider', stateDir: pRoot, create: false });
      offeredLocator = provider.locator()!;
      const reconnected = await coordinator.submit({ version: 1, id: '21'.repeat(32), command: { op: 'start' } });
      assert.equal(reconnected.state, 'completed', JSON.stringify(reconnected));
      const reopenedRegistry = JSON.parse(await readFile(join(runtimeRoot, 'components.json'), 'utf8'));
      assert.equal(reopenedRegistry.entries[`client:${fundedChannel!.id}`].state, 'ready', 'funded reconnect must reopen its client');
      assert.equal(effects.funding, 1); assert.equal(effects.inference, 0);
      await coordinator.shutdown(); coordinator = undefined;
      for (const missing of ['outbox.json', `channels/${fundedChannel!.id.slice(2)}/stream.json`, `channels/${fundedChannel!.id.slice(2)}/client/client.json`]) {
        const path = join(runtimeRoot, missing), original = JSON.parse(await readFile(path, 'utf8'));
        await rm(path);
        const beforeLoss = { ...effects };
        await assert.rejects(openDemoRuntime({ ...coordinatorOptions, create: false }), /journal_missing/);
        assert.deepEqual(effects, beforeLoss);
        await assert.rejects(access(path));
        await save(path, original);
      }
      console.log(JSON.stringify({ case: name, first_fund_after_restart: 'completed', same_channel_and_budget: true, funding_callbacks: 1, chain: 'fixture' }));
    }
  } finally {
    clearTimeout(timer);
    for (const bridge of bridges) bridge.close();
    await coordinator?.shutdown(); await provider?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}
let failed = 0;
for (const name of selected ? [selected as Case] : cases) {
  try { await check(name); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : 'boot_failed'}`); }
}
assert.equal(failed, 0, 'L1 boot contract remains incomplete');
