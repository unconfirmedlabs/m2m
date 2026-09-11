/**
 * Embeddable L1 demo lifecycle.
 *
 * This module is deliberately a supervisor around the existing service
 * engines.  It does not contain a second payment or model implementation:
 * StreamingChain/StreamingEngine, AgentServiceClient and AgentCoordinator
 * remain the authorities for those operations.
 */
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { toBase58 } from '@mysten/sui/utils';
import { AgentCoordinator, BudgetLedger } from './agent-coordinator.js';
import { AgentEvents, type AgentPublicEvent } from './agent-events.js';
import { DemoComponents } from './agent-demo-components.js';
import { AgentServiceClient } from './agent-service-client.js';
import { AgentServiceHost } from './agent-service-host.js';
import { DurableAgentExchange } from './agent-service-exchange.js';
import { BoundedWebTools, BraveSearchBackend } from './agent-web.js';
import { NativeLock } from './native-lock.js';
import { authority, IrohBridge, NativeInbox, NativePeer } from './native-peer.js';
import { readKey, readOptional, save, type Authorization, type NativeConfig } from './native-chain.js';
import { StreamingChain } from './native-streaming-chain.js';
import { StreamingEngine, type StreamingBinding } from './streaming-engine.js';
import { agentRuntimeFingerprint, openAgentWorker, responsesLimits, type AgentRuntimeDescriptor, type ResponsesLimits } from './agent-runtime.js';
import type { AgentProfile, AgentWorker, EventSink, PinnedAgents, ResearchPort } from './agent-service-types.js';
import { equal, exactKeys, hash, makePolicy, price, validateSigned, type CheckpointData, type CreditData, type OfferData, type PolicyData, type SignedData } from './streaming-codec.js';
import { canonicalDemoJson, validateDemoControl, validateDemoControlRecord } from './agent-demo-event-contract.js';
import type {
  Address, DemoBridge, DemoBridgeEvent, DemoCommand, DemoConnection, DemoControl, DemoControlRecord,
  DemoEconomy, DemoEvidence, DemoHostClock, DemoIdentity, DemoLocator, DemoPublication, DemoRoleStatus,
  DemoRuntimeHandle, ID, SourceCursor, SourceEventPage, U64, MachineRole, DemoRuntimeTestDependencies,
} from './demo-types.js';

const FEATURES = { required: ['payment.sui.streaming.v1', 'service.research.conversation.v2'], optional: [] };
const ID_RE = /^[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-f]{64}$/;
const PUBLIC_CODES = new Set([
  'already_initialized', 'backend_unavailable', 'budget_policy_conflict', 'budget_uncertain', 'channel_mismatch', 'channel_not_open', 'channel_open',
  'channel_not_bound', 'conversation_busy', 'coordinator_closed', 'credit_not_monotonic', 'deadline_expired', 'deposit_exceeded', 'funding_conflict',
  'funding_limit', 'invalid_agent', 'invalid_config', 'invalid_control', 'invalid_request', 'journal_corrupt', 'journal_missing', 'journal_limit',
  'limit_exceeded', 'network_mismatch', 'provider_unavailable', 'provider_start_failed', 'connection_failed', 'transport_closed', 'search_unconfigured',
  'spending_paused', 'uncertain_execution', 'funding_uncertain', 'settlement_uncertain', 'uncredited_channel_requires_expiry_refund', 'control_conflict',
  'configuration_mismatch', 'controller_wallet_required', 'journal_missing', 'storage_failure', 'worker_shutdown_uncertain', 'agent_tool_runtime_unvalidated', 'runtime_error',
]);
const safeCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : '';
  if (message === 'locator_mismatch' || message === 'free_messaging_failed') return 'connection_failed';
  if (message === 'unacceptable_offer') return 'funding_uncertain';
  if (message === 'controller_wallet_required') return 'funding_uncertain';
  if (message === 'missing_chain_config' || message === 'test_dependencies_network') return 'backend_unavailable';
  return PUBLIC_CODES.has(message) ? message : 'runtime_error';
};
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = <T>(v: T): T => structuredClone(v);
const nowClock: DemoHostClock = {
  nowMs: () => Date.now(),
  sleep: (milliseconds, signal) => new Promise<void>((resolvePromise, reject) => {
    if (signal.aborted) { reject(new Error('aborted')); return; }
    const timer = setTimeout(() => done(), milliseconds);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('aborted')); };
    const done = () => { signal.removeEventListener('abort', abort); resolvePromise(); };
    signal.addEventListener('abort', abort, { once: true });
  }),
};

interface RuntimeManifest {
  version: 1; role: MachineRole; conversation: ID; agents: PinnedAgents;
  config: AgentServiceConfigLike; configuration_hash: ID; initialized: true;
}
interface AgentServiceConfigLike {
  version: 1; budget: { max_total_mist: string; max_channel_deposit_mist: string; max_turn_mist: string; max_outstanding_mist: string; max_requests: number; deadline_ms: string; output_tranche_bytes: number };
  deposit_mist: string; price: { input_rate: string; output_rate: string; denominator: string }; allowed_hosts: string[];
}
interface RuntimeJournal {
  version: 1; role: MachineRole; conversation: ID; desired: 'online' | 'offline'; generation: string;
  spending_paused: boolean; controls: DemoControlRecord[]; selected_channel: Address | null; locator: DemoLocator | null;
}

/* AgentServiceConfig is exported from agent-services.  Keep this local shape
 * only to make the journal validator independent of that CLI module. */
import type { AgentServiceConfig } from './agent-services.js';

function configurationHash(config: AgentServiceConfig, agents: PinnedAgents): ID {
  return createHash('sha256').update(canonicalDemoJson({ config, agents }), 'utf8').digest('hex');
}
function emptyCursor(): SourceCursor { return { coordinator: '0', research: '0', host: '0' }; }
function cursorFor(events: AgentPublicEvent[]): SourceCursor {
  const cursor = emptyCursor();
  for (const event of events) cursor[event.role] = event.id as U64;
  return cursor;
}
function validAgentRef(ref: unknown): ref is PinnedAgents['buyer'] {
  return isRecord(ref) && Array.isArray(ref.network) && ref.network.length > 0 && ref.network.length <= 64 &&
    ref.network.every(v => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 255) &&
    typeof ref.package_id === 'string' && ADDRESS_RE.test(ref.package_id) && typeof ref.domain === 'string' && ADDRESS_RE.test(ref.domain) &&
    typeof ref.agent === 'string' && ADDRESS_RE.test(ref.agent);
}
function validateConfig(config: AgentServiceConfig): PolicyData {
  exactKeys(config, ['version', 'budget', 'deposit_mist', 'price', 'allowed_hosts']);
  exactKeys(config.price, ['input_rate', 'output_rate', 'denominator']);
  if (config.version !== 1 || !Array.isArray(config.allowed_hosts) || config.allowed_hosts.length < 1 || config.allowed_hosts.length > 32 ||
      config.allowed_hosts.some(host => typeof host !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes('..'))) throw new Error('invalid_config');
  for (const value of [config.deposit_mist, config.price.input_rate, config.price.output_rate, config.price.denominator,
    config.budget.max_total_mist, config.budget.max_channel_deposit_mist, config.budget.max_turn_mist,
    config.budget.max_outstanding_mist, config.budget.deadline_ms]) {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('invalid_config');
  }
  if (config.deposit_mist === '0' || config.price.denominator === '0') throw new Error('invalid_config');
  return makePolicy(['input_utf8_bytes', 'output_utf8_bytes'], [config.price.input_rate, config.price.output_rate], config.price.denominator);
}
function readSafeManifest(value: unknown, expected: Omit<RuntimeManifest, 'initialized'>): RuntimeManifest {
  if (!isRecord(value)) throw new Error('journal_corrupt');
  exactKeys(value, ['version', 'role', 'conversation', 'agents', 'config', 'configuration_hash', 'initialized']);
  if (value.version !== 1 || value.initialized !== true || value.role !== expected.role || value.conversation !== expected.conversation ||
      canonicalDemoJson(value.agents) !== canonicalDemoJson(expected.agents) || canonicalDemoJson(value.config) !== canonicalDemoJson(expected.config) ||
      value.configuration_hash !== expected.configuration_hash) throw new Error('journal_corrupt');
  return value as unknown as RuntimeManifest;
}
function readSafeJournal(value: unknown, expected: Omit<RuntimeJournal, 'controls' | 'generation' | 'desired' | 'spending_paused' | 'selected_channel' | 'locator'>): RuntimeJournal {
  if (!isRecord(value)) throw new Error('journal_corrupt');
  exactKeys(value, ['version', 'role', 'conversation', 'desired', 'generation', 'spending_paused', 'controls', 'selected_channel', 'locator']);
  if (value.version !== 1 || value.role !== expected.role || value.conversation !== expected.conversation ||
      !['online', 'offline'].includes(value.desired as string) || typeof value.generation !== 'string' || !/^\d+$/.test(value.generation) ||
      typeof value.spending_paused !== 'boolean' || !Array.isArray(value.controls) || value.controls.length > 512 ||
      (value.selected_channel !== null && (typeof value.selected_channel !== 'string' || !ADDRESS_RE.test(value.selected_channel)))) throw new Error('journal_corrupt');
  return value as unknown as RuntimeJournal;
}
function transaction(value: unknown): DemoEconomy['opening'] {
  if (!isRecord(value)) return { state: 'unknown', digest: null, gas: null };
  const state = value.state;
  if (state === 'confirmed' && typeof value.digest === 'string') return { state: 'confirmed', digest: value.digest, gas: isRecord(value.gas) ? {
    computation_cost: String(value.gas.computationCost ?? value.gas.computation_cost ?? '0'),
    storage_cost: String(value.gas.storageCost ?? value.gas.storage_cost ?? '0'),
    storage_rebate: String(value.gas.storageRebate ?? value.gas.storage_rebate ?? '0'),
    non_refundable_storage_fee: String(value.gas.nonRefundableStorageFee ?? value.gas.non_refundable_storage_fee ?? '0'),
  } : null };
  if (state === 'failed') return { state: 'failed', digest: null, gas: null };
  if (state === 'submitted' || state === 'pending') return { state: 'pending', digest: typeof value.digest === 'string' ? value.digest : null, gas: null };
  return { state: 'unknown', digest: null, gas: null };
}
function latestEngine(engine: StreamingEngine | undefined): { credit: SignedData<CreditData> | null; checkpoint: SignedData<CheckpointData> | null; units: [string, string] } {
  if (!engine) return { credit: null, checkpoint: null, units: ['0', '0'] };
  const records = engine.replay(); const last = records.at(-1); const delivery = records.flatMap(record => record.deliveries).at(-1);
  return { credit: last?.credit ?? null, checkpoint: delivery?.checkpoint ?? null, units: (delivery?.checkpoint.payload.units ?? ['0', '0']) as [string, string] };
}

export async function openDemoRuntime(options: {
  role: MachineRole; stateDir: string; conversation: ID; create: boolean; config: AgentServiceConfig;
  runtime: AgentRuntimeDescriptor; network: 'testnet' | 'localnet'; agents: { buyer: PinnedAgents['buyer']; provider: PinnedAgents['provider'] };
  walletFile?: string; modelApiKeyFile: string; searchApiKeyFile?: string; providerLocator?: () => Promise<DemoLocator>;
  dependencies?: DemoRuntimeTestDependencies;
}): Promise<DemoRuntimeHandle> {
  if (!options || !ID_RE.test(options.conversation) || !options.stateDir || !options.modelApiKeyFile ||
      (options.network !== 'localnet' && options.network !== 'testnet') || !validAgentRef(options.agents.buyer) || !validAgentRef(options.agents.provider)) throw new Error('invalid_runtime_config');
  const policy = validateConfig(options.config);
  const configHash = configurationHash(options.config, options.agents);
  const state = resolve(options.stateDir);
  const root = join(state, 'agent-services', options.conversation, options.role);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = await NativeLock.acquire(join(root, 'runtime.lock'));
  let events: AgentEvents | undefined;
  let worker: AgentWorker | undefined;
  let web: Pick<BoundedWebTools, 'profile' | 'sources' | 'close'> | undefined;
  let chain: StreamingChain | undefined;
  let bridge: DemoBridge | undefined;
  let peer: NativePeer | undefined;
  let inbox: NativeInbox | undefined;
  let host: AgentServiceHost | undefined;
  let budget: BudgetLedger | undefined;
  let exchange: DurableAgentExchange | undefined;
  let engine: StreamingEngine | undefined;
  let client: AgentServiceClient | undefined;
  let coordinator: AgentCoordinator | undefined;
  let coordinatorProfile: AgentProfile | undefined;
  let roleProfile: AgentProfile | undefined;
  let coordinatorWorker: AgentWorker | undefined;
  let researchPort: ResearchPort | undefined;
  let locator: DemoLocator | null = null;
  let providerAuthority: Authorization | undefined;
  let localAuthority: Authorization | undefined;
  let observedChannel: Awaited<ReturnType<StreamingChain['channel']>> | undefined;
  let openingTransaction: DemoEconomy['opening'] = { state: 'unknown', digest: null, gas: null };
  let terminalTransaction: DemoEconomy['opening'] | null = null;
  let stop = false;
  let providerLoop: Promise<void> | undefined;
  const providerAbort = new AbortController();
  let queue: Promise<unknown> = Promise.resolve();
  let journalWrites: Promise<unknown> = Promise.resolve();
  let publicationState: DemoPublication = { version: 1, state: 'ready', cursor: emptyCursor(), code: null };

  const manifestPath = join(root, 'manifest.json');
  const markerPath = join(root, 'initialized.json');
  const existingManifest = await readOptional<unknown>(manifestPath);
  const manifestExpected = { version: 1 as const, role: options.role, conversation: options.conversation, agents: options.agents, config: options.config, configuration_hash: configHash };
  if (existingManifest) {
    if (options.create) { await lock.close(); throw new Error('already_initialized'); }
    readSafeManifest(existingManifest, manifestExpected);
    if (!await readOptional(markerPath)) { await lock.close(); throw new Error('journal_missing'); }
  } else {
    if (!options.create) { await lock.close(); throw new Error('journal_missing'); }
    await save(manifestPath, { ...manifestExpected, initialized: true });
    await save(markerPath, { version: 1 });
  }
  const journalPath = join(root, 'runtime.json');
  const existingJournal = await readOptional<unknown>(journalPath);
  let journal: RuntimeJournal;
  if (existingJournal) {
    journal = readSafeJournal(existingJournal, { version: 1, role: options.role, conversation: options.conversation });
    for (const record of journal.controls) {
      try { validateDemoControlRecord(record, { conversation: options.conversation, configuration_hash: configHash, config: options.config, agents: options.agents }); } catch { await lock.close(); throw new Error('journal_corrupt'); }
    }
  } else {
    if (!options.create) { await lock.close(); throw new Error('journal_missing'); }
    journal = { version: 1, role: options.role, conversation: options.conversation, desired: 'offline', generation: '0', spending_paused: false, controls: [], selected_channel: null, locator: null };
    await save(journalPath, journal);
  }
  const clock = options.dependencies?.clock ?? nowClock;
  const pollMs = options.dependencies?.pollMs ?? 750;
  if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 5000 || (options.dependencies?.clock && !Number.isSafeInteger(clock.nowMs()))) { await lock.close(); throw new Error('invalid_runtime_config'); }
  const eventsPath = join(root, 'events.json');
  events = await AgentEvents.open(eventsPath, options.conversation, () => {}, !options.create);
  const components = await DemoComponents.open(root, options.create, {
    role: options.role, conversation: options.conversation, configuration_hash: configHash, test_dependencies_used: !!options.dependencies,
  }).catch(async error => { await events?.close(); await lock.close(); throw error; });
  publicationReady();
  const emit: EventSink = async input => { if (input.conversation !== options.conversation) throw new Error('event_conversation_mismatch'); await events!.append(input.role, input.type, input.data, input.request); };
  const roleRoot = join(state, options.role === 'coordinator' ? 'local' : 'research');
  const transportKeyFile = join(roleRoot, 'iroh-key.json');
  const economicKeyFile = join(roleRoot, 'economic.json');
  const ticketFile = join(state, 'agent-services', options.conversation, 'ticket.json');
  const deferredPort: ResearchPort = {
    execute: input => researchPort ? researchPort.execute(input) : Promise.reject(new Error('channel_not_open')),
    cancel: requestId => researchPort ? researchPort.cancel(requestId) : Promise.reject(new Error('channel_not_open')),
  };

  try {
    const chainConfig = await readOptional<NativeConfig>(join(state, 'chain.json'));
    if (!chainConfig) throw new Error('missing_chain_config');
    if (chainConfig.network !== options.network) throw new Error('network_mismatch');
    if (options.dependencies) {
      if (options.network !== 'localnet') throw new Error('test_dependencies_network');
      const rpc = new URL(chainConfig.rpc_url);
      if (![ '127.0.0.1', 'localhost', '[::1]' ].includes(rpc.hostname)) throw new Error('test_dependencies_network');
    }
    chain = options.dependencies?.chainFactory?.(chainConfig) ?? new StreamingChain(chainConfig);
    await chain.validate();
    const [buyerAuth, researchAuth] = await Promise.all([chain.resolve(options.agents.buyer), chain.resolve(options.agents.provider)]);
    localAuthority = buyerAuth; providerAuthority = researchAuth;
    if (equal(buyerAuth.transport_key, buyerAuth.economic_key) || equal(researchAuth.transport_key, researchAuth.economic_key)) throw new Error('identity_changed');
    if (options.role === 'provider') {
      const limits = responsesLimits('provider');
      if (options.dependencies) {
        if (!options.dependencies.webToolsFactory || !options.dependencies.workerFactory) throw new Error('test_dependencies_required');
        web = await options.dependencies.webToolsFactory({ stateDir: join(root, 'web'), create: options.create, allowedHosts: options.config.allowed_hosts });
        if (!web || typeof web.profile !== 'function' || typeof web.sources !== 'function' || typeof web.close !== 'function') throw new Error('invalid_test_dependency');
        const profile = web.profile(); roleProfile = profile;
        const original = profile.handleTool;
        profile.handleTool = async call => {
          await emit({ role: 'research', conversation: options.conversation, request: call.request.requestId, type: 'tool_started', data: { name: call.name, call_id: call.callId, arguments: call.arguments as Record<string, unknown> } });
          const result = await original(call);
          await emit({ role: 'research', conversation: options.conversation, request: call.request.requestId, type: 'tool_result', data: { name: call.name, call_id: call.callId, success: result.success, result_bytes: Buffer.byteLength(result.text) } });
          return result;
        };
        await components.openComponent('worker', async create => worker = await options.dependencies!.workerFactory!({ role: options.role, descriptor: options.runtime, stateDir: join(root, 'worker'), create, profile, limits }));
      } else {
        if (!options.searchApiKeyFile) throw new Error('search_unconfigured');
        const search = await readSecret(options.searchApiKeyFile, 'search');
        web = await BoundedWebTools.open({ stateDir: join(root, 'web'), searchBackend: new BraveSearchBackend({ apiKey: search }), allowedHosts: options.config.allowed_hosts });
        const profile = web.profile(); roleProfile = profile;
        const original = profile.handleTool;
        profile.handleTool = async call => {
          await emit({ role: 'research', conversation: options.conversation, request: call.request.requestId, type: 'tool_started', data: { name: call.name, call_id: call.callId, arguments: call.arguments as Record<string, unknown> } });
          const result = await original(call);
          await emit({ role: 'research', conversation: options.conversation, request: call.request.requestId, type: 'tool_result', data: { name: call.name, call_id: call.callId, success: result.success, result_bytes: Buffer.byteLength(result.text) } });
          return result;
        };
        await components.openComponent('worker', async create => worker = await openAgentWorker({ descriptor: options.runtime, stateDir: join(root, 'worker'), create, profile, apiKeyFile: options.modelApiKeyFile, limits }));
      }
      host = await AgentServiceHost.open({ stateDir: root, create: options.create, conversation: options.conversation,
        agents: options.agents, policy, deposit: options.config.deposit_mist, chain, signer: await readKey(economicKeyFile), worker: worker!, sources: web.sources });
      inbox = await NativeInbox.open(join(root, 'inbox'));
      bridge = options.dependencies?.bridgeFactory?.({ mode: 'listen', keyFile: transportKeyFile, ticketFile, relay: true }) ?? new IrohBridge(['listen', '--key-file', transportKeyFile, '--ticket', ticketFile, '--relay']);
      const ready = await bridge.event();
      locator = await locatorFromEvent(ready, options.conversation, options.agents.provider, configHash);
      if (locator.endpoint.id !== Buffer.from(providerAuthority.transport_key).toString('hex')) throw new Error('identity_changed');
      journal.locator = locator; journal.desired = 'online'; await save(journalPath, journal);
      providerLoop = providerServe();
      await emit({ role: 'host', conversation: options.conversation, request: null, type: 'runtime', data: { status: roleStatus('ready', null) } });
    } else {
      const limits = responsesLimits('coordinator');
      if (options.dependencies && (!options.dependencies.workerFactory || !options.dependencies.webToolsFactory)) throw new Error('test_dependencies_required');
      if (!options.create) {
        const savedOpening = await readOptional<{ nonce: number[]; binding: StreamingBinding | null }>(join(root, 'opening.json'));
        if (savedOpening?.binding) {
          await openBudget();
          const channelDir = join(root, 'channels', savedOpening.binding.channel.slice(2));
          await components.openComponent(`stream:${savedOpening.binding.channel}`, async () => engine = await StreamingEngine.open(join(channelDir, 'stream.json'), 'buyer', savedOpening.binding!, await readKey(economicKeyFile)));
          journal.selected_channel = savedOpening.binding.channel;
          openingTransaction = transaction(await readOptional<unknown>(join(root, `fund-${Buffer.from(savedOpening.nonce).toString('hex')}.tx.json`)) ?? { state: 'unknown' });
          await persistJournal();
        }
      }
      // The coordinator is opened lazily, but start() performs its real
      // profile/factory gate before any bridge or funding side effect.
      await emit({ role: 'host', conversation: options.conversation, request: null, type: 'runtime', data: { status: roleStatus('ready', null) } });
      void limits;
    }
  } catch (error) {
    await cleanup().catch(() => {}); throw error;
  }

  function roleStatus(phase: DemoRoleStatus['phase'], code: string | null): DemoRoleStatus {
    const status = coordinator?.status();
    const profile = roleProfile ?? coordinatorProfile;
    const cursor = cursorFor(events?.replay() ?? []);
    return { version: 1, role: options.role, conversation: options.conversation, phase, code,
      runtime: clone(options.runtime), profile_fingerprint: profile ? agentRuntimeFingerprint(options.runtime, profile, responsesLimits(options.role)) : createHash('sha256').update(canonicalDemoJson(options.runtime)).digest('hex'),
      configuration_hash: configHash, active_task: status?.activeTask ?? null, active_request: status?.activeRequest ?? null,
      spending_paused: journal.spending_paused, waiting_for_credit: false,
      connection: { desired: journal.desired, state: peer ? 'connected' : 'disconnected', generation: journal.generation, path: 'unknown', changed_at_ms: String(clock.nowMs()), code: null }, cursor };
  }
  function identity(role: MachineRole): DemoIdentity {
    const auth = role === 'coordinator' ? localAuthority! : providerAuthority!;
    return { name: role === 'coordinator' ? 'local.nozomi.sui' : 'research.nozomi.sui', agent: clone(auth.agent), controller: auth.controller,
      transport_key: [...auth.transport_key], economic_key: [...auth.economic_key], generation: auth.generation, authority_checked_at_ms: auth.read_at_ms, alias_state: 'verified' };
  }
  function selectedEconomy(): DemoEconomy[] {
    if (!engine || !budget || !engine.snapshot()) return [];
    const snapshot = engine.snapshot(); const last = latestEngine(engine); const b = budget.snapshot();
    const status = snapshot.frozen ? 'closed' : observedChannel?.status === 2 ? 'refunded' : observedChannel?.status === 1 ? 'closed' : 'open';
    const redeemed = observedChannel?.redeemed_amount ?? b.redeemed_mist;
    return [{ channel: snapshot.binding.channel, status, offer: clone(snapshot.binding.offer), policy: clone(snapshot.binding.policy), signed_credit: last.credit,
      checkpoint: last.checkpoint, budget: b, delivered_units: last.units, delivered_mist: price(snapshot.binding.policy, last.units),
      signed_authorized_mist: last.credit?.payload.cumulative_amount ?? '0', reserved_mist: b.authorized_mist, outstanding_mist: b.outstanding_mist,
      reserved_exposure_mist: b.outstanding_mist, redeemed_mist: b.redeemed_mist === '0' ? null : b.redeemed_mist,
      locked_mist: observedChannel?.funds ?? null, refunded_mist: status === 'refunded' ? String(BigInt(snapshot.binding.offer.payload.deposit) - BigInt(redeemed)) : null,
      observed_at_ms: observedChannel ? String(clock.nowMs()) : null, opening: clone(openingTransaction), terminal: clone(terminalTransaction) }];
  }
  function publicStatus(): DemoRoleStatus { return clone(roleStatus(peer ? 'active' : 'ready', null)); }
  function publication(): DemoPublication { return clone(publicationState); }
  function publicationPending(): void { publicationState = { version: 1, state: 'pending', cursor: cursorFor(events?.replay() ?? []), code: 'publication_pending' }; }
  function publicationReady(): void { publicationState = { version: 1, state: 'ready', cursor: cursorFor(events?.replay() ?? []), code: null }; }
  function publicationFailed(): void { publicationState = { version: 1, state: 'failed', cursor: cursorFor(events?.replay() ?? []), code: 'publication_failed' }; }
  function checkControl(control: DemoControl): DemoControl {
    try { return validateDemoControl(control); } catch { throw new Error('invalid_control'); }
  }
  async function persistJournal(): Promise<void> {
    const snapshot = clone(journal);
    const next = journalWrites.then(() => save(journalPath, snapshot));
    journalWrites = next.catch(() => {}); await next;
  }
  async function emitObservation(channel: Address, observed: Awaited<ReturnType<StreamingChain['channel']>>, terminal: DemoEconomy['terminal'] | null = null): Promise<void> {
    await emit({ role: 'host', conversation: options.conversation, request: null, type: 'chain_observation', data: {
      channel, status: observed.status === 0 ? 'open' : observed.status === 1 ? 'closed' : 'refunded', redeemed_mist: observed.redeemed_amount,
      locked_mist: observed.funds, refunded_mist: observed.status === 2 ? String(BigInt(observed.offer.deposit) - BigInt(observed.redeemed_amount)) : null,
      observed_at_ms: String(clock.nowMs()), terminal,
    } });
  }
  function recordFor(id: ID): DemoControlRecord | undefined { return journal.controls.find(item => item.id === id); }
  function admission<T>(fn: () => Promise<T>): Promise<T> { const result = queue.then(fn); queue = result.catch(() => {}); return result; }

  async function coordinatorWorkerFactory(profile: AgentProfile): Promise<AgentWorker> {
    if (coordinatorWorker) return coordinatorWorker;
    const limits = responsesLimits('coordinator');
    await components.openComponent('worker', async create => coordinatorWorker = await (options.dependencies
      ? options.dependencies.workerFactory({ role: 'coordinator', descriptor: options.runtime, stateDir: join(root, 'worker'), create, profile, limits })
      : openAgentWorker({ descriptor: options.runtime, stateDir: join(root, 'worker'), create, profile, apiKeyFile: options.modelApiKeyFile, limits })));
    return coordinatorWorker!;
  }
  async function openBudget(): Promise<void> {
    if (!budget) await components.openComponent('budget', async create => budget = await BudgetLedger.open({ stateDir: join(root, 'budget'), create, limits: options.config.budget, buyer: options.agents.buyer, provider: options.agents.provider }));
  }
  async function prepareCoordinator(): Promise<void> {
    if (coordinator) return;
    await openBudget();
    await components.openComponent('coordinator', async create => coordinator = await AgentCoordinator.open({ stateDir: join(root, 'coordinator'), create, conversation: options.conversation,
      buyer: options.agents.buyer, provider: options.agents.provider, budget: budget!, port: deferredPort, workerFactory: coordinatorWorkerFactory, emit, strictEvents: true }));
    coordinatorProfile = coordinator!.profile();
    roleProfile = coordinatorProfile;
    // This is the actual adapter/factory gate. It performs no model request
    // and is completed before Iroh start/funding can be admitted.
    try { await coordinatorWorkerFactory(coordinatorProfile); }
    catch (error) { await coordinator!.shutdown(); coordinator = undefined; await budget!.close(); budget = undefined; throw error; }
  }

  async function start(): Promise<void> {
    if (options.role !== 'coordinator') return;
    if (peer) return;
    await components.validate();
    await prepareCoordinator();
    if (!options.providerLocator) throw new Error('provider_unavailable');
    const remote = await options.providerLocator();
    if (remote.version !== 1 || remote.conversation !== options.conversation || canonicalDemoJson(remote.provider) !== canonicalDemoJson(options.agents.provider) || remote.configuration_hash !== configHash) throw new Error('locator_mismatch');
    validateEndpoint(remote.endpoint);
    const currentProvider = await chain!.resolve(options.agents.provider);
    authority(currentProvider, options.agents.provider, BigInt(clock.nowMs()));
    if (remote.endpoint.id !== Buffer.from(currentProvider.transport_key).toString('hex')) throw new Error('identity_changed');
    providerAuthority = currentProvider;
    // Each Machine owns its ticket; the provider's listener writes only its
    // own filesystem. Persist the validated public endpoint before connecting.
    await save(ticketFile, remote.endpoint);
    bridge = options.dependencies?.bridgeFactory?.({ mode: 'connect', keyFile: transportKeyFile, ticketFile, relay: true }) ?? new IrohBridge(['connect', '--key-file', transportKeyFile, '--ticket', ticketFile, '--relay']);
    await bridge.connected();
    peer = new NativePeer(options.agents.buyer, await readKey(transportKeyFile), options.agents.provider, ref => chain!.resolve(ref), bridge, FEATURES);
    await peer.connect();
    const free = await peer.request('message.send', { service: 'echo', content_type: 'application/octet-stream', content: Array.from(new TextEncoder().encode('unpaid before funding')) });
    if (!free.receipt.result || !equal(free.receipt.result, Array.from(new TextEncoder().encode('unpaid before funding')))) throw new Error('free_messaging_failed');
    if (exchange) { await exchange.replacePeer(peer); await exchange.recover(); }
    journal.desired = 'online'; journal.generation = String(BigInt(journal.generation) + 1n); await persistJournal();
    const savedOpening = await readOptional<{ binding: StreamingBinding | null }>(join(root, 'opening.json'));
    if (savedOpening?.binding && !client) await fund({ op: 'fund', configuration_hash: configHash, previous_channel: journal.selected_channel });
    const pendingFunding = journal.controls.find(record => (record.state === 'accepted' || record.state === 'running' || record.state === 'uncertain') && record.command.op === 'fund');
    if (pendingFunding) await finishControl({ version: 1, id: pendingFunding.id, command: pendingFunding.command }, pendingFunding);
    await emit({ role: 'host', conversation: options.conversation, request: null, type: 'connection', data: { connection: publicStatus().connection, actor: 'operator' } });
  }
  async function fund(command: Extract<DemoCommand, { op: 'fund' }>): Promise<void> {
    if (options.role !== 'coordinator' || !peer || !coordinator) throw new Error('connection_failed');
    if (engine && client) { if (command.previous_channel !== journal.selected_channel) throw new Error('channel_mismatch'); return; }
    await components.validate();
    await openBudget();
    if (!exchange) await components.openComponent('exchange', async create => exchange = await DurableAgentExchange.open({ stateDir: root, create, conversation: options.conversation, peer: peer! }));
    await exchange!.recover();
    const noncePath = join(root, 'opening.json');
    const saved = await readOptional<{ nonce: number[]; previous_channel: string | null; binding: StreamingBinding | null }>(noncePath);
    const opening = saved ?? { nonce: Array.from(randomBytes(32)), previous_channel: command.previous_channel, binding: null };
    if (!saved) await save(noncePath, opening);
    if (!opening.binding) {
      if (!options.walletFile) throw new Error('controller_wallet_required');
      const response = (await exchange!.call({ op: 'offer', conversation: options.conversation, nonce: opening.nonce, previous_channel: opening.previous_channel }, `offer:${Buffer.from(opening.nonce).toString('hex')}`)).body;
      if (response.type === 'error') throw new Error(String(response.code));
      exactKeys(response, ['version', 'op_id', 'type', 'offer', 'policy', 'service']);
      const offer = validateSigned<OfferData>('offer', response.offer, providerAuthority!.economic_key);
      if (response.service !== 'service.research.conversation.v2' || !equal(response.policy, policy) || offer.payload.deposit !== options.config.deposit_mist || !equal(offer.payload.opening_nonce, opening.nonce)) throw new Error('unacceptable_offer');
      await budget!.reserveFunding(Buffer.from(opening.nonce).toString('hex'), offer.payload.deposit);
      const fundingJournal = join(root, `fund-${Buffer.from(opening.nonce).toString('hex')}.tx.json`);
      const funded = await chain!.fund(offer, policy, await readKey(options.walletFile), fundingJournal);
      openingTransaction = transaction(await readOptional<unknown>(fundingJournal) ?? { state: 'unknown' });
      opening.binding = { offer, policy, channel: funded }; await save(noncePath, opening);
      await emit({ role: 'host', conversation: options.conversation, request: null, type: 'funding', data: { channel: funded, opening_nonce: Buffer.from(opening.nonce).toString('hex'), deposit_mist: offer.payload.deposit, transaction: openingTransaction } });
    }
    const binding = opening.binding; if (!binding) throw new Error('funding_uncertain');
    openingTransaction = transaction(await readOptional<unknown>(join(root, `fund-${Buffer.from(opening.nonce).toString('hex')}.tx.json`)) ?? { state: 'unknown' });
    journal.selected_channel = binding.channel; observedChannel = await chain!.channel(binding.channel); await persistJournal(); await emitObservation(binding.channel, observedChannel, null);
    const funded = (await exchange!.call({ op: 'funded', conversation: options.conversation, channel: binding.channel }, `funded:${binding.channel}`)).body;
    if (funded.type !== 'funded') throw new Error(funded.code ?? 'funding_uncertain');
    const chDir = join(root, 'channels', binding.channel.slice(2));
    await components.openComponent(`stream:${binding.channel}`, async () => engine = await StreamingEngine.open(join(chDir, 'stream.json'), 'buyer', binding, await readKey(join(roleRoot, 'economic.json'))));
    await budget!.bindChannel({ channel: binding.channel, opening_nonce: Buffer.from(opening.nonce).toString('hex'), deposit: binding.offer.payload.deposit, policy });
    await components.openComponent(`client:${binding.channel}`, async create => client = await AgentServiceClient.open({ stateDir: join(chDir, 'client'), create, conversation: options.conversation, engine: engine!, budget: budget!,
      exchange: exchange!, observeChannel: async () => { const current = await chain!.channel(binding!.channel); observedChannel = current; return { channel: current, now_ms: String(await chain!.clock()) }; },
      settle: async (credit, checkpoint) => { const result = await chain!.closeExact(credit, checkpoint, await readKey(options.walletFile!), join(chDir, 'close.tx.json')); const observed = await chain!.channel(binding!.channel); return { channel: observed, digest: typeof result.digest === 'string' ? result.digest : toBase58(Uint8Array.from(observed.terminal_tx)) }; }, emit }));
    client!.setSpendingPaused(journal.spending_paused);
    researchPort = client;
    // A task control that was durably accepted before a process crash is
    // resumed with its original ID/prompt once the operator has explicitly
    // restored the funded channel. AgentCoordinator reconciles any saved
    // worker operation; this never allocates a replacement request.
    for (const pending of journal.controls.filter(record => (record.state === 'accepted' || record.state === 'running') && record.command.op === 'task')) {
      void finishControl({ version: 1, id: pending.id, command: pending.command }, pending).catch(() => {});
    }
  }
  async function runTask(id: ID, prompt: string): Promise<void> {
    if (!coordinator) throw new Error('channel_not_open');
    await components.validate();
    const result = await coordinator.run({ id, prompt });
    if (result.state === 'uncertain') throw new Error('uncertain_execution');
  }
  async function closeChannel(channel: Address): Promise<void> {
    if (!engine || !client || journal.selected_channel !== channel) throw new Error('channel_mismatch');
    await client.close(); terminalTransaction = transaction(await readOptional<unknown>(join(root, 'channels', channel.slice(2), 'close.tx.json')) ?? { state: 'unknown' }); observedChannel = await chain!.channel(channel); await emitObservation(channel, observedChannel, terminalTransaction);
  }
  async function refundChannel(channel: Address): Promise<void> {
    if (!options.walletFile || journal.selected_channel !== channel) throw new Error('channel_mismatch');
    const journalFile = join(root, `refund-${channel.slice(2)}.tx.json`);
    await chain!.refund(channel, await readKey(options.walletFile), journalFile); terminalTransaction = transaction(await readOptional<unknown>(journalFile) ?? { state: 'unknown' }); observedChannel = await chain!.channel(channel); await emitObservation(channel, observedChannel, terminalTransaction);
  }
  async function runControl(control: DemoControl): Promise<void> {
    const op = control.command.op;
    if (op === 'start') return start();
    if (op === 'fund') { if (control.command.configuration_hash !== configHash) throw new Error('configuration_mismatch'); return fund(control.command); }
    if (op === 'task') { if (journal.spending_paused) throw new Error('spending_paused'); return runTask(control.id, control.command.prompt); }
    if (op === 'cancel') { await coordinator?.cancel(); return; }
    if (op === 'spending') { journal.spending_paused = control.command.paused; client?.setSpendingPaused(journal.spending_paused); await persistJournal(); await emit({ role: 'host', conversation: options.conversation, request: null, type: 'connection', data: { connection: publicStatus().connection, actor: 'operator' } }); return; }
    if (op === 'disconnect') { journal.desired = 'offline'; await persistJournal(); bridge?.close(); peer = undefined; return; }
    if (op === 'reconnect') { journal.desired = 'online'; await persistJournal(); return start(); }
    if (op === 'close') return closeChannel(control.command.channel);
    if (op === 'refund') return refundChannel(control.command.channel);
  }
  async function finishControl(checked: DemoControl, accepted: DemoControlRecord): Promise<DemoControlRecord> {
    try { await runControl(checked); accepted.state = 'completed'; accepted.code = null; }
    catch (error) { const code = safeCode(error); accepted.state = ['uncertain_execution', 'funding_uncertain', 'settlement_uncertain', 'worker_shutdown_uncertain'].includes(code) ? 'uncertain' : 'failed'; accepted.code = code; }
    accepted.updated_at_ms = String(clock.nowMs());
    try { await persistJournal(); await emit({ role: 'host', conversation: options.conversation, request: null, type: 'control', data: { control: accepted } }); publicationReady(); }
    catch { publicationFailed(); throw new Error('publication_failed'); }
    return clone(accepted);
  }
  async function providerServe(): Promise<void> {
    if (!host || !inbox || options.role !== 'provider') return;
    let failures = 0;
    while (!stop) {
      const activeBridge = bridge;
      if (!activeBridge) break;
      try {
        await activeBridge.connected();
        const accepted = new NativePeer(options.agents.provider, await readKey(transportKeyFile), options.agents.buyer, ref => chain!.resolve(ref), activeBridge, FEATURES);
        await accepted.accept(); failures = 0;
        await accepted.serve(inbox, async (kind, body) => {
          if (kind === 'message.send') { if (body.service === 'echo') return body.content; if (body.service === 'blake2b-256') return hash(body.content); throw new Error('unknown_service'); }
          return host!.command(body.content);
        });
      } catch (error) {
        if (stop) break;
        failures += 1;
        await emit({ role: 'host', conversation: options.conversation, request: null, type: 'error', data: { code: safeCode(error) } }).catch(() => {});
        activeBridge.close(); bridge = undefined;
        const delay = [1000, 2000, 4000, 8000, 15000][Math.min(failures - 1, 4)];
        try { await clock.sleep(delay, providerAbort.signal); } catch { break; }
        if (!bridge && !stop) {
          bridge = options.dependencies?.bridgeFactory?.({ mode: 'listen', keyFile: transportKeyFile, ticketFile, relay: true }) ?? new IrohBridge(['listen', '--key-file', transportKeyFile, '--ticket', ticketFile, '--relay']);
          try { const listening = await bridge.event(); locator = await locatorFromEvent(listening, options.conversation, options.agents.provider, configHash); if (locator.endpoint.id !== Buffer.from(providerAuthority!.transport_key).toString('hex')) throw new Error('identity_changed'); journal.locator = locator; await persistJournal(); }
          catch (reopenError) { bridge.close(); bridge = undefined; await emit({ role: 'host', conversation: options.conversation, request: null, type: 'error', data: { code: safeCode(reopenError) } }).catch(() => {}); }
        }
      }
    }
  }
  async function cleanup(): Promise<void> {
    stop = true; providerAbort.abort(); bridge?.close();
    await providerLoop?.catch(() => {});
    await coordinator?.shutdown();
    await coordinatorWorker?.shutdown?.(); coordinatorWorker?.close();
    await host?.close().catch(() => {}); await inbox?.close().catch(() => {});
    await worker?.shutdown?.().catch(() => {}); worker?.close(); web?.close();
    await journalWrites.catch(() => {}); await budget?.close().catch(() => {}); await events?.close().catch(() => {}); await lock.close();
  }
  const handle: DemoRuntimeHandle = {
    role: options.role, conversation: options.conversation,
    publication, status: publicStatus, selectedChannel: () => journal.selected_channel,
    availableControls: () => {
      if (options.role !== 'coordinator') return [];
      const controls: DemoCommand['op'][] = ['spending'];
      if (peer) { if (!engine) controls.push('fund'); if (journal.selected_channel && coordinator && !journal.spending_paused && coordinator.status().activeTask === null) controls.push('task'); if (coordinator?.status().activeTask) controls.push('cancel'); controls.push('disconnect'); }
      else controls.push('start');
      if (!peer && journal.desired === 'offline') controls.push('reconnect');
      if (engine && journal.selected_channel) { controls.push('close'); controls.push('refund'); }
      return controls;
    },
    submit: control => admission(async () => {
      if (options.role !== 'coordinator') throw new Error('control_not_allowed');
      const checked = checkControl(control); const prior = recordFor(checked.id);
      if (prior) { if (canonicalDemoJson(prior.command) !== canonicalDemoJson(checked.command)) throw new Error('control_conflict'); return clone(prior); }
      const channel = checked.command.op === 'fund' || checked.command.op === 'close' || checked.command.op === 'refund' ? (checked.command.op === 'fund' ? checked.command.previous_channel : checked.command.channel) : null;
      const accepted: DemoControlRecord = { version: 1, id: checked.id, command: clone(checked.command), state: 'accepted', code: null, accepted_at_ms: String(clock.nowMs()), updated_at_ms: String(clock.nowMs()), task: checked.command.op === 'task' ? checked.id : checked.command.op === 'cancel' ? checked.command.task : null, channel };
      publicationPending(); journal.controls.push(accepted); await persistJournal(); await emit({ role: 'host', conversation: options.conversation, request: null, type: 'control', data: { control: accepted } }); publicationReady();
      accepted.state = 'running'; accepted.updated_at_ms = String(clock.nowMs()); publicationPending(); await persistJournal(); await emit({ role: 'host', conversation: options.conversation, request: null, type: 'control', data: { control: accepted } }); publicationReady();
      if (checked.command.op === 'task') {
        await persistJournal(); publicationReady();
        void finishControl(checked, accepted).catch(() => {});
        return clone(accepted);
      }
      return finishControl(checked, accepted);
    }),
    control: id => clone(recordFor(id)),
    events: (after, limit = 256): SourceEventPage => { const all = events?.replay(after) ?? []; return { version: 1, conversation: options.conversation, source: options.role, events: all.slice(0, limit), high_water: cursorFor(events?.replay() ?? []), has_more: all.length > limit }; },
    subscribe: listener => { if (!events) return () => {}; return events.subscribe(listener); },
    economy: () => clone(selectedEconomy()),
    identities: () => ({ coordinator: identity('coordinator'), provider: identity('provider') }),
    evidence: async channel => { const economy = selectedEconomy().find(item => item.channel === channel); if (!economy) throw new Error('channel_mismatch'); const replay = engine?.replay() ?? []; return { version: 1, conversation: options.conversation, channel, offer: economy.offer, policy: economy.policy, credits: replay.map(item => item.credit), checkpoints: replay.flatMap(item => item.deliveries.map(delivery => delivery.checkpoint)), terminal_receipts: client?.evidence().terminal_receipts ?? [], economy }; },
    locator: () => clone(locator),
    shutdown: cleanup,
  };
  return handle;
}

async function readSecret(path: string, kind: 'search' | 'model'): Promise<string> {
  try {
    const info = await lstat(resolve(path));
    if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0 || info.size > 16 * 1024) throw new Error();
    let value = await readFile(resolve(path), 'utf8');
    value = value.replace(/\r?\n$/u, '');
    if (!value || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error();
    return value;
  } catch { throw new Error(`${kind}_unconfigured`); }
}
async function locatorFromEvent(event: DemoBridgeEvent, conversation: ID, provider: PinnedAgents['provider'], configuration_hash: ID): Promise<DemoLocator> {
  if (event.event !== 'listening') throw new Error('provider_start_failed');
  validateEndpoint(event.endpoint);
  return { version: 1, conversation, provider: clone(provider), configuration_hash, endpoint: clone(event.endpoint) };
}

function validateEndpoint(endpoint: unknown): asserts endpoint is DemoLocator['endpoint'] {
  if (!isRecord(endpoint) || Object.keys(endpoint).sort().join(',') !== 'addrs,id' || typeof endpoint.id !== 'string' || !/^[0-9a-f]{64}$/.test(endpoint.id) ||
      !Array.isArray(endpoint.addrs) || endpoint.addrs.length > 32) throw new Error('provider_start_failed');
  const seen = new Set<string>();
  for (const address of endpoint.addrs) {
    if (!isRecord(address) || Object.keys(address).length !== 1) throw new Error('provider_start_failed');
    if ('Relay' in address) {
      if (typeof address.Relay !== 'string') throw new Error('provider_start_failed');
      let url: URL; try { url = new URL(address.Relay); } catch { throw new Error('provider_start_failed'); }
      if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('provider_start_failed');
      const key = `r:${url.href}`; if (seen.has(key)) throw new Error('provider_start_failed'); seen.add(key);
    } else if ('Ip' in address) {
      if (typeof address.Ip !== 'string' || !/^\[(?:[0-9a-fA-F:]+)\]:[1-9][0-9]*$|^(?:\d{1,3}\.){3}\d{1,3}:[1-9][0-9]*$/.test(address.Ip)) throw new Error('provider_start_failed');
      const port = Number(address.Ip.slice(address.Ip.lastIndexOf(':') + 1).replace(/\]$/u, '')); const host = address.Ip.startsWith('[') ? address.Ip.slice(1, address.Ip.indexOf(']')) : address.Ip.slice(0, address.Ip.lastIndexOf(':'));
      if (!Number.isSafeInteger(port) || port > 65535 || (host.includes('.') && host.split('.').some(part => Number(part) > 255))) throw new Error('provider_start_failed');
      const key = `i:${address.Ip}`; if (seen.has(key)) throw new Error('provider_start_failed'); seen.add(key);
    } else throw new Error('provider_start_failed');
  }
}
