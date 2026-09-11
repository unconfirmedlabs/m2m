import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePolicy, utf8 } from './streaming-codec.js';
import { BudgetLedger, AgentCoordinator } from './agent-coordinator.js';
import { ResearchNotDispatchedError, type AgentProfile, type AgentToolResult, type AgentWorker, type BudgetLimits, type ResearchPort, type ResearchResult, type Units } from './agent-service-types.js';
import type { AgentRef } from './native-chain.js';
import type { RequestRecord, RequestRef, WorkRequest } from './codex-worker.js';

const id = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const buyer: AgentRef = { network: [108, 111, 99, 97, 108], package_id: id(1), domain: id(2), agent: id(3) };
const provider: AgentRef = { network: [108, 111, 99, 97, 108], package_id: id(1), domain: id(2), agent: id(4) };
const limits = (overrides: Partial<BudgetLimits> = {}): BudgetLimits => ({
  max_total_mist: '1000', max_channel_deposit_mist: '900', max_turn_mist: '800', max_outstanding_mist: '900',
  max_requests: 4, deadline_ms: String(Date.now() + 60 * 60 * 1000), output_tranche_bytes: 1024, ...overrides,
});
const policy = makePolicy(['input_utf8_bytes', 'output_utf8_bytes'], ['1', '1'], '1');
const nonce = (n: number): string => n.toString(16).padStart(64, '0');
const channel = (n: number): string => id(100 + n);
const binding = (n: number) => ({ channel: channel(n), opening_nonce: nonce(n), deposit: '500', policy });
const receipt = (conversation: string, request: string): ResearchResult => ({
  text: `provider result for ${request}`,
  receipt: { version: 2, conversation, request, request_hash: Array(32).fill(1), sequence: '1', outcome: 'completed', reason: null,
    checkpoint_hash: Array(32).fill(2), delivered_units: ['0', '0'], generated_output: `provider result for ${request}`,
    discarded_output: '', continuation: 'ready', citations: [] },
});
function fakeRecord(request: WorkRequest, text: string): RequestRecord {
  return { ...request, commitment: 'fixture', submittedInputHash: 'fixture', clientUserMessageId: 'fixture', state: 'completed', knownTurnIds: [],
    startedAt: Date.now(), deadline: Date.now() + 1000, baselineUsage: null, upstreamUsage: null, usageObserved: false, producedUtf8Bytes: Buffer.byteLength(text),
    items: { item: text }, events: [{ type: 'content', itemId: 'item', delta: text, producedUtf8Bytes: Buffer.byteLength(text), index: 0, observedAt: Date.now(), requestId: request.requestId }] };
}
class FixtureWorker implements AgentWorker {
  constructor(private profile: AgentProfile, private conversation: string, private mode: 'normal' | 'lost', private observed?: AgentToolResult[]) {}
  async run(request: WorkRequest): Promise<RequestRecord> {
    const call = { request: { agent: request.agent, conversationId: request.conversationId, requestId: request.requestId }, threadId: 'thread', turnId: 'turn', callId: 'stable-call', name: 'research', arguments: { question: 'What is the evidence?' }, signal: new AbortController().signal };
    const result = await this.profile.handleTool(call);
    this.observed?.push(result);
    return fakeRecord(request, result.success ? result.text : `tool failed: ${result.text}`);
  }
  async reconcile(ref: RequestRef): Promise<RequestRecord | undefined> {
    if (this.mode !== 'lost') return undefined;
    const request: WorkRequest = { ...ref, prompt: 'reconcile retained research operation' };
    const call = { request: { agent: request.agent, conversationId: request.conversationId, requestId: request.requestId }, threadId: 'thread', turnId: 'turn', callId: 'stable-call', name: 'research', arguments: { question: 'What is the evidence?' }, signal: new AbortController().signal };
    const result = await this.profile.handleTool(call);
    this.observed?.push(result);
    return fakeRecord(request, result.success ? result.text : `tool failed: ${result.text}`);
  }
  status(_ref: RequestRef): RequestRecord | undefined { return undefined; }
  async cancel(_ref: RequestRef): Promise<RequestRecord | undefined> { return undefined; }
  close(): void {}
}

class StalledWorker implements AgentWorker {
  readonly runStarted: Promise<void>;
  readonly shutdownStarted: Promise<void>;
  private runStartedResolve!: () => void;
  private shutdownStartedResolve!: () => void;
  private readonly runGate: Promise<RequestRecord>;
  private readonly shutdownGate: Promise<void>;
  private runResolve!: (record: RequestRecord) => void;
  private shutdownResolve!: () => void;
  constructor() {
    this.runStarted = new Promise(resolve => { this.runStartedResolve = resolve; });
    this.shutdownStarted = new Promise(resolve => { this.shutdownStartedResolve = resolve; });
    this.runGate = new Promise(resolve => { this.runResolve = resolve; });
    this.shutdownGate = new Promise(resolve => { this.shutdownResolve = resolve; });
  }
  async run(_request: WorkRequest): Promise<RequestRecord> {
    this.runStartedResolve();
    return this.runGate;
  }
  status(_ref: RequestRef): RequestRecord | undefined { return undefined; }
  async reconcile(_ref: RequestRef): Promise<RequestRecord | undefined> { return undefined; }
  async cancel(_ref: RequestRef): Promise<RequestRecord | undefined> { return undefined; }
  close(): void {}
  async shutdown(): Promise<void> {
    this.shutdownStartedResolve();
    return this.shutdownGate;
  }
  releaseRun(request: WorkRequest): void { this.runResolve(fakeRecord(request, 'stalled result')); }
  releaseShutdown(): void { this.shutdownResolve(); }
}

class GateWorker implements AgentWorker {
  runCalls = 0;
  cancelCalls = 0;
  readonly runStarted: Promise<void>;
  private runStartedResolve!: () => void;
  private readonly runGate: Promise<RequestRecord>;
  private runResolve!: (record: RequestRecord) => void;
  constructor(private readonly cancellation: RequestRecord | undefined) {
    this.runStarted = new Promise(resolve => { this.runStartedResolve = resolve; });
    this.runGate = new Promise(resolve => { this.runResolve = resolve; });
  }
  async run(request: WorkRequest): Promise<RequestRecord> { this.runCalls += 1; this.runStartedResolve(); return this.runGate; }
  status(_ref: RequestRef): RequestRecord | undefined { return undefined; }
  async reconcile(_ref: RequestRef): Promise<RequestRecord | undefined> { return undefined; }
  async cancel(_ref: RequestRef): Promise<RequestRecord | undefined> { this.cancelCalls += 1; return this.cancellation; }
  close(): void {}
  release(request: WorkRequest): void { this.runResolve(fakeRecord(request, 'late worker result')); }
}

/** Emits a terminal model record while its paid ResearchPort call is still pending. */
class TerminalReconcileWorker implements AgentWorker {
  runCalls = 0;
  reconcileCalls = 0;
  constructor(private readonly profile: AgentProfile, private readonly conversation: string) {}
  async run(request: WorkRequest): Promise<RequestRecord> {
    this.runCalls += 1;
    const call = { request: { agent: request.agent, conversationId: request.conversationId, requestId: request.requestId }, threadId: 'thread', turnId: 'turn', callId: 'stable-call', name: 'research', arguments: { question: 'What is the evidence?' }, signal: new AbortController().signal };
    await this.profile.handleTool(call);
    return fakeRecord(request, 'model terminal while receipt is pending');
  }
  status(_ref: RequestRef): RequestRecord | undefined { return undefined; }
  async reconcile(ref: RequestRef): Promise<RequestRecord> {
    this.reconcileCalls += 1;
    return fakeRecord({ ...ref, prompt: 'reconcile retained operation' }, 'reconciled model terminal');
  }
  async cancel(ref: RequestRef): Promise<RequestRecord> { return { ...fakeRecord({ ...ref, prompt: '' }, ''), state: 'cancelled' }; }
  close(): void {}
}

/** A worker whose prior uncertain operation has no local terminal evidence. */
class UncertainWorker implements AgentWorker {
  runCalls = 0;
  reconcileCalls = 0;
  async run(request: WorkRequest): Promise<RequestRecord> { this.runCalls += 1; return { ...fakeRecord(request, 'uncertain launch'), state: 'uncertain' }; }
  status(_ref: RequestRef): RequestRecord | undefined { return undefined; }
  async reconcile(_ref: RequestRef): Promise<RequestRecord | undefined> { this.reconcileCalls += 1; return undefined; }
  async cancel(ref: RequestRef): Promise<RequestRecord> { return { ...fakeRecord({ ...ref, prompt: '' }, ''), state: 'cancelled' }; }
  close(): void {}
}

class FlakyShutdownWorker implements AgentWorker {
  shutdownCalls = 0;
  closeCalls = 0;
  async run(request: WorkRequest): Promise<RequestRecord> { return fakeRecord(request, 'done'); }
  status(_ref: RequestRef): RequestRecord | undefined { return undefined; }
  async reconcile(_ref: RequestRef): Promise<RequestRecord | undefined> { return undefined; }
  async cancel(_ref: RequestRef): Promise<RequestRecord | undefined> { return { ...fakeRecord({ agent: buyer.agent, conversationId: 'conv-flaky', requestId: 'cancel', prompt: '' }, ''), state: 'cancelled' }; }
  close(): void { this.closeCalls += 1; }
  async shutdown(): Promise<void> { this.shutdownCalls += 1; if (this.shutdownCalls === 1) throw new Error('first_shutdown_failure'); }
}

async function ledgerTests(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'm2m-coordinator-budget-'));
  const allocationLimits = limits();
  let ledger!: BudgetLedger;
  try {
    ledger = await BudgetLedger.open({ stateDir: root, create: true, limits: allocationLimits, buyer, provider });
    await ledger.reserveFunding(nonce(1), '500');
    await assert.rejects(() => ledger.reserveFunding(nonce(2), '500'), /funding_conflict/);
    await ledger.bindChannel(binding(1));
    await ledger.beginRequest('request-a', ['0', '0']);
    await ledger.beginRequest('request-a', ['0', '0']);
    await assert.rejects(() => ledger.beginRequest('request-b', ['0', '0']), /request_active/);
    await ledger.reserveCredit({ channel: channel(1), request: 'request-a', ceilings: ['10', '100'], delivered_units: ['0', '0'], request_start_units: ['0', '0'] });
    // The cumulative authorization is priced once: 10 + 100, not a sum of
    // each cumulative credit amount.
    assert.equal(ledger.snapshot().authorized_mist, '110');
    assert.deepEqual(ledger.reservedUnits(), ['10', '100']);
    await ledger.observe({ channel: channel(1), status: 'open', redeemed_mist: '20', delivered_units: ['5', '20'], authorized_units: ['10', '100'] });
    assert.equal(ledger.snapshot().outstanding_mist, '85');
    // Replaying the original request identity uses its persisted baseline,
    // even after cumulative delivery advanced.
    await ledger.beginRequest('request-a', ['0', '0']);
    await ledger.completeRequest('request-a');
    await ledger.beginRequest('request-b', ['5', '20']);
    await ledger.reserveCredit({ channel: channel(1), request: 'request-b', ceilings: ['20', '200'], delivered_units: ['5', '20'], request_start_units: ['5', '20'] });
    assert.equal(ledger.snapshot().authorized_mist, '220');
    const terminal = { channel: channel(1), status: 'closed' as const, redeemed_mist: '220', delivered_units: ['20', '200'] as Units, authorized_units: ['20', '200'] as Units };
    await ledger.observe(terminal);
    await ledger.observe(terminal);
    assert.equal(ledger.snapshot().channel, null);
    assert.equal(ledger.snapshot().settled_prior_mist, '220');
    await assert.rejects(() => ledger.reserveFunding(nonce(3), '900'), /funding_limit/);
    await ledger.close();
    const reopened = await BudgetLedger.open({ stateDir: root, create: false, limits: allocationLimits, buyer, provider });
    assert.equal(reopened.snapshot().requests_remaining, 2);
    await reopened.close();
  } finally { await ledger?.close(); await rm(root, { recursive: true, force: true }); }
}

async function coordinatorTests(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'm2m-coordinator-'));
  const budgetRoot = join(root, 'budget');
  const coordinatorRoot = join(root, 'coordinator');
  let budget!: BudgetLedger; let coordinator: AgentCoordinator | undefined;
  const calls: string[] = [];
  const port: ResearchPort = { execute: async ({ requestId, prompt }) => { calls.push(requestId); await budget.beginRequest(requestId, budget.currentUnits()); return receipt('conv-1', requestId); }, cancel: async () => ({ confirmed: true }) };
  try {
    budget = await BudgetLedger.open({ stateDir: budgetRoot, create: true, limits: limits(), buyer, provider });
    await budget.reserveFunding(nonce(10), '500'); await budget.bindChannel(binding(10));
    coordinator = await AgentCoordinator.open({ stateDir: coordinatorRoot, create: true, conversation: 'conv-1', buyer, provider, budget, port,
      workerFactory: async profile => new FixtureWorker(profile, 'conv-1', 'normal') });
    const first = await coordinator.run({ id: 'task-1', prompt: 'Research the question.' });
    assert.equal(first.state, 'completed'); assert.equal(calls.length, 1);
    const replay = await coordinator.run({ id: 'task-1', prompt: 'Research the question.' });
    assert.deepEqual(replay, first); assert.equal(calls.length, 1);
    const profile = coordinator.profile();
    assert.equal(profile.id, 'm2m-coordinator-v2');
    assert.deepEqual(profile.recoverableTools, ['research', 'follow_up']);
    const bad = await profile.handleTool({ request: { agent: buyer.agent, conversationId: 'conv-1', requestId: 'task-1' }, threadId: 't', turnId: 'u', callId: 'bad', name: 'research', arguments: { question: 'x', recipient: provider.agent }, signal: new AbortController().signal });
    assert.equal(bad.success, false);
    const exactReplay = await profile.handleTool({ request: { agent: buyer.agent, conversationId: 'conv-1', requestId: 'task-1' }, threadId: 't', turnId: 'u', callId: 'stable-call', name: 'research', arguments: { question: 'What is the evidence?' }, signal: new AbortController().signal });
    assert.equal(exactReplay.success, true); assert.match(exactReplay.text, /^\{"text":/);
    const surrogate = await profile.handleTool({ request: { agent: buyer.agent, conversationId: 'conv-1', requestId: 'task-1' }, threadId: 't', turnId: 'u', callId: 'surrogate', name: 'research', arguments: { question: '\ud800' }, signal: new AbortController().signal });
    assert.equal(surrogate.success, false); assert.equal(surrogate.text, 'invalid_argument');
    await coordinator.shutdown(); coordinator = undefined;
    const reopened = await AgentCoordinator.open({ stateDir: coordinatorRoot, create: false, conversation: 'conv-1', buyer, provider, budget, port,
      workerFactory: async profile => new FixtureWorker(profile, 'conv-1', 'normal') });
    assert.equal((await reopened.run({ id: 'task-1', prompt: 'Research the question.' })).state, 'completed');
    await reopened.shutdown();
  } finally { await coordinator?.shutdown(); await budget?.close(); await rm(root, { recursive: true, force: true }); }
}

async function lostReplyTest(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'm2m-coordinator-recovery-'));
  const budgetRoot = join(root, 'budget'); const coordinatorRoot = join(root, 'coordinator');
  let budget!: BudgetLedger; let coordinator: AgentCoordinator | undefined;
  let first = true; const calls: string[] = []; const toolResults: AgentToolResult[] = [];
  const port: ResearchPort = { execute: async ({ requestId }) => { calls.push(requestId); await budget.beginRequest(requestId, budget.currentUnits()); if (first) { first = false; throw new Error('reply_lost_after_provider_execution'); } return receipt('conv-recovery', requestId); }, cancel: async () => ({ confirmed: true }) };
  try {
    budget = await BudgetLedger.open({ stateDir: budgetRoot, create: true, limits: limits(), buyer, provider });
    await budget.reserveFunding(nonce(20), '500'); await budget.bindChannel(binding(20));
    coordinator = await AgentCoordinator.open({ stateDir: coordinatorRoot, create: true, conversation: 'conv-recovery', buyer, provider, budget, port,
      workerFactory: async profile => new FixtureWorker(profile, 'conv-recovery', 'lost', toolResults) });
    const current = coordinator;
    assert.equal((await current.run({ id: 'task-recovery', prompt: 'Recover this task.' })).state, 'uncertain');
    assert.deepEqual(toolResults[0], { success: false, text: 'backend_unavailable', uncertain: true });
    await assert.rejects(() => current.run({ id: 'task-new', prompt: 'Must wait for recovery.' }), /uncertain_execution/);
    await coordinator.shutdown(); coordinator = undefined;
    const reopened = await AgentCoordinator.open({ stateDir: coordinatorRoot, create: false, conversation: 'conv-recovery', buyer, provider, budget, port,
      workerFactory: async profile => new FixtureWorker(profile, 'conv-recovery', 'lost') });
    assert.equal((await reopened.run({ id: 'task-recovery', prompt: 'Recover this task.' })).state, 'completed');
    assert.equal(calls.length, 2); assert.equal(calls[0], calls[1]);
    await reopened.shutdown();
  } finally { await coordinator?.shutdown(); await budget?.close(); await rm(root, { recursive: true, force: true }); }
}

async function typedNoDispatchTest(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'm2m-coordinator-no-dispatch-'));
  const budgetRoot = join(root, 'budget'); const coordinatorRoot = join(root, 'coordinator');
  let budget!: BudgetLedger; let coordinator: AgentCoordinator | undefined;
  let first = true; const calls: string[] = [];
  const port: ResearchPort = {
    execute: async ({ requestId }) => { calls.push(requestId); await budget.beginRequest(requestId, budget.currentUnits()); if (first) { first = false; throw new ResearchNotDispatchedError('budget_rejected'); } return receipt('conv-no-dispatch', requestId); },
    cancel: async () => { throw new ResearchNotDispatchedError('cancelled_before_dispatch'); },
  };
  try {
    budget = await BudgetLedger.open({ stateDir: budgetRoot, create: true, limits: limits(), buyer, provider });
    await budget.reserveFunding(nonce(30), '500'); await budget.bindChannel(binding(30));
    await budget.completeRequest('never-reserved');
    assert.equal(budget.snapshot().requests_remaining, 4);
    coordinator = await AgentCoordinator.open({ stateDir: coordinatorRoot, create: true, conversation: 'conv-no-dispatch', buyer, provider, budget, port,
      workerFactory: async profile => new FixtureWorker(profile, 'conv-no-dispatch', 'normal') });
    const firstRun = await coordinator.run({ id: 'task-no-dispatch', prompt: 'Budget may reject this.' });
    assert.equal(firstRun.state, 'completed'); assert.equal(calls.length, 1);
    assert.equal(budget.snapshot().requests_remaining, 3);
    const profile = coordinator.profile();
    const replay = await profile.handleTool({ request: { agent: buyer.agent, conversationId: 'conv-no-dispatch', requestId: 'task-no-dispatch' }, threadId: 't', turnId: 'u', callId: 'stable-call', name: 'research', arguments: { question: 'What is the evidence?' }, signal: new AbortController().signal });
    assert.deepEqual(replay, { success: false, text: 'budget_rejected' }); assert.equal(replay.uncertain, undefined); assert.equal(calls.length, 1);
    const next = await coordinator.run({ id: 'task-next', prompt: 'The next task may proceed.' });
    assert.equal(next.state, 'completed'); assert.equal(calls.length, 2);
    await coordinator.shutdown(); coordinator = undefined;
  } finally { await coordinator?.shutdown(); await budget?.close(); await rm(root, { recursive: true, force: true }); }
}

async function cancellationBeforeFactoryAdmissionTest(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'm2m-coordinator-factory-cancel-'));
  const budgetRoot = join(root, 'budget'); const coordinatorRoot = join(root, 'coordinator');
  let budget!: BudgetLedger; let coordinator: AgentCoordinator | undefined; let releaseFactory!: () => void; let factoryEntered!: () => void;
  const worker = new GateWorker(undefined);
  const factoryGate = new Promise<void>(resolve => { releaseFactory = resolve; });
  const entered = new Promise<void>(resolve => { factoryEntered = resolve; });
  const port: ResearchPort = { execute: async ({ requestId }) => receipt('conv-factory-cancel', requestId), cancel: async () => ({ confirmed: true }) };
  try {
    budget = await BudgetLedger.open({ stateDir: budgetRoot, create: true, limits: limits(), buyer, provider });
    coordinator = await AgentCoordinator.open({ stateDir: coordinatorRoot, create: true, conversation: 'conv-factory-cancel', buyer, provider, budget, port,
      workerFactory: async () => { factoryEntered(); await factoryGate; return worker; } });
    const running = coordinator.run({ id: 'task-factory-cancel', prompt: 'Cancel while worker admission is pending.' });
    await entered;
    await coordinator.cancel();
    releaseFactory();
    const result = await running;
    assert.equal(result.state, 'cancelled');
    assert.equal(worker.runCalls, 0);
    assert.equal(worker.cancelCalls, 0);
    await coordinator.shutdown(); coordinator = undefined;
  } finally {
    releaseFactory?.(); await coordinator?.shutdown().catch(() => {}); await budget?.close(); await rm(root, { recursive: true, force: true });
  }
}

async function uncertainWorkerCancellationTest(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'm2m-coordinator-worker-cancel-'));
  const budgetRoot = join(root, 'budget'); const coordinatorRoot = join(root, 'coordinator');
  let budget!: BudgetLedger; let coordinator: AgentCoordinator | undefined; let reopened: AgentCoordinator | undefined;
  const worker = new GateWorker(undefined);
  const port: ResearchPort = { execute: async ({ requestId }) => receipt('conv-worker-cancel', requestId), cancel: async () => ({ confirmed: true }) };
  const request: WorkRequest = { agent: buyer.agent, conversationId: 'conv-worker-cancel', requestId: 'task-worker-cancel', prompt: 'Cancel in flight.' };
  try {
    budget = await BudgetLedger.open({ stateDir: budgetRoot, create: true, limits: limits(), buyer, provider });
    coordinator = await AgentCoordinator.open({ stateDir: coordinatorRoot, create: true, conversation: 'conv-worker-cancel', buyer, provider, budget, port,
      workerFactory: async () => worker });
    const running = coordinator.run({ id: request.requestId, prompt: request.prompt });
    await worker.runStarted;
    await coordinator.cancel();
    worker.release(request);
    const result = await running;
    assert.equal(result.state, 'uncertain');
    assert.equal(coordinator.status().state, 'uncertain');
    const replay = await coordinator.run({ id: request.requestId, prompt: request.prompt });
    assert.equal(replay.state, 'uncertain');
    assert.equal(worker.runCalls, 1);
    await coordinator.shutdown();
    coordinator = undefined;
    reopened = await AgentCoordinator.open({ stateDir: coordinatorRoot, create: false, conversation: 'conv-worker-cancel', buyer, provider, budget, port,
      workerFactory: async () => new GateWorker(undefined) });
    const recovered = await reopened.run({ id: request.requestId, prompt: request.prompt });
    assert.equal(recovered.state, 'uncertain');
    await reopened.shutdown(); reopened = undefined;
  } finally { await coordinator?.shutdown().catch(() => {}); await reopened?.shutdown().catch(() => {}); await budget?.close(); await rm(root, { recursive: true, force: true }); }
}

async function pendingPaidCallTerminalGuardTest(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'm2m-coordinator-pending-terminal-'));
  const budgetRoot = join(root, 'budget'); const coordinatorRoot = join(root, 'coordinator');
  let budget!: BudgetLedger; let coordinator: AgentCoordinator | undefined; let reopened: AgentCoordinator | undefined;
  let worker!: TerminalReconcileWorker; let recoveredWorker!: TerminalReconcileWorker; let executeCalls = 0;
  const port: ResearchPort = {
    execute: async ({ requestId }) => { executeCalls += 1; await budget.beginRequest(requestId, budget.currentUnits()); throw new Error('reply_lost_after_credit'); },
    cancel: async () => ({ confirmed: false }),
  };
  try {
    budget = await BudgetLedger.open({ stateDir: budgetRoot, create: true, limits: limits(), buyer, provider });
    await budget.reserveFunding(nonce(51), '500'); await budget.bindChannel(binding(51));
    coordinator = await AgentCoordinator.open({ stateDir: coordinatorRoot, create: true, conversation: 'conv-pending-terminal', buyer, provider, budget, port,
      workerFactory: async profile => { worker = new TerminalReconcileWorker(profile, 'conv-pending-terminal'); return worker; } });
    const task = { id: 'task-pending-terminal', prompt: 'Keep the paid operation unresolved.' };
    assert.equal((await coordinator.run(task)).state, 'uncertain');
    await coordinator.cancel();
    await coordinator.shutdown(); coordinator = undefined;
    reopened = await AgentCoordinator.open({ stateDir: coordinatorRoot, create: false, conversation: 'conv-pending-terminal', buyer, provider, budget, port,
      workerFactory: async profile => { recoveredWorker = new TerminalReconcileWorker(profile, 'conv-pending-terminal'); return recoveredWorker; } });
    const replay = await reopened.run(task);
    assert.equal(replay.state, 'uncertain');
    assert.equal(recoveredWorker.runCalls, 0);
    assert.equal(recoveredWorker.reconcileCalls, 1);
    assert.equal(executeCalls, 1);
    assert.equal(reopened.status().activeRequest !== null, true);
    await reopened.shutdown(); reopened = undefined;
  } finally { await coordinator?.shutdown().catch(() => {}); await reopened?.shutdown().catch(() => {}); await budget?.close(); await rm(root, { recursive: true, force: true }); }
}

async function uncertainLaunchWithoutReceiptTest(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'm2m-coordinator-uncertain-launch-'));
  const budgetRoot = join(root, 'budget'); const coordinatorRoot = join(root, 'coordinator');
  let budget!: BudgetLedger; let coordinator: AgentCoordinator | undefined; let reopened: AgentCoordinator | undefined;
  let worker!: UncertainWorker; let recoveredWorker!: UncertainWorker;
  const port: ResearchPort = { execute: async () => { throw new Error('worker_uncertain_before_port'); }, cancel: async () => ({ confirmed: false }) };
  try {
    budget = await BudgetLedger.open({ stateDir: budgetRoot, create: true, limits: limits(), buyer, provider });
    await budget.reserveFunding(nonce(52), '500'); await budget.bindChannel(binding(52));
    coordinator = await AgentCoordinator.open({ stateDir: coordinatorRoot, create: true, conversation: 'conv-uncertain-launch', buyer, provider, budget, port,
      workerFactory: async () => { worker = new UncertainWorker(); return worker; } });
    const task = { id: 'task-uncertain-launch', prompt: 'Do not relaunch this uncertain operation.' };
    assert.equal((await coordinator.run(task)).state, 'uncertain');
    await coordinator.cancel();
    assert.equal(coordinator.status().state, 'uncertain');
    await coordinator.shutdown(); coordinator = undefined;
    reopened = await AgentCoordinator.open({ stateDir: coordinatorRoot, create: false, conversation: 'conv-uncertain-launch', buyer, provider, budget, port,
      workerFactory: async () => { recoveredWorker = new UncertainWorker(); return recoveredWorker; } });
    const replay = await reopened.run(task);
    assert.equal(replay.state, 'uncertain');
    assert.equal(recoveredWorker.runCalls, 0);
    await reopened.shutdown(); reopened = undefined;
  } finally { await coordinator?.shutdown().catch(() => {}); await reopened?.shutdown().catch(() => {}); await budget?.close(); await rm(root, { recursive: true, force: true }); }
}

async function closedHeldFactoryPreservesPriorUncertaintyTest(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'm2m-coordinator-held-prior-uncertain-'));
  const budgetRoot = join(root, 'budget'); const coordinatorRoot = join(root, 'coordinator');
  let budget!: BudgetLedger; let coordinator: AgentCoordinator | undefined; let reopened: AgentCoordinator | undefined; let checked: AgentCoordinator | undefined;
  const seedWorker = new UncertainWorker(); const heldWorker = new UncertainWorker();
  let releaseFactory!: () => void; let factoryEntered!: () => void;
  const factoryGate = new Promise<void>(resolve => { releaseFactory = resolve; });
  const entered = new Promise<void>(resolve => { factoryEntered = resolve; });
  let paidCalls = 0;
  const port: ResearchPort = { execute: async () => { paidCalls += 1; throw new Error('must_not_dispatch'); }, cancel: async () => ({ confirmed: false }) };
  const task = { id: 'task-held-prior-uncertain', prompt: 'Preserve an uncertain prior launch.' };
  const waitUntilStopped = async (): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const journal = JSON.parse(await readFile(join(coordinatorRoot, 'coordinator.json'), 'utf8')) as { tasks: Record<string, { stopped: boolean }> };
      if (journal.tasks[task.id]?.stopped) return;
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    throw new Error('cancel_transition_not_observed');
  };
  try {
    budget = await BudgetLedger.open({ stateDir: budgetRoot, create: true, limits: limits(), buyer, provider });
    await budget.reserveFunding(nonce(53), '500'); await budget.bindChannel(binding(53));
    coordinator = await AgentCoordinator.open({ stateDir: coordinatorRoot, create: true, conversation: 'conv-held-prior-uncertain', buyer, provider, budget, port,
      workerFactory: async () => seedWorker });
    assert.equal((await coordinator.run(task)).state, 'uncertain');
    assert.equal(seedWorker.runCalls, 1); assert.equal(paidCalls, 0);
    await coordinator.shutdown(); coordinator = undefined;
    reopened = await AgentCoordinator.open({ stateDir: coordinatorRoot, create: false, conversation: 'conv-held-prior-uncertain', buyer, provider, budget, port,
      workerFactory: async () => { factoryEntered(); await factoryGate; return heldWorker; } });
    const replay = reopened.run(task);
    await entered;
    const shuttingDown = reopened.shutdown();
    await waitUntilStopped();
    releaseFactory();
    await shuttingDown;
    assert.equal((await replay).state, 'uncertain');
    assert.equal(heldWorker.runCalls, 0); assert.equal(heldWorker.reconcileCalls, 0); assert.equal(paidCalls, 0);
    reopened = undefined;
    checked = await AgentCoordinator.open({ stateDir: coordinatorRoot, create: false, conversation: 'conv-held-prior-uncertain', buyer, provider, budget, port,
      workerFactory: async () => { throw new Error('lazy worker must not be launched for status'); } });
    assert.equal(checked.status().state, 'uncertain');
    await checked.shutdown(); checked = undefined;
  } finally {
    releaseFactory?.(); await coordinator?.shutdown().catch(() => {}); await reopened?.shutdown().catch(() => {}); await checked?.shutdown().catch(() => {});
    await budget?.close(); await rm(root, { recursive: true, force: true });
  }
}

async function retryWorkerShutdownTest(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'm2m-coordinator-shutdown-retry-'));
  const budgetRoot = join(root, 'budget'); const coordinatorRoot = join(root, 'coordinator');
  let budget!: BudgetLedger; let coordinator: AgentCoordinator | undefined; let reopened: AgentCoordinator | undefined;
  const worker = new FlakyShutdownWorker();
  const port: ResearchPort = { execute: async ({ requestId }) => receipt('conv-shutdown-retry', requestId), cancel: async () => ({ confirmed: true }) };
  try {
    budget = await BudgetLedger.open({ stateDir: budgetRoot, create: true, limits: limits(), buyer, provider });
    coordinator = await AgentCoordinator.open({ stateDir: coordinatorRoot, create: true, conversation: 'conv-shutdown-retry', buyer, provider, budget, port,
      workerFactory: async () => worker });
    assert.equal((await coordinator.run({ id: 'task-retry-shutdown', prompt: 'Complete before shutdown.' })).state, 'completed');
    await assert.rejects(() => coordinator!.shutdown(), /worker_shutdown_uncertain/);
    assert.equal(worker.shutdownCalls, 1);
    await coordinator.shutdown(); coordinator = undefined;
    assert.equal(worker.shutdownCalls, 2);
    assert.equal(worker.closeCalls, 1);
    reopened = await AgentCoordinator.open({ stateDir: coordinatorRoot, create: false, conversation: 'conv-shutdown-retry', buyer, provider, budget, port,
      workerFactory: async () => worker });
    await reopened.shutdown(); reopened = undefined;
  } finally { await coordinator?.shutdown().catch(() => {}); await reopened?.shutdown().catch(() => {}); await budget?.close(); await rm(root, { recursive: true, force: true }); }
}

async function stalledShutdownTest(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'm2m-coordinator-shutdown-'));
  const budgetRoot = join(root, 'budget'); const coordinatorRoot = join(root, 'coordinator');
  let budget!: BudgetLedger; let coordinator: AgentCoordinator | undefined; let reopened: AgentCoordinator | undefined;
  const worker = new StalledWorker();
  const port: ResearchPort = { execute: async ({ requestId }) => receipt('conv-shutdown', requestId), cancel: async () => ({ confirmed: true }) };
  let request!: WorkRequest;
  try {
    budget = await BudgetLedger.open({ stateDir: budgetRoot, create: true, limits: limits(), buyer, provider });
    await budget.reserveFunding(nonce(40), '500'); await budget.bindChannel(binding(40));
    coordinator = await AgentCoordinator.open({ stateDir: coordinatorRoot, create: true, conversation: 'conv-shutdown', buyer, provider, budget, port,
      workerFactory: async () => worker });
    const running = coordinator.run({ id: 'task-shutdown', prompt: 'Wait for the worker.' });
    await worker.runStarted;
    // The optional shutdown hook and worker callback are both unresolved;
    // coordinator shutdown must retain the lock rather than guessing.
    await assert.rejects(() => coordinator!.shutdown(), /worker_shutdown_uncertain/);
    await assert.rejects(() => AgentCoordinator.open({ stateDir: coordinatorRoot, create: false, conversation: 'conv-shutdown', buyer, provider, budget, port,
      workerFactory: async profile => new FixtureWorker(profile, 'conv-shutdown', 'normal') }), /state_directory_in_use/);
    request = { agent: buyer.agent, conversationId: 'conv-shutdown', requestId: 'task-shutdown', prompt: 'Wait for the worker.' };
    worker.releaseRun(request); worker.releaseShutdown();
    const completed = await running;
    assert.equal(completed.state, 'uncertain');
    await coordinator.shutdown(); coordinator = undefined;
    reopened = await AgentCoordinator.open({ stateDir: coordinatorRoot, create: false, conversation: 'conv-shutdown', buyer, provider, budget, port,
      workerFactory: async profile => new FixtureWorker(profile, 'conv-shutdown', 'normal') });
    await reopened.shutdown(); reopened = undefined;
  } finally {
    worker.releaseRun(request ?? { agent: buyer.agent, conversationId: 'conv-shutdown', requestId: 'task-shutdown', prompt: 'Wait for the worker.' });
    worker.releaseShutdown();
    await coordinator?.shutdown().catch(() => {});
    await reopened?.shutdown().catch(() => {});
    await budget?.close(); await rm(root, { recursive: true, force: true });
  }
}

async function delayedAdmissionShutdownTest(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'm2m-coordinator-admission-'));
  const budgetRoot = join(root, 'budget'); const coordinatorRoot = join(root, 'coordinator');
  let budget!: BudgetLedger; let coordinator: AgentCoordinator | undefined; let releaseEvent!: () => void;
  const eventGate = new Promise<void>(resolve => { releaseEvent = resolve; });
  const port: ResearchPort = { execute: async ({ requestId }) => receipt('conv-admission', requestId), cancel: async () => ({ confirmed: true }) };
  try {
    budget = await BudgetLedger.open({ stateDir: budgetRoot, create: true, limits: limits(), buyer, provider });
    await budget.reserveFunding(nonce(41), '500'); await budget.bindChannel(binding(41));
    coordinator = await AgentCoordinator.open({ stateDir: coordinatorRoot, create: true, conversation: 'conv-admission', buyer, provider, budget, port,
      workerFactory: async profile => new FixtureWorker(profile, 'conv-admission', 'normal'),
      emit: async event => { if (event.type === 'task_started') await eventGate; } });
    const running = coordinator.run({ id: 'task-admission', prompt: 'Delay before worker admission.' });
    // Let the write-ahead journal save complete and reach the gated event.
    await new Promise<void>(resolve => setImmediate(resolve));
    await assert.rejects(() => coordinator!.shutdown(), /worker_shutdown_uncertain/);
    await assert.rejects(() => AgentCoordinator.open({ stateDir: coordinatorRoot, create: false, conversation: 'conv-admission', buyer, provider, budget, port,
      workerFactory: async profile => new FixtureWorker(profile, 'conv-admission', 'normal') }), /state_directory_in_use/);
    releaseEvent();
    const result = await running;
    assert.equal(result.state, 'cancelled');
    await coordinator.shutdown(); coordinator = undefined;
  } finally {
    releaseEvent?.();
    await coordinator?.shutdown().catch(() => {});
    await budget?.close(); await rm(root, { recursive: true, force: true });
  }
}

async function delayedSaveShutdownTest(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'm2m-coordinator-save-'));
  const budgetRoot = join(root, 'budget'); const coordinatorRoot = join(root, 'coordinator');
  let budget!: BudgetLedger; let coordinator: AgentCoordinator | undefined;
  let releaseSave!: () => void;
  let queuedPersist: Promise<void> | undefined;
  const delayedSave = new Promise<void>(resolve => { releaseSave = resolve; });
  const port: ResearchPort = { execute: async ({ requestId }) => receipt('conv-save', requestId), cancel: async () => ({ confirmed: true }) };
  try {
    budget = await BudgetLedger.open({ stateDir: budgetRoot, create: true, limits: limits(), buyer, provider });
    await budget.reserveFunding(nonce(42), '500'); await budget.bindChannel(binding(42));
    coordinator = await AgentCoordinator.open({ stateDir: coordinatorRoot, create: true, conversation: 'conv-save', buyer, provider, budget, port,
      workerFactory: async profile => new FixtureWorker(profile, 'conv-save', 'normal') });
    // A blocked durable write is a lifecycle transition even with no active
    // model turn.  This injects the same condition a slow/fsync-stalled save
    // produces without changing the production storage implementation.
    const internals = coordinator as unknown as { storage: Promise<unknown>; persist(): Promise<void> };
    internals.storage = delayedSave;
    // Queue an actual coordinator journal write behind the gated storage
    // promise; merely assigning an idle storage promise would not exercise the
    // delayed save transition that shutdown must join.
    queuedPersist = internals.persist();
    await assert.rejects(() => coordinator!.shutdown(), /worker_shutdown_uncertain/);
    await assert.rejects(() => AgentCoordinator.open({ stateDir: coordinatorRoot, create: false, conversation: 'conv-save', buyer, provider, budget, port,
      workerFactory: async profile => new FixtureWorker(profile, 'conv-save', 'normal') }), /state_directory_in_use/);
    releaseSave();
    const closed = coordinator!;
    await closed.shutdown();
    const beforeLateCancel = await readFile(join(coordinatorRoot, 'coordinator.json'), 'utf8');
    await closed.cancel();
    const afterLateCancel = await readFile(join(coordinatorRoot, 'coordinator.json'), 'utf8');
    assert.equal(afterLateCancel, beforeLateCancel);
    coordinator = undefined;
  } finally {
    releaseSave?.();
    await queuedPersist?.catch(() => {});
    await coordinator?.shutdown().catch(() => {});
    await budget?.close(); await rm(root, { recursive: true, force: true });
  }
}

await ledgerTests();
await coordinatorTests();
await lostReplyTest();
await typedNoDispatchTest();
await cancellationBeforeFactoryAdmissionTest();
await uncertainWorkerCancellationTest();
await pendingPaidCallTerminalGuardTest();
await uncertainLaunchWithoutReceiptTest();
await closedHeldFactoryPreservesPriorUncertaintyTest();
await retryWorkerShutdownTest();
await stalledShutdownTest();
await delayedAdmissionShutdownTest();
await delayedSaveShutdownTest();
console.log('agent coordinator tests: ok');
