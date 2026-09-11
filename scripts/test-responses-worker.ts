import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentProfile } from './agent-service-types.js';
import type { ResponsesEvent, ResponsesSnapshot, ResponsesTransport, ResponsesCreateBody, ResponsesHttpOptions } from './responses-transport.js';
import { ResponsesWorker, type AgentRuntimeDescriptor } from './responses-worker.js';
import { openAgentWorker, responsesLimits } from './agent-runtime.js';
import { runResponsesLiveProbe } from './test-responses-live.js';

function deferred<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void; reject(error?: unknown): void } {
  let resolve!: (value: T | PromiseLike<T>) => void; let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

const descriptor: AgentRuntimeDescriptor = { version: 1, kind: 'responses-tools-v1', model: 'gpt-5.6-luna', reasoning: 'xhigh' };
const ref = { agent: 'buyer:one', conversationId: 'conversation', requestId: 'request-1' };

class FixtureTransport implements ResponsesTransport {
  readonly bodies: ResponsesCreateBody[] = []; readonly responseIds: string[] = []; readonly snapshots = new Map<string, ResponsesSnapshot>(); creates = 0; cancels = 0; argumentText = '{"detail":"brief"}'; invalidMetadata = false;
  close(): void {}
  private options(_options: ResponsesHttpOptions): void {}
  async create(body: ResponsesCreateBody, options: ResponsesHttpOptions & { clientRequestId: string }): Promise<AsyncIterable<ResponsesEvent>> {
    this.options(options); this.bodies.push(structuredClone(body)); const id = `resp-${++this.creates}`; this.responseIds.push(id);
    const execution = { model: this.invalidMetadata ? 'gpt-5.6-other' : 'gpt-5.6-luna', reasoning: { effort: 'xhigh' }, instructions: body.instructions, tools: (body.tools as unknown[]), tool_choice: 'auto', parallel_tool_calls: false, background: true, stream: true, store: true, truncation: 'disabled', max_output_tokens: body.max_output_tokens, previous_response_id: body.previous_response_id ?? null };
    const isFirst = this.creates === 1; const events: ResponsesEvent[] = [
      { type: 'response.created', sequence_number: 0, response: { id, ...execution, status: 'in_progress' } },
    ];
    if (isFirst) {
      events.push({ type: 'response.output_text.delta', sequence_number: 1, response_id: id, item_id: 'answer', output_index: 0, content_index: 0, delta: 'fresh ' });
      events.push({ type: 'response.output_item.added', sequence_number: 2, response_id: id, item: { type: 'function_call', id: 'call-item-1', call_id: 'upstream-call-1', name: 'status', arguments: '' } });
      events.push({ type: 'response.function_call_arguments.done', sequence_number: 3, response_id: id, item_id: 'call-item-1', arguments: this.argumentText });
      events.push({ type: 'response.completed', sequence_number: 4, response_id: id, response: { id, ...execution, status: 'completed', output: [
        { type: 'message', id: 'answer', role: 'assistant', content: [{ type: 'output_text', text: 'fresh ' }] },
        { type: 'function_call', id: 'call-item-1', call_id: 'upstream-call-1', name: 'status', arguments: this.argumentText },
      ], usage: { input_tokens: 4, output_tokens: 3, input_tokens_details: { cached_tokens: 1 }, output_tokens_details: { reasoning_tokens: 1 } } } });
    } else {
      events.push({ type: 'response.output_text.delta', sequence_number: 1, response_id: id, item_id: 'answer', output_index: 0, content_index: 0, delta: 'continued' });
      events.push({ type: 'response.completed', sequence_number: 2, response_id: id, response: { id, ...execution, status: 'completed', output: [{ type: 'message', id: 'answer', role: 'assistant', content: [{ type: 'output_text', text: 'continued' }] }], usage: { input_tokens: 4, output_tokens: 3, input_tokens_details: { cached_tokens: 1 }, output_tokens_details: { reasoning_tokens: 1 } } } });
    }
    this.snapshots.set(id, { id, ...execution, status: 'completed', output: events.at(-1)?.response && (events.at(-1)!.response as Record<string, unknown>).output, usage: { input_tokens: 4, output_tokens: 3, input_tokens_details: { cached_tokens: 1 }, output_tokens_details: { reasoning_tokens: 1 } } });
    return (async function* (): AsyncIterable<ResponsesEvent> { for (const event of events) yield event; })();
  }
  async retrieve(id: string, options: ResponsesHttpOptions): Promise<ResponsesSnapshot> { this.options(options); const snapshot = this.snapshots.get(id); if (!snapshot) throw new Error('missing'); return structuredClone(snapshot); }
  async resume(id: string, _after: number, options: ResponsesHttpOptions): Promise<AsyncIterable<ResponsesEvent>> { this.options(options); const snapshot = this.snapshots.get(id); return (async function* (): AsyncIterable<ResponsesEvent> { yield { type: 'response.completed', sequence_number: 99, response_id: id, response: { ...snapshot, id, status: 'completed' } }; })(); }
  async cancel(id: string, options: ResponsesHttpOptions): Promise<ResponsesSnapshot> { this.options(options); this.cancels++; return { id, status: 'cancelled' }; }
}

class NoAcknowledgementTransport implements ResponsesTransport {
  creates = 0; close(): void {}
  async create(_body: ResponsesCreateBody, _options: ResponsesHttpOptions & { clientRequestId: string }): Promise<AsyncIterable<ResponsesEvent>> { this.creates++; return (async function* (): AsyncIterable<ResponsesEvent> {})(); }
  async retrieve(_id: string, _options: ResponsesHttpOptions): Promise<ResponsesSnapshot> { throw new Error('not reached'); }
  async resume(_id: string, _after: number, _options: ResponsesHttpOptions): Promise<AsyncIterable<ResponsesEvent>> { throw new Error('not reached'); }
  async cancel(id: string, _options: ResponsesHttpOptions): Promise<ResponsesSnapshot> { return { id, status: 'cancelled' }; }
}

function profile(calls: string[]): AgentProfile {
  return { id: 'responses-test', baseInstructions: 'base', developerInstructions: 'developer', tools: [{ name: 'status', description: 'status', inputSchema: { type: 'object', properties: { detail: { type: 'string', minLength: 1, maxLength: 64 } }, required: ['detail'], additionalProperties: false } }], maxToolCalls: 4, maxToolResultBytes: 4096, recoverableTools: ['status'], handleTool: async call => { calls.push(call.callId); return { success: true, text: JSON.stringify({ ok: true, detail: (call.arguments as { detail: string }).detail }) }; } };
}

async function tests(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'm2m-responses-worker-')); const calls: string[] = []; const transport = new FixtureTransport();
  try {
    const worker = await ResponsesWorker.open({ stateDir: join(root, 'worker'), create: true, descriptor, profile: profile(calls), limits: responsesLimits('provider'), transport });
    const events: number[] = []; const result = await worker.run({ ...ref, prompt: 'question' }, event => { events.push(event.index); });
    assert.equal(result.state, 'completed'); assert.equal(result.knownTurnIds.length, 2); assert.equal(result.items[`${result.knownTurnIds[0]}:answer:0`], 'fresh '); assert.equal(result.items[`${result.knownTurnIds[1]}:answer:0`], 'continued'); assert.equal(calls.length, 1); assert.equal(transport.creates, 2);
    assert.deepEqual(transport.bodies[0], { model: 'gpt-5.6-luna', reasoning: { effort: 'xhigh' }, instructions: 'base\n\ndeveloper', tools: [{ type: 'function', name: 'status', description: 'status', parameters: { type: 'object', properties: { detail: { type: 'string', minLength: 1, maxLength: 64 } }, required: ['detail'], additionalProperties: false }, strict: true }], tool_choice: 'auto', parallel_tool_calls: false, background: true, stream: true, store: true, truncation: 'disabled', max_output_tokens: 4096, input: [{ role: 'user', content: [{ type: 'input_text', text: 'question' }] }] });
    const continuation = transport.bodies[1].input as Array<Record<string, unknown>>; assert.deepEqual(continuation, [{ type: 'function_call_output', call_id: 'upstream-call-1', output: JSON.stringify({ success: true, text: JSON.stringify({ ok: true, detail: 'brief' }) }) }]);
    const status = worker.status(ref)!; assert.deepEqual(status.events.map(event => event.index), events); assert.equal(worker.diagnostics(ref)?.usage[0].inputTokens, 4); await worker.shutdown();
    const reopenedTransport = new FixtureTransport(); const reopened = await ResponsesWorker.open({ stateDir: join(root, 'worker'), create: false, descriptor, profile: profile([]), limits: responsesLimits('provider'), transport: reopenedTransport });
    const replay = await reopened.run({ ...ref, prompt: 'question' }, undefined, -1); assert.equal(replay.state, 'completed'); assert.equal(reopenedTransport.creates, 0);
    const next = await reopened.run({ ...ref, requestId: 'request-2', prompt: 'next question' }); assert.equal(next.state, 'completed'); assert.equal(reopenedTransport.creates, 2); assert.equal(reopenedTransport.bodies[0].previous_response_id, replay.knownTurnIds.at(-1)); await reopened.shutdown();
    const journal = JSON.parse(readFileSync(join(root, 'worker', 'responses-worker.json'), 'utf8')); assert.equal(journal.runtime, 'responses-tools-v1'); assert.equal(journal.requests[Object.keys(journal.requests)[0]].runtime, 'responses-tools-v1');
    await assert.rejects(() => ResponsesWorker.open({ stateDir: join(root, 'worker'), create: false, descriptor, profile: { ...profile([]), baseInstructions: 'changed' }, limits: responsesLimits('provider'), transport: new FixtureTransport() }), /runtime_profile_mismatch/);
    await assert.rejects(() => ResponsesWorker.open({ stateDir: join(root, 'worker'), create: true, descriptor, profile: profile([]), limits: responsesLimits('provider'), transport: new FixtureTransport() }), /journal_already_initialized/);
    assert.throws(() => responsesLimits('provider', { maxResponses: 0 }), /invalid_limit/);
    const malformedCalls: string[] = []; const malformedTransport = new FixtureTransport(); malformedTransport.argumentText = '{"detail":"brief","detail":"changed"}'; const malformed = await ResponsesWorker.open({ stateDir: join(root, 'malformed'), create: true, descriptor, profile: profile(malformedCalls), limits: responsesLimits('provider'), transport: malformedTransport }); const malformedResult = await malformed.run({ ...ref, requestId: 'malformed', prompt: 'question' }); assert.equal(malformedResult.state, 'uncertain'); assert.equal(malformedCalls.length, 0); await malformed.shutdown();
    const unicodeCalls: string[] = []; const unicodeTransport = new FixtureTransport(); unicodeTransport.argumentText = '{"detail":"\\ud800"}'; const unicode = await ResponsesWorker.open({ stateDir: join(root, 'unicode-args'), create: true, descriptor, profile: profile(unicodeCalls), limits: responsesLimits('provider'), transport: unicodeTransport }); const unicodeResult = await unicode.run({ ...ref, requestId: 'unicode-args', prompt: 'question' }); assert.equal(unicodeResult.state, 'uncertain'); assert.equal(unicodeCalls.length, 0); await unicode.shutdown();
    const policyTransport = new FixtureTransport(); policyTransport.invalidMetadata = true; const policy = await ResponsesWorker.open({ stateDir: join(root, 'policy'), create: true, descriptor, profile: profile([]), limits: responsesLimits('provider'), transport: policyTransport }); const policyResult = await policy.run({ ...ref, requestId: 'policy', prompt: 'question' }); assert.equal(policyResult.state, 'uncertain'); assert.equal(policyResult.knownTurnIds.length, 1); assert.equal(policyTransport.creates, 1); assert.equal((await policy.cancel({ ...ref, requestId: 'policy' }))?.state, 'cancelled'); await policy.shutdown();
    const noAckTransport = new NoAcknowledgementTransport(); const noAck = await ResponsesWorker.open({ stateDir: join(root, 'no-ack'), create: true, descriptor, profile: profile([]), limits: responsesLimits('provider'), transport: noAckTransport }); const noAckResult = await noAck.run({ ...ref, requestId: 'no-ack', prompt: 'question' }); assert.equal(noAckResult.state, 'uncertain'); assert.equal(noAckTransport.creates, 1); await noAck.shutdown(); const noAckReopen = await ResponsesWorker.open({ stateDir: join(root, 'no-ack'), create: false, descriptor, profile: profile([]), limits: responsesLimits('provider'), transport: noAckTransport }); const noRepeat = await noAckReopen.run({ ...ref, requestId: 'no-ack', prompt: 'question' }); assert.equal(noRepeat.state, 'uncertain'); assert.equal(noAckTransport.creates, 1); await noAckReopen.shutdown();
    const legacyDir = join(root, 'legacy'); const legacyTransport = new FixtureTransport(); await ResponsesWorker.open({ stateDir: legacyDir, create: true, descriptor, profile: profile([]), limits: responsesLimits('provider'), transport: legacyTransport }).then(worker => worker.shutdown()); const legacyJournal = readFileSync(join(legacyDir, 'responses-worker.json'), 'utf8'); writeFileSync(join(legacyDir, 'worker.json'), legacyJournal); await assert.rejects(() => ResponsesWorker.open({ stateDir: legacyDir, create: false, descriptor, profile: profile([]), limits: responsesLimits('provider'), transport: new FixtureTransport() }), /legacy_worker_journal/); rmSync(join(legacyDir, 'responses-worker.json')); await assert.rejects(() => ResponsesWorker.open({ stateDir: legacyDir, create: false, descriptor, profile: profile([]), limits: responsesLimits('provider'), transport: new FixtureTransport() }), /legacy_worker_journal/);
    const corruptDir = join(root, 'corrupt'); const corruptTransport = new NoAcknowledgementTransport(); const corruptWorker = await ResponsesWorker.open({ stateDir: corruptDir, create: true, descriptor, profile: profile([]), limits: responsesLimits('provider'), transport: corruptTransport }); await corruptWorker.run({ ...ref, requestId: 'corrupt', prompt: 'question' }); await corruptWorker.shutdown(); const corruptFile = join(corruptDir, 'responses-worker.json'); const corruptJournal = JSON.parse(readFileSync(corruptFile, 'utf8')) as { requests: Record<string, { events: Array<{ index: number }> }> }; Object.values(corruptJournal.requests)[0].events[0].index = 99; writeFileSync(corruptFile, JSON.stringify(corruptJournal)); await assert.rejects(() => ResponsesWorker.open({ stateDir: corruptDir, create: false, descriptor, profile: profile([]), limits: responsesLimits('provider'), transport: new NoAcknowledgementTransport() }), /journal_corrupt/);
    const duplicateJournalDir = join(root, 'duplicate-journal'); const duplicateJournalWorker = await ResponsesWorker.open({ stateDir: duplicateJournalDir, create: true, descriptor, profile: profile([]), limits: responsesLimits('provider'), transport: new NoAcknowledgementTransport() }); await duplicateJournalWorker.shutdown(); writeFileSync(join(duplicateJournalDir, 'responses-worker.json'), '{"version":1,"version":1}'); await assert.rejects(() => ResponsesWorker.open({ stateDir: duplicateJournalDir, create: false, descriptor, profile: profile([]), limits: responsesLimits('provider'), transport: new NoAcknowledgementTransport() }), /duplicate_json_key|journal_corrupt/);
    const unicodeJournalDir = join(root, 'unicode-journal'); const unicodeJournalWorker = await ResponsesWorker.open({ stateDir: unicodeJournalDir, create: true, descriptor, profile: profile([]), limits: responsesLimits('provider'), transport: new NoAcknowledgementTransport() }); await unicodeJournalWorker.shutdown(); writeFileSync(join(unicodeJournalDir, 'responses-worker.json'), '{"version":1,"runtime":"responses-tools-v1","x":"\\ud800"}'); await assert.rejects(() => ResponsesWorker.open({ stateDir: unicodeJournalDir, create: false, descriptor, profile: profile([]), limits: responsesLimits('provider'), transport: new NoAcknowledgementTransport() }), /invalid_unicode|journal_corrupt/);
    const missingDir = join(root, 'missing-journal'); const missingWorker = await ResponsesWorker.open({ stateDir: missingDir, create: true, descriptor, profile: profile([]), limits: responsesLimits('provider'), transport: new NoAcknowledgementTransport() }); await missingWorker.shutdown(); rmSync(join(missingDir, 'responses-worker.json')); await assert.rejects(() => ResponsesWorker.open({ stateDir: missingDir, create: false, descriptor, profile: profile([]), limits: responsesLimits('provider'), transport: new NoAcknowledgementTransport() }), /journal_missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
  console.log('Responses worker: exact strict body/tool loop, durable call result reuse, predecessor continuation, replay, diagnostics and profile gate passed (fixture-only).');
}

export async function runLiveProbe(continueConversation = false): Promise<void> {
  await runResponsesLiveProbe(continueConversation);
}

function responseMetadata(body: ResponsesCreateBody, id: string): Record<string, unknown> {
  return { id, model: body.model, reasoning: body.reasoning, instructions: body.instructions, tools: body.tools,
    tool_choice: body.tool_choice, parallel_tool_calls: body.parallel_tool_calls, background: body.background,
    store: body.store, truncation: body.truncation, max_output_tokens: body.max_output_tokens,
    previous_response_id: body.previous_response_id ?? null };
}

class ContinuationNoAckTransport implements ResponsesTransport {
  creates = 0; readonly cancelIds: string[] = []; close(): void {}
  async create(body: ResponsesCreateBody, _options: ResponsesHttpOptions & { clientRequestId: string }): Promise<AsyncIterable<ResponsesEvent>> {
    this.creates++;
    if (this.creates > 1) return (async function* (): AsyncIterable<ResponsesEvent> {})();
    const id = 'continuation-1'; const metadata = responseMetadata(body, id);
    const events: ResponsesEvent[] = [
      { type: 'response.created', sequence_number: 0, response: { ...metadata, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', sequence_number: 1, item: { id: 'call-item', type: 'function_call', call_id: 'continuation-call', name: 'status', arguments: '' } },
      { type: 'response.function_call_arguments.done', sequence_number: 2, item_id: 'call-item', arguments: '{"detail":"brief"}' },
      { type: 'response.completed', sequence_number: 3, response: { ...metadata, status: 'completed', output: [{ type: 'function_call', id: 'call-item', call_id: 'continuation-call', name: 'status', arguments: '{"detail":"brief"}' }], usage: null } },
    ];
    return (async function* () { for (const event of events) yield event; })();
  }
  async retrieve(): Promise<ResponsesSnapshot> { throw new Error('not expected'); }
  async resume(): Promise<AsyncIterable<ResponsesEvent>> { throw new Error('not expected'); }
  async cancel(id: string): Promise<ResponsesSnapshot> { this.cancelIds.push(id); return { id, status: 'cancelled' }; }
}

/** A successor acknowledges, then completes only when recovered. */
class AcknowledgedSuccessorTransport implements ResponsesTransport {
  creates = 0; retrieves = 0; readonly bodies: ResponsesCreateBody[] = []; close(): void {}
  async create(body: ResponsesCreateBody, _options: ResponsesHttpOptions & { clientRequestId: string }): Promise<AsyncIterable<ResponsesEvent>> {
    this.creates++; this.bodies.push(structuredClone(body));
    if (this.creates === 1) {
      const id = 'nr01-first'; const metadata = responseMetadata(body, id);
      return (async function* () {
        yield { type: 'response.created', sequence_number: 0, response: { ...metadata, status: 'in_progress', output: [] } };
        yield { type: 'response.output_item.added', sequence_number: 1, item: { id: 'nr01-item', type: 'function_call', call_id: 'nr01-call', name: 'status', arguments: '' } };
        yield { type: 'response.function_call_arguments.done', sequence_number: 2, item_id: 'nr01-item', arguments: '{"detail":"brief"}' };
        yield { type: 'response.completed', sequence_number: 3, response: { ...metadata, status: 'completed', output: [{ type: 'function_call', id: 'nr01-item', call_id: 'nr01-call', name: 'status', arguments: '{"detail":"brief"}' }], usage: null } };
      })();
    }
    const id = 'nr01-successor'; const metadata = responseMetadata(body, id);
    return (async function* () { yield { type: 'response.created', sequence_number: 0, response: { ...metadata, status: 'in_progress', output: [] } }; })();
  }
  async retrieve(id: string, _options: ResponsesHttpOptions): Promise<ResponsesSnapshot> {
    this.retrieves++;
    if (id !== 'nr01-successor') throw new Error('unexpected_retrieve');
    const body = this.bodies[1]; const metadata = responseMetadata(body, id);
    return { ...metadata, id, status: 'completed', output: [{ type: 'message', id: 'nr01-answer', role: 'assistant', content: [{ type: 'output_text', text: 'successor' }] }], usage: null };
  }
  async resume(): Promise<AsyncIterable<ResponsesEvent>> { throw new Error('unexpected_resume'); }
  async cancel(id: string): Promise<ResponsesSnapshot> { return { id, status: 'in_progress' }; }
}

class SameKeyTransport implements ResponsesTransport {
  creates = 0; close(): void {}
  async create(body: ResponsesCreateBody): Promise<AsyncIterable<ResponsesEvent>> {
    const id = `nr04-response-${++this.creates}`; const metadata = responseMetadata(body, id);
    if (this.creates > 1) return (async function* () { yield { type: 'response.created', sequence_number: 0, response: { ...metadata, status: 'in_progress', output: [] } }; yield { type: 'response.output_text.delta', sequence_number: 1, item_id: 'nr04-answer', content_index: 0, delta: 'ok' }; yield { type: 'response.completed', sequence_number: 2, response: { ...metadata, status: 'completed', output: [{ type: 'message', id: 'nr04-answer', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], usage: null } }; })();
    return (async function* () {
      yield { type: 'response.created', sequence_number: 0, response: { ...metadata, status: 'in_progress', output: [] } };
      yield { type: 'response.output_item.added', sequence_number: 1, item: { id: 'nr04-item', type: 'function_call', call_id: 'nr04-call', name: 'status', arguments: '' } };
      yield { type: 'response.function_call_arguments.done', sequence_number: 2, item_id: 'nr04-item', arguments: '{"detail":"brief"}' };
      yield { type: 'response.completed', sequence_number: 3, response: { ...metadata, status: 'completed', output: [{ type: 'function_call', id: 'nr04-item', call_id: 'nr04-call', name: 'status', arguments: '{"detail":"brief"}' }], usage: null } };
    })();
  }
  async retrieve(): Promise<ResponsesSnapshot> { throw new Error('unexpected_retrieve'); }
  async resume(): Promise<AsyncIterable<ResponsesEvent>> { throw new Error('unexpected_resume'); }
  async cancel(id: string): Promise<ResponsesSnapshot> { return { id, status: 'cancelled' }; }
}

class InvalidOutputTransport implements ResponsesTransport {
  close(): void {}
  async create(body: ResponsesCreateBody, _options: ResponsesHttpOptions & { clientRequestId: string }): Promise<AsyncIterable<ResponsesEvent>> {
    const id = 'invalid-output'; const metadata = responseMetadata(body, id);
    return (async function* () {
      yield { type: 'response.created', sequence_number: 0, response: { ...metadata, status: 'in_progress', output: [] } };
      yield { type: 'response.completed', sequence_number: 1, response: { ...metadata, status: 'completed', output: [{ type: 'message', id: 'bad', role: 'user', content: [{ type: 'output_text', text: 'not assistant' }, { type: 'unknown', text: 'must reject' }] }], usage: null } };
    })();
  }
  async retrieve(): Promise<ResponsesSnapshot> { throw new Error('not expected'); }
  async resume(): Promise<AsyncIterable<ResponsesEvent>> { throw new Error('not expected'); }
  async cancel(id: string): Promise<ResponsesSnapshot> { return { id, status: 'cancelled' }; }
}

class InvalidCompleteOutputTransport implements ResponsesTransport {
  constructor(private readonly variant: 'unknown' | 'status' | 'empty-id' | 'empty-call') {}
  close(): void {}
  async create(body: ResponsesCreateBody): Promise<AsyncIterable<ResponsesEvent>> {
    const id = `invalid-${this.variant}`; const metadata = responseMetadata(body, id);
    const output = this.variant === 'unknown'
      ? [{ type: 'message', id: 'invalid-message', role: 'assistant', content: [{ type: 'output_text', text: 'must-not-commit' }] }, { type: 'function_call', id: 'invalid-call-item', call_id: 'invalid-call', name: 'unregistered', arguments: '{}' }]
      : this.variant === 'status'
        ? [{ type: 'message', id: 'status-message', role: 'assistant', status: 'in_progress', content: [{ type: 'output_text', text: 'must-not-commit' }] }]
        : this.variant === 'empty-id'
          ? [{ type: 'message', id: '', role: 'assistant', content: [{ type: 'output_text', text: 'must-not-commit' }] }]
          : [{ type: 'function_call', id: 'empty-call-item', call_id: '', name: 'status', arguments: '{"detail":"brief"}' }];
    return (async function* () { yield { type: 'response.created', sequence_number: 0, response: { ...metadata, status: 'in_progress', output: [] } }; yield { type: 'response.completed', sequence_number: 1, response: { ...metadata, status: 'completed', output, usage: null } }; })();
  }
  async retrieve(): Promise<ResponsesSnapshot> { throw new Error('unexpected_retrieve'); }
  async resume(): Promise<AsyncIterable<ResponsesEvent>> { throw new Error('unexpected_resume'); }
  async cancel(id: string): Promise<ResponsesSnapshot> { return { id, status: 'in_progress' }; }
}

class ExactPrefixTransport implements ResponsesTransport {
  constructor(private readonly variant: 'empty-content' | 'changed-type' | 'inserted-before' | 'negative-index') {}
  close(): void {}
  async create(body: ResponsesCreateBody): Promise<AsyncIterable<ResponsesEvent>> {
    const id = `prefix-${this.variant}`; const metadata = responseMetadata(body, id);
    if (this.variant === 'negative-index') {
      return (async function* () { yield { type: 'response.created', sequence_number: 0, response: { ...metadata, status: 'in_progress', output: [] } }; yield { type: 'response.output_text.delta', sequence_number: 1, item_id: 'answer', content_index: -1, delta: 'abc' }; yield { type: 'response.completed', sequence_number: 2, response: { ...metadata, status: 'completed', output: [{ type: 'message', id: 'answer', role: 'assistant', content: [{ type: 'output_text', text: 'abc' }] }], usage: null } }; })();
    }
    const output = this.variant === 'empty-content'
      ? [{ type: 'message', id: 'answer', role: 'assistant', content: [] }]
      : this.variant === 'changed-type'
        ? [{ type: 'reasoning', id: 'answer', summary: [] }]
        : [{ type: 'message', id: 'earlier', role: 'assistant', content: [{ type: 'output_text', text: 'new-before' }] }, { type: 'message', id: 'answer', role: 'assistant', content: [{ type: 'output_text', text: 'abc' }] }];
    return (async function* () { yield { type: 'response.created', sequence_number: 0, response: { ...metadata, status: 'in_progress', output: [] } }; yield { type: 'response.output_text.delta', sequence_number: 1, item_id: 'answer', output_index: 0, content_index: 0, delta: 'abc' }; yield { type: 'response.completed', sequence_number: 2, response: { ...metadata, status: 'completed', output, usage: null } }; })();
  }
  async retrieve(): Promise<ResponsesSnapshot> { throw new Error('unexpected_retrieve'); }
  async resume(): Promise<AsyncIterable<ResponsesEvent>> { throw new Error('unexpected_resume'); }
  async cancel(id: string): Promise<ResponsesSnapshot> { return { id, status: 'in_progress' }; }
}

class EventExhaustionTransport implements ResponsesTransport {
  close(): void {}
  async create(body: ResponsesCreateBody): Promise<AsyncIterable<ResponsesEvent>> {
    const id = 'event-exhaustion'; const metadata = responseMetadata(body, id);
    const output = ['a', 'b', 'c'].map((text, index) => ({ type: 'message', id: `message-${index}`, role: 'assistant', content: [{ type: 'output_text', text }] }));
    return (async function* () { yield { type: 'response.created', sequence_number: 0, response: { ...metadata, status: 'in_progress', output: [] } }; yield { type: 'response.completed', sequence_number: 1, response: { ...metadata, status: 'completed', output, usage: null } }; })();
  }
  async retrieve(): Promise<ResponsesSnapshot> { throw new Error('unexpected_retrieve'); }
  async resume(): Promise<AsyncIterable<ResponsesEvent>> { throw new Error('unexpected_resume'); }
  async cancel(id: string): Promise<ResponsesSnapshot> { return { id, status: 'in_progress' }; }
}

class InvalidSnapshotOutputTransport implements ResponsesTransport {
  private body?: ResponsesCreateBody; close(): void {}
  async create(body: ResponsesCreateBody): Promise<AsyncIterable<ResponsesEvent>> {
    this.body = structuredClone(body);
    const id = 'invalid-snapshot-output'; const metadata = responseMetadata(body, id);
    return (async function* () { yield { type: 'response.created', sequence_number: 0, response: { ...metadata, status: 'in_progress', output: [] } }; })();
  }
  async retrieve(id: string): Promise<ResponsesSnapshot> {
    const metadata = responseMetadata(this.body!, id);
    return { ...metadata, status: 'completed', output: [
      { type: 'message', id: 'partial', role: 'assistant', content: [{ type: 'output_text', text: 'must not publish' }] },
      { type: 'unregistered_output', id: 'reject-me' },
    ], usage: null };
  }
  async resume(): Promise<AsyncIterable<ResponsesEvent>> { throw new Error('not expected'); }
  async cancel(id: string): Promise<ResponsesSnapshot> { return { id, status: 'cancelled' }; }
}

class ResumeAfterAcknowledgementTransport implements ResponsesTransport {
  creates = 0; retrieves = 0; resumes: number[] = []; close(): void {}
  async create(body: ResponsesCreateBody): Promise<AsyncIterable<ResponsesEvent>> {
    this.creates++; const id = 'resume-after-ack'; const metadata = responseMetadata(body, id);
    return (async function* () { yield { type: 'response.created', sequence_number: 0, response: { ...metadata, status: 'in_progress', output: [] } }; })();
  }
  async retrieve(id: string, options: ResponsesHttpOptions): Promise<ResponsesSnapshot> { void options; this.retrieves++; return { id, ...responseMetadata({ model: 'gpt-5.6-luna', reasoning: { effort: 'xhigh' }, instructions: 'base\n\ndeveloper', tools: [], tool_choice: 'auto', parallel_tool_calls: false, background: true, store: true, truncation: 'disabled', max_output_tokens: 4096 }, id), status: 'in_progress' }; }
  async resume(id: string, after: number): Promise<AsyncIterable<ResponsesEvent>> {
    this.resumes.push(after);
    return (async function* () {
      yield { type: 'response.output_text.delta', sequence_number: 1, response_id: id, item_id: 'resumed', output_index: 0, content_index: 0, delta: 'resumed' };
      yield { type: 'response.completed', sequence_number: 2, response_id: id, response: { id, model: 'gpt-5.6-luna', reasoning: { effort: 'xhigh' }, instructions: 'base\n\ndeveloper', tools: [], tool_choice: 'auto', parallel_tool_calls: false, background: true, store: true, truncation: 'disabled', max_output_tokens: 4096, status: 'completed', output: [{ type: 'message', id: 'resumed', role: 'assistant', content: [{ type: 'output_text', text: 'resumed' }] }], usage: null } };
    })();
  }
  async cancel(id: string): Promise<ResponsesSnapshot> { return { id, status: 'cancelled' }; }
}

class GapRecoveryTransport implements ResponsesTransport {
  creates = 0; retrieves = 0; resumes: number[] = []; private body?: ResponsesCreateBody; close(): void {}
  async create(body: ResponsesCreateBody): Promise<AsyncIterable<ResponsesEvent>> {
    this.body = structuredClone(body); this.creates++; const id = 'gap-response'; const metadata = responseMetadata(body, id);
    return (async function* () { yield { type: 'response.created', sequence_number: 0, response: { ...metadata, status: 'in_progress', output: [] } }; })();
  }
  async retrieve(id: string): Promise<ResponsesSnapshot> {
    this.retrieves++; const metadata = responseMetadata(this.body!, id);
    if (this.retrieves === 1) return { ...metadata, status: 'in_progress', output: [] };
    return { ...metadata, status: 'completed', output: [{ type: 'message', id: 'gap-answer', role: 'assistant', content: [{ type: 'output_text', text: 'gap-recovered' }] }], usage: null };
  }
  async resume(id: string, after: number): Promise<AsyncIterable<ResponsesEvent>> {
    this.resumes.push(after);
    return (async function* () { yield { type: 'response.output_text.delta', sequence_number: 2, response_id: id, item_id: 'gap-answer', content_index: 0, delta: 'gap' }; })();
  }
  async cancel(id: string): Promise<ResponsesSnapshot> { return { id, status: 'in_progress' }; }
}

class ControlHeadroomTransport implements ResponsesTransport {
  creates = 0; cancels = 0; close(): void {}
  async create(body: ResponsesCreateBody, options: ResponsesHttpOptions & { clientRequestId: string }): Promise<AsyncIterable<ResponsesEvent>> {
    this.creates++; await options.chargeReceivedBytes(100); const id = 'control-headroom'; const metadata = responseMetadata(body, id);
    return (async function* () { yield { type: 'response.created', sequence_number: 0, response: { ...metadata, status: 'in_progress', output: [] } }; })();
  }
  async retrieve(): Promise<ResponsesSnapshot> { throw new Error('retrieve_unresolved'); }
  async resume(): Promise<AsyncIterable<ResponsesEvent>> { throw new Error('resume_unresolved'); }
  async cancel(id: string, options: ResponsesHttpOptions): Promise<ResponsesSnapshot> { this.cancels++; await options.chargeReceivedBytes(1); return { id, status: 'cancelled' }; }
}

class FailedResponseTransport implements ResponsesTransport {
  close(): void {}
  async create(body: ResponsesCreateBody): Promise<AsyncIterable<ResponsesEvent>> {
    const id = 'failed-response'; const metadata = responseMetadata(body, id);
    return (async function* () { yield { type: 'response.created', sequence_number: 0, response: { ...metadata, status: 'in_progress', output: [] } }; yield { type: 'response.failed', sequence_number: 1, response_id: id, response: { ...metadata, status: 'failed', output: [] } }; })();
  }
  async retrieve(id: string): Promise<ResponsesSnapshot> { return { id, status: 'failed' }; }
  async resume(): Promise<AsyncIterable<ResponsesEvent>> { throw new Error('not expected'); }
  async cancel(id: string): Promise<ResponsesSnapshot> { return { id, status: 'cancelled' }; }
}

class OpaqueIdTransport implements ResponsesTransport {
  close(): void {}
  async create(body: ResponsesCreateBody): Promise<AsyncIterable<ResponsesEvent>> {
    const metadata = responseMetadata(body, '__proto__');
    return (async function* () {
      yield { type: 'response.created', sequence_number: 0, response: { ...metadata, status: 'in_progress', output: [] } };
      yield { type: 'response.completed', sequence_number: 1, response: { ...metadata, status: 'completed', output: [], usage: null } };
    })();
  }
  async retrieve(): Promise<ResponsesSnapshot> { throw new Error('not expected'); }
  async resume(): Promise<AsyncIterable<ResponsesEvent>> { throw new Error('not expected'); }
  async cancel(id: string): Promise<ResponsesSnapshot> { return { id, status: 'cancelled' }; }
}

class HeldStreamTransport implements ResponsesTransport {
  creates = 0; readonly started = deferred<void>(); private readonly gate = deferred<void>(); readonly signals: AbortSignal[] = [];
  close(): void { this.gate.resolve(); }
  release(): void { this.gate.resolve(); }
  async create(body: ResponsesCreateBody, options: ResponsesHttpOptions & { clientRequestId: string }): Promise<AsyncIterable<ResponsesEvent>> {
    this.creates++; this.signals.push(options.signal); const id = `held-${this.creates}`; const metadata = responseMetadata(body, id);
    const gate = this.gate.promise;
    const started = this.started;
    return (async function* () {
      started.resolve();
      yield { type: 'response.created', sequence_number: 0, response: { ...metadata, status: 'in_progress', output: [] } };
      yield { type: 'response.output_text.delta', sequence_number: 1, item_id: 'held-answer', output_index: 0, content_index: 0, delta: 'held ' };
      await gate;
      if (options.signal.aborted) throw new Error('held_stream_aborted');
      yield { type: 'response.completed', sequence_number: 2, response: { ...metadata, status: 'completed', output: [{ type: 'message', id: 'held-answer', role: 'assistant', content: [{ type: 'output_text', text: 'held ' }] }], usage: null } };
    }.bind(this))();
  }
  async retrieve(id: string): Promise<ResponsesSnapshot> { return { id, status: 'in_progress' }; }
  async resume(): Promise<AsyncIterable<ResponsesEvent>> { throw new Error('not expected'); }
  async cancel(id: string): Promise<ResponsesSnapshot> { return { id, status: 'cancelled' }; }
}

class ConsumerStopTransport extends HeldStreamTransport {
  readonly cancelIds: string[] = [];
  async cancel(id: string): Promise<ResponsesSnapshot> { this.cancelIds.push(id); return { id, status: 'cancelled' }; }
}

async function childBoundaryRecovery(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'm2m-responses-child-'));
  try {
    const prePostChild = `
      import { ResponsesWorker } from './scripts/responses-worker.ts';
      const descriptor={version:1,kind:'responses-tools-v1',model:'gpt-5.6-luna',reasoning:'xhigh'};
      const profile={id:'child-pre-post',baseInstructions:'base',developerInstructions:'developer',tools:[],maxToolCalls:1,maxToolResultBytes:64,recoverableTools:[],handleTool:async()=>({success:true,text:'unused'})};
      const transport={close(){},async create(){process.exit(0)},async retrieve(){throw Error('unreachable')},async resume(){throw Error('unreachable')},async cancel(id){return {id,status:'cancelled'}}};
      const worker=await ResponsesWorker.open({stateDir:process.env.M2M_CHILD_PRE_POST,create:true,descriptor,profile,limits:(await import('./scripts/agent-runtime.ts')).responsesLimits('provider'),transport});
      await worker.run({agent:'child-agent',conversationId:'pre-post-conversation',requestId:'pre-post-request',prompt:'pre-post prompt'});
    `;
    const prePostState = join(root, 'pre-post-worker');
    const prePostResult = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', prePostChild], { cwd: process.cwd(), env: { ...process.env, M2M_CHILD_PRE_POST: prePostState }, encoding: 'utf8' });
    assert.equal(prePostResult.status, 0, prePostResult.stderr);
    await new Promise(resolve => setTimeout(resolve, 250));
    const prePostTransport = new NoAcknowledgementTransport();
    const prePostProfile: AgentProfile = { id: 'child-pre-post', baseInstructions: 'base', developerInstructions: 'developer', tools: [], maxToolCalls: 1, maxToolResultBytes: 64, recoverableTools: [], handleTool: async () => ({ success: true, text: 'unused' }) };
    const prePostWorker = await ResponsesWorker.open({ stateDir: prePostState, create: false, descriptor, profile: prePostProfile, limits: responsesLimits('provider'), transport: prePostTransport });
    const prePost = await prePostWorker.run({ agent: 'child-agent', conversationId: 'pre-post-conversation', requestId: 'pre-post-request', prompt: 'pre-post prompt' });
    assert.equal(prePost.state, 'uncertain'); assert.equal(prePostTransport.creates, 0);
    const prePostJournal = JSON.parse(readFileSync(join(prePostState, 'responses-worker.json'), 'utf8')) as { requests: Record<string, { state: string }> };
    assert.equal(Object.values(prePostJournal.requests)[0].state, 'uncertain');
    await prePostWorker.shutdown();

    const child = `
      import { ResponsesWorker } from './scripts/responses-worker.ts';
      const descriptor={version:1,kind:'responses-tools-v1',model:'gpt-5.6-luna',reasoning:'xhigh'};
      const profile={id:'child',baseInstructions:'base',developerInstructions:'developer',tools:[],maxToolCalls:1,maxToolResultBytes:64,recoverableTools:[],handleTool:async()=>({success:true,text:'unused'})};
      const transport={close(){},async create(body){return (async function*(){yield {type:'response.created',sequence_number:0,response:{id:'child-response',model:body.model,reasoning:body.reasoning,instructions:body.instructions,tools:body.tools,tool_choice:body.tool_choice,parallel_tool_calls:body.parallel_tool_calls,background:body.background,store:body.store,truncation:body.truncation,max_output_tokens:body.max_output_tokens,status:'in_progress',output:[]}};process.exit(0)})();},async retrieve(){throw Error('unreachable')},async resume(){throw Error('unreachable')},async cancel(id){return {id,status:'cancelled'}}};
      const worker=await ResponsesWorker.open({stateDir:process.env.M2M_CHILD_STATE,create:true,descriptor,profile,limits:(await import('./scripts/agent-runtime.ts')).responsesLimits('provider'),transport});
      await worker.run({agent:'child-agent',conversationId:'child-conversation',requestId:'child-request',prompt:'child prompt'});
    `;
    const childResult = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', child], { cwd: process.cwd(), env: { ...process.env, M2M_CHILD_STATE: join(root, 'worker') }, encoding: 'utf8' });
    assert.equal(childResult.status, 0, childResult.stderr);
    const journal = JSON.parse(readFileSync(join(root, 'worker', 'responses-worker.json'), 'utf8')) as { requests: Record<string, { intent: { body: string; responseId: string }; currentResponseId: string }> };
    const saved = Object.values(journal.requests)[0];
    assert.equal(saved.currentResponseId, 'child-response');
    class RecoveryTransport implements ResponsesTransport {
      creates = 0; retrieves = 0; close(): void {}
      async create(): Promise<AsyncIterable<ResponsesEvent>> { this.creates++; throw new Error('duplicate create'); }
      async retrieve(id: string, _options: ResponsesHttpOptions): Promise<ResponsesSnapshot> { this.retrieves++; const body = JSON.parse(saved.intent.body) as ResponsesCreateBody; const metadata = responseMetadata(body, id); return { ...metadata, status: 'completed', output: [{ type: 'message', id: 'answer', role: 'assistant', content: [{ type: 'output_text', text: 'recovered' }] }], usage: null }; }
      async resume(): Promise<AsyncIterable<ResponsesEvent>> { throw new Error('not expected'); }
      async cancel(id: string): Promise<ResponsesSnapshot> { return { id, status: 'cancelled' }; }
    }
    const transport = new RecoveryTransport();
    const childProfile: AgentProfile = { id: 'child', baseInstructions: 'base', developerInstructions: 'developer', tools: [], maxToolCalls: 1, maxToolResultBytes: 64, recoverableTools: [], handleTool: async () => ({ success: true, text: 'unused' }) };
    await new Promise(resolve => setTimeout(resolve, 250));
    const worker = await ResponsesWorker.open({ stateDir: join(root, 'worker'), create: false, descriptor, profile: childProfile, limits: responsesLimits('provider'), transport });
    const result = await worker.reconcile({ agent: 'child-agent', conversationId: 'child-conversation', requestId: 'child-request' });
    assert.ok(result);
    assert.equal(result.state, 'completed'); assert.equal(transport.creates, 0); assert.equal(transport.retrieves, 1);
    await worker.shutdown();
  } finally { rmSync(root, { recursive: true, force: true }); }
}

async function childPendingAndPreparedRecovery(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'm2m-responses-nr02-'));
  try {
    const pendingChild = `
      import { ResponsesWorker } from './scripts/responses-worker.ts';
      const descriptor={version:1,kind:'responses-tools-v1',model:'gpt-5.6-luna',reasoning:'xhigh'};
      const profile={id:'nr02-pending',baseInstructions:'base',developerInstructions:'developer',tools:[{name:'status',description:'status',inputSchema:{type:'object',properties:{detail:{type:'string'}},required:['detail'],additionalProperties:false}}],maxToolCalls:1,maxToolResultBytes:64,recoverableTools:[],handleTool:async()=>{process.exit(0);return {success:true,text:'never'}}};
      const transport={close(){},async create(body){const id='nr02-pending-response';const metadata={id,model:body.model,reasoning:body.reasoning,instructions:body.instructions,tools:body.tools,tool_choice:body.tool_choice,parallel_tool_calls:body.parallel_tool_calls,background:body.background,store:body.store,truncation:body.truncation,max_output_tokens:body.max_output_tokens,previous_response_id:body.previous_response_id??null};return (async function*(){yield {type:'response.created',sequence_number:0,response:{...metadata,status:'in_progress'}};yield {type:'response.output_item.added',sequence_number:1,item:{id:'nr02-item',type:'function_call',call_id:'nr02-call',name:'status',arguments:''}};yield {type:'response.function_call_arguments.done',sequence_number:2,item_id:'nr02-item',arguments:'{"detail":"brief"}'};yield {type:'response.completed',sequence_number:3,response:{...metadata,status:'completed',output:[{type:'function_call',id:'nr02-item',call_id:'nr02-call',name:'status',arguments:'{"detail":"brief"}'}],usage:null}}})()},async retrieve(){throw Error('unreachable')},async resume(){throw Error('unreachable')},async cancel(id){return {id,status:'cancelled'}}};
      const worker=await ResponsesWorker.open({stateDir:process.env.M2M_NR02_PENDING,create:true,descriptor,profile,limits:(await import('./scripts/agent-runtime.ts')).responsesLimits('provider'),transport});
      await worker.run({agent:'nr02-agent',conversationId:'nr02-conversation',requestId:'nr02-pending',prompt:'pending prompt'});
    `;
    const pendingState = join(root, 'pending');
    const pendingResult = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', pendingChild], { cwd: process.cwd(), env: { ...process.env, M2M_NR02_PENDING: pendingState }, encoding: 'utf8' });
    assert.equal(pendingResult.status, 0, pendingResult.stderr);
    let pendingCalls = 0;
    const pendingProfile: AgentProfile = { id: 'nr02-pending', baseInstructions: 'base', developerInstructions: 'developer', tools: [{ name: 'status', description: 'status', inputSchema: { type: 'object', properties: { detail: { type: 'string' } }, required: ['detail'], additionalProperties: false } }], maxToolCalls: 1, maxToolResultBytes: 64, recoverableTools: [], handleTool: async () => { pendingCalls++; return { success: true, text: 'must-not-repeat' }; } };
    const pendingTransport = new NoAcknowledgementTransport();
    const pendingWorker = await ResponsesWorker.open({ stateDir: pendingState, create: false, descriptor, profile: pendingProfile, limits: responsesLimits('provider'), transport: pendingTransport });
    const pendingReplay = await pendingWorker.run({ agent: 'nr02-agent', conversationId: 'nr02-conversation', requestId: 'nr02-pending', prompt: 'pending prompt' });
    assert.equal(pendingReplay.state, 'uncertain'); assert.equal(pendingCalls, 0); assert.equal(pendingTransport.creates, 0);
    const pendingReconcile = await pendingWorker.reconcile({ agent: 'nr02-agent', conversationId: 'nr02-conversation', requestId: 'nr02-pending' });
    assert.equal(pendingReconcile?.state, 'uncertain'); assert.equal(pendingCalls, 0); await pendingWorker.shutdown();

    const preparedChild = `
      import { ResponsesWorker } from './scripts/responses-worker.ts';
      const descriptor={version:1,kind:'responses-tools-v1',model:'gpt-5.6-luna',reasoning:'xhigh'};
      const profile={id:'nr02-prepared',baseInstructions:'base',developerInstructions:'developer',tools:[],maxToolCalls:1,maxToolResultBytes:64,recoverableTools:[],handleTool:async()=>({success:true,text:'unused'})};
      const transport={close(){},async create(){throw Error('must-not-run-in-child')},async retrieve(){throw Error('unreachable')},async resume(){throw Error('unreachable')},async cancel(id){return {id,status:'cancelled'}}};
      const worker=await ResponsesWorker.open({stateDir:process.env.M2M_NR02_PREPARED,create:true,descriptor,profile,limits:(await import('./scripts/agent-runtime.ts')).responsesLimits('provider'),transport});
      const original=worker.persist.bind(worker);let first=true;worker.persist=()=>{original();if(first){first=false;process.exit(0)}};
      await worker.run({agent:'nr02-agent',conversationId:'nr02-prepared-conversation',requestId:'nr02-prepared',prompt:'review prompt'});
    `;
    const preparedState = join(root, 'prepared');
    const preparedResult = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', preparedChild], { cwd: process.cwd(), env: { ...process.env, M2M_NR02_PREPARED: preparedState }, encoding: 'utf8' });
    assert.equal(preparedResult.status, 0, preparedResult.stderr);
    await new Promise(resolve => setTimeout(resolve, 250));
    class PreparedTransport implements ResponsesTransport {
      readonly bodies: ResponsesCreateBody[] = []; close(): void {}
      async create(body: ResponsesCreateBody): Promise<AsyncIterable<ResponsesEvent>> { this.bodies.push(structuredClone(body)); return (async function* () {})(); }
      async retrieve(): Promise<ResponsesSnapshot> { throw new Error('unexpected_retrieve'); }
      async resume(): Promise<AsyncIterable<ResponsesEvent>> { throw new Error('unexpected_resume'); }
      async cancel(id: string): Promise<ResponsesSnapshot> { return { id, status: 'cancelled' }; }
    }
    const preparedTransport = new PreparedTransport();
    const preparedProfile: AgentProfile = { id: 'nr02-prepared', baseInstructions: 'base', developerInstructions: 'developer', tools: [], maxToolCalls: 1, maxToolResultBytes: 64, recoverableTools: [], handleTool: async () => ({ success: true, text: 'unused' }) };
    const preparedWorker = await ResponsesWorker.open({ stateDir: preparedState, create: false, descriptor, profile: preparedProfile, limits: responsesLimits('provider'), transport: preparedTransport });
    const preparedReplay = await preparedWorker.reconcile({ agent: 'nr02-agent', conversationId: 'nr02-prepared-conversation', requestId: 'nr02-prepared' });
    assert.equal(preparedReplay?.state, 'uncertain'); assert.equal(preparedTransport.bodies.length, 1);
    const preparedInput = preparedTransport.bodies[0].input as Array<{ content: Array<{ text: string }> }>;
    assert.equal(preparedInput[0].content[0].text, 'review prompt'); await preparedWorker.shutdown();
  } finally { rmSync(root, { recursive: true, force: true }); }
}

async function childAcknowledgedContinuationRecovery(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'm2m-responses-nr01-child-'));
  try {
    const child = `
      import { ResponsesWorker } from './scripts/responses-worker.ts';
      const descriptor={version:1,kind:'responses-tools-v1',model:'gpt-5.6-luna',reasoning:'xhigh'};
      const profile={id:'nr01-child',baseInstructions:'base',developerInstructions:'developer',tools:[{name:'status',description:'status',inputSchema:{type:'object',properties:{detail:{type:'string'}},required:['detail'],additionalProperties:false}}],maxToolCalls:2,maxToolResultBytes:64,recoverableTools:[],handleTool:async()=>({success:true,text:'child result'})};
      let creates=0;
      const transport={close(){},async create(body){const id=creates++===0?'child-first':'child-successor';const metadata={id,model:body.model,reasoning:body.reasoning,instructions:body.instructions,tools:body.tools,tool_choice:body.tool_choice,parallel_tool_calls:body.parallel_tool_calls,background:body.background,store:body.store,truncation:body.truncation,max_output_tokens:body.max_output_tokens,previous_response_id:body.previous_response_id??null};if(id==='child-successor')return (async function*(){yield {type:'response.created',sequence_number:0,response:{...metadata,status:'in_progress',output:[]}};process.exit(0)})();return (async function*(){yield {type:'response.created',sequence_number:0,response:{...metadata,status:'in_progress',output:[]}};yield {type:'response.output_item.added',sequence_number:1,item:{id:'child-item',type:'function_call',call_id:'child-call',name:'status',arguments:''}};yield {type:'response.function_call_arguments.done',sequence_number:2,item_id:'child-item',arguments:'{"detail":"brief"}'};yield {type:'response.completed',sequence_number:3,response:{...metadata,status:'completed',output:[{type:'function_call',id:'child-item',call_id:'child-call',name:'status',arguments:'{"detail":"brief"}'}],usage:null}}})()},async retrieve(){throw Error('unreachable')},async resume(){throw Error('unreachable')},async cancel(id){return {id,status:'cancelled'}}};
      const worker=await ResponsesWorker.open({stateDir:process.env.M2M_NR01_CHILD,create:true,descriptor,profile,limits:(await import('./scripts/agent-runtime.ts')).responsesLimits('provider'),transport});
      await worker.run({agent:'nr01-agent',conversationId:'nr01-child-conversation',requestId:'nr01-child-request',prompt:'child continuation prompt'});
    `;
    const state = join(root, 'worker'); const childResult = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', child], { cwd: process.cwd(), env: { ...process.env, M2M_NR01_CHILD: state }, encoding: 'utf8' }); assert.equal(childResult.status, 0, childResult.stderr); await new Promise(resolve => setTimeout(resolve, 250));
    const saved = JSON.parse(readFileSync(join(state, 'responses-worker.json'), 'utf8')) as { requests: Record<string, { knownTurnIds: string[]; currentResponseId?: string; intent?: { responseId?: string; body: string }; pendingCallId?: string; continuationResult?: string }> }; const record = Object.values(saved.requests)[0]; assert.deepEqual(record.knownTurnIds, ['child-first', 'child-successor']); assert.equal(record.currentResponseId, 'child-successor'); assert.equal(record.intent?.responseId, 'child-successor'); assert.equal(record.pendingCallId, undefined); assert.equal(record.continuationResult, undefined);
    class RecoveryTransport implements ResponsesTransport {
      creates = 0; retrieves = 0; close(): void {}
      async create(): Promise<AsyncIterable<ResponsesEvent>> { this.creates++; throw new Error('duplicate continuation POST'); }
      async retrieve(id: string): Promise<ResponsesSnapshot> { this.retrieves++; const body = JSON.parse(record.intent!.body) as ResponsesCreateBody; const metadata = responseMetadata(body, id); return { ...metadata, status: 'completed', output: [{ type: 'message', id: 'child-answer', role: 'assistant', content: [{ type: 'output_text', text: 'recovered successor' }] }], usage: null }; }
      async resume(): Promise<AsyncIterable<ResponsesEvent>> { throw new Error('unexpected resume'); }
      async cancel(id: string): Promise<ResponsesSnapshot> { return { id, status: 'cancelled' }; }
    }
    const transport = new RecoveryTransport(); const profileValue: AgentProfile = { id: 'nr01-child', baseInstructions: 'base', developerInstructions: 'developer', tools: [{ name: 'status', description: 'status', inputSchema: { type: 'object', properties: { detail: { type: 'string' } }, required: ['detail'], additionalProperties: false } }], maxToolCalls: 2, maxToolResultBytes: 64, recoverableTools: [], handleTool: async () => ({ success: true, text: 'unused' }) }; const worker = await ResponsesWorker.open({ stateDir: state, create: false, descriptor, profile: profileValue, limits: responsesLimits('provider'), transport }); const result = await worker.run({ agent: 'nr01-agent', conversationId: 'nr01-child-conversation', requestId: 'nr01-child-request', prompt: 'child continuation prompt' }); assert.equal(result.state, 'completed'); assert.equal(transport.creates, 0); assert.equal(transport.retrieves, 1); await worker.shutdown();
  } finally { rmSync(root, { recursive: true, force: true }); }
}

async function adversarialTests(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'm2m-responses-adversarial-'));
  try {
    const noAck = new ContinuationNoAckTransport(); const calls: string[] = [];
    const worker = await ResponsesWorker.open({ stateDir: join(root, 'no-ack-continuation'), create: true, descriptor, profile: profile(calls), limits: responsesLimits('provider', { maxResponses: 3 }), transport: noAck });
    const first = await worker.run({ ...ref, requestId: 'no-ack-continuation', prompt: 'question' });
    assert.equal(first.state, 'uncertain'); assert.equal(noAck.creates, 2);
    const replay = await worker.run({ ...ref, requestId: 'no-ack-continuation', prompt: 'question' });
    assert.equal(replay.state, 'uncertain'); assert.equal(noAck.creates, 2); await worker.shutdown();

    // NR-01: once a continuation has an acknowledged response ID, recovery
    // must consume that exact intent rather than resubmitting its result.
    const nr01Transport = new AcknowledgedSuccessorTransport();
    const nr01Worker = await ResponsesWorker.open({ stateDir: join(root, 'nr01'), create: true, descriptor, profile: profile([]), limits: responsesLimits('provider'), transport: nr01Transport });
    const nr01Result = await nr01Worker.run({ ...ref, requestId: 'nr01', prompt: 'question' });
    assert.equal(nr01Result.state, 'completed'); assert.equal(nr01Transport.creates, 2); assert.equal(nr01Transport.retrieves, 1);
    const nr01Replay = await nr01Worker.reconcile({ ...ref, requestId: 'nr01' });
    assert.equal(nr01Replay?.state, 'completed'); assert.equal(nr01Transport.creates, 2); await nr01Worker.shutdown();

    // NR-03: an unacknowledged successor has no safe cancellation target;
    // cancelling its predecessor must never manufacture terminal certainty.
    const nr03Transport = new ContinuationNoAckTransport();
    const nr03Worker = await ResponsesWorker.open({ stateDir: join(root, 'nr03'), create: true, descriptor, profile: profile([]), limits: responsesLimits('provider'), transport: nr03Transport });
    const nr03Initial = await nr03Worker.run({ ...ref, requestId: 'nr03', prompt: 'question' });
    assert.equal(nr03Initial.state, 'uncertain'); assert.equal(nr03Transport.creates, 2);
    const nr03Cancelled = await nr03Worker.cancel({ ...ref, requestId: 'nr03' });
    assert.equal(nr03Cancelled?.state, 'uncertain'); assert.equal(nr03Transport.cancelIds.length, 0);
    assert.equal((await nr03Worker.run({ ...ref, requestId: 'nr03', prompt: 'question' })).state, 'uncertain'); assert.equal(nr03Transport.creates, 2); await nr03Worker.shutdown();
    const nr03Reopen = await ResponsesWorker.open({ stateDir: join(root, 'nr03'), create: false, descriptor, profile: profile([]), limits: responsesLimits('provider'), transport: nr03Transport }); assert.equal(nr03Reopen.status({ ...ref, requestId: 'nr03' })?.state, 'uncertain'); const firstReconcile = nr03Reopen.reconcile({ ...ref, requestId: 'nr03' }); await assert.rejects(() => nr03Reopen.reconcile({ ...ref, requestId: 'nr03' }), /worker_busy/); assert.equal((await firstReconcile)?.state, 'uncertain'); assert.equal((await nr03Reopen.run({ ...ref, requestId: 'nr03', prompt: 'question' })).state, 'uncertain'); assert.equal(nr03Transport.creates, 2); await nr03Reopen.shutdown();

    // NR-04: identical admission while a handler is in flight is rejected
    // before a second host callback can be entered.
    const nr04Started = deferred<void>(); const nr04Release = deferred<void>(); let nr04Calls = 0;
    const nr04Profile: AgentProfile = { ...profile([]), async handleTool() { nr04Calls++; nr04Started.resolve(); await nr04Release.promise; return { success: true, text: 'ok' }; } };
    const nr04Worker = await ResponsesWorker.open({ stateDir: join(root, 'nr04'), create: true, descriptor, profile: nr04Profile, limits: responsesLimits('provider'), transport: new SameKeyTransport() });
    const nr04Run = nr04Worker.run({ ...ref, requestId: 'nr04', prompt: 'question' }); await nr04Started.promise;
    await assert.rejects(() => nr04Worker.run({ ...ref, requestId: 'nr04', prompt: 'question' }), /worker_busy/); await assert.rejects(() => nr04Worker.reconcile({ ...ref, requestId: 'nr04' }), /worker_busy/); assert.equal(nr04Calls, 1);
    nr04Release.resolve(); assert.equal((await nr04Run).state, 'completed'); await nr04Worker.shutdown();

    const invalid = await ResponsesWorker.open({ stateDir: join(root, 'invalid-output'), create: true, descriptor, profile: profile([]), limits: responsesLimits('provider'), transport: new InvalidOutputTransport() });
    const invalidResult = await invalid.run({ ...ref, requestId: 'invalid-output', prompt: 'question' });
    assert.equal(invalidResult.state, 'uncertain'); assert.equal(invalidResult.producedUtf8Bytes, 0); await invalid.shutdown();
    const invalidSnapshot = await ResponsesWorker.open({ stateDir: join(root, 'invalid-snapshot-output'), create: true, descriptor, profile: profile([]), limits: responsesLimits('provider'), transport: new InvalidSnapshotOutputTransport() });
    const invalidSnapshotResult = await invalidSnapshot.run({ ...ref, requestId: 'invalid-snapshot-output', prompt: 'question' });
    assert.equal(invalidSnapshotResult.state, 'uncertain'); assert.equal(invalidSnapshotResult.producedUtf8Bytes, 0); assert.equal(invalidSnapshotResult.knownTurnIds.length, 1); await invalidSnapshot.shutdown();
    for (const variant of ['unknown', 'status', 'empty-id', 'empty-call'] as const) {
      const invalidComplete = await ResponsesWorker.open({ stateDir: join(root, `invalid-complete-${variant}`), create: true, descriptor, profile: profile([]), limits: responsesLimits('provider'), transport: new InvalidCompleteOutputTransport(variant) });
      const invalidCompleteResult = await invalidComplete.run({ ...ref, requestId: `invalid-complete-${variant}`, prompt: 'question' });
      assert.equal(invalidCompleteResult.state, 'uncertain'); assert.equal(invalidCompleteResult.producedUtf8Bytes, 0); assert.equal(invalidCompleteResult.toolCalls && Object.keys(invalidCompleteResult.toolCalls).length, 0);
      await invalidComplete.shutdown();
      const reopenedInvalid = await ResponsesWorker.open({ stateDir: join(root, `invalid-complete-${variant}`), create: false, descriptor, profile: profile([]), limits: responsesLimits('provider'), transport: new InvalidCompleteOutputTransport(variant) });
      assert.equal(reopenedInvalid.status({ ...ref, requestId: `invalid-complete-${variant}` })?.state, 'uncertain'); await reopenedInvalid.shutdown();
    }
    for (const variant of ['empty-content', 'changed-type', 'inserted-before', 'negative-index'] as const) {
      const prefixWorker = await ResponsesWorker.open({ stateDir: join(root, `exact-prefix-${variant}`), create: true, descriptor, profile: profile([]), limits: responsesLimits('provider'), transport: new ExactPrefixTransport(variant) });
      const prefixResult = await prefixWorker.run({ ...ref, requestId: `exact-prefix-${variant}`, prompt: 'question' });
      assert.equal(prefixResult.state, 'uncertain'); assert.equal(prefixResult.producedUtf8Bytes, variant === 'negative-index' ? 0 : 3); if (variant !== 'negative-index') assert.equal(Object.values(prefixResult.items)[0], 'abc'); await prefixWorker.shutdown();
    }
    const resumeAfterAckTransport = new ResumeAfterAcknowledgementTransport(); const resumeProfile: AgentProfile = { id: 'resume-profile', baseInstructions: 'base', developerInstructions: 'developer', tools: [], maxToolCalls: 1, maxToolResultBytes: 64, recoverableTools: [], handleTool: async () => ({ success: true, text: 'unused' }) }; const resumed = await ResponsesWorker.open({ stateDir: join(root, 'resume-after-ack'), create: true, descriptor, profile: resumeProfile, limits: responsesLimits('provider'), transport: resumeAfterAckTransport });
    const resumedResult = await resumed.run({ ...ref, requestId: 'resume-after-ack', prompt: 'question' });
    assert.equal(resumedResult.state, 'completed'); assert.deepEqual(resumeAfterAckTransport.resumes, [0]); await resumed.shutdown();
    const gapTransport = new GapRecoveryTransport(); const gapWorker = await ResponsesWorker.open({ stateDir: join(root, 'gap-recovery'), create: true, descriptor, profile: resumeProfile, limits: responsesLimits('provider'), transport: gapTransport });
    const gapResult = await gapWorker.run({ ...ref, requestId: 'gap-recovery', prompt: 'question' });
    assert.equal(gapResult.state, 'completed'); assert.equal(gapTransport.creates, 1); assert.equal(gapTransport.retrieves, 2); assert.deepEqual(gapTransport.resumes, [0]); assert.equal(Object.values(gapResult.items)[0], 'gap-recovered'); await gapWorker.shutdown();
    const failedWorker = await ResponsesWorker.open({ stateDir: join(root, 'failed-response'), create: true, descriptor, profile: resumeProfile, limits: responsesLimits('provider'), transport: new FailedResponseTransport() });
    assert.equal((await failedWorker.run({ ...ref, requestId: 'failed-response', prompt: 'question' })).state, 'failed'); await failedWorker.shutdown();

    const opaque = await ResponsesWorker.open({ stateDir: join(root, 'opaque-id'), create: true, descriptor, profile: profile([]), limits: responsesLimits('provider'), transport: new OpaqueIdTransport() });
    const opaqueResult = await opaque.run({ ...ref, requestId: 'opaque-id', prompt: 'question' });
    assert.equal(opaqueResult.state, 'completed'); assert.equal(opaqueResult.knownTurnIds[0], '__proto__'); assert.equal((Object.prototype as unknown as { completed?: unknown }).completed, undefined); await opaque.shutdown();

    await assert.rejects(() => openAgentWorker({ stateDir: join(root, 'gate-missing'), create: true, descriptor, profile: profile([]), limits: responsesLimits('provider') }), /missing_openai_credential/);
    await assert.rejects(() => openAgentWorker({ stateDir: join(root, 'gate-conflict'), create: true, descriptor, profile: profile([]), limits: responsesLimits('provider'), apiKey: 'fixture', apiKeyFile: join(root, 'missing-secret') }), /conflicting_openai_credentials/);

    const limited = await ResponsesWorker.open({ stateDir: join(root, 'headroom'), create: true, descriptor, profile: profile([]), limits: responsesLimits('provider', { maxEvents: 1 }), transport: new FixtureTransport() });
    const limitedResult = await limited.run({ ...ref, requestId: 'headroom', prompt: 'question' });
    assert.equal(limitedResult.state, 'uncertain'); await limited.shutdown();
    const controlTransport = new ControlHeadroomTransport(); const controlState = join(root, 'control-headroom'); const controlWorker = await ResponsesWorker.open({ stateDir: controlState, create: true, descriptor, profile: profile([]), limits: responsesLimits('provider', { maxReceivedBytes: 100, cancelGraceMs: 50 }), transport: controlTransport });
    const controlResult = await controlWorker.run({ ...ref, requestId: 'control-headroom', prompt: 'question' }); assert.equal(controlResult.state, 'uncertain'); assert.equal(controlTransport.creates, 1);
    const controlCancelled = await controlWorker.cancel({ ...ref, requestId: 'control-headroom' }); assert.equal(controlCancelled?.state, 'cancelled'); assert.equal(controlTransport.cancels, 1);
    const controlJournal = JSON.parse(readFileSync(join(controlState, 'responses-worker.json'), 'utf8')) as { requests: Record<string, { receivedBytes: number; controlReceivedBytes: number }> }; const controlRecord = Object.values(controlJournal.requests)[0]; assert.equal(controlRecord.receivedBytes, 100); assert.equal(controlRecord.controlReceivedBytes, 1); await controlWorker.shutdown();
    const exhaustedState = join(root, 'event-exhaustion'); const exhausted = await ResponsesWorker.open({ stateDir: exhaustedState, create: true, descriptor, profile: profile([]), limits: responsesLimits('provider', { maxEvents: 4 }), transport: new EventExhaustionTransport() });
    const exhaustedResult = await exhausted.run({ ...ref, requestId: 'event-exhaustion', prompt: 'question' });
    assert.notEqual(exhaustedResult.state, 'completed'); const exhaustedJournal = JSON.parse(readFileSync(join(exhaustedState, 'responses-worker.json'), 'utf8')) as { requests: Record<string, { state: string; events: unknown[] }> }; const exhaustedRecord = Object.values(exhaustedJournal.requests)[0]; assert.equal(exhaustedRecord.state, exhaustedResult.state); assert.ok(exhaustedRecord.events.length <= 4); await exhausted.shutdown();
    const exhaustedReopen = await ResponsesWorker.open({ stateDir: exhaustedState, create: false, descriptor, profile: profile([]), limits: responsesLimits('provider', { maxEvents: 4 }), transport: new EventExhaustionTransport() }); assert.equal(exhaustedReopen.status({ ...ref, requestId: 'event-exhaustion' })?.state, exhaustedResult.state); await exhaustedReopen.shutdown();

    // A live consumer receives durable content while the backend stream is
    // still held; a second request and a competing reopen are rejected at the
    // root boundary, and shutdown cannot release the lock early.
    const held = new HeldStreamTransport();
    const heldWorker = await ResponsesWorker.open({ stateDir: join(root, 'held'), create: true, descriptor, profile: profile([]), limits: responsesLimits('provider', { maxDurationMs: 500, cancelGraceMs: 50 }), transport: held });
    const deliveredEvents: number[] = []; const deliveredKinds: string[] = [];
    const heldRun = heldWorker.run({ ...ref, requestId: 'held', prompt: 'held prompt' }, event => { deliveredEvents.push(event.index); deliveredKinds.push(event.type === 'state' ? event.state : event.type); });
    await held.started.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(deliveredEvents.some(index => index > 0), 'consumer must receive stream content before completion'); assert.ok(deliveredKinds.includes('running'), 'first response acknowledgement must publish durable running state');
    await assert.rejects(() => heldWorker.run({ ...ref, requestId: 'other', prompt: 'competing' }), /worker_busy/);
    await assert.rejects(() => ResponsesWorker.open({ stateDir: join(root, 'held'), create: false, descriptor, profile: profile([]), limits: responsesLimits('provider'), transport: new FixtureTransport() }), /worker_lock/);
    held.release();
    assert.equal((await heldRun).state, 'completed'); await heldWorker.shutdown();

    // NR-07: consumer stop must tombstone the canonical request and cancel
    // its acknowledged upstream response, not a pre-run placeholder record.
    const stopTransport = new ConsumerStopTransport();
    const stopWorker = await ResponsesWorker.open({ stateDir: join(root, 'consumer-stop'), create: true, descriptor, profile: profile([]), limits: responsesLimits('provider', { maxDurationMs: 500, cancelGraceMs: 50 }), transport: stopTransport });
    const stopSeen = deferred<void>();
    const stopRun = stopWorker.run({ ...ref, requestId: 'consumer-stop', prompt: 'stop prompt' }, event => { if (event.type === 'content') { stopSeen.resolve(); return false; } return true; });
    await stopTransport.started.promise; await stopSeen.promise;
    for (let wait = 0; wait < 20 && stopTransport.cancelIds.length === 0; wait++) await new Promise(resolve => setImmediate(resolve));
    const stoppedStatus = stopWorker.status({ ...ref, requestId: 'consumer-stop' });
    assert.ok(stoppedStatus?.cancelRequestedAt); assert.deepEqual(stopTransport.cancelIds, ['held-1']); stopTransport.release();
    const stoppedResult = await stopRun; assert.equal(stoppedResult.state, 'cancelled'); await stopWorker.shutdown();

    const slowConsumerTransport = new HeldStreamTransport(); const slowConsumerWorker = await ResponsesWorker.open({ stateDir: join(root, 'slow-consumer'), create: true, descriptor, profile: profile([]), limits: responsesLimits('provider', { maxDurationMs: 500, cancelGraceMs: 50 }), transport: slowConsumerTransport });
    const consumerStarted = deferred<void>(); const consumerRelease = deferred<void>(); let consumed = 0;
    const slowRun = slowConsumerWorker.run({ ...ref, requestId: 'slow-consumer', prompt: 'slow prompt' }, async event => { if (event.type === 'content') { consumed++; consumerStarted.resolve(); await consumerRelease.promise; } return true; });
    await slowConsumerTransport.started.promise; await consumerStarted.promise; const slowCancelled = await slowConsumerWorker.cancel({ ...ref, requestId: 'slow-consumer' }); assert.equal(slowCancelled?.state, 'cancelled'); consumerRelease.resolve(); slowConsumerTransport.release(); assert.equal((await slowRun).state, 'cancelled'); assert.ok(consumed > 0); await slowConsumerWorker.shutdown();

    const handlerStarted = deferred<void>(); const handlerRelease = deferred<void>();
    const stalledProfile: AgentProfile = { ...profile([]), async handleTool(call) { handlerStarted.resolve(); await handlerRelease.promise; if (call.signal.aborted) return { success: false, text: 'aborted' }; return { success: true, text: 'late result' }; } };
    const stalledTransport = new FixtureTransport();
    const stalledWorker = await ResponsesWorker.open({ stateDir: join(root, 'stalled-handler'), create: true, descriptor, profile: stalledProfile, limits: responsesLimits('provider', { maxDurationMs: 500, cancelGraceMs: 25 }), transport: stalledTransport });
    const stalledRun = stalledWorker.run({ ...ref, requestId: 'stalled-handler', prompt: 'stalled prompt' }); await handlerStarted.promise;
    stalledWorker.close(); await assert.rejects(() => stalledWorker.shutdown(), /worker_shutdown_uncertain/);
    await assert.rejects(() => ResponsesWorker.open({ stateDir: join(root, 'stalled-handler'), create: false, descriptor, profile: stalledProfile, limits: responsesLimits('provider', { maxDurationMs: 500, cancelGraceMs: 25 }), transport: new FixtureTransport() }), /worker_lock/);
    handlerRelease.resolve(); await stalledRun.catch(() => {}); await stalledWorker.shutdown();
    const reopenedAfterStall = await ResponsesWorker.open({ stateDir: join(root, 'stalled-handler'), create: false, descriptor, profile: stalledProfile, limits: responsesLimits('provider', { maxDurationMs: 500, cancelGraceMs: 25 }), transport: new FixtureTransport() }); await reopenedAfterStall.shutdown();

    // The original deadline supervises a held SSE operation and prevents a
    // late stream from creating a second response.
    const deadlineTransport = new HeldStreamTransport();
    const deadlineWorker = await ResponsesWorker.open({ stateDir: join(root, 'deadline'), create: true, descriptor, profile: profile([]), limits: responsesLimits('provider', { maxDurationMs: 25, cancelGraceMs: 50 }), transport: deadlineTransport });
    const deadlineRun = deadlineWorker.run({ ...ref, requestId: 'deadline', prompt: 'deadline prompt' });
    await deadlineTransport.started.promise; await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(deadlineTransport.signals[0].aborted, true);
    deadlineTransport.release(); const deadlineResult = await deadlineRun; assert.equal(deadlineResult.state, 'uncertain'); assert.equal(deadlineTransport.creates, 1); await deadlineWorker.shutdown();

    // Explicit cancellation uses the acknowledged opaque ID and remains
    // joined to shutdown; it never guesses a predecessor or creates work.
    const cancelTransport = new HeldStreamTransport();
    const cancelWorker = await ResponsesWorker.open({ stateDir: join(root, 'cancel'), create: true, descriptor, profile: profile([]), limits: responsesLimits('provider', { maxDurationMs: 500, cancelGraceMs: 50 }), transport: cancelTransport });
    const cancelRun = cancelWorker.run({ ...ref, requestId: 'cancel', prompt: 'cancel prompt' });
    await cancelTransport.started.promise; await new Promise(resolve => setImmediate(resolve)); const cancelled = await cancelWorker.cancel({ ...ref, requestId: 'cancel' });
    assert.equal(cancelled?.state, 'cancelled'); assert.equal(cancelTransport.creates, 1); cancelTransport.release(); await cancelRun.catch(() => {}); await cancelWorker.shutdown();

    await childBoundaryRecovery();
    await childAcknowledgedContinuationRecovery();
    await childPendingAndPreparedRecovery();
  } finally { rmSync(root, { recursive: true, force: true }); }
  console.log('Responses worker adversarial rows: no-ack continuation, strict complete output, event headroom, and child crash/reopen passed (fixture/process-boundary evidence).');
}

const args = process.argv.slice(2);
const liveFlags = args.filter(arg => arg === '--live' || arg === '--live-continue');
if (args.some(arg => arg !== '--live' && arg !== '--live-continue') || liveFlags.length > 1) throw new Error('unknown_argument');
if (liveFlags.length) await runLiveProbe(liveFlags[0] === '--live-continue');
else { await tests(); await adversarialTests(); }
