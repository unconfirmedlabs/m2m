import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RequestRecord, type RequestRef, type RequestState, type WorkRequest } from './codex-worker.js';
import { ResearchService, requestHash, type ResearchRequest, type ResearchWorker } from './native-research.js';
import { StreamingEngine } from './streaming-engine.js';
import { makePolicy, policyHash, price, signStatement, utf8, type SignedData, type CheckpointData } from './streaming-codec.js';
import { streamingFixture } from './test-streaming-fixtures.js';

type Json = Record<string, any>;
const terminal = (state: RequestState) => ['completed', 'failed', 'cancelled'].includes(state);
const key = (ref: RequestRef) => JSON.stringify([ref.agent, ref.conversationId, ref.requestId]);
interface WorkerStore { executions: number; record?: RequestRecord }

/** Durable execution fixture: replacing this object simulates a worker-process restart. */
class FakeResearchWorker implements ResearchWorker {
  calls = 0;
  cancellations = 0;
  reconciliations = 0;
  confirmCancellation = true;
  private waiters: Array<(record: RequestRecord) => void> = [];
  constructor(readonly path: string, readonly initialText = '', readonly initialState: RequestState = 'completed') {}
  private load(): WorkerStore { return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : { executions: 0 }; }
  private save(store: WorkerStore): void { writeFileSync(this.path, JSON.stringify(store), { mode: 0o600 }); }
  get executions(): number { return this.load().executions; }
  status(ref: RequestRef): RequestRecord | undefined {
    const record = this.load().record;
    assert.ok(!record || key(record) === key(ref), 'worker references must retain the authenticated buyer and conversation');
    return record;
  }
  async run(request: WorkRequest): Promise<RequestRecord> {
    this.calls++;
    const store = this.load();
    const commitment = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    if (store.record) {
      assert.equal(key(store.record), key(request));
      assert.equal(store.record.commitment, commitment, 'duplicate request content must remain identical');
    } else {
      // An initially cancelled fixture models a deadline expiring before dispatch.
      if (this.initialState !== 'cancelled') store.executions++;
      store.record = {
        agent: request.agent, conversationId: request.conversationId, requestId: request.requestId,
        commitment, submittedInputHash: commitment, clientUserMessageId: 'test-client-message',
        threadId: 'test-thread', turnId: this.initialState === 'cancelled' ? undefined : 'test-turn', knownTurnIds: [], state: this.initialState,
        startedAt: 1, deadline: Number.MAX_SAFE_INTEGER, baselineUsage: null,
        // Deliberately unrelated to byte quantities: these are upstream telemetry.
        upstreamUsage: { totalTokens: 1010, inputTokens: 1000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 3 },
        usageObserved: true, producedUtf8Bytes: Buffer.byteLength(this.initialText),
        items: this.initialText ? { answer: this.initialText } : {},
        events: this.initialText ? [{ type: 'content', itemId: 'answer', delta: this.initialText, producedUtf8Bytes: Buffer.byteLength(this.initialText), index: 0, observedAt: 2, requestId: request.requestId }] : [],
      };
      this.save(store);
    }
    const record = store.record;
    if (terminal(record.state) || record.state === 'uncertain') return structuredClone(record);
    return new Promise(resolve => this.waiters.push(resolve));
  }
  async reconcile(ref: RequestRef): Promise<RequestRecord | undefined> { this.reconciliations++; return this.status(ref); }
  async cancel(ref: RequestRef, reason?: string): Promise<RequestRecord | undefined> {
    this.cancellations++;
    const record = this.status(ref);
    if (record && !terminal(record.state)) {
      const store = this.load();
      store.record!.reason = reason;
      if (this.confirmCancellation) store.record!.state = 'cancelled';
      this.save(store);
      if (terminal(store.record!.state)) this.resolveWaiters(store.record!);
    }
    return this.status(ref);
  }
  finish(state: RequestState = 'completed'): void {
    const store = this.load(); assert.ok(store.record); store.record.state = state; this.save(store); this.resolveWaiters(store.record);
  }
  private resolveWaiters(record: RequestRecord): void { for (const resolve of this.waiters.splice(0)) resolve(structuredClone(record)); }
}

const directory = await mkdtemp(join(tmpdir(), 'm2m-native-research-test-'));
const fixture = await streamingFixture();
const policy = makePolicy(['input_utf8_bytes', 'output_utf8_bytes'], ['3', '7'], '10');
const binding = { offer: await signStatement('offer', { ...fixture.offer.payload, policy_hash: policyHash(policy) }, fixture.provider), policy, channel: fixture.channel };

async function scenario(name: string, output = '', state: RequestState = 'completed') {
  const path = join(directory, name); await mkdir(path, { mode: 0o700 });
  const request: ResearchRequest = { version: 1, conversation: '11'.repeat(32), request: '22'.repeat(32), sequence: '1', prompt: 'Why?' };
  const digest = requestHash(binding.channel, request);
  let buyer = await StreamingEngine.open(join(path, 'buyer.json'), 'buyer', binding, fixture.buyer);
  let provider = await StreamingEngine.open(join(path, 'provider.json'), 'provider', binding, fixture.provider);
  let worker = new FakeResearchWorker(join(path, 'worker.json'), output, state);
  let service = await ResearchService.open(join(path, 'service.json'), provider, worker);
  const send = async (command: Json): Promise<Json> => JSON.parse(Buffer.from(await service.command(utf8(JSON.stringify(command)))).toString('utf8'));
  return {
    path, request, digest, send,
    get buyer() { return buyer; }, get provider() { return provider; }, get worker() { return worker; }, get service() { return service; },
    async credit(outputCeiling: number) {
      const signed = await buyer.authorize('1', digest, [String(Buffer.byteLength(request.prompt)), String(outputCeiling)]);
      const response = await send({ op: 'credit', request, credit: signed });
      assert.equal(response.type, 'ack'); await buyer.receiveAck(response.ack); return signed;
    },
    async start() { return send({ op: 'start', request_hash: digest }); },
    async poll(after: number) { return send({ op: 'poll', request_hash: digest, after_output: String(after) }); },
    async cancel() { return send({ op: 'cancel', request_hash: digest }); },
    async reopen() {
      buyer = await StreamingEngine.open(join(path, 'buyer.json'), 'buyer', binding, fixture.buyer);
      provider = await StreamingEngine.open(join(path, 'provider.json'), 'provider', binding, fixture.provider);
      worker = new FakeResearchWorker(join(path, 'worker.json'), output, state);
      service = await ResearchService.open(join(path, 'service.json'), provider, worker);
    },
    async receive(delivery: Json) {
      assert.equal(delivery.type, 'delivery');
      await buyer.receiveCheckpoint(delivery.checkpoint, Uint8Array.from(delivery.output));
      return delivery.checkpoint as SignedData<CheckpointData>;
    },
  };
}

try {
  {
    const text = 'αβγδεζηθ'; // 16 UTF-8 bytes; the first five-byte credit ends within a character.
    const s = await scenario('credit-recovery', text);
    await assert.rejects(() => s.start(), /unknown_request/);
    assert.equal(s.worker.executions, 0);
    const firstCredit = await s.credit(5);
    const ackReplay = await s.send({ op: 'credit', request: s.request, credit: firstCredit });
    assert.deepEqual(ackReplay.ack, s.provider.replay()[0].ack);
    assert.equal(s.provider.replay().length, 1);
    await s.start(); await s.start();
    assert.equal(s.worker.executions, 1, 'repeated starts cannot repeat external execution');
    const first = await s.poll(0); const firstCheckpoint = await s.receive(first);
    assert.equal(first.output.length, 5); assert.deepEqual(firstCheckpoint.payload.units, ['4', '5']);
    assert.equal(firstCheckpoint.payload.final, false);
    assert.equal(firstCheckpoint.payload.cumulative_amount, price(policy, ['4', '5']));
    assert.deepEqual(first.upstream_usage, s.worker.status({ agent: binding.offer.payload.buyer, conversationId: s.request.conversation, requestId: s.request.request })!.upstreamUsage);
    const beforeExhaustion = s.provider.replay();
    const exhausted = await s.poll(5);
    assert.equal(exhausted.type, 'waiting'); assert.equal(exhausted.reason, 'credit_exhausted');
    assert.deepEqual(s.provider.replay(), beforeExhaustion, 'exhaustion cannot create a checkpoint or an extra charge');
    const replay = await s.poll(0);
    assert.deepEqual(replay.checkpoint, firstCheckpoint); assert.deepEqual(replay.output, first.output);
    await s.receive(replay); assert.equal(s.buyer.replay()[0].deliveries.length, 1);

    // Reopen both payment journals, the service, and its independently durable worker.
    await s.reopen(); await s.start();
    assert.equal(s.worker.executions, 1);
    const replayAfterRestart = await s.poll(0);
    assert.deepEqual(replayAfterRestart.checkpoint, firstCheckpoint); assert.deepEqual(replayAfterRestart.output, first.output);
    const credit2 = await s.credit(30);
    assert.equal(credit2.payload.sequence, '2'); assert.equal(credit2.payload.request_sequence, '1');
    assert.deepEqual(credit2.payload.request_hash, firstCredit.payload.request_hash);
    const finalDelivery = await s.poll(5); const final = await s.receive(finalDelivery);
    assert.equal(final.payload.final, true); assert.deepEqual(final.payload.units, ['4', '16']);
    assert.equal(Buffer.concat([Buffer.from(first.output), Buffer.from(finalDelivery.output)]).toString('utf8'), text);
    assert.equal(final.payload.cumulative_amount, '13');
    assert.equal(credit2.payload.cumulative_amount, '23');
    assert.equal(s.buyer.replay().length, 2, 'provider final consent requires no new buyer credit or answer acceptance');
    assert.ok(s.buyer.snapshot().frozen && s.provider.snapshot().frozen);
    const finalReplay = await s.poll(16);
    assert.deepEqual(finalReplay.checkpoint, final); assert.deepEqual(finalReplay.output, finalDelivery.output);
    assert.equal(s.worker.executions, 1);
    await assert.rejects(() => s.credit(40), /frozen/);
    await assert.rejects(() => s.poll(17), /output_cursor_mismatch/);
    // The server can recover saved evidence after expiry/close without invoking a worker.
    const activity = [s.worker.calls, s.worker.cancellations, s.worker.reconciliations];
    const cached = (command: Json) => {
      const response = s.service.cached(utf8(JSON.stringify(command)));
      return response && JSON.parse(Buffer.from(response).toString('utf8'));
    };
    assert.deepEqual(cached({ op: 'credit', request: s.request, credit: credit2 }).ack, s.provider.replay()[1].ack);
    assert.deepEqual(cached({ op: 'poll', request_hash: s.digest, after_output: '16' }).checkpoint, final);
    assert.equal(cached({ op: 'poll', request_hash: s.digest, after_output: '17' }), undefined);
    assert.equal(cached({ op: 'start', request_hash: s.digest }), undefined);
    const badCredit = structuredClone(credit2); badCredit.signature[0] ^= 1;
    assert.throws(() => cached({ op: 'credit', request: s.request, credit: badCredit }));
    assert.deepEqual([s.worker.calls, s.worker.cancellations, s.worker.reconciliations], activity);
  }
  {
    const s = await scenario('cancel-before-start', 'must never be generated');
    await s.credit(30);
    assert.deepEqual(await s.cancel(), { type: 'cancellation_requested', confirmed: true });
    assert.equal(s.worker.executions, 0); assert.equal(s.worker.cancellations, 0);
    assert.equal(JSON.parse(readFileSync(join(s.path, 'service.json'), 'utf8')).cancelled, true);
    await assert.rejects(() => s.start(), /cancelled_before_start/);
    await s.reopen();
    await assert.rejects(() => s.start(), /cancelled_before_start/);
    assert.deepEqual(await s.cancel(), { type: 'cancellation_requested', confirmed: true });
    assert.equal(s.worker.executions, 0);
    assert.equal(s.provider.replay().length, 1, 'cancellation preserves the already signed credit');
    assert.equal(s.provider.replay()[0].deliveries.length, 0);
    const zero = await s.poll(0); const consent = await s.receive(zero);
    assert.equal(consent.payload.final, true); assert.deepEqual(consent.payload.units, ['0', '0']);
    assert.equal(consent.payload.cumulative_amount, '0'); assert.deepEqual(zero.output, []);
    assert.deepEqual((await s.poll(0)).checkpoint, consent);
    await assert.rejects(() => s.poll(1), /output_cursor_mismatch/);
    await s.reopen(); assert.deepEqual((await s.poll(0)).checkpoint, consent);
    assert.equal(s.provider.replay()[0].deliveries.length, 1, 'zero-use close consent is durable and idempotent');
  }
  {
    const s = await scenario('cancel-running', 'partial', 'running');
    await s.credit(20); await s.start(); await s.start();
    assert.equal(s.worker.calls, 1, 'a still-running worker has a single supervisor');
    assert.deepEqual(await s.cancel(), { type: 'cancellation_requested', confirmed: true });
    await s.service.finish();
    const partial = await s.poll(0); const checkpoint = await s.receive(partial);
    assert.equal(Buffer.from(partial.output).toString('utf8'), 'partial');
    assert.equal(checkpoint.payload.final, true); assert.equal(partial.worker_state, 'cancelled');
    await s.reopen(); await assert.rejects(() => s.start(), /cancelled_before_start/);
    assert.equal(s.worker.executions, 1);
  }
  {
    const s = await scenario('cancel-unconfirmed', '', 'running');
    await s.credit(20); await s.start(); s.worker.confirmCancellation = false;
    assert.deepEqual(await s.cancel(), { type: 'cancellation_requested', confirmed: false });
    await s.reopen();
    s.worker.confirmCancellation = false;
    await assert.rejects(() => s.start(), /cancelled_before_start/);
    const pending = await s.poll(0);
    assert.equal(pending.type, 'waiting'); assert.equal(pending.reason, 'running');
    assert.equal(s.worker.calls, 0, 'a persisted stop must prevent restart supervision');
    assert.equal(s.worker.cancellations, 1, 'restart polling must retransmit the durable interrupt intent');
    assert.equal(s.worker.executions, 1);
    s.worker.finish('cancelled');
    assert.deepEqual(await s.cancel(), { type: 'cancellation_requested', confirmed: true });
    const stopped = await s.poll(0); const final = await s.receive(stopped);
    assert.equal(final.payload.final, true); assert.deepEqual(final.payload.units, ['4', '0']);
    assert.deepEqual(stopped.output, []);
  }
  {
    const s = await scenario('cancel-before-external-dispatch', '', 'cancelled');
    await s.credit(20); await s.start(); await s.service.finish();
    const response = await s.poll(0); const consent = await s.receive(response);
    assert.equal(consent.payload.final, true); assert.deepEqual(consent.payload.units, ['0', '0']);
    assert.equal(consent.payload.cumulative_amount, '0'); assert.equal(s.worker.executions, 0);
  }
  {
    const s = await scenario('crash-before-worker', 'eventually once');
    await s.credit(30);
    const path = join(s.path, 'service.json'); const state = JSON.parse(readFileSync(path, 'utf8'));
    // Crash after the service's intent write but before invoking worker.run().
    state.started = true; writeFileSync(path, JSON.stringify(state));
    await s.reopen(); assert.equal(s.worker.executions, 0);
    await s.start(); await s.start();
    assert.equal(s.worker.executions, 1);
    await s.receive(await s.poll(0));
  }
  {
    const s = await scenario('uncertain-worker', 'saved prefix', 'uncertain');
    await s.credit(30); await s.start(); await s.service.finish();
    await s.start(); await s.service.finish();
    assert.equal(s.worker.calls, 2, 'settled supervisor promises are cleared for reconciliation');
    assert.equal(s.worker.executions, 1, 'uncertainty never means a fresh execution');
    await s.reopen(); await s.start(); await s.service.finish();
    assert.equal(s.worker.executions, 1);
    const partial = await s.poll(0); await s.receive(partial);
    assert.equal(partial.checkpoint.payload.final, false);
    s.worker.finish('completed');
    const final = await s.poll(Buffer.byteLength('saved prefix')); await s.receive(final);
    assert.equal(final.checkpoint.payload.final, true); assert.deepEqual(final.output, []);
  }
  console.log('PASS native research: acknowledged byte ceilings, exhaustion/replenishment, exact final consent, signed replay, service/worker restart, duplicate dispatch suppression, persisted cancellation and uncertain cancellation.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
