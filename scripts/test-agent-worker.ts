import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_MODEL, CODEX_REASONING, CodexWorker, WorkerError, type AppServerRpc, type TokenUsage, type WorkRequest } from './codex-worker.js';
import type { AgentProfile } from './agent-service-types.js';

type Json = Record<string, any>;
const usage: TokenUsage = { totalTokens: 2, inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 };
class ProfileRpc implements AppServerRpc {
  readonly events = new EventEmitter(); readonly history: Array<{ method: string; params: Json }> = []; handler?: (method: string, params: Json) => Promise<Json>; thread = { id: 'thread-1', turns: [] as Json[] }; calls = 0; turnCount = 0;
  async request(method: string, params: Json): Promise<Json> {
    this.history.push({ method, params });
    if (method === 'initialize') return {};
    if (method === 'thread/start' || method === 'thread/resume') return { thread: this.thread, model: CODEX_MODEL, reasoningEffort: CODEX_REASONING, approvalPolicy: 'never', sandbox: { type: 'readOnly', networkAccess: false }, cwd: params.cwd, instructionSources: [], dynamicTools: params.dynamicTools };
    if (method === 'turn/start') {
      this.turnCount++; const turnId = `turn-${this.turnCount}`; const callId = `call-${this.turnCount}`; const turn = { id: turnId, status: 'inProgress', items: [] as Json[] }; this.thread.turns.push(turn);
      setTimeout(() => {
        if (this.handler) void this.handler('item/tool/call', { threadId: 'thread-1', turnId: turnId, callId, namespace: null, tool: 'status', arguments: { detail: 'brief' } });
        this.events.emit('notification', 'item/started', { threadId: 'thread-1', turnId: turnId, item: { type: 'dynamicToolCall', id: callId, tool: 'status' } });
        setTimeout(() => { turn.status = 'completed'; turn.items.push({ type: 'agentMessage', id: 'answer', text: 'done' }); this.events.emit('notification', 'item/agentMessage/delta', { threadId: 'thread-1', turnId: turnId, itemId: 'answer', delta: 'done' }); this.events.emit('notification', 'thread/tokenUsage/updated', { threadId: 'thread-1', turnId: turnId, tokenUsage: { total: usage, last: usage } }); this.events.emit('notification', 'turn/completed', { threadId: 'thread-1', turn }); }, 5);
      }, 2);
      return { turn };
    }
    if (method === 'thread/read') return { thread: this.thread };
    return {};
  }
  notify(method: string, params: Json): void { this.history.push({ method, params }); }
  onNotification(listener: (method: string, params: Json) => void): () => void { this.events.on('notification', listener); return () => this.events.off('notification', listener); }
  onDisconnect(listener: () => void): () => void { this.events.on('disconnect', listener); return () => this.events.off('disconnect', listener); }
  onServerRequest(handler: (method: string, params: Json) => Promise<Json>): () => void { this.handler = handler; return () => { if (this.handler === handler) this.handler = undefined; }; }
  close(): void {}
}
const profile = (baseInstructions = 'bounded'): AgentProfile => ({ id: 'test-profile', baseInstructions, developerInstructions: 'tools only', tools: [{ name: 'status', description: 'Read status.', inputSchema: { type: 'object', properties: { detail: { type: 'string', minLength: 1 } }, required: ['detail'], additionalProperties: false } }], maxToolCalls: 4, maxToolResultBytes: 4096, recoverableTools: ['status'], handleTool: async call => ({ success: true, text: JSON.stringify({ ok: true, callId: call.callId }) }) });
const request: WorkRequest = { agent: 'test:buyer', conversationId: 'conversation', requestId: 'request-1', prompt: 'question' };

async function tests(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'm2m-agent-worker-'));
  try {
    const rpc = new ProfileRpc(); const worker = await CodexWorker.open({ stateDir: join(root, 'profile'), rpc, agentProfile: profile() });
    const result = await worker.run(request); assert.equal(result.state, 'completed'); assert.equal(result.turnId, 'turn-1'); assert.equal(result.producedUtf8Bytes, 4);
    const start = rpc.history.find(item => item.method === 'thread/start')!; assert.equal(start.params.dynamicTools[0].name, 'status'); assert.equal(start.params.dynamicTools[0].type, 'function');
    const second = await worker.run({ ...request, requestId: 'request-2', prompt: 'follow-up' }); assert.equal(second.state, 'completed');
    const resume = rpc.history.find(item => item.method === 'thread/resume')!; assert.equal(resume.params.dynamicTools, undefined);
    const saved = await rpc.handler!('item/tool/call', { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1', namespace: null, tool: 'status', arguments: { detail: 'brief' } }); assert.equal(saved.success, true);
    await assert.rejects(() => rpc.handler!('item/tool/call', { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1', namespace: null, tool: 'status', arguments: { detail: 'changed' } }), /tool_call_conflict/);
    await assert.rejects(() => rpc.handler!('item/tool/call', { threadId: 'thread-1', turnId: 'turn-1', callId: 'wrong', namespace: 'bad', tool: 'status', arguments: { detail: 'brief' } }), /invalid_tool_call/); worker.close();
    const reopened = await CodexWorker.open({ stateDir: join(root, 'profile'), rpc: new ProfileRpc(), agentProfile: profile() }); reopened.close();
    await assert.rejects(() => CodexWorker.open({ stateDir: join(root, 'profile'), rpc: new ProfileRpc(), agentProfile: profile('changed') }), /agent_profile_mismatch/);
    unlinkSync(join(root, 'profile', 'worker.initialized')); await assert.rejects(() => CodexWorker.open({ stateDir: join(root, 'profile'), rpc: new ProfileRpc(), agentProfile: profile() }), /journal_missing/);
    const pendingDir = join(root, 'pending-recoverable'); const seeded = await CodexWorker.open({ stateDir: pendingDir, rpc: new ProfileRpc(), agentProfile: profile() }); await seeded.run(request); seeded.close();
    const pendingFile = join(pendingDir, 'worker.json'); const pendingJournal = JSON.parse(readFileSync(pendingFile, 'utf8'));
    const pendingKey = Object.keys(pendingJournal.requests)[0]; const pendingRecord = pendingJournal.requests[pendingKey];
    pendingRecord.state = 'running'; pendingRecord.threadId = 'thread-1'; pendingRecord.turnId = 'turn-pending'; pendingRecord.knownTurnIds = ['turn-pending'];
    pendingRecord.toolCalls = { 'recoverable-call': { threadId: 'thread-1', turnId: 'turn-pending', callId: 'recoverable-call', name: 'status', arguments: { detail: 'brief' },
      argumentsDigest: createHash('sha256').update('{"detail":"brief"}').digest('hex'), state: 'pending' } };
    const pendingConversation = pendingJournal.conversations[Object.keys(pendingJournal.conversations)[0]];
    pendingConversation.threadId = 'thread-1'; pendingConversation.activeRequest = pendingKey; writeFileSync(pendingFile, JSON.stringify(pendingJournal));
    const pendingRpc = new ProfileRpc(); pendingRpc.thread = { id: 'thread-1', turns: [{ id: 'turn-pending', status: 'inProgress', items: [] }] };
    const recovered = await CodexWorker.open({ stateDir: pendingDir, rpc: pendingRpc, agentProfile: profile() });
    const reconciled = await recovered.reconcile(request); assert.equal(reconciled?.state, 'running'); assert.equal(reconciled?.toolCalls?.['recoverable-call']?.state, 'pending');
    assert.equal(pendingRpc.history.some(item => item.method === 'thread/resume' && item.params.dynamicTools !== undefined), false);
    recovered.close();
    await assert.rejects(CodexWorker.open({ stateDir: join(root, 'live-gated'), agentProfile: profile() }), /agent_tool_runtime_unvalidated/);
    const noProfileRpc = new ProfileRpc(); const noProfile = await CodexWorker.open({ stateDir: join(root, 'default'), rpc: noProfileRpc }); assert.equal(noProfileRpc.handler, undefined); noProfile.close();
    const legacyRpc = new ProfileRpc(); const legacy = await CodexWorker.open({ stateDir: join(root, 'legacy'), rpc: legacyRpc }); legacy.close(); await assert.rejects(() => CodexWorker.open({ stateDir: join(root, 'legacy'), rpc: new ProfileRpc(), agentProfile: profile() }), /legacy_worker_journal/);
  } finally { rmSync(root, { recursive: true, force: true }); }
  console.log('Agent worker: opt-in registration, early launch-time tool binding, durable duplicate/conflict handling, profile fingerprint and legacy denial passed.');
}
await tests();
