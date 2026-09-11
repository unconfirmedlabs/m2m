/** Mechanical payment driver. All research decisions belong to AgentCoordinator. */
import { join } from 'node:path';
import { toBase58 } from '@mysten/sui/utils';
import { CoordinatorError, type BudgetLedger } from './agent-coordinator.js';
import type { AgentExchange, AgentServiceReply } from './agent-service-exchange.js';
import { readAgentJournal } from './agent-service-exchange.js';
import type { EventSink, ResearchPort, ResearchRequestV2, ResearchResult, TurnReceipt, Units } from './agent-service-types.js';
import { ResearchNotDispatchedError, type ResearchNotDispatchedCode } from './agent-service-types.js';
import { save } from './native-chain.js';
import { researchRequestHash } from './research-conversation.js';
import { StreamingEngine } from './streaming-engine.js';
import { byteArray, checkpointHash, creditHash, equal, exactKeys, hash, offerHash, price, u64, ZERO_HASH,
  type ChannelData, type CheckpointData, type CreditData, type OfferData, type SignedData } from './streaming-codec.js';
import { strictJson, type SignedEnvelope } from './native-peer.js';

interface ClientRequest {
  request: ResearchRequestV2;
  start_units: Units;
  started_ms: string;
  cancelling: boolean;
  cancel_deadline_ms: string | null;
  error: string | null;
  receipt: TurnReceipt | null;
  proof: SignedEnvelope | null;
}
interface ClientJournal {
  version: 2; conversation: string; channel: string; offer_hash: number[];
  requests: ClientRequest[];
  rejections: Record<string, ResearchNotDispatchedCode>;
  credit_intent: { request: string; sequence: string; ceilings: Units } | null;
}
export interface AgentClientOptions {
  stateDir: string; create: boolean; conversation: string; engine: StreamingEngine; budget: BudgetLedger;
  exchange: AgentExchange; observeChannel: () => Promise<{ channel: ChannelData; now_ms: string }>;
  settle: (credit: SignedData<CreditData>, checkpoint: SignedData<CheckpointData>) => Promise<{ channel: ChannelData; digest: string }>;
  emit?: EventSink; pollMs?: number;
}
const idValid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const maximum = (a: string, b: string) => String(BigInt(a) > BigInt(b) ? BigInt(a) : BigInt(b));
const terminalWorker = (state: unknown) => ['completed', 'failed', 'cancelled'].includes(state as string);
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
};
const NO_DISPATCH_CODES = new Set<ResearchNotDispatchedCode>([
  'cancelled_before_dispatch', 'budget_rejected', 'deadline_exceeded', 'request_limit_exceeded',
]);

function localNoDispatch(error: unknown): ResearchNotDispatchedCode | undefined {
  // CoordinatorError is a trusted host boundary.  Never infer this category
  // from an arbitrary provider/transport Error.message.
  if (!(error instanceof CoordinatorError)) return undefined;
  if (error.code === 'deadline_expired') return 'deadline_exceeded';
  if (error.code === 'request_limit') return 'request_limit_exceeded';
  if (['funding_limit', 'deposit_exceeded', 'total_limit', 'outstanding_limit', 'turn_limit', 'output_tranche_limit'].includes(error.code)) return 'budget_rejected';
  return undefined;
}

function storedReceipt(value: unknown, conversation: string, channel: string, request: ResearchRequestV2): TurnReceipt {
  try {
    exactKeys(value, ['version', 'conversation', 'request', 'request_hash', 'sequence', 'outcome', 'reason', 'checkpoint_hash',
      'delivered_units', 'generated_output', 'discarded_output', 'continuation', 'citations']);
    const receipt = value as TurnReceipt;
    if (receipt.version !== 2 || receipt.conversation !== conversation || receipt.request !== request.request || receipt.sequence !== request.sequence ||
      !equal(receipt.request_hash, researchRequestHash(channel, request)) ||
      !['completed', 'failed', 'cancelled'].includes(receipt.outcome) ||
      !['ready', 'requires_channel_close'].includes(receipt.continuation) ||
      (receipt.reason !== null && (typeof receipt.reason !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(receipt.reason)))) throw Error('invalid_turn_receipt');
    byteArray(receipt.request_hash, 32); byteArray(receipt.checkpoint_hash, 32);
    if (!Array.isArray(receipt.delivered_units) || receipt.delivered_units.length !== 2) throw Error('invalid_turn_receipt');
    receipt.delivered_units.forEach(u64); u64(receipt.generated_output); u64(receipt.discarded_output);
    if (!Array.isArray(receipt.citations) || receipt.citations.length > 8) throw Error('invalid_turn_receipt');
    for (const [index, citation] of receipt.citations.entries()) {
      exactKeys(citation, ['id', 'url', 'title', 'retrieved_at_ms', 'content_hash']);
      if (citation.id !== `s${index + 1}` || typeof citation.url !== 'string' || Buffer.byteLength(citation.url) > 2048 ||
        !citation.url.startsWith('https://') || typeof citation.title !== 'string' || Buffer.byteLength(citation.title) > 256) throw Error('invalid_citation');
      u64(citation.retrieved_at_ms); byteArray(citation.content_hash, 32);
    }
    return structuredClone(receipt);
  } catch { throw Error('journal_corrupt'); }
}

function validateStoredProof(value: unknown, receipt: TurnReceipt, binding: OfferData): void {
  try {
    exactKeys(value, ['message', 'signature']);
    const proof = value as SignedEnvelope;
    byteArray(proof.signature, 64);
    const message = proof.message as any;
    exactKeys(message, ['purpose', 'sender', 'recipient', 'generation', 'id', 'correlation', 'created_ms', 'expires_ms', 'kind', 'payload']);
    byteArray(message.purpose); byteArray(message.id, 32); byteArray(message.payload);
    if (message.correlation === null) throw Error('invalid_proof');
    byteArray(message.correlation, 32);
    if (Buffer.from(message.purpose).toString('utf8') !== 'm2m/core/message/v1' || typeof message.kind !== 'string' || message.kind !== 'message.receipt') throw Error('invalid_proof');
    u64(message.generation); u64(message.created_ms); u64(message.expires_ms);
    const ref = (value: unknown, expectedAgent: string) => {
      exactKeys(value, ['network', 'package_id', 'domain', 'agent']);
      const r = value as any; byteArray(r.network);
      if (!r.network.length || r.network.length > 64 || !/^0x[0-9a-f]{64}$/.test(r.package_id) ||
        !/^0x[0-9a-f]{64}$/.test(r.domain) || !/^0x[0-9a-f]{64}$/.test(r.agent) ||
        !equal(r.network, binding.network) || r.package_id !== binding.package_id || r.domain !== binding.deployment || r.agent !== expectedAgent) throw Error('invalid_proof');
    };
    ref(message.sender, binding.provider); ref(message.recipient, binding.buyer);
    const body = strictJson(message.payload);
    exactKeys(body, ['session', 'message_id', 'commitment', 'state', 'result']);
    byteArray(body.session, 32); byteArray(body.message_id, 32); byteArray(body.commitment, 32);
    if (body.state !== 'completed' || !equal(body.message_id, message.correlation) || !Array.isArray(body.result)) throw Error('invalid_proof');
    const result = strictJson(body.result);
    exactKeys(result, ['version', 'op_id', 'type', 'receipt']);
    if (result.version !== 2 || typeof result.op_id !== 'string' || !/^[0-9a-f]{64}$/.test(result.op_id) || result.type !== 'turn_terminal' || canonicalJson(result.receipt) !== canonicalJson(receipt)) throw Error('invalid_proof');
  } catch { throw Error('journal_corrupt'); }
}

export class AgentServiceClient implements ResearchPort {
  private active?: string;
  private storage: Promise<unknown> = Promise.resolve();
  private poisoned = false;
  private spendingPaused = false;
  private spendingWaiters = new Set<() => void>();
  private spendingQueue: Promise<unknown> = Promise.resolve();
  private constructor(readonly path: string, private journal: ClientJournal, private options: AgentClientOptions) {}
  static async open(options: AgentClientOptions) {
    const binding = options.engine.snapshot().binding;
    if (!idValid(options.conversation)) throw Error('invalid_conversation');
    const path = join(options.stateDir, 'client.json');
    const existing = await readAgentJournal<ClientJournal>(path, !options.create);
    const journal = existing ?? { version: 2 as const, conversation: options.conversation, channel: binding.channel,
      offer_hash: offerHash(binding.offer.payload), requests: [], rejections: {}, credit_intent: null };
    exactKeys(journal, ['version', 'conversation', 'channel', 'offer_hash', 'requests', 'rejections', 'credit_intent']);
    if (journal.version !== 2 || journal.conversation !== options.conversation || journal.channel !== binding.channel ||
      !equal(journal.offer_hash, offerHash(binding.offer.payload)) || !Array.isArray(journal.requests) || journal.requests.length > 32) throw Error('journal_corrupt');
    if (!journal.rejections || Array.isArray(journal.rejections) || Object.keys(journal.rejections).length > 256) throw Error('journal_corrupt');
    for (const [id, code] of Object.entries(journal.rejections)) if (!idValid(id) || !['cancelled_before_dispatch', 'budget_rejected', 'deadline_exceeded', 'request_limit_exceeded'].includes(code)) throw Error('journal_corrupt');
    if (journal.credit_intent !== null) {
      exactKeys(journal.credit_intent, ['request', 'sequence', 'ceilings']);
      if (!idValid(journal.credit_intent.request) || journal.rejections[journal.credit_intent.request] !== undefined ||
        journal.requests.every(record => record.request.request !== journal.credit_intent!.request)) throw Error('journal_corrupt');
      u64(journal.credit_intent.sequence); if (journal.credit_intent.sequence === '0' || !Array.isArray(journal.credit_intent.ceilings) || journal.credit_intent.ceilings.length !== 2) throw Error('journal_corrupt');
      journal.credit_intent.ceilings.forEach(u64);
    }
    const ids = new Set<string>(); let previousSequence = 0n;
    for (const [index, record] of journal.requests.entries()) {
      exactKeys(record, ['request', 'start_units', 'started_ms', 'cancelling', 'cancel_deadline_ms', 'error', 'receipt', 'proof']);
      researchRequestHash(binding.channel, record.request);
      const sequence = BigInt(record.request.sequence);
      const rejection = journal.rejections[record.request.request];
      const locallyRejected = typeof record.error === 'string' && rejection === record.error && !record.receipt && !record.proof;
      if (ids.has(record.request.request) || record.request.conversation !== options.conversation ||
        sequence < previousSequence || (sequence > previousSequence && sequence > previousSequence + 1n) ||
        (sequence === previousSequence && !locallyRejected) ||
        !Array.isArray(record.start_units) || record.start_units.length !== 2 || typeof record.cancelling !== 'boolean' ||
        (record.error !== null && (typeof record.error !== 'string' || !NO_DISPATCH_CODES.has(record.error as ResearchNotDispatchedCode))) ||
        (record.error !== null && rejection !== record.error) || (record.error === null && rejection !== undefined)) throw Error('journal_corrupt');
      ids.add(record.request.request); if (sequence > previousSequence) previousSequence = sequence;
      record.start_units.forEach(u64); u64(record.started_ms);
      if (record.cancel_deadline_ms !== null) u64(record.cancel_deadline_ms);
      if (record.receipt && !record.proof) throw Error('journal_corrupt');
      if (record.receipt) {
        const receipt = storedReceipt(record.receipt, options.conversation, binding.channel, record.request);
        if (BigInt(receipt.delivered_units[1]) < BigInt(record.start_units[1]) ||
          BigInt(receipt.generated_output) !== BigInt(receipt.delivered_units[1]) - BigInt(record.start_units[1]) + BigInt(receipt.discarded_output)) throw Error('journal_corrupt');
        record.receipt = receipt;
        validateStoredProof(record.proof, receipt, binding.offer.payload);
      } else if (record.proof) throw Error('journal_corrupt');
    }
    // Known application state must never silently acquire an empty replacement engine.
    if (existing && options.engine.replay().length === 0 && journal.requests.some(r => r.receipt || r.proof)) throw Error('journal_missing');
    if (!existing) await save(path, journal);
    return new AgentServiceClient(path, journal, options);
  }
  private persist() {
    const snapshot = structuredClone(this.journal);
    const next = this.storage.then(async () => {
      if (this.poisoned) throw Error('storage_failure');
      if (Buffer.byteLength(JSON.stringify(snapshot, null, 2)) > 8 * 1024 * 1024) throw Error('journal_limit');
      try { await save(this.path, snapshot); } catch (e) { this.poisoned = true; throw e; }
    });
    this.storage = next.catch(() => {}); return next;
  }
  private async event(type: Parameters<EventSink>[0]['type'], data: Record<string, unknown>, request: string | null = null) {
    await this.options.emit?.({ role: 'host', conversation: this.journal.conversation, request, type, data });
  }
  private deliveries() { return this.options.engine.replay().flatMap(r => r.deliveries); }
  private units(): Units { return (this.deliveries().at(-1)?.checkpoint.payload.units ?? ['0', '0']) as Units; }
  private ceilings(): Units { return (this.options.engine.replay().at(-1)?.credit.payload.units ?? ['0', '0']) as Units; }
  private cursor(): number[] { const last = this.deliveries().at(-1); return last ? checkpointHash(last.checkpoint.payload) : ZERO_HASH; }
  private result(record: ClientRequest): ResearchResult {
    const digest = researchRequestHash(this.journal.channel, record.request);
    const bytes = Buffer.concat(this.deliveries().filter(d => equal(d.checkpoint.payload.request_hash, digest)).map(d => Buffer.from(d.output_base64, 'base64')));
    // A cancelled credit window may end inside a code point. Keep exact bytes in
    // the engine and use replacement only for this presentation string.
    return { text: new TextDecoder('utf-8').decode(bytes), receipt: structuredClone(record.receipt!) };
  }
  private async observe(terminalOnly = false) {
    const observation = await this.options.observeChannel(), ch = observation.channel;
    if (ch.id !== this.journal.channel || !equal(offerHash(ch.offer), this.journal.offer_hash)) throw Error('channel_mismatch');
    if (!terminalOnly || ch.status !== 0) await this.options.budget.observe({ channel: ch.id,
      status: ch.status === 0 ? 'open' : ch.status === 1 ? 'closed' : 'refunded', redeemed_mist: ch.redeemed_amount,
      delivered_units: this.units(), authorized_units: this.ceilings() });
    return observation;
  }
  private async requireOpen() {
    // An unsigned write-ahead reservation can exceed the last engine credit.
    // Reading chain status must not lower or prematurely reconcile that reserve.
    const observation = await this.options.observeChannel();
    if (observation.channel.id !== this.journal.channel || !equal(offerHash(observation.channel.offer), this.journal.offer_hash)) throw Error('channel_mismatch');
    if (observation.channel.status !== 0) throw new CoordinatorError('channel_not_open');
    if (BigInt(observation.now_ms) >= BigInt(observation.channel.offer.work_deadline_ms)) throw new CoordinatorError('deadline_expired');
  }
  private operationRoomLow(): boolean {
    const remaining = this.options.exchange.remaining?.();
    // Keep room for up to 32 drain checkpoints plus cancellation, finish and
    // close; the exchange also reserves byte headroom for larger tranches.
    return remaining !== undefined && remaining <= 64;
  }
  private checked(reply: AgentServiceReply, type?: string): Record<string, any> {
    const body = reply.body;
    if (body.version !== 2 || !idValid(body.op_id)) throw Error('invalid_service_response');
    if (body.type === 'error') {
      exactKeys(body, ['version', 'op_id', 'type', 'code']);
      if (typeof body.code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(body.code)) throw Error('invalid_service_response');
      throw Error(body.code);
    }
    if (type && body.type !== type) throw Error('invalid_service_response');
    return body;
  }
  private async localBudgetFailure(record: ClientRequest, error: unknown): Promise<never> {
    const code = localNoDispatch(error);
    if (code) return this.rejectBeforeDispatch(record.request.request, code);
    throw error;
  }
  private async credit(record: ClientRequest, ceilings: Units) {
    const engine = this.options.engine, digest = researchRequestHash(this.journal.channel, record.request);
    const hasSignedForRequest = engine.replay().some(r => equal(r.credit.payload.request_hash, digest));
    try { await this.requireOpen(); }
    catch (error) {
      const code = localNoDispatch(error);
      if (code && !hasSignedForRequest && !this.journal.credit_intent) return this.rejectBeforeDispatch(record.request.request, code);
      throw error;
    }
    const pending = this.journal.credit_intent;
    if (pending && (pending.request !== record.request.request || !equal(pending.ceilings, ceilings))) throw Error('credit_intent_conflict');
    const unacknowledged = engine.replay().at(-1);
    const replaySequence = unacknowledged && !unacknowledged.ack && equal(unacknowledged.credit.payload.request_hash, digest) &&
      equal(unacknowledged.credit.payload.units, ceilings) ? unacknowledged.credit.payload.sequence : undefined;
    const intent = pending ?? { request: record.request.request,
      sequence: replaySequence ?? String(BigInt(engine.replay().at(-1)?.credit.payload.sequence ?? '0') + 1n), ceilings };
    const retained = engine.replay().find(r => r.credit.payload.sequence === intent.sequence);
    // Leave enough durable operation slots for cancellation, drain, finish and
    // close.  This check happens before any new reservation or signature.
    if (!retained && this.operationRoomLow()) {
      record.cancelling = true; await this.persist();
      await this.cancel(record.request.request);
      throw Error('uncertain_execution');
    }
    // Replaying an existing signature grants no new authority and cannot depend
    // on a newly permissive budget. New signatures always reserve first.
    if (!retained) {
      try {
        await this.options.budget.reserveCredit({ channel: this.journal.channel, request: record.request.request, ceilings,
          delivered_units: this.units(), request_start_units: record.start_units });
      } catch (error) {
        const code = localNoDispatch(error);
        if (code && !hasSignedForRequest && !this.journal.credit_intent) return this.rejectBeforeDispatch(record.request.request, code);
        throw error;
      }
      // Cancellation may have won while reserveCredit was awaited.  Keep its
      // reservation, but do not create a credit intent or sign anything.
      if (this.journal.rejections[record.request.request]) await this.rejectBeforeDispatch(record.request.request, this.journal.rejections[record.request.request]);
      if (record.cancelling) await this.rejectBeforeDispatch(record.request.request, 'cancelled_before_dispatch');
    }
    // A retained, already-signed credit is replayable and does not acquire
    // fresh authority. New authority crosses the durable spending gate only
    // after the budget reservation above; cancellation/pause can therefore
    // win while reserveCredit or the gate is awaiting.
    const credit = retained?.credit ?? await this.withCreditAdmission(record.request.request, async () => {
      if (this.journal.rejections[record.request.request] || record.cancelling) throw Error('uncertain_execution');
      if (this.spendingPaused) throw Error('spending_paused');
      this.journal.credit_intent = intent; await this.persist();
      if (this.journal.rejections[record.request.request] || record.cancelling || this.spendingPaused) throw Error('spending_paused');
      return engine.authorize(record.request.sequence, digest, ceilings);
    });
    if (!equal(credit.payload.request_hash, digest) || !equal(credit.payload.units, ceilings)) throw Error('credit_intent_conflict');
    if (!retained) await this.event('authorization', { channel: this.journal.channel, credit, actor: 'host' }, record.request.request);
    const reply = this.checked(await this.options.exchange.call({ op: 'credit', request: record.request, credit }, `credit:${Buffer.from(creditHash(credit.payload)).toString('hex')}`), 'ack');
    exactKeys(reply, ['version', 'op_id', 'type', 'ack']);
    await engine.receiveAck(reply.ack);
    this.journal.credit_intent = null; await this.persist();
    await this.event('budget', { ...this.options.budget.snapshot(), action: 'mechanical_credit' }, record.request.request);
  }

  /** Durable host gate for new credit signatures. Existing signed credits
   * remain replayable while paused. */
  setSpendingPaused(paused: boolean): void {
    this.spendingPaused = paused;
    if (!paused) { for (const wake of this.spendingWaiters) wake(); this.spendingWaiters.clear(); }
  }

  async waitForSpending(signal?: AbortSignal): Promise<void> {
    if (!this.spendingPaused) return;
    await new Promise<void>((resolvePromise, reject) => {
      if (signal?.aborted) { reject(new Error('cancelled')); return; }
      const wake = () => { cleanup(); resolvePromise(); };
      const abort = () => { cleanup(); reject(new Error('cancelled')); };
      const cleanup = () => { this.spendingWaiters.delete(wake); signal?.removeEventListener('abort', abort); };
      this.spendingWaiters.add(wake); signal?.addEventListener('abort', abort, { once: true });
      if (!this.spendingPaused) wake();
    });
  }

  async withCreditAdmission<T>(requestId: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (typeof requestId !== 'string' || !idValid(requestId) || typeof action !== 'function') throw Error('invalid_request');
    const run = this.spendingQueue.then(async () => { await this.waitForSpending(signal); if (this.spendingPaused) throw Error('spending_paused'); return action(); });
    this.spendingQueue = run.catch(() => {}); return run;
  }
  private async delivery(record: ClientRequest, body: Record<string, any>) {
    exactKeys(body, ['version', 'op_id', 'type', 'checkpoint', 'output']);
    const cp = body.checkpoint as SignedData<CheckpointData>, output = Uint8Array.from(byteArray(body.output));
    if (output.length > 1024 || cp.payload.final || !equal(cp.payload.request_hash, researchRequestHash(this.journal.channel, record.request))) throw Error('invalid_delivery');
    if (this.deliveries().some(d => equal(checkpointHash(d.checkpoint.payload), checkpointHash(cp.payload)))) return;
    const before = this.units(), input = String(BigInt(record.start_units[0]) + BigInt(Buffer.byteLength(record.request.prompt)));
    if (cp.payload.units[0] !== input || BigInt(cp.payload.units[1]) !== BigInt(before[1]) + BigInt(output.length)) throw Error('invalid_delivery_units');
    if (before[0] === record.start_units[0] && output.length !== 0) throw Error('missing_input_checkpoint');
    await this.options.engine.receiveCheckpoint(cp, output);
    await this.observe();
    await this.event('delivery', { checkpoint: cp, output: Array.from(output) }, record.request.request);
  }
  private async receipt(record: ClientRequest, reply: AgentServiceReply) {
    const body = this.checked(reply, 'turn_terminal'); exactKeys(body, ['version', 'op_id', 'type', 'receipt']);
    const r = body.receipt as TurnReceipt;
    exactKeys(r, ['version', 'conversation', 'request', 'request_hash', 'sequence', 'outcome', 'reason', 'checkpoint_hash',
      'delivered_units', 'generated_output', 'discarded_output', 'continuation', 'citations']);
    if (r.version !== 2 || r.conversation !== this.journal.conversation || r.request !== record.request.request || r.sequence !== record.request.sequence ||
      !equal(r.request_hash, researchRequestHash(this.journal.channel, record.request)) || !equal(r.checkpoint_hash, this.cursor()) ||
      !equal(r.delivered_units, this.units()) || !['completed', 'failed', 'cancelled'].includes(r.outcome) ||
      !['ready', 'requires_channel_close'].includes(r.continuation) || (r.reason !== null && !/^[a-z][a-z0-9_]{0,63}$/.test(r.reason)) ||
      !Array.isArray(r.citations) || r.citations.length > 8) throw Error('invalid_turn_receipt');
    const count = BigInt(this.units()[1]) - BigInt(record.start_units[1]);
    if (BigInt(u64(r.generated_output)) !== count + BigInt(u64(r.discarded_output))) throw Error('invalid_turn_receipt');
    for (const [index, citation] of r.citations.entries()) {
      exactKeys(citation, ['id', 'url', 'title', 'retrieved_at_ms', 'content_hash']);
      if (citation.id !== `s${index + 1}` || typeof citation.url !== 'string' || Buffer.byteLength(citation.url) > 2048 ||
        !citation.url.startsWith('https://') || typeof citation.title !== 'string' || Buffer.byteLength(citation.title) > 256) throw Error('invalid_citation');
      u64(citation.retrieved_at_ms); byteArray(citation.content_hash, 32);
    }
    record.receipt = structuredClone(r); record.proof = structuredClone(reply.envelope); await this.persist();
    if (r.continuation === 'ready') await this.options.engine.completeRequest(record.request.sequence);
    await this.event('turn_terminal', { receipt: r }, record.request.request);
  }
  async execute(input: { requestId: string; prompt: string }): Promise<ResearchResult> {
    if (this.active) throw Error('conversation_busy');
    if (!idValid(input.requestId)) throw Error('invalid_request');
    if (this.journal.rejections[input.requestId]) throw new ResearchNotDispatchedError(this.journal.rejections[input.requestId]);
    let record = this.journal.requests.find(r => r.request.request === input.requestId);
    if (record && record.request.prompt !== input.prompt) throw Error('request_conflict');
    if (!record) {
      if (this.journal.requests.some(r => !r.receipt && !r.error) || this.journal.requests.at(-1)?.receipt?.continuation === 'requires_channel_close') throw Error('conversation_busy');
      if (this.journal.requests.length >= 32) throw Error('limit_exceeded');
      const request: ResearchRequestV2 = { version: 2, conversation: this.journal.conversation,
        request: input.requestId, sequence: String(BigInt(this.options.engine.replay().at(-1)?.credit.payload.request_sequence ?? '0') + 1n), prompt: input.prompt };
      researchRequestHash(this.journal.channel, request);
      record = { request, start_units: this.units(), started_ms: String(Date.now()), cancelling: false,
        cancel_deadline_ms: null, error: null, receipt: null, proof: null };
      this.journal.requests.push(record); await this.persist();
    }
    if (record.receipt) {
      if (record.receipt.continuation === 'ready' && BigInt(this.options.engine.snapshot().completed_request_sequence) < BigInt(record.request.sequence)) await this.options.engine.completeRequest(record.request.sequence);
      return this.result(record);
    }
    if (record.error) throw new ResearchNotDispatchedError(record.error as ResearchNotDispatchedCode);
    this.active = input.requestId;
    try {
      const hasSignedCredit = this.options.engine.replay().some(r => equal(r.credit.payload.request_hash, researchRequestHash(this.journal.channel, record!.request)));
      if (this.journal.rejections[input.requestId]) {
        await this.rejectBeforeDispatch(input.requestId, 'cancelled_before_dispatch');
      }
      if (record.cancelling && !hasSignedCredit && !this.journal.credit_intent) {
        await this.rejectBeforeDispatch(input.requestId, 'cancelled_before_dispatch');
      }
      try { await this.options.budget.beginRequest(input.requestId, record.start_units); }
      catch (error) { await this.localBudgetFailure(record, error); }
      if ((record.cancelling || this.journal.rejections[input.requestId]) &&
        !this.options.engine.replay().some(r => equal(r.credit.payload.request_hash, researchRequestHash(this.journal.channel, record!.request))) && !this.journal.credit_intent) {
        await this.rejectBeforeDispatch(input.requestId, 'cancelled_before_dispatch');
      }
      const existing = this.options.engine.replay().filter(r => r.credit.payload.request_sequence === record!.request.sequence);
      if (this.journal.credit_intent) await this.credit(record, this.journal.credit_intent.ceilings);
      else if (!existing.length) {
        const before = this.units(), old = this.ceilings(), reserved = this.options.budget.reservedUnits();
        const retained: Units = [maximum(old[0], reserved[0]), maximum(old[1], reserved[1])];
        await this.credit(record, [maximum(retained[0], String(BigInt(before[0]) + BigInt(Buffer.byteLength(input.prompt)))),
          maximum(retained[1], String(BigInt(before[1]) + BigInt(this.options.budget.snapshot().limits.output_tranche_bytes)))]);
      } else if (!existing.at(-1)!.ack) await this.credit(record, existing.at(-1)!.credit.payload.units as Units);
      const digest = researchRequestHash(this.journal.channel, record.request);
      if (!record.cancelling) {
        const started = this.checked(await this.options.exchange.call({ op: 'start', request_hash: digest }, `start:${input.requestId}`), 'started');
        exactKeys(started, ['version', 'op_id', 'type', 'request_hash']);
        if (!equal(started.request_hash, digest)) throw Error('invalid_service_response');
      }
      else await this.cancel(input.requestId);
      await this.event('request_started', { request: record.request, request_hash: digest }, input.requestId);
      for (;;) {
        const budget = this.options.budget.snapshot();
        if (Date.now() >= Number(budget.limits.deadline_ms) && !record.cancelling) await this.cancel(input.requestId);
        if (record.cancelling && !record.cancel_deadline_ms) await this.cancel(input.requestId);
        if (record.cancel_deadline_ms && Date.now() >= Number(record.cancel_deadline_ms)) throw Error('uncertain_execution');
        if (!record.cancelling && this.operationRoomLow()) { await this.cancel(input.requestId); continue; }
        const reply = await this.options.exchange.call({ op: 'poll', request_hash: digest, after_checkpoint: this.cursor() });
        const body = this.checked(reply);
        if (body.type === 'delivery') { await this.delivery(record, body); continue; }
        if (body.type === 'turn_terminal') { await this.receipt(record, reply); return this.result(record); }
        if (body.type !== 'waiting' || !body.status) throw Error('invalid_service_response');
        exactKeys(body, ['version', 'op_id', 'type', 'reason', 'status']);
        const status = body.status;
        exactKeys(status, ['request_hash', 'phase', 'worker_state', 'checkpoint_hash', 'delivered_units', 'authorized_units',
          'generated_output', 'available_output', 'input_dispatched', 'cancel_requested']);
        if (!['running', 'credit_exhausted', 'cancelling'].includes(body.reason) ||
          !['credited', 'launching', 'running', 'draining', 'cancelling', 'terminal', 'uncertain'].includes(status.phase) ||
          (status.worker_state !== null && !['prepared', 'launching', 'running', 'completed', 'failed', 'cancelled', 'uncertain'].includes(status.worker_state)) ||
          typeof status.input_dispatched !== 'boolean' || typeof status.cancel_requested !== 'boolean' ||
          !equal(status.checkpoint_hash, this.cursor())) throw Error('invalid_service_status');
        if (!equal(status.request_hash, digest) || !equal(status.delivered_units, this.units()) || !equal(status.authorized_units, this.ceilings())) throw Error('invalid_service_status');
        u64(status.generated_output); u64(status.available_output);
        if (BigInt(status.available_output) > BigInt(status.generated_output)) throw Error('invalid_service_status');
        if (status.phase === 'uncertain' || status.worker_state === 'uncertain') throw Error('uncertain_execution');
        if (body.reason === 'credit_exhausted' && !record.cancelling) {
          const actual = this.ceilings(), reserved = this.options.budget.reservedUnits();
          const old: Units = [maximum(actual[0], reserved[0]), maximum(actual[1], reserved[1])];
          const generatedExtent = BigInt(record.start_units[1]) + BigInt(status.generated_output);
          if (generatedExtent <= BigInt(actual[1])) throw Error('invalid_service_status');
          const trancheTarget = BigInt(actual[1]) + BigInt(budget.limits.output_tranche_bytes);
          // Advance by at most one output tranche; generatedExtent may be far
          // ahead because the worker produced unpaid bytes.  The next credit
          // must not turn those bytes into one oversized reservation.
          const target = maximum(old[1], String(trancheTarget < generatedExtent ? trancheTarget : generatedExtent));
          try { await this.credit(record, [old[0], target]); continue; }
          catch (e) {
            // A local budget/deadline guard after a signed credit is trusted
            // host evidence for cancellation, not proof of no dispatch.
            const local = localNoDispatch(e);
            if (!((e instanceof ResearchNotDispatchedError) || local) || this.journal.credit_intent) throw e;
            await this.cancel(input.requestId);
          }
        }
        if (terminalWorker(status.worker_state) || (record.cancelling && ['cancelling', 'draining', 'terminal'].includes(status.phase))) {
          const finish = await this.options.exchange.call({ op: 'finish', request_hash: digest, discard_unpaid: record.cancelling }, `finish:${input.requestId}:${record.cancelling}`);
          const finished = this.checked(finish);
          if (finished.type === 'turn_terminal') { await this.receipt(record, finish); return this.result(record); }
          throw Error('invalid_service_response');
        }
        await new Promise(resolve => setTimeout(resolve, this.options.pollMs ?? 750));
      }
    } catch (e) {
      const credited = this.options.engine.replay().some(r => equal(r.credit.payload.request_hash, researchRequestHash(this.journal.channel, record!.request)));
      if (credited || this.journal.credit_intent) { record.cancelling = true; await this.options.budget.markUncertain(); }
      else if (e instanceof ResearchNotDispatchedError && this.journal.rejections[record.request.request] !== e.code) {
        // The exception is trusted only because it carries the host-only class
        // identity.  Its code is never reconstructed from peer text.
        await this.rejectBeforeDispatch(record.request.request, e.code);
      }
      await this.persist();
      throw e;
    } finally { this.active = undefined; }
  }
  async cancel(requestId: string): Promise<{ confirmed: boolean }> {
    // Wake a paused credit waiter. Cancellation remains independent from the
    // model/network operation and is never stranded behind it.
    for (const wake of this.spendingWaiters) wake();
    const record = this.journal.requests.find(r => r.request.request === requestId);
    if (!idValid(requestId)) throw Error('invalid_request');
    if (!record || record.error) return this.rejectBeforeDispatch(requestId, 'cancelled_before_dispatch');
    if (record.receipt) return { confirmed: true };
    record.cancelling = true; record.cancel_deadline_ms ??= String(Date.now() + 15_000); await this.persist();
    if (!this.options.engine.replay().some(r => equal(r.credit.payload.request_hash, researchRequestHash(this.journal.channel, record.request))) && !this.journal.credit_intent) return this.rejectBeforeDispatch(requestId, 'cancelled_before_dispatch');
    const body = this.checked(await this.options.exchange.call({ op: 'cancel', request_hash: researchRequestHash(this.journal.channel, record.request) }, `cancel:${requestId}`), 'cancellation_requested');
    exactKeys(body, ['version', 'op_id', 'type', 'confirmed']);
    if (typeof body.confirmed !== 'boolean') throw Error('invalid_service_response');
    return { confirmed: body.confirmed };
  }
  private async rejectBeforeDispatch(requestId: string, code: ResearchNotDispatchedCode): Promise<never> {
    const record = this.journal.requests.find(r => r.request.request === requestId);
    // Any retained intent is a write-ahead promise to recover/sign one credit;
    // a local typed rejection is therefore impossible until it is reconciled.
    if (this.journal.credit_intent || (record && this.options.engine.replay().some(r =>
      equal(r.credit.payload.request_hash, researchRequestHash(this.journal.channel, record.request))))) throw Error('uncertain_execution');
    if (!this.journal.rejections[requestId] && Object.keys(this.journal.rejections).length >= 256) throw Error('limit_exceeded');
    const prior = this.journal.rejections[requestId];
    if (prior && prior !== code) throw Error('request_conflict');
    this.journal.rejections[requestId] ??= code;
    if (record) record.error = this.journal.rejections[requestId];
    // The tombstone is durable before completeRequest.  The latter is
    // idempotent and never refunds the reserved money or request count.
    if (!prior) await this.persist();
    await this.options.budget.completeRequest(requestId);
    if (prior) await this.persist();
    throw new ResearchNotDispatchedError(this.journal.rejections[requestId]);
  }
  readyForReplacement(): boolean { return !this.active && this.journal.requests.every(r => r.receipt !== null || r.error !== null); }
  /** Retained public proof projection; no private prompts or worker state. */
  evidence(): { terminal_receipts: SignedEnvelope[] } {
    return { terminal_receipts: this.journal.requests.flatMap(record => record.proof ? [structuredClone(record.proof)] : []) };
  }
  async close() {
    if (!this.readyForReplacement()) throw Error('uncertain_execution');
    const engine = this.options.engine, last = engine.replay().at(-1);
    if (!last) throw Error('uncredited_channel_requires_expiry_refund');
    let final = this.deliveries().at(-1)?.checkpoint;
    if (!engine.snapshot().frozen) {
      // A later locally rejected request has no provider/economic identity.
      // Close the last actual credit, not the last local attempt.
      const request = this.journal.requests.find(record => equal(
        researchRequestHash(this.journal.channel, record.request), last.credit.payload.request_hash));
      if (!request) throw Error('journal_corrupt');
      const response = this.checked(await this.options.exchange.call({ op: 'close', conversation: this.journal.conversation,
        last_request_hash: researchRequestHash(this.journal.channel, request.request) }, `channel-close:${this.journal.channel}`), 'channel_final');
      exactKeys(response, ['version', 'op_id', 'type', 'checkpoint', 'output']);
      final = response.checkpoint;
      if (!final?.payload.final || !equal(final.payload.units, this.units()) || !equal(response.output, []) || !equal(final.payload.output_hash, hash([]))) throw Error('invalid_channel_final');
      await engine.receiveCheckpoint(final, new Uint8Array());
      await this.event('channel_final', { checkpoint: final });
    }
    if (!final?.payload.final) throw Error('missing_channel_final');
    const current = await this.options.observeChannel();
    const settled = current.channel.status === 0 ? await this.options.settle(last.credit, final) :
      { channel: current.channel, digest: toBase58(Uint8Array.from(current.channel.terminal_tx)) };
    const ch = settled.channel;
    if (ch.status !== 1 || ch.funds !== '0' || ch.redeemed_amount !== price(engine.snapshot().binding.policy, this.units()) ||
      !equal(ch.close_hash, checkpointHash(final.payload))) throw Error('settlement_uncertain');
    await this.observe();
    const result = { channel: ch.id, status: 'closed', digest: settled.digest, paid_mist: ch.redeemed_amount,
      refund_mist: String(BigInt(ch.offer.deposit) - BigInt(ch.redeemed_amount)) };
    await this.event('settlement', result); return result;
  }
}
