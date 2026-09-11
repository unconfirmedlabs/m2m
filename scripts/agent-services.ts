/** Local two-process runner. No UI, Fly provisioning, fixture fallback, or public-chain writes. */
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { toBase58 } from '@mysten/sui/utils';
import { AgentCoordinator, BudgetLedger } from './agent-coordinator.js';
import { AgentEvents } from './agent-events.js';
import { AgentServiceClient } from './agent-service-client.js';
import { AgentServiceHost } from './agent-service-host.js';
import { DurableAgentExchange, readAgentJournal } from './agent-service-exchange.js';
import { BoundedWebTools, BraveSearchBackend } from './agent-web.js';
import { CodexWorker, type RequestRef } from './codex-worker.js';
import type { AgentProfile, AgentWorker, BudgetLimits, Citation, EventSink, PinnedAgents } from './agent-service-types.js';
import { NativeLock } from './native-lock.js';
import { IrohBridge, NativeInbox, NativePeer, strictJson } from './native-peer.js';
import { readKey, readOptional, save, type NativeConfig } from './native-chain.js';
import { StreamingChain } from './native-streaming-chain.js';
import { StreamingEngine, type StreamingBinding } from './streaming-engine.js';
import { equal, exactKeys, hash, makePolicy, offerHash, policyHash, u64, utf8, validateSigned, type OfferData, type SignedData, type PolicyData } from './streaming-codec.js';

export interface AgentServiceConfig {
  version: 1; budget: BudgetLimits; deposit_mist: string;
  price: { input_rate: string; output_rate: string; denominator: string };
  allowed_hosts: string[];
}
interface Manifest {
  version: 2; role: 'provider' | 'coordinator'; conversation: string; agents: PinnedAgents; config: AgentServiceConfig;
  worker_location: string; components: string[]; selected: string | null;
  openings: Array<{ nonce: number[]; previous_channel: string | null; binding: StreamingBinding | null }>;
  task_file: { id: string; prompt: string } | null;
}
/** Deliberate dependency injection for tests; production CLI has no backend-selection flag. */
export interface AgentRuntimeOptions {
  role: 'provider' | 'coordinator'; state: string; conversation: string; config: AgentServiceConfig;
  wallet?: string; previousChannel?: string; ticket?: string; taskFile?: string; input?: Readable;
  publish?: (line: string) => void; diagnostic?: (code: string) => void;
  providerFactory?: (location: string, emit: EventSink) => Promise<{ worker: AgentWorker; sources?: (ref: RequestRef) => Citation[]; close(): void }>;
  coordinatorFactory?: (profile: AgentProfile, location: string) => Promise<AgentWorker>;
  pollMs?: number;
}
const FEATURES = { required: ['payment.sui.streaming.v1', 'service.research.conversation.v2'], optional: [] };
const terminal = (state: string) => ['completed', 'failed', 'cancelled'].includes(state);
function validateConfig(value: AgentServiceConfig): PolicyData {
  exactKeys(value, ['version', 'budget', 'deposit_mist', 'price', 'allowed_hosts']);
  exactKeys(value.price, ['input_rate', 'output_rate', 'denominator']);
  if (value.version !== 1 || !Array.isArray(value.allowed_hosts) || value.allowed_hosts.length < 1 || value.allowed_hosts.length > 32 ||
    value.allowed_hosts.some(host => typeof host !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes('..'))) throw Error('invalid_config');
  u64(value.deposit_mist);
  if (value.deposit_mist === '0') throw Error('invalid_config');
  return makePolicy(['input_utf8_bytes', 'output_utf8_bytes'], [value.price.input_rate, value.price.output_rate], value.price.denominator);
}
const safeError = (error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  return /^[a-z][a-z0-9_]{0,63}$/.test(message) ? message : 'runtime_error';
};
const bounded = async (work: Promise<unknown>, ms: number) => {
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([work, new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]); }
  finally { if (timer) clearTimeout(timer); }
};

export async function runAgentServices(options: AgentRuntimeOptions): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(options.conversation)) throw Error('invalid_conversation');
  const policy = validateConfig(options.config), state = resolve(options.state);
  // Fail before any identity/chain/funding operation, not after a model has
  // silently continued without callable service tools. No CLI override exists.
  if ((options.role === 'provider' && !options.providerFactory) ||
      (options.role === 'coordinator' && !options.coordinatorFactory)) throw Error('agent_tool_runtime_unvalidated');
  const config = await readOptional<NativeConfig>(join(state, 'chain.json'));
  if (!config || config.network !== 'localnet' || !/^http:\/\/127\.0\.0\.1(?::[0-9]+)?$/.test(config.rpc_url)) throw Error('preconfigured_localnet_required');
  const chain = new StreamingChain(config); await chain.validate();
  const [local, research] = await Promise.all(['local', 'research'].map(role => readOptional<{ agent: string }>(join(state, role, 'identity.json'))));
  if (!local || !research) throw Error('missing_agent_identity');
  const agents = { buyer: chain.reference(local.agent), provider: chain.reference(research.agent) };
  await Promise.all([chain.resolve(agents.buyer), chain.resolve(agents.provider)]);
  const identityRole = options.role === 'provider' ? 'research' : 'local';
  const lock = await NativeLock.acquire(join(state, identityRole, '.agent-services.lock'));
  const directory = join(state, 'agent-services', options.conversation, options.role);
  const manifestPath = join(directory, 'manifest.json');
  const initializedPath = join(directory, 'initialized.json');
  let bridge: IrohBridge | undefined, inbox: NativeInbox | undefined, coordinator: AgentCoordinator | undefined;
  let budget: BudgetLedger | undefined;
  let backend: { worker: AgentWorker; sources?: (ref: RequestRef) => Citation[]; close(): void } | undefined;
  let host: AgentServiceHost | undefined, events: AgentEvents | undefined;
  let stopping = false, active: Promise<unknown> | undefined;
  let controls: ReturnType<typeof createInterface> | undefined;
  const publish = options.publish ?? (line => process.stdout.write(line + '\n'));
  const diagnostic = options.diagnostic ?? (code => process.stderr.write(code + '\n'));
  const signal = () => { stopping = true; controls?.close(); bridge?.close(); void coordinator?.cancel().catch(() => {}); };
  process.once('SIGTERM', signal); process.once('SIGINT', signal);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const initialized = await readOptional(initializedPath);
    let manifest = await readAgentJournal<Manifest>(manifestPath, !!initialized);
    if (manifest) {
      exactKeys(manifest, ['version', 'role', 'conversation', 'agents', 'config', 'worker_location', 'components', 'selected', 'openings', 'task_file']);
      if (manifest.version !== 2 || manifest.role !== options.role || manifest.conversation !== options.conversation ||
        !equal(manifest.agents, agents) || !equal(manifest.config, options.config) || !Array.isArray(manifest.components) || !Array.isArray(manifest.openings)) throw Error('journal_corrupt');
      if (!(await stat(manifest.worker_location)).isDirectory()) throw Error('journal_missing');
    } else {
      manifest = { version: 2, role: options.role, conversation: options.conversation, agents, config: options.config,
        worker_location: await mkdtemp(join(tmpdir(), `m2m-agent-${options.role}-`)), components: [], selected: null, openings: [], task_file: null };
      await save(manifestPath, manifest); await save(initializedPath, { version: 2 });
    }
    const app = manifest;
    const mark = async (component: string) => {
      if (!app.components.includes(component)) { app.components.push(component); await save(manifestPath, app); }
    };
    events = await AgentEvents.open(join(directory, 'events.json'), options.conversation, event => publish(JSON.stringify(event)), app.components.includes('events'));
    await mark('events');
    const emit: EventSink = async event => {
      if (event.conversation !== options.conversation) throw Error('event_conversation_mismatch');
      await events!.append(event.role, event.type, event.data, event.request);
    };
    const emitError = (error: unknown) => emit({ role: 'host', conversation: options.conversation, request: null, type: 'error', data: { code: safeError(error) } });
    const ticket = resolve(options.ticket ?? join(state, 'agent-services', options.conversation, 'ticket.json'));

    if (options.role === 'provider') {
      if (app.components.includes('worker')) await readAgentJournal(join(app.worker_location, 'worker', 'worker.json'), true, 16 * 1024 * 1024);
      if (options.providerFactory) backend = await options.providerFactory(app.worker_location, emit);
      else {
        if (!process.env.M2M_BRAVE_API_KEY) throw Error('search_unconfigured');
        if (!process.env.M2M_CODEX_AUTH_FILE && !process.env.M2M_CODEX_API_KEY) throw Error('backend_unavailable');
        const web = await BoundedWebTools.open({ stateDir: join(app.worker_location, 'web'),
          searchBackend: new BraveSearchBackend({ apiKey: process.env.M2M_BRAVE_API_KEY }), allowedHosts: options.config.allowed_hosts });
        const profile = web.profile(), original = profile.handleTool;
        profile.handleTool = async call => {
          await emit({ role: 'research', conversation: options.conversation, request: call.request.requestId, type: 'tool_started',
            data: { name: call.name, call_id: call.callId, arguments: call.arguments as Record<string, unknown> } });
          const result = await original(call);
          // Never publish fetched page bodies or host diagnostics in public tool events.
          await emit({ role: 'research', conversation: options.conversation, request: call.request.requestId, type: 'tool_result',
            data: { name: call.name, call_id: call.callId, success: result.success, result_bytes: Buffer.byteLength(result.text) } });
          return result;
        };
        const worker = await CodexWorker.open({ stateDir: join(app.worker_location, 'worker'), agentProfile: profile,
          authFile: process.env.M2M_CODEX_AUTH_FILE, apiKey: process.env.M2M_CODEX_API_KEY, maxDurationMs: 120_000, maxOutputBytes: 32_768 });
        backend = { worker, sources: ref => web.sources(ref), close: () => { worker.close(); web.close(); } };
      }
      await mark('worker');
      host = await AgentServiceHost.open({ stateDir: directory, create: !app.components.includes('host'), conversation: options.conversation,
        agents, policy, deposit: options.config.deposit_mist, chain, signer: await readKey(join(state, 'research', 'economic.json')),
        worker: backend.worker, sources: backend.sources });
      await mark('host');
      const inboxPath = join(state, 'research', 'agent-services-inbox');
      if (app.components.includes('inbox')) await readAgentJournal(join(inboxPath, 'inbox.json'), true, 16 * 1024 * 1024);
      inbox = await NativeInbox.open(inboxPath); await mark('inbox');
      let failures = 0;
      while (!stopping) {
        bridge = new IrohBridge(['listen', '--key-file', join(state, 'research', 'iroh-key.json'), '--ticket', ticket]);
        try {
          const ready = await bridge.event(); if (ready.event !== 'listening') throw Error('provider_start_failed');
          diagnostic('provider_ready'); await bridge.connected();
          const peer = new NativePeer(agents.provider, await readKey(join(state, 'research', 'transport.json')), agents.buyer,
            ref => chain.resolve(ref), bridge, FEATURES);
          await peer.accept(); failures = 0;
          await peer.serve(inbox, async (kind, body) => {
            if (kind === 'message.send') {
              if (body.service === 'echo') return body.content;
              if (body.service === 'blake2b-256') return hash(body.content);
              throw Error('unknown_service');
            }
            if (!FEATURES.required.every(feature => peer.selected.includes(feature))) throw Error('unsupported_service');
            return host!.command(body.content);
          });
        } catch (e) {
          if (stopping) break;
          await emitError(e);
          if (++failures >= 3) throw Error('provider_transport_unavailable');
        } finally { bridge.close(); bridge = undefined; }
      }
      return;
    }

    if (!options.wallet) throw Error('controller_wallet_required');
    if (!options.coordinatorFactory && !process.env.M2M_CODEX_AUTH_FILE && !process.env.M2M_CODEX_API_KEY) throw Error('backend_unavailable');
    const wallet = await readKey(resolve(options.wallet));
    const budgetFile = await readAgentJournal(join(directory, 'budget', 'budget.json'), app.components.includes('budget'));
    budget = await BudgetLedger.open({ stateDir: join(directory, 'budget'), create: !budgetFile,
      limits: options.config.budget, ...agents }); await mark('budget');
    bridge = new IrohBridge(['connect', '--key-file', join(state, 'local', 'iroh-key.json'), '--ticket', ticket]); await bridge.connected();
    const peer = new NativePeer(agents.buyer, await readKey(join(state, 'local', 'transport.json')), agents.provider, ref => chain.resolve(ref), bridge, FEATURES);
    await peer.connect();
    const free = await peer.request('message.send', { service: 'echo', content_type: 'application/octet-stream', content: utf8('unpaid before funding') });
    if (!equal(free.receipt.result, utf8('unpaid before funding'))) throw Error('free_messaging_failed');
    const exchange = await DurableAgentExchange.open({ stateDir: directory, create: !app.components.includes('outbox'), conversation: options.conversation, peer });
    await mark('outbox'); await exchange.recover();
    let opening = app.openings.at(-1);
    if (options.previousChannel && opening?.previous_channel !== options.previousChannel) {
      if (app.selected !== options.previousChannel || !opening?.binding || opening.binding.channel !== options.previousChannel) throw Error('channel_mismatch');
      const previous = await chain.channel(options.previousChannel);
      const oldDirectory = join(directory, 'channels', options.previousChannel.slice(2));
      await readAgentJournal(join(oldDirectory, 'stream.json'), true);
      const old = await StreamingEngine.open(join(oldDirectory, 'stream.json'), 'buyer', opening.binding, await readKey(join(state, 'local', 'economic.json')));
      const snapshot = old.snapshot(), last = old.replay().at(-1);
      if (previous.status === 0 || (last && !snapshot.frozen && snapshot.completed_request_sequence !== last.credit.payload.request_sequence)) throw Error('uncertain_execution');
      await budget.observe({ channel: previous.id, status: previous.status === 1 ? 'closed' : 'refunded', redeemed_mist: previous.redeemed_amount,
        delivered_units: (old.replay().flatMap(r => r.deliveries).at(-1)?.checkpoint.payload.units ?? ['0', '0']) as [string, string],
        authorized_units: (last?.credit.payload.units ?? ['0', '0']) as [string, string] });
      opening = undefined;
    }
    if (!opening) {
      opening = { nonce: Array.from(randomBytes(32)), previous_channel: options.previousChannel ?? null, binding: null };
      app.openings.push(opening); await save(manifestPath, app);
    }
    if (!opening.binding) {
      const reply = (await exchange.call({ op: 'offer', conversation: options.conversation, nonce: opening.nonce, previous_channel: opening.previous_channel }, `offer:${Buffer.from(opening.nonce).toString('hex')}`)).body;
      if (reply.type === 'error') throw Error(reply.code);
      exactKeys(reply, ['version', 'op_id', 'type', 'offer', 'policy', 'service']);
      if (reply.type !== 'offer' || reply.service !== 'service.research.conversation.v2' || !equal(reply.policy, policy)) throw Error('unacceptable_offer');
      const offer = validateSigned<OfferData>('offer', reply.offer, (await chain.resolve(agents.provider)).economic_key);
      if (offer.payload.buyer !== agents.buyer.agent || offer.payload.provider !== agents.provider.agent ||
        offer.payload.deposit !== options.config.deposit_mist || !equal(offer.payload.opening_nonce, opening.nonce) ||
        !equal(offer.payload.policy_hash, policyHash(policy))) throw Error('unacceptable_offer');
      await budget.reserveFunding(Buffer.from(opening.nonce).toString('hex'), offer.payload.deposit);
      const funded = await chain.fund(offer, policy, wallet, join(directory, `fund-${Buffer.from(opening.nonce).toString('hex')}.tx.json`));
      opening.binding = { offer, policy, channel: funded }; app.selected = funded; await save(manifestPath, app);
    }
    const binding = opening.binding, channelDirectory = join(directory, 'channels', binding.channel.slice(2));
    const currentChannel = await chain.channel(binding.channel);
    if (currentChannel.status === 0) await budget.bindChannel({ channel: binding.channel, opening_nonce: Buffer.from(opening.nonce).toString('hex'), deposit: binding.offer.payload.deposit, policy });
    const funded = (await exchange.call({ op: 'funded', conversation: options.conversation, channel: binding.channel }, `funded:${binding.channel}`)).body;
    if (funded.type !== 'funded' || funded.channel !== binding.channel) throw Error(funded.type === 'error' ? funded.code : 'invalid_funding_response');
    const engineMarker = `engine:${binding.channel}`, clientMarker = `client:${binding.channel}`;
    if (app.components.includes(engineMarker)) await readAgentJournal(join(channelDirectory, 'stream.json'), true);
    const engine = await StreamingEngine.open(join(channelDirectory, 'stream.json'), 'buyer', binding, await readKey(join(state, 'local', 'economic.json'))); await mark(engineMarker);
    if (currentChannel.status !== 0) await budget.observe({ channel: currentChannel.id,
      status: currentChannel.status === 1 ? 'closed' : 'refunded', redeemed_mist: currentChannel.redeemed_amount,
      delivered_units: (engine.replay().flatMap(r => r.deliveries).at(-1)?.checkpoint.payload.units ?? ['0', '0']) as [string, string],
      authorized_units: (engine.replay().at(-1)?.credit.payload.units ?? ['0', '0']) as [string, string] });
    const client = await AgentServiceClient.open({ stateDir: channelDirectory, create: !app.components.includes(clientMarker), conversation: options.conversation,
      engine, budget, exchange, emit, pollMs: options.pollMs,
      observeChannel: async () => ({ channel: await chain.channel(binding.channel), now_ms: String(await chain.clock()) }),
      settle: async (credit, checkpoint) => {
        const existing = await chain.channel(binding.channel);
        if (existing.status !== 0) return { channel: existing, digest: toBase58(Uint8Array.from(existing.terminal_tx)) };
        const result = await chain.closeExact(credit, checkpoint, wallet, join(channelDirectory, 'close.tx.json'));
        return { channel: await chain.channel(binding.channel), digest: result.digest };
      } }); await mark(clientMarker);
    if (app.components.includes('worker')) await readAgentJournal(join(app.worker_location, 'worker.json'), true, 16 * 1024 * 1024);
    const coordinatorFile = await readAgentJournal(join(directory, 'coordinator', 'coordinator.json'), app.components.includes('coordinator'));
    coordinator = await AgentCoordinator.open({ stateDir: join(directory, 'coordinator'), create: !coordinatorFile, conversation: options.conversation,
      ...agents, budget, port: client, emit, workerFactory: async profile => {
        const worker = options.coordinatorFactory ? await options.coordinatorFactory(profile, app.worker_location) :
          await CodexWorker.open({ stateDir: app.worker_location, agentProfile: profile, authFile: process.env.M2M_CODEX_AUTH_FILE,
            apiKey: process.env.M2M_CODEX_API_KEY, maxDurationMs: 300_000, maxOutputBytes: 32_768 });
        await mark('worker'); return worker;
      } }); await mark('coordinator');
    diagnostic('coordinator_ready');
    const control = async (value: any) => {
      if (!value || !/^[0-9a-f]{64}$/.test(value.id)) throw Error('invalid_control');
      if (value.op === 'task') {
        exactKeys(value, ['op', 'id', 'prompt']);
        if (active) throw Error('conversation_busy');
        active = coordinator!.run({ id: value.id, prompt: value.prompt }).then(result => emit({ role: 'host', conversation: options.conversation,
          request: value.id, type: 'tool_result', data: { name: 'operator.task', call_id: value.id, result } })).catch(emitError).finally(() => { active = undefined; });
        return;
      }
      exactKeys(value, ['op', 'id']);
      if (value.op === 'status') {
        await emit({ role: 'host', conversation: options.conversation, request: null, type: 'budget', data: { ...budget!.snapshot() } });
        await emit({ role: 'host', conversation: options.conversation, request: null, type: 'tool_result', data: { name: 'operator.status', call_id: value.id, result: coordinator!.status() } });
      } else if (value.op === 'cancel') await coordinator!.cancel();
      else if (value.op === 'close') {
        if (active) throw Error('conversation_busy');
        await client.close();
      } else if (value.op === 'shutdown') { stopping = true; await coordinator!.shutdown(); }
      else throw Error('invalid_control');
    };
    if (options.taskFile) {
      const prompt = await readFile(resolve(options.taskFile), 'utf8');
      if (app.task_file && app.task_file.prompt !== prompt) throw Error('task_conflict');
      app.task_file ??= { id: randomBytes(32).toString('hex'), prompt }; await save(manifestPath, app);
      await control({ op: 'task', ...app.task_file });
    }
    const input = options.input ?? process.stdin;
    const lines = createInterface({ input }); controls = lines;
    for await (const line of lines) {
      if (stopping) break;
      try { if (Buffer.byteLength(line) > 65_536) throw Error('invalid_control'); await control(strictJson(line)); }
      catch (e) { await emitError(e); }
      if (stopping) break;
    }
    lines.close();
    if (active && !stopping) await active;
  } finally {
    stopping = true;
    controls?.close();
    if (coordinator) await bounded(coordinator.shutdown().catch(() => {}), 15_000);
    if (active) await bounded(active.catch(() => {}), 15_000);
    if (backend) { backend.close(); if (host) await bounded(host.close().catch(() => {}), 5_000); }
    if (budget) await budget.close();
    bridge?.close(); if (inbox) await inbox.close();
    await lock.close(); process.off('SIGTERM', signal); process.off('SIGINT', signal);
  }
}

async function main() {
  const { values } = parseArgs({ options: { help: { type: 'boolean' }, role: { type: 'string' }, state: { type: 'string', default: '.m2m/native-localnet' },
    conversation: { type: 'string' }, config: { type: 'string' }, wallet: { type: 'string' }, ticket: { type: 'string' },
    'task-file': { type: 'string' }, 'previous-channel': { type: 'string' } } });
  if (values.help) {
    process.stdout.write('Usage: tsx scripts/agent-services.ts --role provider|coordinator --conversation <64hex> --config <operator.json> [--state <existing localnet state>] [--wallet <controller key file>] [--ticket <Iroh ticket>] [--task-file <text>] [--previous-channel <settled channel>]\n' +
      'LIVE ENABLEMENT BLOCKED: agent_tool_runtime_unvalidated (see docs/AGENT_SERVICES_VALIDATION.md). No funding or fixture fallback occurs.\n' +
      'After runtime validation, run provider separately, then coordinator. Provider needs M2M_BRAVE_API_KEY; both roles need M2M_CODEX_AUTH_FILE or M2M_CODEX_API_KEY.\n' +
      'Coordinator stdin: {"op":"task","id":"<64hex>","prompt":"..."}; cancel/status/close/shutdown use only op and id. Task completion does not close the channel.\n' +
      'Operator config: {version:1,budget:{max_total_mist,max_channel_deposit_mist,max_turn_mist,max_outstanding_mist,max_requests,deadline_ms,output_tranche_bytes},deposit_mist,price:{input_rate,output_rate,denominator},allowed_hosts:[...]}. Amounts/deadline are decimal strings.\n'); return;
  }
  if (!['provider', 'coordinator'].includes(values.role ?? '') || !values.conversation || !values.config) throw Error('missing_runtime_arguments');
  await runAgentServices({ role: values.role as 'provider' | 'coordinator', state: values.state!, conversation: values.conversation,
    config: strictJson(await readFile(resolve(values.config), 'utf8')), wallet: values.wallet, ticket: values.ticket,
    taskFile: values['task-file'], previousChannel: values['previous-channel'] });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { process.stderr.write(safeError(e) + '\n'); process.exitCode = 1; });
