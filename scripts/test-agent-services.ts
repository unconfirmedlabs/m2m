/** Explicit test fixtures and separately selected real-network/live probes. Never a runtime fallback. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { BudgetLedger } from './agent-coordinator.js';
import { AgentServiceClient } from './agent-service-client.js';
import type { AgentExchange, AgentServiceReply } from './agent-service-exchange.js';
import type { AgentProfile, AgentWorker, BudgetLimits, EventSink } from './agent-service-types.js';
import { ResearchNotDispatchedError } from './agent-service-types.js';
import { runAgentServices, type AgentServiceConfig } from './agent-services.js';
import { CodexWorker, type RequestRecord, type RequestRef, type WorkRequest, type EventConsumer } from './codex-worker.js';
import { save, type AgentRef } from './native-chain.js';
import { Envelope, strictJson, type SignedEnvelope } from './native-peer.js';
import { ResearchConversationService } from './research-conversation.js';
import { StreamingEngine } from './streaming-engine.js';
import { StreamingChain } from './native-streaming-chain.js';
import { checkpointHash, hash, makePolicy, policyHash, price, signStatement, utf8, ZERO_HASH, type ChannelData } from './streaming-codec.js';
import { streamingFixture } from './test-streaming-fixtures.js';

const identifier = () => randomBytes(32).toString('hex');
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const key = (ref: RequestRef) => createHash('sha256').update(JSON.stringify(ref)).digest('hex');
interface FixtureStore { records: Record<string, RequestRecord>; executions: number }

/** Deterministic, explicitly injected process-persistent worker, not LLM evidence. */
class IntegrationFixtureWorker implements AgentWorker {
  private store: FixtureStore;
  constructor(readonly path: string, private options: { profile?: AgentProfile; text?: string; delayMs?: number } = {}) {
    this.store = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { records: {}, executions: 0 };
    this.persist();
  }
  private persist() { writeFileSync(this.path, JSON.stringify(this.store), { mode: 0o600 }); }
  status(ref: RequestRef) { const record = this.store.records[key(ref)]; return record && structuredClone(record); }
  async reconcile(ref: RequestRef) { return this.status(ref); }
  async cancel(ref: RequestRef) {
    const record = this.store.records[key(ref)];
    if (record && !['completed', 'failed', 'cancelled'].includes(record.state)) { record.state = 'cancelled'; this.persist(); }
    return this.status(ref);
  }
  close() { this.persist(); }
  get executions() { return this.store.executions; }
  async run(request: WorkRequest, consume?: EventConsumer): Promise<RequestRecord> {
    const ref = { agent: request.agent, conversationId: request.conversationId, requestId: request.requestId };
    const id = key(ref), commitment = createHash('sha256').update(request.prompt).digest('hex');
    let record = this.store.records[id];
    if (record) { assert.equal(record.commitment, commitment); return structuredClone(record); }
    const now = Date.now();
    record = { ...ref, commitment, submittedInputHash: commitment, clientUserMessageId: id, state: 'running',
      threadId: `fixture-thread-${request.conversationId}`, turnId: `fixture-turn-${request.requestId}`, knownTurnIds: [],
      startedAt: now, deadline: now + 120_000, baselineUsage: null, upstreamUsage: null, usageObserved: false,
      producedUtf8Bytes: 0, items: {}, events: [] };
    this.store.records[id] = record; this.store.executions++; this.persist();
    if (this.options.delayMs) await delay(this.options.delayMs);
    let text = this.options.text ?? `Fixture research answer for ${request.prompt}. `.repeat(8);
    if (this.options.profile) {
      const profile = this.options.profile;
      const call = async (name: string, arguments_: unknown, suffix: string) => profile.handleTool({ request: ref, threadId: record.threadId!,
        turnId: record.turnId!, callId: `${request.requestId}-${suffix}`, name, arguments: arguments_, signal: new AbortController().signal });
      const first = await call('research', { question: 'Give a bounded first research answer.' }, 'research');
      assert.equal(first.success, true, first.text);
      const second = await call('follow_up', { question: 'Clarify the first answer in the same conversation.' }, 'followup');
      assert.equal(second.success, true, second.text);
      text = 'Explicit fixture coordinator completed two requests; this is not live LLM evidence.';
    }
    if (record.state !== 'cancelled') {
      record.producedUtf8Bytes = Buffer.byteLength(text); record.items.answer = text;
      record.events.push({ type: 'content', itemId: 'answer', delta: text, producedUtf8Bytes: record.producedUtf8Bytes,
        index: record.events.length, observedAt: Date.now(), requestId: request.requestId });
      record.state = 'completed'; this.persist();
      if (consume) for (const event of record.events) await consume(structuredClone(event));
    }
    return structuredClone(record);
  }
}

function limits(): BudgetLimits {
  return { max_total_mist: '100000', max_channel_deposit_mist: '12000', max_turn_mist: '10000',
    max_outstanding_mist: '2000', max_requests: 4, deadline_ms: String(Date.now() + 600_000), output_tranche_bytes: 128 };
}

async function liveEnablementGate() {
  const root = await mkdtemp(join(tmpdir(), 'm2m-agent-live-gate-'));
  const state = join(root, 'must-not-be-created');
  const config: AgentServiceConfig = { version: 1, budget: limits(), deposit_mist: '12000',
    price: { input_rate: '3', output_rate: '7', denominator: '10' }, allowed_hosts: ['fly.io'] };
  for (const role of ['provider', 'coordinator'] as const) {
    await assert.rejects(runAgentServices({ role, state, conversation: identifier(), config }),
      /agent_tool_runtime_unvalidated/);
    assert.equal(existsSync(state), false);
  }
  console.log('PASS live enablement gate: both roles refuse before state/identity/chain/funding; no CLI fallback');
}

async function offline(fault?: 'credit' | 'delivery' | 'completion') {
  const dir = await mkdtemp(join(tmpdir(), 'm2m-agent-driver-test-'));
  const fixture = await streamingFixture(), conversation = identifier();
  const policy = makePolicy(['input_utf8_bytes', 'output_utf8_bytes'], ['3', '7'], '10');
  const offer = await signStatement('offer', { ...fixture.offer.payload, policy_hash: policyHash(policy),
    offer_expires_ms: String(Date.now() + 120000), work_deadline_ms: String(Date.now() + 600000), claim_deadline_ms: String(Date.now() + 1200000) }, fixture.provider);
  const binding = { offer, policy, channel: fixture.channel };
  const agent = (id: string): AgentRef => ({ network: offer.payload.network, package_id: offer.payload.package_id, domain: offer.payload.deployment, agent: id });
  const buyer = agent(offer.payload.buyer), provider = agent(offer.payload.provider);
  let channel: ChannelData = { id: binding.channel, offer: offer.payload, policy, funds: offer.payload.deposit, redeemed_amount: '0', redeemed_sequence: '0',
    redeemed_units: ['0', '0'], status: 0, terminal_tx: [], close_hash: ZERO_HASH };
  const budgetLimits = limits();
  const budget = await BudgetLedger.open({ stateDir: join(dir, 'budget'), create: true, buyer, provider, limits: budgetLimits });
  await budget.reserveFunding(Buffer.from(offer.payload.opening_nonce).toString('hex'), offer.payload.deposit);
  await budget.bindChannel({ channel: binding.channel, opening_nonce: Buffer.from(offer.payload.opening_nonce).toString('hex'), deposit: offer.payload.deposit, policy });
  const buyerEngine = await StreamingEngine.open(join(dir, 'buyer.json'), 'buyer', binding, fixture.buyer);
  let providerEngine = await StreamingEngine.open(join(dir, 'provider.json'), 'provider', binding, fixture.provider);
  let worker = new IntegrationFixtureWorker(join(dir, 'worker.json'), { text: 'αβγδ research fixture '.repeat(20) });
  const observation = async () => ({ channel: structuredClone(channel), now_ms: String(Date.now()) });
  let service = await ResearchConversationService.open({ stateDir: join(dir, 'service'), create: true, conversation, buyer, provider,
    engine: providerEngine, worker, observeChannel: observation });
  const transport = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(99));
  const saved = new Map<string, AgentServiceReply>(); let operations = 0, injected = false;
  const exchange: AgentExchange = { call: async (command, stableKey) => {
    if (stableKey && saved.has(stableKey)) return structuredClone(saved.get(stableKey)!);
    const opId = identifier(); const body = strictJson(await service.command(utf8(JSON.stringify({ version: 2, op_id: opId, ...command })))); operations++;
    const requestMessageId = Array.from(randomBytes(32));
    const message = { purpose: utf8('m2m/core/message/v1'), sender: provider, recipient: buyer, generation: '0', id: Array.from(randomBytes(32)),
      correlation: requestMessageId, created_ms: String(Date.now()), expires_ms: String(Date.now() + 30000), kind: 'message.receipt',
      payload: utf8(JSON.stringify({ session: ZERO_HASH, message_id: requestMessageId, commitment: ZERO_HASH, state: 'completed', result: utf8(JSON.stringify(body)) })) };
    const envelope: SignedEnvelope = { message, signature: Array.from(await transport.sign(Envelope.serialize(message).toBytes())) };
    const reply = { body, envelope }; if (stableKey) saved.set(stableKey, reply);
    if (!injected && ((fault === 'credit' && body.type === 'ack') ||
      (fault === 'delivery' && body.type === 'delivery' && body.output.length > 0) ||
      (fault === 'completion' && body.type === 'turn_terminal'))) {
      injected = true;
      await service.close(); worker.close();
      providerEngine = await StreamingEngine.open(join(dir, 'provider.json'), 'provider', binding, fixture.provider);
      worker = new IntegrationFixtureWorker(join(dir, 'worker.json'), { text: 'αβγδ research fixture '.repeat(20) });
      service = await ResearchConversationService.open({ stateDir: join(dir, 'service'), create: false, conversation, buyer, provider,
        engine: providerEngine, worker, observeChannel: observation });
      throw Error('injected_restart');
    }
    return reply;
  } };
  const seen: any[] = []; const emit: EventSink = async e => { seen.push(e); };
  const clientOptions = { stateDir: join(dir, 'client'), create: true, conversation, engine: buyerEngine, budget, exchange, observeChannel: observation, emit, pollMs: 1,
    settle: async (_credit: any, checkpoint: any) => {
      channel = { ...channel, funds: '0', status: 1, redeemed_amount: checkpoint.payload.cumulative_amount,
        redeemed_sequence: checkpoint.payload.sequence, redeemed_units: checkpoint.payload.units, close_hash: checkpointHash(checkpoint.payload) };
      return { channel: structuredClone(channel), digest: 'explicit-offline-fixture' };
    } };
  try {
    let client = await AgentServiceClient.open(clientOptions);
    const firstId = identifier();
    if (fault) {
      await assert.rejects(client.execute({ requestId: firstId, prompt: 'First?' }), /injected_restart/);
      assert.equal(injected, true);
      clientOptions.engine = await StreamingEngine.open(join(dir, 'buyer.json'), 'buyer', binding, fixture.buyer);
      client = await AgentServiceClient.open({ ...clientOptions, create: false });
      const resumed = await client.execute({ requestId: firstId, prompt: 'First?' });
      const settlement = await client.close();
      assert.equal(settlement.paid_mist, price(policy, resumed.receipt.delivered_units));
      assert.equal(BigInt(settlement.paid_mist) + BigInt(settlement.refund_mist), BigInt(offer.payload.deposit));
      assert.equal(worker.executions, fault === 'credit' ? 0 : 1);
      console.log(JSON.stringify({ mode: 'explicit-offline-crash-fixture', fault, outcome: resumed.receipt.outcome,
        paid_mist: settlement.paid_mist, executions: worker.executions, same_channel: true }));
      return;
    }
    const first = await client.execute({ requestId: firstId, prompt: 'First?' });
    assert.equal(first.receipt.continuation, 'ready'); assert.equal(first.text, 'αβγδ research fixture '.repeat(20));
    assert.equal(buyerEngine.snapshot().frozen, false); await budget.completeRequest(firstId);
    assert.equal(buyerEngine.snapshot().completed_request_sequence, '1');
    const firstOutput = first.receipt.delivered_units[1];
    client = await AgentServiceClient.open({ ...clientOptions, create: false });
    assert.deepEqual(await client.execute({ requestId: firstId, prompt: 'First?' }), first);
    assert.equal(worker.executions, 1);
    const secondId = identifier(); const second = await client.execute({ requestId: secondId, prompt: 'Second?' });
    await budget.completeRequest(secondId);
    assert.equal(second.receipt.sequence, '2'); assert.equal(worker.executions, 2);
    assert.equal(second.receipt.delivered_units[0], String(Buffer.byteLength('First?Second?')));
    assert.equal(second.receipt.delivered_units[1], String(BigInt(firstOutput) * 2n));
    assert.ok(buyerEngine.replay().length > 2, 'real payment-engine credit renewals');
    assert.ok(buyerEngine.replay().flatMap(r => r.deliveries).every(d => !d.checkpoint.payload.final));
    // An unaffordable local attempt must not replace the last economic request
    // used for explicit channel close.
    await assert.rejects(client.execute({ requestId: identifier(), prompt: 'x'.repeat(8000) }),
      error => error instanceof ResearchNotDispatchedError && error.code === 'budget_rejected');
    const settlement = await client.close();
    assert.equal(settlement.paid_mist, price(policy, second.receipt.delivered_units));
    assert.equal(BigInt(settlement.paid_mist) + BigInt(settlement.refund_mist), BigInt(offer.payload.deposit));
    assert.equal(buyerEngine.snapshot().frozen, true);
    assert.ok(JSON.parse(await readFile(join(dir, 'client', 'client.json'), 'utf8')).requests.filter((r: any) => r.receipt).every((r: any) => r.proof.signature.length === 64));
    console.log(JSON.stringify({ mode: 'explicit-offline-fixture', assertions: 'two requests, renewals, exact bytes, buyer restart/replay, retained signed receipts, explicit close', operations, paid_mist: settlement.paid_mist }));
  } finally { await service.close(); worker.close(); await budget.close(); }
}

async function liveAdapter() {
  if (!process.env.M2M_CODEX_AUTH_FILE && !process.env.M2M_CODEX_API_KEY) throw Error('live_adapter_credentials_required');
  const dir = await mkdtemp(join(tmpdir(), 'm2m-live-agent-probe-'));
  const conversation = identifier(), calls: Array<{ thread: string; turn: string; call: string }> = [];
  const profile: AgentProfile = { id: 'm2m-bounded-tool-integration-probe-v1',
    baseInstructions: 'You are a bounded integration probe. Use the registered budget tool to inspect the allowance, then give a short public answer. No other tools or host access exist.',
    developerInstructions: 'Do not invent tool results. This is a real adapter probe, not a payment or web-research demonstration.',
    tools: [{ name: 'budget', description: 'Read the test allowance from the host.', inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
    maxToolCalls: 4, maxToolResultBytes: 1024, recoverableTools: ['budget'],
    handleTool: async call => { calls.push({ thread: call.threadId, turn: call.turnId, call: call.callId });
      await save(join(dir, 'calls.json'), calls); return { success: true, text: JSON.stringify({ remaining_mist: '4321', probe: 'host-tool-not-payment' }) }; } };
  const options = { stateDir: join(dir, 'worker'), agentProfile: profile, authFile: process.env.M2M_CODEX_AUTH_FILE, apiKey: process.env.M2M_CODEX_API_KEY,
    maxDurationMs: 120_000, maxOutputBytes: 4096 };
  let worker = await CodexWorker.open(options);
  try {
    const first = await worker.run({ agent: 'bounded-adapter-probe', conversationId: conversation, requestId: identifier(), prompt: 'Use budget once and summarize the allowance in one sentence.' });
    worker.close(); worker = await CodexWorker.open(options);
    const second = await worker.run({ agent: 'bounded-adapter-probe', conversationId: conversation, requestId: identifier(), prompt: 'Continue our earlier conversation. Use budget once again and summarize whether the allowance changed.' });
    const report = { mode: 'real-codex-adapter-probe-only', model: 'gpt-5.6-luna', effort: 'xhigh', first_state: first.state, second_state: second.state,
      first_reason: first.reason ?? null, second_reason: second.reason ?? null, thread: first.threadId, resumed_thread: second.threadId,
      first_turn: first.turnId, second_turn: second.turnId, calls, web_research: false, payments: false };
    await save(join(dir, 'report.json'), report); console.log(JSON.stringify(report));
    assert.equal(first.state, 'completed'); assert.equal(second.state, 'completed');
    assert.equal(first.threadId, second.threadId); assert.notEqual(first.turnId, second.turnId); assert.ok(calls.length >= 2);
  } finally { worker.close(); }
}

/** Real Rust Iroh processes and real Sui localnet; only inference is injected. */
async function localnet(state: string, wallet: string, live = false) {
  const dir = await mkdtemp(join(tmpdir(), 'm2m-agent-localnet-'));
  const conversation = identifier();
  const configuration: AgentServiceConfig = { version: 1, budget: limits(), deposit_mist: '12000',
    price: { input_rate: '3', output_rate: '7', denominator: '10' },
    allowed_hosts: ['fly.io', 'docs.sui.io', 'www.iroh.computer', 'iroh.computer'] };
  if (live) configuration.budget.output_tranche_bytes = 1024;
  const configPath = join(dir, 'operator.json'); await save(configPath, configuration);
  const chain = new StreamingChain(JSON.parse(await readFile(join(state, 'chain.json'), 'utf8')));
  await chain.validate();
  type Process = { child: ChildProcessWithoutNullStreams; events: any[]; diagnostics: string; exited: Promise<number | null>; code?: number | null };
  const children: Process[] = [];
  const launch = (role: 'provider' | 'coordinator', previous?: string): Process => {
    const args = ['--import', 'tsx', live ? 'scripts/agent-services.ts' : 'scripts/test-agent-services.ts',
      live ? '--role' : '--fixture-child', role, '--state', resolve(state), '--conversation', conversation, '--config', configPath];
    if (role === 'coordinator') args.push('--wallet', resolve(wallet));
    if (previous) args.push('--previous-channel', previous);
    const child = spawn(process.execPath, args, { stdio: 'pipe', env: process.env });
    const proc: Process = { child, events: [], diagnostics: '', exited: Promise.resolve(null) };
    proc.exited = new Promise(resolve => child.once('exit', code => { proc.code = code; resolve(code); }));
    let buffered = '';
    child.stdout.on('data', chunk => {
      buffered += chunk.toString();
      for (;;) {
        const index = buffered.indexOf('\n'); if (index < 0) break;
        const line = buffered.slice(0, index); buffered = buffered.slice(index + 1);
        if (line) { try { proc.events.push(JSON.parse(line)); } catch { proc.diagnostics += 'invalid_stdout\n'; } }
      }
    });
    child.stderr.on('data', chunk => { proc.diagnostics = (proc.diagnostics + chunk.toString()).slice(-8192); });
    child.stdin.on('error', () => {}); children.push(proc); return proc;
  };
  const until = async <T>(proc: Process, select: () => T | undefined, label: string, ms = 120000): Promise<T> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const result = select(); if (result !== undefined) return result;
      if (proc.code !== undefined || Date.now() >= deadline) throw Error(`${label}: ${JSON.stringify({ code: proc.code, diagnostics: proc.diagnostics, events: proc.events.slice(-4) })}`);
      await delay(25);
    }
  };
  const ready = (proc: Process, role: string) => until(proc, () => proc.diagnostics.includes(`${role}_ready`) ? true : undefined, `${role}_startup`);
  const send = (proc: Process, op: string, fields: Record<string, unknown> = {}) => { const id = identifier(); proc.child.stdin.write(JSON.stringify({ op, id, ...fields }) + '\n'); return id; };
  const stop = async (proc: Process) => {
    if (proc.code !== undefined) return;
    proc.child.kill('SIGTERM');
    const timer = setTimeout(() => proc.child.kill('SIGKILL'), 7000);
    try { await proc.exited; } finally { clearTimeout(timer); }
  };
  const manifestPath = (role: string) => join(state, 'agent-services', conversation, role, 'manifest.json');
  const manifest = async (role: string) => JSON.parse(await readFile(manifestPath(role), 'utf8'));
  const channels: any[] = [];
  try {
    let provider = launch('provider'); await ready(provider, 'provider');
    let coordinator = launch('coordinator'); await ready(coordinator, 'coordinator');
    const runTask = async (proc: Process) => {
      const task = send(proc, 'task', { prompt: live
        ? 'Research whether Fly Machines can host two separately deployed Iroh agents. Search the web, fetch official sources, ask one useful follow-up if budget permits, then summarize the findings with citations. Keep the response concise.'
        : 'Explicit fixture task: run two research requests.' });
      const status = send(proc, 'status');
      await until(proc, () => proc.events.find(e => e.data?.name === 'operator.status' && e.data.call_id === status), 'responsive_status');
      const result = await until(proc, () => proc.events.find(e => e.data?.name === 'operator.task' && e.data.call_id === task), 'task_result', live ? 360000 : 120000);
      assert.equal(result.data.result.state, 'completed', JSON.stringify(result));
    };
    const settle = async (proc: Process) => {
      const current = await manifest('coordinator'), channel = await chain.channel(current.selected);
      assert.equal(channel.status, 0, 'task completion must not close channel');
      const receipts = proc.events.filter(e => e.type === 'turn_terminal').map(e => e.data.receipt).filter(Boolean);
      assert.ok(receipts.length >= (live ? 1 : 2));
      assert.ok(receipts.every(r => r.continuation === 'ready'));
      const client = JSON.parse(await readFile(join(state, 'agent-services', conversation, 'coordinator', 'channels', channel.id.slice(2), 'client.json'), 'utf8'));
      assert.ok(client.requests.every((r: any) => r.proof?.signature.length === 64));
      const beforeClose = proc.events.length;
      send(proc, 'close');
      const settled = await until(proc, () => {
        const failure = proc.events.slice(beforeClose).find(e => e.type === 'error');
        if (failure) throw Error(`settlement_failed:${failure.data.code}`);
        return proc.events.find(e => e.type === 'settlement' && e.data.channel === channel.id);
      }, 'settlement');
      const confirmed = await chain.channel(channel.id), last = receipts.at(-1);
      assert.equal(confirmed.status, 1);
      assert.equal(confirmed.redeemed_amount, price(channel.policy, last.delivered_units));
      assert.equal(confirmed.redeemed_amount, settled.data.paid_mist);
      assert.equal(BigInt(confirmed.redeemed_amount) + BigInt(settled.data.refund_mist), BigInt(channel.offer.deposit));
      channels.push({ channel: confirmed.id, requests: receipts.length, paid_mist: confirmed.redeemed_amount,
        refund_mist: settled.data.refund_mist, close_hash: confirmed.close_hash, transaction: settled.data.digest });
      return channel.id;
    };
    await runTask(coordinator);
    // Restart both processes before settlement; journals preserve the same channel.
    const firstManifest = await manifest('coordinator');
    await stop(coordinator); await stop(provider);
    provider = launch('provider'); await ready(provider, 'provider');
    coordinator = launch('coordinator'); await ready(coordinator, 'coordinator');
    assert.equal((await manifest('coordinator')).selected, firstManifest.selected);
    // Public history is retained locally; settlement assertions use its persisted receipts.
    const retained = JSON.parse(await readFile(join(state, 'agent-services', conversation, 'coordinator', 'events.json'), 'utf8'));
    const history: any[] = Array.isArray(retained.events) ? retained.events : retained.records;
    coordinator.events.push(...history.filter(e => e.type === 'turn_terminal'));
    const first = await settle(coordinator); await stop(coordinator); await stop(provider);
    // Closed-session restart must not reserve a new deposit implicitly.
    provider = launch('provider'); await ready(provider, 'provider');
    coordinator = launch('coordinator'); await ready(coordinator, 'coordinator');
    assert.equal((await manifest('coordinator')).openings.length, 1);
    await stop(coordinator); await stop(provider);
    if (!live) {
      provider = launch('provider'); await ready(provider, 'provider');
      coordinator = launch('coordinator', first); await ready(coordinator, 'coordinator');
      assert.notEqual((await manifest('coordinator')).selected, first);
      await runTask(coordinator); await settle(coordinator);
      const pm = await manifest('provider'), cm = await manifest('coordinator');
      const providerWorker = JSON.parse(await readFile(join(pm.worker_location, 'worker', 'worker.json'), 'utf8')) as FixtureStore;
      const coordinatorWorker = JSON.parse(await readFile(join(cm.worker_location, 'worker.json'), 'utf8')) as FixtureStore;
      assert.equal(providerWorker.executions, 4); assert.equal(coordinatorWorker.executions, 2);
      assert.equal(new Set(Object.values(providerWorker.records).map(r => r.threadId)).size, 1);
      assert.equal(new Set(Object.values(coordinatorWorker.records).map(r => r.threadId)).size, 1);
    }
    const report = { mode: live ? 'two-real-llm-live-research' : 'real-iroh-sui-localnet-explicit-fixture-inference',
      conversation, channels, restart_before_settlement: true, closed_restart_no_new_deposit: true,
      explicit_replacement: !live, fixture_inference: !live };
    await save(join(dir, 'report.json'), report); console.log(JSON.stringify({ ...report, report_path: join(dir, 'report.json') }));
  } finally { for (const proc of children.reverse()) await stop(proc); }
}

const { values } = parseArgs({ options: { localnet: { type: 'boolean' }, 'live-adapter': { type: 'boolean' }, 'live-research': { type: 'boolean' },
  state: { type: 'string', default: '.m2m/native-localnet' }, wallet: { type: 'string' }, 'fixture-child': { type: 'string' },
  conversation: { type: 'string' }, config: { type: 'string' }, 'previous-channel': { type: 'string' } } });
if (values['fixture-child']) {
  const configuration = JSON.parse(await readFile(values.config!, 'utf8')) as AgentServiceConfig;
  await runAgentServices({ role: values['fixture-child'] as 'provider' | 'coordinator', state: values.state!, wallet: values.wallet,
    conversation: values.conversation!, config: configuration, previousChannel: values['previous-channel'], pollMs: 20,
    providerFactory: async location => { await mkdir(join(location, 'worker'), { recursive: true, mode: 0o700 });
      const worker = new IntegrationFixtureWorker(join(location, 'worker', 'worker.json')); return { worker, close: () => worker.close() }; },
    coordinatorFactory: async (profile, location) => new IntegrationFixtureWorker(join(location, 'worker.json'), { profile }) });
} else if (values['live-adapter']) await liveAdapter();
else if (values['live-research']) {
  if (!values.wallet || !process.env.M2M_BRAVE_API_KEY || (!process.env.M2M_CODEX_AUTH_FILE && !process.env.M2M_CODEX_API_KEY)) throw Error('live_research_requires_wallet_model_and_brave_credentials');
  await localnet(values.state!, values.wallet, true);
} else if (values.localnet) {
  if (!values.wallet) throw Error('localnet_controller_wallet_required');
  await localnet(values.state!, values.wallet);
}
else { await liveEnablementGate(); await offline(); for (const fault of ['credit', 'delivery', 'completion'] as const) await offline(fault); }
