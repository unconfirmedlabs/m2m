/** Bounded L1 runtime tests. These use only explicit localnet factories. */
import { strict as assert } from 'node:assert';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { openDemoRuntime } from './agent-demo-runtime.js';
import { fixtureWorkerState } from '../tests/agent-demo/fixture-worker-state.js';
import type { DemoBridge, DemoBridgeEvent, DemoLocator, DemoRuntimeTestDependencies, ID } from './demo-types.js';
import type { AgentProfile, AgentWorker } from './agent-service-types.js';
import type { AgentRuntimeDescriptor } from './agent-runtime.js';
import type { AgentRef, Authorization, NativeConfig } from './native-chain.js';
import type { StreamingChain } from './native-streaming-chain.js';

const conversation = '11'.repeat(32) as ID;
const address = (byte: string) => `0x${byte.repeat(64)}`;
const agents = { buyer: { network: [...new TextEncoder().encode('local')], package_id: address('1'), domain: address('2'), agent: address('3') }, provider: { network: [...new TextEncoder().encode('local')], package_id: address('1'), domain: address('2'), agent: address('4') } } satisfies { buyer: AgentRef; provider: AgentRef };
const config = {
  version: 1 as const,
  budget: { max_total_mist: '100000', max_channel_deposit_mist: '10000', max_turn_mist: '10000', max_outstanding_mist: '10000', max_requests: 4, deadline_ms: '4102444800000', output_tranche_bytes: 1024 },
  deposit_mist: '1000', price: { input_rate: '1', output_rate: '2', denominator: '1' }, allowed_hosts: ['example.com'],
};
const descriptor: AgentRuntimeDescriptor = { version: 1, kind: 'responses-tools-v1', model: 'gpt-5.6-luna', reasoning: 'xhigh' };

async function writeKey(path: string, key: Ed25519Keypair): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify({ secretKey: key.getSecretKey() }), { mode: 0o600 });
}
function auth(ref: AgentRef, transport: Ed25519Keypair, economic: Ed25519Keypair): Authorization {
  const readAt = Date.now();
  return { agent: ref, controller: address('a'), transport_key: Array.from(transport.getPublicKey().toRawBytes()), economic_key: Array.from(economic.getPublicKey().toRawBytes()), generation: '0', read_at_ms: String(readAt), valid_until_ms: String(readAt + 30_000) };
}
function worker(): AgentWorker {
  return { run: async () => ({ state: 'completed', agent: agents.buyer.agent, conversationId: conversation, requestId: conversation, commitment: '0'.repeat(64), submittedInputHash: '0'.repeat(64), clientUserMessageId: conversation, knownTurnIds: [], startedAt: 0, deadline: 1, producedUtf8Bytes: 0, items: {}, events: [] }), status: () => ({ state: 'completed' }), reconcile: async () => null, cancel: async () => ({ state: 'cancelled' }), close: () => {}, shutdown: async () => {} } as unknown as AgentWorker;
}
function profile(): AgentProfile {
  return { id: 'fixture', baseInstructions: 'fixture', developerInstructions: 'fixture', tools: [], maxToolCalls: 1, maxToolResultBytes: 1024, recoverableTools: [], handleTool: async () => ({ success: false, text: 'fixture' }) };
}
function webTools() {
  return { profile, sources: () => [], close: () => {} };
}
function fakeChain(buyerAuth: Authorization, providerAuth: Authorization, funding?: { calls: number }): StreamingChain {
  return { validate: async () => ({}), resolve: async (ref: AgentRef) => ref.agent === agents.buyer.agent ? buyerAuth : providerAuth, clock: async () => 1n, fund: async () => { if (funding) funding.calls += 1; throw new Error('unexpected_funding'); } } as unknown as StreamingChain;
}
function configFile(): NativeConfig { return { network: 'localnet', rpc_url: 'http://127.0.0.1:9000', chain_id: 'local', package_id: agents.buyer.package_id, domain: agents.buyer.domain }; }

interface BridgePair { listener?: MemoryBridge; connector?: MemoryBridge }

class MemoryBridge implements DemoBridge {
  remoteKey: number[] = [];
  private queue: DemoBridgeEvent[] = [];
  private waiters: Array<(event: DemoBridgeEvent) => void> = [];
  private closed = false;
  isOpen(): boolean { return !this.closed; }
  constructor(private readonly mode: 'listen' | 'connect', private readonly key: number[], private readonly peerBox: BridgePair) {
    if (mode === 'listen') this.queue.push({ event: 'listening', endpoint: { id: Buffer.from(key).toString('hex'), addrs: [] } });
  }
  private push(event: DemoBridgeEvent): void { const waiter = this.waiters.shift(); if (waiter) waiter(event); else this.queue.push(event); }
  async event(): Promise<DemoBridgeEvent> {
    if (this.queue.length) return this.queue.shift()!;
    if (this.closed) throw new Error('transport_closed');
    return new Promise(resolve => this.waiters.push(resolve));
  }
  async connected(): Promise<void> {
    if (this.mode === 'connect') {
      let listener = this.peerBox.listener;
      while (!listener || !listener.isOpen()) { await new Promise(resolve => setTimeout(resolve, 2)); listener = this.peerBox.listener; }
      this.peerBox.connector = this;
      this.remoteKey = listener.key; listener.remoteKey = this.key; listener.push({ event: 'connected', remote_key: this.key }); this.push({ event: 'connected', remote_key: listener.key });
      return;
    }
    const event = await this.event(); if (event.event !== 'connected') throw new Error('transport_closed'); this.remoteKey = event.remote_key;
  }
  async send(bytes: number[]): Promise<void> {
    const target = this.mode === 'connect' ? this.peerBox.listener : this.peerBox.connector;
    if (!target) throw new Error('transport_closed');
    target.push({ event: 'frame', bytes });
  }
  async receive(): Promise<number[]> { for (;;) { const event = await this.event(); if (event.event === 'frame') return event.bytes; if (event.event === 'error') throw new Error('transport_closed'); } }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const target = this.mode === 'connect' ? this.peerBox.listener : this.peerBox.connector;
    target?.push({ event: 'error', message: 'transport closed' });
    for (const waiter of this.waiters.splice(0)) waiter({ event: 'error', message: 'transport closed' });
  }
}

async function setup(root: string) {
  const buyerTransport = Ed25519Keypair.generate(), buyerEconomic = Ed25519Keypair.generate(), providerTransport = Ed25519Keypair.generate(), providerEconomic = Ed25519Keypair.generate();
  await mkdir(root, { recursive: true, mode: 0o700 }); await writeFile(join(root, 'chain.json'), JSON.stringify(configFile()), { mode: 0o600 });
  await writeKey(join(root, 'local', 'iroh-key.json'), buyerTransport); await writeKey(join(root, 'local', 'economic.json'), buyerEconomic);
  await writeKey(join(root, 'research', 'iroh-key.json'), providerTransport); await writeKey(join(root, 'research', 'economic.json'), providerEconomic);
  const buyerAuth = auth(agents.buyer, buyerTransport, buyerEconomic), providerAuth = auth(agents.provider, providerTransport, providerEconomic), fundTracker = { calls: 0 };
  return { buyerAuth, providerAuth, buyerTransport, buyerEconomic, providerTransport, providerEconomic, fundTracker, chain: fakeChain(buyerAuth, providerAuth, fundTracker) };
}
function deps(chain: StreamingChain, workerFactory: DemoRuntimeTestDependencies['workerFactory'], bridgeFactory?: DemoRuntimeTestDependencies['bridgeFactory']): DemoRuntimeTestDependencies {
  return { workerFactory: async options => fixtureWorkerState(options, await workerFactory(options)), webToolsFactory: async () => webTools(), chainFactory: () => chain, bridgeFactory };
}

async function main(): Promise<void> {
  const root = join(tmpdir(), `m2m-demo-runtime-${randomBytes(8).toString('hex')}`); await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    // F01: the real coordinator profile/factory gate runs before bridge/fund.
    const first = await setup(join(root, 'gate')); let workerCalls = 0;
    const failing = deps(first.chain, async () => { workerCalls++; throw new Error('agent_tool_runtime_unvalidated'); });
    const gate = await openDemoRuntime({ role: 'coordinator', stateDir: join(root, 'gate'), conversation, create: true, config, runtime: descriptor, network: 'localnet', agents, modelApiKeyFile: join(root, 'missing'), dependencies: failing, providerLocator: async () => { throw new Error('must_not_reach_locator'); } });
    const gateResult = await gate.submit({ version: 1, id: 'aa'.repeat(32), command: { op: 'start' } }); assert.equal(gateResult.state, 'failed'); assert.equal(gateResult.code, 'agent_tool_runtime_unvalidated'); assert.equal(workerCalls, 1); assert.equal(first.fundTracker.calls, 0); await gate.shutdown();

    // F02: provider role owns only its own roots and reopens the same journal.
    const provider = await setup(join(root, 'provider')); const providerKeys: string[] = [];
    const listenerBox: BridgePair = {};
    const providerDeps = deps(provider.chain, async options => { providerKeys.push(options.stateDir); return worker(); });
    providerDeps.bridgeFactory = options => { assert.equal(options.mode, 'listen'); assert.match(options.keyFile, /research[\\/]iroh-key\.json$/u); const bridge = new MemoryBridge('listen', Array.from(provider.providerTransport.getPublicKey().toRawBytes()), listenerBox); listenerBox.listener = bridge; return bridge; };
    const p1 = await openDemoRuntime({ role: 'provider', stateDir: join(root, 'provider'), conversation, create: true, config, runtime: descriptor, network: 'localnet', agents, modelApiKeyFile: join(root, 'missing'), dependencies: providerDeps }); assert.match(p1.locator()!.endpoint.id, /^[0-9a-f]{64}$/u); assert.deepEqual(p1.identities().provider.transport_key, Array.from(provider.providerTransport.getPublicKey().toRawBytes())); assert.deepEqual(p1.identities().provider.economic_key, Array.from(provider.providerEconomic.getPublicKey().toRawBytes())); await p1.shutdown();
    const p2 = await openDemoRuntime({ role: 'provider', stateDir: join(root, 'provider'), conversation, create: false, config, runtime: descriptor, network: 'localnet', agents, modelApiKeyFile: join(root, 'missing'), dependencies: providerDeps }); assert.equal(providerKeys.length, 2); await p2.shutdown();

    // F05: actual NativePeer handshake over the explicit memory Iroh seam,
    // then operator disconnect/reconnect with no funding or new channel.
    const connected = await setup(join(root, 'connected')); const pair: BridgePair = {};
    const bridgeFactory = (options: { mode: 'listen' | 'connect'; keyFile: string; ticketFile: string; relay: boolean }): DemoBridge => {
      if (options.mode === 'listen') { const bridge = new MemoryBridge('listen', Array.from(connected.providerTransport.getPublicKey().toRawBytes()), pair); pair.listener = bridge; return bridge; }
      return new MemoryBridge('connect', Array.from(connected.buyerTransport.getPublicKey().toRawBytes()), pair);
    };
    const providerDeps2 = deps(connected.chain, async () => worker(), bridgeFactory);
    const p = await openDemoRuntime({ role: 'provider', stateDir: join(root, 'connected'), conversation, create: true, config, runtime: descriptor, network: 'localnet', agents, modelApiKeyFile: join(root, 'missing'), dependencies: providerDeps2 });
    // The runtime computes the immutable hash; use the locator emitted by the provider.
    const configuration_hash = p.status().configuration_hash;
    const c = await openDemoRuntime({ role: 'coordinator', stateDir: join(root, 'connected'), conversation, create: true, config, runtime: descriptor, network: 'localnet', agents, modelApiKeyFile: join(root, 'missing'), dependencies: deps(connected.chain, async () => worker(), bridgeFactory), providerLocator: async () => ({ ...p.locator()!, configuration_hash }) });
    const started = await c.submit({ version: 1, id: 'bb'.repeat(32), command: { op: 'start' } }); assert.equal(started.state, 'completed');
    assert.deepEqual(await c.submit({ version: 1, id: 'bb'.repeat(32), command: { op: 'start' } }), started);
    await assert.rejects(() => c.submit({ version: 1, id: 'bb'.repeat(32), command: { op: 'spending', paused: true } }), /control_conflict/);
    const paused = await c.submit({ version: 1, id: 'ee'.repeat(32), command: { op: 'spending', paused: true } }); assert.equal(paused.state, 'completed'); assert.equal(c.status().spending_paused, true); assert.equal(c.publication().state, 'ready');
    // F06/F07 bounded safety seam: a connected runtime cannot spend or
    // fabricate terminal settlement without an explicit wallet/channel.
    const funding = await c.submit({ version: 1, id: '1212'.repeat(16), command: { op: 'fund', configuration_hash, previous_channel: null } }); assert.equal(funding.state, 'uncertain'); assert.equal(funding.code, 'funding_uncertain'); assert.equal(connected.fundTracker.calls, 0);
    const closeWithoutChannel = await c.submit({ version: 1, id: '1313'.repeat(16), command: { op: 'close', channel: address('5') } }); assert.equal(closeWithoutChannel.state, 'failed'); assert.equal(closeWithoutChannel.code, 'channel_mismatch');
    const refundWithoutChannel = await c.submit({ version: 1, id: '1414'.repeat(16), command: { op: 'refund', channel: address('5') } }); assert.equal(refundWithoutChannel.state, 'failed'); assert.equal(refundWithoutChannel.code, 'channel_mismatch');
    const disconnected = await c.submit({ version: 1, id: 'cc'.repeat(32), command: { op: 'disconnect' } }); assert.equal(disconnected.state, 'completed'); const reconnected = await c.submit({ version: 1, id: 'dd'.repeat(32), command: { op: 'reconnect' } }); assert.equal(reconnected.state, 'completed'); assert.equal(c.economy().length, 0); await c.shutdown();
    const c2 = await openDemoRuntime({ role: 'coordinator', stateDir: join(root, 'connected'), conversation, create: false, config, runtime: descriptor, network: 'localnet', agents, modelApiKeyFile: join(root, 'missing'), dependencies: deps(connected.chain, async () => worker(), bridgeFactory), providerLocator: async () => ({ ...p.locator()!, configuration_hash }) });
    assert.deepEqual(c2.control('bb'.repeat(32)), started); assert.equal(c2.status().spending_paused, true); const c2reconnect = await c2.submit({ version: 1, id: 'ff'.repeat(32), command: { op: 'reconnect' } }); assert.equal(c2reconnect.state, 'completed'); await c2.shutdown(); await p.shutdown();
    console.log('PASS demo runtime: F01 gate-before-funding, F02 role-root/restart identity, F05 unpaid Iroh reconnect, durable control replay/pause; F06/F07 chain settlement not covered');
  } finally { await rm(root, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
