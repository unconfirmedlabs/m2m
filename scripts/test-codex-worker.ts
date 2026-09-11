import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_CONFIG, CODEX_MODEL, CODEX_REASONING, CodexWorker, WorkerError, type AppServerRpc, type TokenUsage, type WorkerEvent, type WorkRequest } from './codex-worker.js';

type Json = Record<string, any>;
const counters = (input: number, output: number): TokenUsage => ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0 });
interface BackendState { threads: Map<string, Json>; launches: number; resumes: number; interrupts: number; plans: Array<(rpc: FakeRpc, turn: Json, params: Json) => void> }
class FakeRpc implements AppServerRpc {
  private events = new EventEmitter();
  history: Array<{ method: string; params: Json }> = [];
  disconnected = false;
  constructor(readonly state: BackendState) {}
  policy(params: Json, thread: Json): Json {
    assert.equal(params.sandbox, 'read-only');
    return { thread, model: params.model, cwd: params.cwd, reasoningEffort: params.config.model_reasoning_effort,
      approvalPolicy: params.approvalPolicy, sandbox: { type: 'readOnly', networkAccess: false }, instructionSources: [] };
  }
  async request(method: string, params: Json): Promise<Json> {
    this.history.push({ method, params: structuredClone(params) });
    if (this.disconnected) throw new WorkerError('backend_disconnected');
    if (method === 'initialize') return {};
    if (method === 'thread/start') {
      const thread = { id: `thread-${this.state.threads.size + 1}`, turns: [] };
      this.state.threads.set(thread.id, thread); return this.policy(params, thread);
    }
    if (method === 'thread/resume') {
      this.state.resumes++; return this.policy(params, this.state.threads.get(params.threadId)!);
    }
    if (method === 'thread/read') return { thread: structuredClone(this.state.threads.get(params.threadId)) };
    if (method === 'turn/start') {
      assert.equal(params.model, CODEX_MODEL); assert.equal(params.effort, CODEX_REASONING);
      assert.equal(params.sandboxPolicy.networkAccess, false);
      this.state.launches++;
      const turn = { id: `turn-${this.state.launches}`, status: 'inProgress', items: [{ type: 'userMessage', id: params.clientUserMessageId, content: params.input }] };
      this.state.threads.get(params.threadId)!.turns.push(turn);
      const plan = this.state.plans.shift();
      if (plan) plan(this, turn, params);
      if (this.disconnected) throw new WorkerError('backend_disconnected');
      return { turn: structuredClone(turn) };
    }
    if (method === 'turn/interrupt') {
      this.state.interrupts++;
      const turn = this.state.threads.get(params.threadId)!.turns.find((t: Json) => t.id === params.turnId);
      turn.status = 'interrupted';
      queueMicrotask(() => this.emit('turn/completed', { threadId: params.threadId, turn: structuredClone(turn) }));
      return {};
    }
    throw new WorkerError('unsupported_fake_rpc');
  }
  notify(): void {}
  emit(method: string, params: Json): void { if (!this.disconnected) this.events.emit('notification', method, params); }
  disconnect(): void { this.disconnected = true; this.events.emit('disconnect'); }
  onNotification(fn: (method: string, params: Json) => void): () => void { this.events.on('notification', fn); return () => this.events.off('notification', fn); }
  onDisconnect(fn: () => void): () => void { this.events.on('disconnect', fn); return () => this.events.off('disconnect', fn); }
  close(): void { this.disconnected = true; }
}
function backend(...plans: BackendState['plans']): BackendState { return { threads: new Map(), launches: 0, resumes: 0, interrupts: 0, plans }; }
function completion(text: string, total: TokenUsage, last = total): BackendState['plans'][number] {
  return (rpc, turn, params) => {
    setTimeout(() => {
      const base = { threadId: params.threadId, turnId: turn.id };
      rpc.emit('item/agentMessage/delta', { ...base, itemId: 'answer', delta: text.slice(0, 2) });
      rpc.emit('item/agentMessage/delta', { ...base, itemId: 'answer', delta: text.slice(2) });
      turn.items.push({ type: 'agentMessage', id: 'answer', text });
      rpc.emit('item/completed', { ...base, item: turn.items.at(-1) });
      rpc.emit('thread/tokenUsage/updated', { ...base, tokenUsage: { total, last } });
      rpc.emit('thread/tokenUsage/updated', { ...base, tokenUsage: { total, last } });
      rpc.emit('thread/tokenUsage/updated', { ...base, turnId: 'other-turn', tokenUsage: { total: counters(999, 999), last } });
      turn.status = 'completed'; rpc.emit('turn/completed', { threadId: params.threadId, turn });
    }, 5);
  };
}
const request: WorkRequest = { agent: 'testnet:package:domain:buyer', conversationId: 'conversation', requestId: 'request-1', prompt: 'Synthetic test question' };

async function localTests(): Promise<void> {
  const temp = mkdtempSync(join(tmpdir(), 'm2m-codex-test-'));
  try {
    {
      const state = backend(completion('Hello 🌍', counters(100, 20)), completion('Continued.', counters(150, 50), counters(50, 30)));
      const rpc = new FakeRpc(state);
      const worker = await CodexWorker.open({ stateDir: join(temp, 'basic'), rpc });
      await assert.rejects(() => CodexWorker.open({ stateDir: join(temp, 'basic'), rpc: new FakeRpc(state) }), /worker_already_open/);
      const seen: WorkerEvent[] = [];
      const first = await worker.run(request, event => { seen.push(event); });
      assert.equal(first.state, 'completed'); assert.equal(first.producedUtf8Bytes, Buffer.byteLength('Hello 🌍'));
      assert.deepEqual(first.upstreamUsage, counters(100, 20));
      assert.equal(seen.filter(e => e.type === 'usage').length, 1);
      assert.equal(seen.filter(e => e.type === 'content').map(e => e.delta).join(''), 'Hello 🌍');
      await assert.rejects(() => worker.run({ ...request, prompt: 'Changed' }), /request_content_conflict/);
      const replay: WorkerEvent[] = [];
      await worker.run(request, event => { replay.push(event); }, seen[1].index);
      assert.deepEqual(replay, seen.slice(2)); assert.equal(state.launches, 1);
      const second = await worker.run({ ...request, requestId: 'request-2', prompt: 'Continue.' });
      assert.equal(second.threadId, first.threadId); assert.equal(state.resumes, 1);
      assert.deepEqual(second.upstreamUsage, counters(50, 30));
      const start = rpc.history.find(row => row.method === 'thread/start')!;
      assert.deepEqual(start.params.config, CODEX_CONFIG);
      assert.equal(start.params.config.features.shell_tool, false); assert.equal(start.params.config.features.plugins, false);
      assert.equal(start.params.config.web_search, 'disabled');
      assert.equal(readFileSync(join(temp, 'basic', 'worker.json'), 'utf8').includes(request.prompt), false);
      worker.close();
      const reopened = await CodexWorker.open({ stateDir: join(temp, 'basic'), rpc: new FakeRpc(state) });
      assert.equal((await reopened.run(request)).turnId, first.turnId); assert.equal(state.launches, 2); reopened.close();
    }
    {
      const state = backend((rpc, turn, params) => {
        // External execution completed, but the adapter never got an RPC response.
        turn.items.push({ type: 'agentMessage', id: 'saved-answer', text: 'Recovered result' }); turn.status = 'completed'; rpc.disconnect();
      }, completion('After recovery', counters(200, 50)));
      const directory = join(temp, 'uncertain');
      const worker = await CodexWorker.open({ stateDir: directory, rpc: new FakeRpc(state) });
      assert.equal((await worker.run(request)).state, 'uncertain'); worker.close();
      const resumed = await CodexWorker.open({ stateDir: directory, rpc: new FakeRpc(state) });
      const recovered = await resumed.run(request);
      assert.equal(recovered.state, 'completed'); assert.equal(state.launches, 1);
      assert.equal(Object.values(recovered.items).join(''), 'Recovered result'); assert.equal(recovered.upstreamUsage, null);
      const continuation = await resumed.run({ ...request, requestId: 'request-2' });
      assert.equal(continuation.upstreamUsage, null, 'missing prior telemetry cannot become invented per-turn usage');
      resumed.close();
    }
    {
      const state = backend((rpc, turn) => { turn.items = []; rpc.disconnect(); });
      const directory = join(temp, 'unrecoverable');
      const worker = await CodexWorker.open({ stateDir: directory, rpc: new FakeRpc(state) });
      await worker.run(request); worker.close();
      const resumed = await CodexWorker.open({ stateDir: directory, rpc: new FakeRpc(state) });
      assert.equal((await resumed.run(request)).state, 'uncertain');
      assert.equal((await resumed.run(request)).state, 'uncertain'); assert.equal(state.launches, 1);
      await assert.rejects(() => resumed.run({ ...request, requestId: 'new-request' }), /conversation_busy/); resumed.close();
    }
    {
      const state = backend((rpc, turn, params) => { setTimeout(() => {
        turn.items.push({ type: 'agentMessage', id: 'partial', text: 'Partial output' });
        rpc.emit('item/agentMessage/delta', { threadId: params.threadId, turnId: turn.id, itemId: 'partial', delta: 'Partial output' });
      }, 5); });
      const worker = await CodexWorker.open({ stateDir: join(temp, 'cancel'), rpc: new FakeRpc(state) });
      const result = await worker.run(request, event => event.type === 'content' ? false : undefined);
      assert.equal(result.state, 'cancelled'); assert.equal(state.interrupts, 1);
      assert.equal(Object.values(result.items).join(''), 'Partial output'); worker.close();
    }
    {
      const state = backend((rpc, turn, params) => { setTimeout(() => {
        turn.items.push({ type: 'agentMessage', id: 'partial', text: 'Stop here' });
        rpc.emit('item/agentMessage/delta', { threadId: params.threadId, turnId: turn.id, itemId: 'partial', delta: 'Stop here' });
      }, 5); });
      const rpc = new FakeRpc(state); const originalRequest = rpc.request.bind(rpc);
      rpc.request = async (method, params) => {
        if (method === 'turn/interrupt') throw new WorkerError('backend_disconnected');
        return originalRequest(method, params);
      };
      const directory = join(temp, 'cancel-recovery');
      const worker = await CodexWorker.open({ stateDir: directory, rpc });
      const result = await worker.run(request, event => event.type === 'content' ? false : undefined);
      assert.equal(result.state, 'uncertain'); assert.ok(result.cancelRequestedAt); worker.close();
      const reopened = await CodexWorker.open({ stateDir: directory, rpc: new FakeRpc(state) });
      const recovered = await reopened.run(request);
      assert.equal(recovered.state, 'cancelled'); assert.equal(state.launches, 1);
      assert.equal(state.interrupts, 1, 'restart must reissue a persisted, unconfirmed interrupt'); reopened.close();
    }
    {
      const state = backend(() => {});
      const worker = await CodexWorker.open({ stateDir: join(temp, 'timeout'), rpc: new FakeRpc(state), maxDurationMs: 40 });
      const result = await worker.run(request); assert.equal(result.state, 'cancelled'); assert.equal(state.interrupts, 1); worker.close();
    }
    {
      const state = backend((rpc, turn, params) => { setTimeout(() => {
        rpc.emit('item/agentMessage/delta', { threadId: params.threadId, turnId: turn.id, itemId: 'answer', delta: 'exceeds the output cap' });
      }, 5); });
      const worker = await CodexWorker.open({ stateDir: join(temp, 'output-limit'), rpc: new FakeRpc(state), maxOutputBytes: 5 });
      const result = await worker.run(request); assert.equal(result.state, 'cancelled'); assert.equal(result.producedUtf8Bytes, 0);
      assert.equal(result.reason, 'output_limit'); assert.equal(state.interrupts, 1); worker.close();
    }
    {
      const state = backend();
      const rpc = new FakeRpc(state);
      const policy = rpc.policy.bind(rpc);
      rpc.policy = (params, thread) => ({ ...policy(params, thread), model: 'wrong-model' });
      const worker = await CodexWorker.open({ stateDir: join(temp, 'policy'), rpc });
      const result = await worker.run(request);
      assert.equal(result.reason, 'backend_policy_mismatch'); assert.equal(state.launches, 0); worker.close();
    }
    {
      const state = backend((rpc, turn, params) => {
        rpc.emit('turn/started', { threadId: params.threadId, turn });
        turn.items.push({ type: 'agentMessage', id: 'answer', text: 'Partial' });
        rpc.emit('item/agentMessage/delta', { threadId: params.threadId, turnId: turn.id, itemId: 'answer', delta: 'Partial' });
        rpc.disconnect();
      });
      const directory = join(temp, 'partial-recovery');
      const worker = await CodexWorker.open({ stateDir: directory, rpc: new FakeRpc(state) });
      const partial = await worker.run(request); assert.equal(partial.state, 'uncertain'); worker.close();
      const savedTurn = state.threads.get(partial.threadId!)!.turns[0];
      savedTurn.items.at(-1).text = 'Partial recovered'; savedTurn.status = 'completed';
      const resumed = await CodexWorker.open({ stateDir: directory, rpc: new FakeRpc(state) });
      const recoveredEvents: WorkerEvent[] = [];
      const recovered = await resumed.run(request, e => { recoveredEvents.push(e); }, partial.events.length - 1);
      assert.equal(recovered.state, 'completed'); assert.equal(state.launches, 1);
      assert.equal(recoveredEvents.filter(e => e.type === 'content').map(e => e.delta).join(''), ' recovered');
      assert.equal(recovered.producedUtf8Bytes, Buffer.byteLength('Partial recovered')); resumed.close();
    }
    {
      const state = backend((rpc, turn, params) => {
        setTimeout(() => {
          rpc.emit('thread/tokenUsage/updated', { threadId: params.threadId, turnId: turn.id, tokenUsage: { total: { ...counters(10, 1), cachedInputTokens: 20 }, last: counters(10, 1) } });
        }, 5);
      });
      const worker = await CodexWorker.open({ stateDir: join(temp, 'bad-usage'), rpc: new FakeRpc(state) });
      const result = await worker.run(request); assert.equal(result.upstreamUsage, null); assert.ok(['uncertain', 'cancelled'].includes(result.state)); worker.close();
    }
    console.log('Codex worker: persistence, duplicate/conflict, continuation, usage attribution, uncertain launch recovery, partial cancellation, duration and policy checks passed.');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

async function liveProbe(): Promise<void> {
  const stateDir = process.env.M2M_CODEX_PROBE_STATE_DIR;
  if (!stateDir) throw new WorkerError('live_probe_requires_private_state_directory');
  if (existsSync(join(stateDir, 'worker.json'))) throw new WorkerError('live_probe_requires_fresh_state_directory');
  const worker = await CodexWorker.open({ stateDir, authFile: process.env.M2M_CODEX_AUTH_FILE, apiKey: process.env.M2M_CODEX_API_KEY, maxDurationMs: 60_000, maxOutputBytes: 8192 });
  const observations: Array<Record<string, unknown>> = [];
  const started = Date.now();
  try {
    const result = await worker.run({ agent: 'synthetic:local:test:buyer', conversationId: 'live-probe', requestId: 'probe-1',
      prompt: 'For an integration test, explain in 100 to 140 words why duplicate request IDs should not trigger duplicate external work. Use no tools, make no external requests, and mention no local files or settings.' }, event => {
      observations.push({ type: event.type, elapsedMs: Date.now() - started, ...(event.type === 'content' ? { bytes: Buffer.byteLength(event.delta) } : {}), ...(event.type === 'usage' ? { requestUsage: event.requestUsage } : {}) });
    });
    console.log(JSON.stringify({ model: CODEX_MODEL, reasoning: CODEX_REASONING, state: result.state, reason: result.reason,
      elapsedMs: Date.now() - started, producedUtf8Bytes: result.producedUtf8Bytes, upstreamUsage: result.upstreamUsage, observations }));
    if (result.state !== 'completed' || !result.usageObserved) process.exitCode = 2;
  } finally { worker.close(); }
}
async function liveContinuation(): Promise<void> {
  const stateDir = process.env.M2M_CODEX_PROBE_STATE_DIR;
  if (!stateDir) throw new WorkerError('live_probe_requires_private_state_directory');
  const worker = await CodexWorker.open({ stateDir, authFile: process.env.M2M_CODEX_AUTH_FILE, apiKey: process.env.M2M_CODEX_API_KEY, maxDurationMs: 60_000, maxOutputBytes: 8192 });
  const original: WorkRequest = { agent: 'synthetic:local:test:buyer', conversationId: 'live-probe', requestId: 'probe-1',
    prompt: 'For an integration test, explain in 100 to 140 words why duplicate request IDs should not trigger duplicate external work. Use no tools, make no external requests, and mention no local files or settings.' };
  try {
    const before = worker.status(original);
    if (before?.state !== 'completed') throw new WorkerError('live_continuation_requires_completed_probe');
    const replay = await worker.run(original);
    assert.deepEqual(replay, before, 'replaying a saved request must not modify or relaunch it');
    const started = Date.now();
    const continuation = await worker.run({ ...original, requestId: 'probe-2', prompt: 'Continue our previous discussion: summarize the reason for suppressing duplicate external work in one sentence, under 35 words. Use no tools.' });
    console.log(JSON.stringify({ model: CODEX_MODEL, reasoning: CODEX_REASONING, state: continuation.state, reason: continuation.reason,
      elapsedMs: Date.now() - started, originalReplayUnchanged: JSON.stringify(replay) === JSON.stringify(before),
      sameThread: continuation.threadId === before.threadId, distinctTurn: continuation.turnId !== before.turnId,
      producedUtf8Bytes: continuation.producedUtf8Bytes, baselineUsage: continuation.baselineUsage, upstreamUsage: continuation.upstreamUsage,
      contentEvents: continuation.events.filter(e => e.type === 'content').length, usageEvents: continuation.events.filter(e => e.type === 'usage').length }));
    if (continuation.state !== 'completed' || !continuation.usageObserved || continuation.threadId !== before.threadId || continuation.turnId === before.turnId) process.exitCode = 2;
  } finally { worker.close(); }
}
if (process.argv.includes('--live-continue')) await liveContinuation();
else if (process.argv.includes('--live')) await liveProbe();
else await localTests();
