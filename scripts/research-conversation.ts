import { mkdir, open, readFile, rename, chmod, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { blake2b } from '@noble/hashes/blake2.js';
import { strictJson } from './native-peer.js';
import { NativeLock } from './native-lock.js';
import { StreamingEngine, type DeliveryRecord } from './streaming-engine.js';
import {
  type ChannelData, type CheckpointData, type CreditData, type PolicyData, type SignedData,
  checkpointHash, creditHash, equal, exactKeys, hash, price, validatePolicy, validateSigned,
  validateStatement, byteArray, u64, utf8, ZERO_HASH, policyHash, offerHash,
} from './streaming-codec.js';
import type { AgentRef } from './native-chain.js';
import type { AgentWorker, Citation, ResearchRequestV2, ResearchStatus, TurnReceipt, Units } from './agent-service-types.js';
import type { RequestRef, RequestRecord, WorkRequest, WorkerEvent } from './codex-worker.js';

export const RESEARCH_CONVERSATION_FEATURE = 'service.research.conversation.v2';
export const RESEARCH_CONVERSATION_VERSION = 2;

const PAYMENT_FEATURE = 'payment.sui.streaming.v1';
const MODEL = 'gpt-5.6-luna';
const REASONING = 'xhigh';
const MAX_WIRE = 65_536;
const MAX_JOURNAL = 8 * 1024 * 1024;
const MAX_REQUESTS = 32;
const MAX_OPERATIONS = 512;
const MAX_PROMPT = 16_384;
const MAX_CHUNK = 1_024;
const ZERO = Array<number>(32).fill(0);
const TERMINAL_WORKER = new Set(['completed', 'failed', 'cancelled']);

type JsonObject = Record<string, any>;
type ErrorCode =
  | 'invalid_command' | 'unsupported_version' | 'unsupported_service' | 'operation_conflict'
  | 'request_conflict' | 'unknown_request' | 'conversation_busy' | 'channel_mismatch'
  | 'channel_not_open' | 'work_expired' | 'claim_expired' | 'credit_mismatch'
  | 'credit_exhausted' | 'checkpoint_cursor_mismatch' | 'drain_required'
  | 'worker_not_terminal' | 'uncertain_execution' | 'journal_missing' | 'journal_corrupt'
  | 'storage_failure' | 'limit_exceeded' | 'backend_unavailable' | 'search_unconfigured'
  | 'invalid_citation';

class ConversationError extends Error {
  constructor(readonly code: ErrorCode) { super(code); }
}

interface OperationRecord { op_id: string; command: JsonObject; result: JsonObject }
interface RequestJournal {
  request: ResearchRequestV2;
  request_hash: number[];
  credit_hash: number[] | null;
  pending_credit: SignedData<any> | null;
  ack: SignedData<any> | null;
  phase: ResearchStatus['phase'];
  worker_state: ResearchStatus['worker_state'];
  started: boolean;
  dispatch_intent: boolean;
  input_checkpoint_intent: boolean;
  delivery_intent: { units: Units; output_base64: string } | null;
  input_dispatched: boolean;
  cancel_requested: boolean;
  cancel_confirmed: boolean;
  generated_output_base64: string;
  discarded_output_bytes: string;
  baseline_units: Units;
  baseline_checkpoint: number[];
  last_worker_event: number;
  worker_thread_id: string | null;
  worker_turn_id: string | null;
  receipt: TurnReceipt | null;
  receipt_envelope: JsonObject | null;
  engine_completed: boolean;
}
interface ServiceState {
  version: 2;
  conversation: string;
  buyer: AgentRef;
  provider: AgentRef;
  channel: string;
  offer_hash: number[];
  policy_hash: number[];
  feature: string;
  operations: OperationRecord[];
  requests: RequestJournal[];
  final_checkpoint: SignedData<CheckpointData> | null;
  final_response: JsonObject | null;
  close_intent: { request_hash: number[]; at: number; op_id: string } | null;
}

function fail(code: ErrorCode): never { throw new ConversationError(code); }
function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail('invalid_command');
  return value;
}
function address(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) fail('invalid_command');
  return value;
}
function validUtf8String(value: unknown, maxBytes: number, nonempty = false): string {
  if (typeof value !== 'string' || (nonempty && value.length === 0)) fail('invalid_command');
  // TextEncoder replaces lone surrogates, which would make the signed bytes
  // differ from the caller's string. Reject them before encoding.
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) fail('invalid_command');
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) fail('invalid_command');
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) fail('limit_exceeded');
  return value;
}
function bytes(value: unknown, length?: number): number[] {
  try { return byteArray(value, length); } catch { fail('invalid_command'); }
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function sameRef(a: AgentRef, b: AgentRef): boolean {
  return a.package_id === b.package_id && a.domain === b.domain && a.agent === b.agent && same(a.network, b.network);
}
function validateRef(value: unknown): AgentRef {
  if (!isObject(value)) fail('invalid_command');
  exactKeys(value, ['network', 'package_id', 'domain', 'agent']);
  const network = bytes(value.network);
  if (network.length < 1 || network.length > 64) fail('invalid_command');
  try { new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(network)); } catch { fail('invalid_command'); }
  return { network, package_id: address(value.package_id), domain: address(value.domain), agent: address(value.agent) };
}
function addressBytes(value: string): number[] { return Array.from(Buffer.from(value.slice(2), 'hex')); }
function uleb(value: number): number[] {
  const out: number[] = [];
  do { let byte = value & 0x7f; value >>>= 7; if (value) byte |= 0x80; out.push(byte); } while (value);
  return out;
}
function bcsVec(value: number[]): number[] { return [...uleb(value.length), ...value]; }
function bcsAgentRef(ref: AgentRef): number[] {
  return [...bcsVec(ref.network), ...addressBytes(ref.package_id), ...addressBytes(ref.domain), ...addressBytes(ref.agent)];
}
/** Stable qualified buyer identity for the worker journal. */
export function qualifiedAgentKey(ref: AgentRef): string { return Buffer.from(bcsAgentRef(ref)).toString('hex'); }
function workerRef(state: ServiceState, req: RequestJournal): RequestRef {
  return { agent: qualifiedAgentKey(state.buyer), conversationId: state.conversation, requestId: req.request.request };
}
function asText(value: string): number[] { return Array.from(new TextEncoder().encode(value)); }
function concat(...parts: number[][]): Uint8Array { return Uint8Array.from(parts.flat()); }

/**
 * BLAKE2b-256 over the ordered, independently specified BCS request object.
 * This deliberately does not use the JSON or economic codecs.
 */
export function researchRequestHash(channel: string, request: ResearchRequestV2): number[] {
  if (!isObject(request)) fail('invalid_command');
  exactKeys(request, ['version', 'conversation', 'request', 'sequence', 'prompt']);
  if (request.version !== 2) fail('unsupported_version');
  const conversation = id(request.conversation);
  const requestId = id(request.request);
  u64(request.sequence); if (request.sequence === '0') fail('invalid_command');
  const prompt = validUtf8String(request.prompt, MAX_PROMPT, true);
  address(channel);
  const bcs = concat(
    bcsVec(asText('m2m/research/request/v2')),
    addressBytes(channel),
    bcsVec(Array.from(Buffer.from(conversation, 'hex'))),
    bcsVec(Array.from(Buffer.from(requestId, 'hex'))),
    Array.from(Buffer.alloc(8)),
    bcsVec(asText(prompt)),
    bcsVec(asText(MODEL)),
    bcsVec(asText(REASONING)),
    bcsVec(asText(RESEARCH_CONVERSATION_FEATURE)),
  );
  const seq = BigInt(request.sequence); const sequenceBytes = Buffer.alloc(8); sequenceBytes.writeBigUInt64LE(seq);
  // The sequence is the fifth BCS field; replace the zero placeholder without
  // relying on a third-party struct encoder.
  const offset = bcsVec(asText('m2m/research/request/v2')).length + 32 +
    bcsVec(Array.from(Buffer.from(conversation, 'hex'))).length +
    bcsVec(Array.from(Buffer.from(requestId, 'hex'))).length;
  bcs.set(sequenceBytes, offset);
  return hash(bcs);
}

function requestValidate(value: unknown): ResearchRequestV2 {
  if (!isObject(value)) fail('invalid_command');
  exactKeys(value, ['version', 'conversation', 'request', 'sequence', 'prompt']);
  if (value.version !== 2) fail('unsupported_version');
  return { version: 2, conversation: id(value.conversation), request: id(value.request), sequence: u64(value.sequence), prompt: validUtf8String(value.prompt, MAX_PROMPT, true) };
}
function response(version: number, opId: string, type: string, rest: JsonObject = {}): JsonObject {
  return { version, op_id: opId, type, ...rest };
}
function errorResponse(opId: string, code: ErrorCode): JsonObject { return response(2, opId, 'error', { code }); }
function opFields(op: string): string[] {
  switch (op) {
    case 'credit': return ['version', 'op_id', 'op', 'request', 'credit'];
    case 'start': return ['version', 'op_id', 'op', 'request_hash'];
    case 'poll': return ['version', 'op_id', 'op', 'request_hash', 'after_checkpoint'];
    case 'status': return ['version', 'op_id', 'op', 'request_hash'];
    case 'cancel': return ['version', 'op_id', 'op', 'request_hash'];
    case 'finish': return ['version', 'op_id', 'op', 'request_hash', 'discard_unpaid'];
    case 'close': return ['version', 'op_id', 'op', 'conversation', 'last_request_hash'];
    case 'offer': return ['version', 'op_id', 'op', 'conversation', 'nonce', 'previous_channel'];
    case 'funded': return ['version', 'op_id', 'op', 'conversation', 'channel'];
    default: return ['version', 'op_id', 'op'];
  }
}
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  const out: JsonObject = {};
  for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
  return out;
}
function orderedCommand(value: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const key of opFields(value.op)) if (key in value) out[key] = key === 'request' ? orderedRequest(value[key]) : key === 'credit' ? orderedSigned(value[key]) : value[key];
  return out;
}
function orderedRequest(value: JsonObject): JsonObject {
  const out: JsonObject = {}; for (const key of ['version', 'conversation', 'request', 'sequence', 'prompt']) out[key] = value[key]; return out;
}
function orderedSigned(value: JsonObject): JsonObject {
  const out: JsonObject = {}; for (const key of ['payload', 'signature']) out[key] = key === 'payload' ? orderedPayload(value[key]) : value[key]; return out;
}
function orderedPayload(value: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const key of Object.keys(value).sort()) out[key] = value[key];
  return out;
}
function commandValidate(value: unknown): JsonObject {
  if (!isObject(value)) fail('invalid_command');
  const opId = id(value.op_id);
  if (value.version !== 2) throw new ConversationError(value.version === undefined ? 'invalid_command' : 'unsupported_version');
  if (typeof value.op !== 'string') fail('invalid_command');
  const fields = opFields(value.op);
  if (fields.length === 3) throw new ConversationError('unsupported_service');
  try { exactKeys(value, fields); } catch { fail('invalid_command'); }
  if (value.op === 'credit') {
    value.request = requestValidate(value.request);
    if (!isObject(value.credit)) fail('credit_mismatch');
    try { validateStatement('credit', value.credit.payload); validateSigned('credit', value.credit, value.credit.payload.buyer_key); } catch { /* Engine re-verifies with the pinned offer key. */ }
  } else if (value.op === 'start' || value.op === 'poll' || value.op === 'status' || value.op === 'cancel' || value.op === 'finish') {
    bytes(value.request_hash, 32);
    if (value.op === 'poll') bytes(value.after_checkpoint, 32);
    if (value.op === 'finish' && typeof value.discard_unpaid !== 'boolean') fail('invalid_command');
  } else if (value.op === 'close') {
    if (id(value.conversation) !== value.conversation) fail('invalid_command');
    bytes(value.last_request_hash, 32);
  } else if (value.op === 'offer' || value.op === 'funded') {
    throw new ConversationError('unsupported_service');
  }
  return orderedCommand(value);
}
function mapWorkerState(state: unknown): ResearchStatus['worker_state'] {
  return typeof state === 'string' && ['prepared', 'launching', 'running', 'completed', 'failed', 'cancelled', 'uncertain'].includes(state)
    ? state as ResearchStatus['worker_state'] : null;
}
function mapWorkerError(error: unknown): ErrorCode {
  const code = error instanceof ConversationError ? error.code : error instanceof Error ? error.message : '';
  if (code.includes('expired')) return 'work_expired';
  if (code.includes('credit') || code.includes('exhaust')) return 'credit_mismatch';
  if (code.includes('checkpoint') || code.includes('frozen')) return 'channel_mismatch';
  if (code.includes('storage') || code.includes('journal')) return 'storage_failure';
  if (code.includes('backend') || code.includes('worker')) return 'backend_unavailable';
  return 'invalid_command';
}
function decodeOutput(bytesValue: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytesValue); } catch { return bytesValue.toString('utf8'); }
}
function sourceIdPattern(text: string): string[] {
  const values: string[] = []; const re = /\[\s*(s[1-9][0-9]*)\s*\]/g; let match: RegExpExecArray | null;
  while ((match = re.exec(text))) values.push(match[1]); return [...new Set(values)];
}
function receiptOutput(req: RequestJournal): Buffer { return Buffer.from(req.generated_output_base64, 'base64'); }

export class ResearchConversationService {
  private constructor(
    private readonly path: string,
    private readonly lock: NativeLock,
    private readonly engine: StreamingEngine,
    private readonly worker: AgentWorker,
    private readonly observeChannel: () => Promise<{ channel: ChannelData; now_ms: string }>,
    private readonly sourceLookup: (ref: RequestRef) => Citation[],
    private state: ServiceState,
  ) {}
  private queue: Promise<unknown> = Promise.resolve();
  private poisoned = false;
  private closed = false;
  private running = new Map<string, Promise<void>>();

  static async open(options: {
    stateDir: string; create: boolean; engine: StreamingEngine; worker: AgentWorker; conversation: string;
    buyer: AgentRef; provider: AgentRef;
    observeChannel: () => Promise<{ channel: ChannelData; now_ms: string }>;
    sources?: (ref: RequestRef) => Citation[];
  }): Promise<ResearchConversationService> {
    id(options.conversation); const buyer = validateRef(options.buyer); const provider = validateRef(options.provider);
    const binding = options.engine.snapshot().binding;
    validatePolicy(binding.policy);
    const offer = binding.offer.payload;
    if (offer.buyer !== buyer.agent || offer.provider !== provider.agent ||
      !same(offer.network, buyer.network) || !same(offer.network, provider.network) ||
      offer.package_id !== buyer.package_id || offer.package_id !== provider.package_id ||
      offer.deployment !== buyer.domain || offer.deployment !== provider.domain) throw new Error('agent binding mismatch');
    if (!same(Array.from(binding.policy.units[0] ?? []), utf8('input_utf8_bytes')) ||
        !same(Array.from(binding.policy.units[1] ?? []), utf8('output_utf8_bytes')) || binding.policy.units.length !== 2) throw new Error('unsupported research policy');
    const root = options.stateDir; await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
    const marker = join(root, 'initialized.json'); const file = join(root, 'service.json');
    const exists = async (p: string) => stat(p).then(s => { if (s.size > MAX_JOURNAL) throw new Error('journal_corrupt'); return true; }, e => { if (e.code === 'ENOENT') return false; throw e; });
    const hasMarker = await exists(marker); const hasState = await exists(file);
    if (!options.create && (!hasMarker || !hasState)) throw new Error('journal_missing');
    // A crash may leave a fully durable service journal before the small
    // initialization marker is renamed into place. In create mode, validate
    // and reuse that journal, then repair only the local marker. A marker
    // without its journal is never treated as initialized.
    if (options.create && hasMarker !== hasState && hasMarker) throw new Error('journal_corrupt');
    const lock = await NativeLock.acquire(join(root, '.lock'));
    try {
      let state: ServiceState;
      if (hasState) {
        try { state = JSON.parse(await readFile(file, 'utf8')) as ServiceState; validateState(state, options.conversation, buyer, provider, binding.channel, binding.offer.payload, binding.policy); }
        catch { throw new Error('journal_corrupt'); }
        if (!hasMarker) await persist(marker, { version: 1, role: 'research-provider', initialized: true });
      } else {
        state = { version: 2, conversation: options.conversation, buyer, provider, channel: binding.channel,
          offer_hash: offerHash(binding.offer.payload), policy_hash: policyHash(binding.policy), feature: RESEARCH_CONVERSATION_FEATURE,
          operations: [], requests: [], final_checkpoint: null, final_response: null, close_intent: null };
        await persist(file, state); await persist(marker, { version: 1, role: 'research-provider', initialized: true });
      }
      const service = new ResearchConversationService(file, lock, options.engine, options.worker, options.observeChannel, options.sources ?? (() => []), state);
      await service.recover();
      return service;
    } catch (error) { await lock.close(); throw error; }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(async () => { if (this.poisoned) fail('storage_failure'); return fn(); });
    this.queue = pending.catch(() => undefined); return pending;
  }
  private async save(): Promise<void> {
    if (this.poisoned) fail('storage_failure');
    try { await persist(this.path, this.state); }
    catch { this.poisoned = true; fail('storage_failure'); }
  }
  /** Reconcile only durable evidence on reopen; a missing worker is uncertain and
   * is never relaunched from a dispatch intent. */
  private async recover(): Promise<void> {
    for (const req of this.state.requests) {
      const records = this.engine.replay();
      if (req.pending_credit) {
        const pendingHash = creditHash(req.pending_credit.payload);
        const pendingRecord = records.find(r => same(creditHash(r.credit.payload), pendingHash));
        if (pendingRecord?.ack) { req.credit_hash = pendingHash; req.ack = structuredClone(pendingRecord.ack); req.pending_credit = null; }
      }
      if (req.delivery_intent) {
        const pendingBytes = Buffer.from(req.delivery_intent.output_base64, 'base64');
        const found = this.currentDeliveries(req).some(d => same(d.checkpoint.payload.units, req.delivery_intent!.units) && same(d.checkpoint.payload.output_hash, hash(pendingBytes)));
        if (found) req.delivery_intent = null;
        else { req.phase = 'uncertain'; req.worker_state = 'uncertain'; }
      }
      const record = req.credit_hash ? records.find(r => same(creditHash(r.credit.payload), req.credit_hash!)) : undefined;
      if (record?.ack && !req.ack) { req.ack = structuredClone(record.ack); }
      if (req.input_checkpoint_intent) {
        if (this.currentDeliveries(req).some(d => !d.checkpoint.payload.final && BigInt(d.checkpoint.payload.units[0]) >= BigInt(this.currentBaseline(req)[0]) + BigInt(Buffer.byteLength(req.request.prompt)))) {
          req.input_dispatched = true; req.input_checkpoint_intent = false;
        } else if (req.dispatch_intent) { req.phase = 'uncertain'; req.worker_state = 'uncertain'; }
      }
      if (req.dispatch_intent && !req.receipt) {
        let status: RequestRecord | undefined;
        try { status = this.worker.status(this.requestRef(req)); } catch { status = undefined; }
        if (!status) { req.phase = 'uncertain'; req.worker_state = 'uncertain'; }
        else {
          // A persisted dispatch is reconciled through the worker journal; it
          // is never relaunched merely because this process reopened.
          let reconciled = status;
          if (!TERMINAL_WORKER.has(status.state) && status.state !== 'uncertain') {
            try { reconciled = (await this.worker.reconcile(this.requestRef(req))) ?? status; } catch { req.phase = 'uncertain'; req.worker_state = 'uncertain'; }
          }
          await this.syncWorker(req, reconciled);
        }
      }
      if (req.delivery_intent) { req.phase = 'uncertain'; req.worker_state = 'uncertain'; }
      if (req.receipt && req.input_dispatched && !req.engine_completed) {
        try { await this.engine.completeRequest(req.request.sequence); req.engine_completed = true; } catch { /* retained for a later reopen */ }
      }
    }
    if (this.state.close_intent && !this.state.final_checkpoint) {
      const final = this.latestDeliveries().find(d => d.checkpoint.payload.final);
      if (final) {
        this.state.final_checkpoint = final.checkpoint;
        this.state.final_response = response(2, this.state.close_intent.op_id, 'channel_final', { checkpoint: final.checkpoint, output: [] });
      }
    }
    await this.save();
  }
  private req(hashValue: number[]): RequestJournal {
    const value = this.state.requests.find(r => same(r.request_hash, hashValue)); if (!value) fail('unknown_request'); return value;
  }
  private requestRef(req: RequestJournal): RequestRef { return workerRef(this.state, req); }
  private binding() { return this.engine.snapshot().binding; }
  private async observe(kind: 'new' | 'read' | 'close' = 'new'): Promise<{ channel: ChannelData; now_ms: string }> {
    let observation: { channel: ChannelData; now_ms: string };
    try { observation = await this.observeChannel(); } catch { fail('channel_mismatch'); }
    if (!observation || !isObject(observation.channel)) fail('channel_mismatch');
    const channel = observation.channel;
    if (channel.id !== this.state.channel || !same(offerHash(channel.offer), this.state.offer_hash) || !same(policyHash(channel.policy), this.state.policy_hash)) fail('channel_mismatch');
    let now: string; try { now = u64(observation.now_ms); } catch { fail('channel_mismatch'); }
    if (kind === 'new' && channel.status !== 0) fail('channel_not_open');
    if (kind === 'new' && BigInt(now) >= BigInt(channel.offer.work_deadline_ms)) fail('work_expired');
    if (kind === 'close' && BigInt(now) >= BigInt(channel.offer.claim_deadline_ms)) fail('claim_expired');
    return { channel, now_ms: now };
  }
  private operations(opId: string, command: JsonObject): JsonObject | undefined {
    const existing = this.state.operations.find(o => o.op_id === opId);
    if (!existing) return undefined;
    if (JSON.stringify(existing.command) !== JSON.stringify(command)) fail('operation_conflict');
    return structuredClone(existing.result);
  }
  private async saveOperation(command: JsonObject, result: JsonObject): Promise<void> {
    const existing = this.state.operations.find(o => o.op_id === command.op_id);
    if (existing) return;
    if (this.state.operations.length >= MAX_OPERATIONS) fail('limit_exceeded');
    this.state.operations.push({ op_id: command.op_id, command: structuredClone(command), result: structuredClone(result) });
    await this.save();
  }

  async command(input: number[]): Promise<number[]> {
    if (this.closed) throw new Error('storage_failure');
    if (!Array.isArray(input) || input.some(n => !Number.isInteger(n) || n < 0 || n > 255) || input.length > MAX_WIRE) throw new Error('invalid_command');
    const parsed = strictJson(input);
    let command: JsonObject;
    try { command = commandValidate(parsed); } catch (error) {
      if (error instanceof ConversationError && isObject(parsed) && typeof parsed.op_id === 'string' && /^[0-9a-f]{64}$/.test(parsed.op_id)) return asText(JSON.stringify(errorResponse(parsed.op_id, error.code)));
      throw error;
    }
    return this.serial(async () => {
      let prior: JsonObject | undefined;
      try { prior = this.operations(command.op_id, command); }
      catch (error) { if (error instanceof ConversationError) return asText(JSON.stringify(errorResponse(command.op_id, error.code))); throw error; }
      if (prior) return asText(JSON.stringify(prior));
      if (this.state.operations.length >= MAX_OPERATIONS) return asText(JSON.stringify(errorResponse(command.op_id, 'limit_exceeded')));
      let result: JsonObject;
      try { result = await this.dispatch(command); }
      catch (error) { result = errorResponse(command.op_id, error instanceof ConversationError ? error.code : mapWorkerError(error)); }
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_WIRE) result = errorResponse(command.op_id, 'limit_exceeded');
      try { await this.saveOperation(command, result); }
      catch (error) { if (error instanceof ConversationError) result = errorResponse(command.op_id, error.code); else throw error; }
      return asText(JSON.stringify(result));
    });
  }

  cached(input: number[]): number[] | undefined {
    if (!Array.isArray(input) || input.length > MAX_WIRE) throw new Error('invalid_command');
    const parsed = strictJson(input); const command = commandValidate(parsed);
    const prior = this.operations(command.op_id, command); return prior ? asText(JSON.stringify(prior)) : undefined;
  }

  private async dispatch(command: JsonObject): Promise<JsonObject> {
    if (this.state.final_response && command.op !== 'close' && command.op !== 'status' && command.op !== 'poll') {
      fail('channel_not_open');
    }
    switch (command.op) {
      case 'credit': return this.credit(command);
      case 'start': return this.start(command);
      case 'poll': return this.poll(command);
      case 'status': return this.statusResponse(command);
      case 'cancel': return this.cancel(command);
      case 'finish': return this.finishRequest(command);
      case 'close': return this.closeChannel(command);
      default: fail('unsupported_service');
    }
  }
  private currentRequestFrom(command: JsonObject): RequestJournal { return this.req(bytes(command.request_hash, 32)); }
  private latestDeliveries(): DeliveryRecord[] { return this.engine.replay().flatMap(record => record.deliveries); }
  private currentDeliveries(req: RequestJournal): DeliveryRecord[] {
    return this.latestDeliveries().filter(d => same(d.checkpoint.payload.request_hash, req.request_hash));
  }
  private latestUnits(): Units {
    const cp = this.latestDeliveries().at(-1)?.checkpoint.payload;
    return cp ? [cp.units[0], cp.units[1]] : ['0', '0'];
  }
  private currentBaseline(req: RequestJournal): Units {
    return [req.baseline_units[0], req.baseline_units[1]];
  }
  private previousUnits(previous: number[]): Units {
    const delivery = this.latestDeliveries().find(d => same(checkpointHash(d.checkpoint.payload), previous));
    return delivery ? [delivery.checkpoint.payload.units[0], delivery.checkpoint.payload.units[1]] : ['0', '0'];
  }
  private authorized(req: RequestJournal): Units {
    const record = this.engine.replay().find(r => same(creditHash(r.credit.payload), req.credit_hash ?? []));
    return record ? [record.credit.payload.units[0], record.credit.payload.units[1]] : this.latestUnits();
  }
  private deliveredFor(req: RequestJournal): Units {
    const deliveries = this.currentDeliveries(req); const latest = deliveries.at(-1)?.checkpoint.payload;
    return latest ? [latest.units[0], latest.units[1]] : this.currentBaseline(req);
  }
  private async credit(command: JsonObject): Promise<JsonObject> {
    await this.observe('new');
    const request = requestValidate(command.request); if (request.conversation !== this.state.conversation) fail('request_conflict');
    const digest = researchRequestHash(this.state.channel, request); const credit = command.credit as SignedData<CreditData>;
    bytes(digest, 32); if (!isObject(credit) || !isObject(credit.payload)) fail('credit_mismatch');
    try { validateSigned('credit', credit, this.binding().offer.payload.buyer_key); } catch { fail('credit_mismatch'); }
    if (!same(credit.payload.request_hash, digest) || credit.payload.request_sequence !== request.sequence || credit.payload.channel !== this.state.channel) fail('credit_mismatch');
    const existing = this.state.requests.find(r => same(r.request_hash, digest));
    const incomingCreditHash = creditHash(credit.payload);
    if (existing) {
      if (!same(existing.request, request)) fail('request_conflict');
      if (existing.credit_hash && same(existing.credit_hash, incomingCreditHash) && existing.ack) return response(2, command.op_id, 'ack', { ack: existing.ack });
      if (existing.cancel_requested || existing.receipt) fail('conversation_busy');
      const requiredInput = BigInt(existing.baseline_units[0]) + BigInt(Buffer.byteLength(request.prompt));
      if (BigInt(credit.payload.units[0]) < requiredInput) fail('credit_mismatch');
      const priorAuth = this.authorized(existing);
      if (BigInt(credit.payload.units[1]) <= BigInt(priorAuth[1])) fail('credit_mismatch');
      const generatedBytes = receiptOutput(existing).length;
      // A renewal can authorize only already durable generated bytes. It may
      // not be used to pre-authorize an unknown future response.
      if (BigInt(credit.payload.units[1]) > BigInt(existing.baseline_units[1]) + BigInt(generatedBytes)) fail('credit_mismatch');
      existing.pending_credit = structuredClone(credit); await this.save();
    } else {
      if (this.state.requests.length >= MAX_REQUESTS) fail('limit_exceeded');
      const prior = this.state.requests.at(-1);
      if (prior && !prior.receipt) fail('conversation_busy');
      if (prior?.receipt?.continuation === 'requires_channel_close') fail('drain_required');
      if (prior && BigInt(request.sequence) !== BigInt(prior.request.sequence) + 1n) fail('request_conflict');
      if (!prior && request.sequence !== '1') fail('request_conflict');
      const previous = this.latestUnits(); const requiredInput = BigInt(previous[0]) + BigInt(Buffer.byteLength(request.prompt));
      if (BigInt(credit.payload.units[0]) < requiredInput) fail('credit_mismatch');
      const next: RequestJournal = { request, request_hash: digest, credit_hash: null, pending_credit: structuredClone(credit), ack: null,
        phase: 'credited', worker_state: null, started: false, dispatch_intent: false, input_checkpoint_intent: false,
        delivery_intent: null, input_dispatched: false, cancel_requested: false, cancel_confirmed: false,
        generated_output_base64: '', discarded_output_bytes: '0', baseline_units: this.latestUnits(), baseline_checkpoint: credit.payload.previous_checkpoint,
        last_worker_event: -1, worker_thread_id: null, worker_turn_id: null, receipt: null, receipt_envelope: null, engine_completed: false };
      this.state.requests.push(next); await this.save();
    }
    const req = this.req(digest);
    try {
      const ack = await this.engine.acceptCredit(credit); req.credit_hash = incomingCreditHash; req.pending_credit = null; req.ack = structuredClone(ack); req.phase = 'credited'; await this.save();
      return response(2, command.op_id, 'ack', { ack });
    } catch { req.pending_credit = null; await this.save(); fail('credit_mismatch'); }
  }
  private async start(command: JsonObject): Promise<JsonObject> {
    await this.observe('new'); const req = this.currentRequestFrom(command); if (!req.ack || !req.credit_hash) fail('credit_mismatch');
    if (req.receipt) return response(2, command.op_id, 'started', { request_hash: req.request_hash });
    if (req.cancel_requested) fail('conversation_busy');
    if (!req.started) {
      req.dispatch_intent = true; req.started = true; req.phase = 'launching'; await this.save();
      this.supervise(req);
    }
    return response(2, command.op_id, 'started', { request_hash: req.request_hash });
  }
  private async syncWorker(req: RequestJournal, record?: RequestRecord): Promise<RequestRecord | undefined> {
    let current = record;
    if (!current) { try { current = this.worker.status(this.requestRef(req)); } catch { current = undefined; } }
    if (!current) {
      if (req.dispatch_intent && !req.receipt) { req.phase = 'uncertain'; req.worker_state = 'uncertain'; await this.save(); }
      return undefined;
    }
    req.worker_thread_id = current.threadId ?? req.worker_thread_id; req.worker_turn_id = current.turnId ?? req.worker_turn_id;
    if (req.worker_turn_id && !req.input_dispatched) await this.ensureInputCheckpoint(req);
    for (const event of current.events ?? []) await this.workerEvent(req, event);
    req.worker_state = mapWorkerState(current.state);
    if (req.worker_state === 'uncertain') req.phase = 'uncertain';
    else if (req.worker_state && TERMINAL_WORKER.has(req.worker_state)) {
      const baseline = this.currentBaseline(req); const delivered = this.deliveredFor(req);
      const authorized = this.authorized(req); const generated = receiptOutput(req).length;
      const paidExtent = Math.max(0, Number(BigInt(authorized[1]) - BigInt(baseline[1])));
      const deliveredExtent = Math.max(0, Number(BigInt(delivered[1]) - BigInt(baseline[1])));
      req.phase = req.cancel_requested || !req.input_dispatched || generated > deliveredExtent || deliveredExtent < Math.min(generated, paidExtent) ? 'draining' : 'terminal';
    }
    else if (req.started) req.phase = req.cancel_requested ? 'cancelling' : 'running';
    await this.save(); return current;
  }
  private async workerEvent(req: RequestJournal, event: WorkerEvent): Promise<void> {
    if (!event || typeof event.index !== 'number' || event.index <= req.last_worker_event) return;
    req.last_worker_event = event.index;
    if (event.type === 'content') {
      const prior = receiptOutput(req); req.generated_output_base64 = Buffer.concat([prior, Buffer.from(event.delta, 'utf8')]).toString('base64');
    }
    if (event.type === 'state') req.worker_state = mapWorkerState(event.state);
    if (req.worker_state === 'uncertain') req.phase = 'uncertain';
    else if (req.worker_state && TERMINAL_WORKER.has(req.worker_state)) req.phase = req.cancel_requested ? 'draining' : 'terminal';
    else if (req.worker_state === 'running' || req.worker_state === 'launching') req.phase = req.cancel_requested ? 'cancelling' : 'running';
    // Event records do not themselves authenticate dispatch. A turn ID from
    // the worker journal (or an explicit reconciliation) is required before
    // charging the prompt input.
    if ((event.type === 'content' || (event.type === 'state' && ['running', 'completed', 'failed', 'cancelled'].includes(event.state))) && !req.input_dispatched) {
      let status: RequestRecord | undefined;
      try { status = this.worker.status(this.requestRef(req)); } catch { status = undefined; }
      if (status?.turnId) { req.worker_thread_id = status.threadId ?? req.worker_thread_id; req.worker_turn_id = status.turnId; await this.ensureInputCheckpoint(req); }
    }
    await this.save();
  }
  private async ensureInputCheckpoint(req: RequestJournal): Promise<void> {
    if (req.input_dispatched) return;
    req.input_checkpoint_intent = true; await this.save();
    const previous = this.latestUnits(); const units: Units = [String(BigInt(previous[0]) + BigInt(Buffer.byteLength(req.request.prompt))), previous[1]];
    const credit = this.authorized(req); if (BigInt(units[0]) > BigInt(credit[0])) { req.phase = 'uncertain'; await this.save(); fail('credit_mismatch'); }
    try { await this.engine.deliver(units, new Uint8Array(), { final: false }); }
    catch { req.phase = 'uncertain'; await this.save(); fail('storage_failure'); }
    req.input_dispatched = true; req.input_checkpoint_intent = false; await this.save();
  }
  private supervise(req: RequestJournal): void {
    if (this.running.has(req.request.request)) return;
    const ref = this.requestRef(req); const promise = (async () => {
      try {
        const record = await this.worker.run({ ...ref, prompt: req.request.prompt } as WorkRequest, event => this.serial(() => this.workerEvent(req, event)).catch(() => false), req.last_worker_event);
        await this.serial(async () => { await this.syncWorker(req, record); });
      } catch {
        await this.serial(async () => { req.phase = 'uncertain'; req.worker_state = 'uncertain'; await this.save(); });
      }
    })().finally(() => this.running.delete(req.request.request));
    this.running.set(req.request.request, promise);
  }
  private cursorDeliveries(req: RequestJournal, cursor: number[]): { next?: DeliveryRecord; cursorIndex: number } {
    const current = this.currentDeliveries(req).filter(d => !d.checkpoint.payload.final);
    const previous = req.baseline_checkpoint;
    if (same(cursor, ZERO)) {
      if (!same(previous, ZERO)) fail('checkpoint_cursor_mismatch');
    } else if (!same(cursor, previous) && !current.some(d => same(checkpointHash(d.checkpoint.payload), cursor))) fail('checkpoint_cursor_mismatch');
    const index = same(cursor, previous) || same(cursor, ZERO) ? -1 : current.findIndex(d => same(checkpointHash(d.checkpoint.payload), cursor));
    return { next: current[index + 1], cursorIndex: index };
  }
  private async poll(command: JsonObject): Promise<JsonObject> {
    await this.observe('read'); const req = this.currentRequestFrom(command); const cursor = bytes(command.after_checkpoint, 32);
    if (req.phase === 'uncertain') fail('uncertain_execution');
    if (req.receipt) {
      const found = this.cursorDeliveries(req, cursor).next;
      if (found) return response(2, command.op_id, 'delivery', { checkpoint: found.checkpoint, output: Array.from(Buffer.from(found.output_base64, 'base64')) });
      return response(2, command.op_id, 'turn_terminal', { receipt: req.receipt });
    }
    let current = await this.syncWorker(req);
    const replay = this.cursorDeliveries(req, cursor).next;
    if (replay) return response(2, command.op_id, 'delivery', { checkpoint: replay.checkpoint, output: Array.from(Buffer.from(replay.output_base64, 'base64')) });
    if (req.dispatch_intent && !current) fail('uncertain_execution');
    if (current && ['launching', 'running'].includes(current.state) && !req.input_dispatched && (current.turnId || current.events?.length)) await this.ensureInputCheckpoint(req);
    const deliveries = this.currentDeliveries(req).filter(d => !d.checkpoint.payload.final);
    const last = deliveries.at(-1)?.checkpoint.payload; const baseline = this.currentBaseline(req); const deliveredOutput = last?.units[1] ?? baseline[1];
    const generated = receiptOutput(req); const authorized = this.authorized(req);
    const maxPaid = BigInt(authorized[1]); const baselineOutput = BigInt(baseline[1]);
    if (BigInt(deliveredOutput) < baselineOutput) fail('journal_corrupt');
    const offset = Number(BigInt(deliveredOutput) - baselineOutput);
    const allowed = Number(maxPaid - baselineOutput);
    if (offset < 0 || Number.isNaN(offset)) fail('journal_corrupt');
    if (offset < Math.min(generated.length, Math.max(0, allowed))) {
      const end = Math.min(generated.length, Math.max(0, allowed), offset + MAX_CHUNK);
      const output = generated.subarray(offset, end); const units: Units = [last?.units[0] ?? String(BigInt(baseline[0]) + BigInt(Buffer.byteLength(req.request.prompt))), String(BigInt(baseline[1]) + BigInt(end))];
      req.delivery_intent = { units, output_base64: Buffer.from(output).toString('base64') }; await this.save();
      const checkpoint = await this.engine.deliver(units, output, { final: false }); req.delivery_intent = null; await this.save();
      return response(2, command.op_id, 'delivery', { checkpoint, output: Array.from(output) });
    }
    const status = await this.statusObject(req);
    const workerTerminal = !!current && TERMINAL_WORKER.has(current.state);
    const reason = generated.length > Math.max(0, allowed) ? 'credit_exhausted' : req.cancel_requested ? 'cancelling' : 'running';
    if (workerTerminal && generated.length <= Math.max(0, allowed) && req.input_dispatched) status.phase = 'terminal';
    return response(2, command.op_id, 'waiting', { reason, status });
  }
  private async statusObject(req: RequestJournal): Promise<ResearchStatus> {
    await this.syncWorker(req); const deliveries = this.currentDeliveries(req); const last = deliveries.at(-1)?.checkpoint;
    const delivered = last ? [last.payload.units[0], last.payload.units[1]] as Units : this.currentBaseline(req);
    const authorized = this.authorized(req); const generated = receiptOutput(req);
    const baseline = this.currentBaseline(req); const deliveredBytes = Math.max(0, Number(BigInt(delivered[1]) - BigInt(baseline[1])));
    const retainedEnd = Math.max(0, generated.length - Number(BigInt(req.discarded_output_bytes)));
    const availableEnd = Math.min(retainedEnd, Math.max(0, Number(BigInt(authorized[1]) - BigInt(baseline[1]))));
    const available = generated.subarray(Math.min(deliveredBytes, generated.length), availableEnd);
    return { request_hash: req.request_hash, phase: req.phase, worker_state: req.worker_state,
      checkpoint_hash: last ? checkpointHash(last.payload) : (same(req.request_hash, ZERO) ? ZERO : (this.engine.replay().find(r => same(creditHash(r.credit.payload), req.credit_hash ?? []))?.credit.payload.previous_checkpoint ?? ZERO)),
      delivered_units: delivered, authorized_units: authorized, generated_output: String(generated.length),
      available_output: String(available.length), input_dispatched: req.input_dispatched, cancel_requested: req.cancel_requested };
  }
  private async statusResponse(command: JsonObject): Promise<JsonObject> {
    await this.observe('read'); const req = this.currentRequestFrom(command); return response(2, command.op_id, 'status', { status: await this.statusObject(req) });
  }
  private async cancel(command: JsonObject): Promise<JsonObject> {
    await this.observe('read'); const req = this.currentRequestFrom(command); if (req.receipt) return response(2, command.op_id, 'cancellation_requested', { confirmed: req.cancel_confirmed });
    req.cancel_requested = true; req.phase = 'cancelling'; await this.save();
    if (!req.started) { req.cancel_confirmed = true; await this.save(); return response(2, command.op_id, 'cancellation_requested', { confirmed: true }); }
    let record: RequestRecord | undefined;
    try { record = await this.worker.cancel(this.requestRef(req), 'buyer_cancelled'); } catch { record = undefined; }
    if (!record) { req.phase = 'uncertain'; req.worker_state = 'uncertain'; await this.save(); return response(2, command.op_id, 'cancellation_requested', { confirmed: false }); }
    req.worker_state = mapWorkerState(record.state); req.cancel_confirmed = record.state === 'cancelled' || record.state === 'completed' || record.state === 'failed';
    req.phase = req.cancel_confirmed ? 'draining' : 'uncertain'; await this.save();
    return response(2, command.op_id, 'cancellation_requested', { confirmed: req.cancel_confirmed });
  }
  private citations(req: RequestJournal): { citations: Citation[]; valid: boolean } {
    let refs: Citation[];
    try { refs = this.sourceLookup(this.requestRef(req)) ?? []; } catch { return { citations: [], valid: false }; }
    const byId = new Map<string, Citation>();
    for (const citation of refs) {
      try {
        const url = new URL(citation.url);
        if (byId.has(citation.id) || !/^s[1-9][0-9]*$/.test(citation.id) || typeof citation.url !== 'string' || Buffer.byteLength(citation.url) > 2048 || url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.hash || typeof citation.title !== 'string' || Buffer.byteLength(citation.title) > 256 || typeof citation.retrieved_at_ms !== 'string' || !/^(0|[1-9][0-9]*)$/.test(citation.retrieved_at_ms) || !Array.isArray(citation.content_hash) || citation.content_hash.length !== 32 || citation.content_hash.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error();
        byId.set(citation.id, citation);
      } catch { return { citations: [], valid: false }; }
    }
    const unknown = sourceIdPattern(decodeOutput(receiptOutput(req))).some(idValue => !byId.has(idValue));
    // Invalid citation quality is a terminal service outcome, not an excuse
    // to strand already-paid bytes. Retain the valid fetched ledger when its
    // structure is sound; malformed ledger entries yield an empty list.
    return { citations: [...byId.values()], valid: !unknown };
  }
  private async finishRequest(command: JsonObject): Promise<JsonObject> {
    await this.observe('read'); const req = this.currentRequestFrom(command); if (req.receipt) return response(2, command.op_id, 'turn_terminal', { receipt: req.receipt });
    const record = !req.started && req.cancel_requested ? ({ state: 'cancelled' } as RequestRecord) : await this.syncWorker(req);
    if (req.phase === 'uncertain' || req.delivery_intent) fail('uncertain_execution');
    if (!record || !TERMINAL_WORKER.has(record.state)) {
      if (req.worker_state === 'uncertain') fail('uncertain_execution');
      fail('worker_not_terminal');
    }
    const deliveries = this.currentDeliveries(req); const current = deliveries.at(-1)?.checkpoint.payload;
    const noDispatchTerminal = !req.input_dispatched && (record.state === 'failed' || record.state === 'cancelled');
    if (!current && !req.cancel_requested && !noDispatchTerminal) fail('drain_required');
    const baseline = this.currentBaseline(req); const authorized = this.authorized(req); const delivered = current?.units[1] ?? baseline[1];
    const generated = receiptOutput(req); const deliveredBytes = Math.max(0, Number(BigInt(delivered) - BigInt(baseline[1])));
    const authorizedBytes = Math.max(0, Number(BigInt(authorized[1]) - BigInt(baseline[1])));
    const unpaid = generated.subarray(Math.min(generated.length, authorizedBytes));
    if (generated.length > authorizedBytes && !command.discard_unpaid) fail('credit_exhausted');
    if (deliveredBytes < Math.min(generated.length, authorizedBytes)) fail('drain_required');
    // This receipt describes the immutable generated extent beyond the final
    // paid ceiling. Never accumulate this field across retries or reopen;
    // repeated finish calls replay the retained receipt above.
    if (unpaid.length) req.discarded_output_bytes = String(unpaid.length);
    const citationResult = this.citations(req);
    const outcome: TurnReceipt['outcome'] = !citationResult.valid ? 'failed' : record.state === 'completed' ? 'completed' : req.cancel_requested ? 'cancelled' : record.state === 'failed' ? 'failed' : 'completed';
    const continuation: TurnReceipt['continuation'] = !req.input_dispatched ? 'requires_channel_close' : 'ready';
    const receipt: TurnReceipt = { version: 2, conversation: this.state.conversation, request: req.request.request, request_hash: req.request_hash,
      sequence: req.request.sequence, outcome, reason: !citationResult.valid ? 'invalid_citation' : outcome === 'completed' ? null : (req.cancel_requested ? 'cancelled' : 'backend_unavailable'),
      checkpoint_hash: current ? checkpointHash(current) : ZERO, delivered_units: current ? [current.units[0], current.units[1]] : baseline,
      generated_output: String(generated.length), discarded_output: req.discarded_output_bytes, continuation, citations: citationResult.citations };
    req.receipt = receipt; req.phase = 'terminal'; await this.save();
    if (req.input_dispatched && !req.engine_completed) {
      try { await this.engine.completeRequest(req.request.sequence); req.engine_completed = true; await this.save(); } catch { /* replay completion on reopen */ }
    }
    return response(2, command.op_id, 'turn_terminal', { receipt });
  }
  private async closeChannel(command: JsonObject): Promise<JsonObject> {
    if (command.conversation !== this.state.conversation) fail('request_conflict');
    const lastHash = bytes(command.last_request_hash, 32); const req = this.state.requests.at(-1); if (!req || !same(req.request_hash, lastHash)) fail('unknown_request');
    if (this.state.final_response) return { ...structuredClone(this.state.final_response), op_id: command.op_id };
    await this.observe('close');
    for (const candidate of this.state.requests) {
      if (!candidate.receipt) fail('worker_not_terminal');
      if (candidate.phase === 'uncertain') fail('uncertain_execution');
    }
    const deliveries = this.currentDeliveries(req); const last = deliveries.at(-1)?.checkpoint.payload;
    if (last && last.final) fail('channel_not_open');
    const active = this.engine.replay().at(-1); if (!active?.ack) fail('drain_required');
    const closeIntent = { request_hash: req.request_hash, at: Date.now(), op_id: command.op_id }; this.state.close_intent = closeIntent; await this.save();
    let checkpoint: SignedData<CheckpointData>;
    try { checkpoint = await this.engine.deliver(last ? [last.units[0], last.units[1]] : this.latestUnits(), new Uint8Array(), { final: true }); }
    catch { fail('drain_required'); }
    this.state.final_checkpoint = checkpoint; const result = response(2, command.op_id, 'channel_final', { checkpoint, output: [] }); this.state.final_response = result; await this.save();
    return result;
  }
  async finish(): Promise<void> {
    const pending = Promise.all([...this.running.values()]).then(() => undefined);
    await Promise.race([pending, new Promise<void>(resolve => setTimeout(resolve, 5_000))]);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.finish(); } finally { await this.lock.close(); }
  }
}

function validateState(state: ServiceState, conversation: string, buyer: AgentRef, provider: AgentRef, channel: string, offer: any, policy: PolicyData): void {
  if (!state || state.version !== 2 || state.conversation !== conversation || !sameRef(state.buyer, buyer) || !sameRef(state.provider, provider) || state.channel !== channel || state.feature !== RESEARCH_CONVERSATION_FEATURE || !same(state.offer_hash, offerHash(offer)) || !same(state.policy_hash, policyHash(policy)) || !Array.isArray(state.operations) || !Array.isArray(state.requests)) throw new Error('corrupt');
  const top = ['version', 'conversation', 'buyer', 'provider', 'channel', 'offer_hash', 'policy_hash', 'feature', 'operations', 'requests', 'final_checkpoint', 'final_response', 'close_intent'];
  if (!same(Object.keys(state).sort(), top.slice().sort())) throw new Error('corrupt');
  if (state.operations.length > MAX_OPERATIONS || state.requests.length > MAX_REQUESTS) throw new Error('corrupt');
  for (const op of state.operations) {
    if (!op || !same(Object.keys(op).sort(), ['op_id', 'command', 'result'].sort()) || !/^[0-9a-f]{64}$/.test(op.op_id) || !isObject(op.command) || !isObject(op.result)) throw new Error('corrupt');
    try { const command = commandValidate(op.command); if (command.op_id !== op.op_id || op.result.version !== 2 || op.result.op_id !== op.op_id || typeof op.result.type !== 'string') throw new Error(); }
    catch { throw new Error('corrupt'); }
  }
  const requestKeys = ['request', 'request_hash', 'credit_hash', 'pending_credit', 'ack', 'phase', 'worker_state', 'started', 'dispatch_intent', 'input_checkpoint_intent', 'delivery_intent', 'input_dispatched', 'cancel_requested', 'cancel_confirmed', 'generated_output_base64', 'discarded_output_bytes', 'baseline_units', 'baseline_checkpoint', 'last_worker_event', 'worker_thread_id', 'worker_turn_id', 'receipt', 'receipt_envelope', 'engine_completed'];
  for (const req of state.requests) {
    if (!req || !same(Object.keys(req).sort(), requestKeys.slice().sort())) throw new Error('corrupt');
    requestValidate(req.request); bytes(req.request_hash, 32);
    if (req.credit_hash !== null) bytes(req.credit_hash, 32);
    if (req.pending_credit !== null) { try { validateSigned('credit', req.pending_credit, offer.buyer_key); } catch { throw new Error('corrupt'); } }
    if (req.ack !== null) { try { validateSigned('ack', req.ack, offer.provider_key); } catch { throw new Error('corrupt'); } }
    if (req.delivery_intent !== null) {
      if (!Array.isArray(req.delivery_intent.units) || req.delivery_intent.units.length !== 2 || !/^(0|[1-9][0-9]*)$/.test(req.delivery_intent.units[0]) || !/^(0|[1-9][0-9]*)$/.test(req.delivery_intent.units[1]) || typeof req.delivery_intent.output_base64 !== 'string') throw new Error('corrupt');
      try { const raw = Buffer.from(req.delivery_intent.output_base64, 'base64'); if (raw.toString('base64') !== req.delivery_intent.output_base64) throw new Error(); } catch { throw new Error('corrupt'); }
    }
    if (!['credited', 'launching', 'running', 'draining', 'cancelling', 'terminal', 'uncertain'].includes(req.phase) ||
      (req.worker_state !== null && !['prepared', 'launching', 'running', 'completed', 'failed', 'cancelled', 'uncertain'].includes(req.worker_state)) ||
      ![req.started, req.dispatch_intent, req.input_checkpoint_intent, req.input_dispatched, req.cancel_requested, req.cancel_confirmed, req.engine_completed].every(v => typeof v === 'boolean') ||
      (req.worker_thread_id !== null && typeof req.worker_thread_id !== 'string') || (req.worker_turn_id !== null && typeof req.worker_turn_id !== 'string') ||
      typeof req.generated_output_base64 !== 'string' || (() => { try { const raw = Buffer.from(req.generated_output_base64, 'base64'); return raw.toString('base64') !== req.generated_output_base64; } catch { return true; } })() ||
      typeof req.discarded_output_bytes !== 'string' || !/^(0|[1-9][0-9]*)$/.test(req.discarded_output_bytes) ||
      !Array.isArray(req.baseline_units) || req.baseline_units.length !== 2 || !req.baseline_units.every(v => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)) ||
      !Array.isArray(req.baseline_checkpoint) || req.baseline_checkpoint.length !== 32 || req.baseline_checkpoint.some(v => !Number.isInteger(v) || v < 0 || v > 255) || !Number.isSafeInteger(req.last_worker_event)) throw new Error('corrupt');
    if (!same(req.request_hash, researchRequestHash(channel, req.request))) throw new Error('corrupt');
    if (req.receipt !== null) {
      const receipt = req.receipt as any;
      const receiptKeys = ['version', 'conversation', 'request', 'request_hash', 'sequence', 'outcome', 'reason', 'checkpoint_hash', 'delivered_units', 'generated_output', 'discarded_output', 'continuation', 'citations'];
      if (!isObject(receipt) || !same(Object.keys(receipt).sort(), receiptKeys.sort()) || receipt.version !== 2 || receipt.conversation !== conversation || receipt.request !== req.request.request || !same(receipt.request_hash, req.request_hash) || receipt.sequence !== req.request.sequence || !['completed', 'failed', 'cancelled'].includes(receipt.outcome) || (receipt.reason !== null && typeof receipt.reason !== 'string') || !Array.isArray(receipt.checkpoint_hash) || receipt.checkpoint_hash.length !== 32 || receipt.checkpoint_hash.some((v: unknown) => !Number.isInteger(v) || (v as number) < 0 || (v as number) > 255) || !Array.isArray(receipt.delivered_units) || receipt.delivered_units.length !== 2 || !receipt.delivered_units.every((v: unknown) => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)) || !/^(0|[1-9][0-9]*)$/.test(receipt.generated_output) || !/^(0|[1-9][0-9]*)$/.test(receipt.discarded_output) || !['ready', 'requires_channel_close'].includes(receipt.continuation) || !Array.isArray(receipt.citations)) throw new Error('corrupt');
      const generatedBytes = Buffer.from(req.generated_output_base64, 'base64').length;
      if (BigInt(receipt.generated_output) !== BigInt(generatedBytes) || BigInt(receipt.discarded_output) !== BigInt(req.discarded_output_bytes) || BigInt(receipt.discarded_output) > BigInt(receipt.generated_output)) throw new Error('corrupt');
      for (const citation of receipt.citations) {
        try { const url = new URL(citation.url); if (!isObject(citation) || !/^s[1-9][0-9]*$/.test(citation.id) || typeof citation.url !== 'string' || Buffer.byteLength(citation.url) > 2048 || url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.hash || typeof citation.title !== 'string' || Buffer.byteLength(citation.title) > 256 || typeof citation.retrieved_at_ms !== 'string' || !/^(0|[1-9][0-9]*)$/.test(citation.retrieved_at_ms) || !Array.isArray(citation.content_hash) || citation.content_hash.length !== 32 || citation.content_hash.some((n: unknown) => !Number.isInteger(n) || (n as number) < 0 || (n as number) > 255)) throw new Error(); } catch { throw new Error('corrupt'); }
      }
    }
    if (req.receipt_envelope !== null && !isObject(req.receipt_envelope)) throw new Error('corrupt');
  }
  if (state.close_intent !== null && (!isObject(state.close_intent) || !Array.isArray(state.close_intent.request_hash) || state.close_intent.request_hash.length !== 32 || !/^[0-9a-f]{64}$/.test(state.close_intent.op_id) || !Number.isSafeInteger(state.close_intent.at))) throw new Error('corrupt');
  if (state.final_checkpoint !== null) { try { validateSigned('checkpoint', state.final_checkpoint, offer.provider_key); if (!state.final_checkpoint.payload.final) throw new Error(); } catch { throw new Error('corrupt'); } }
  if ((state.final_checkpoint === null) !== (state.final_response === null)) throw new Error('corrupt');
  if (state.final_response !== null) {
    if (!same(Object.keys(state.final_response).sort(), ['version', 'op_id', 'type', 'checkpoint', 'output'].sort()) || state.final_response.version !== 2 || !/^[0-9a-f]{64}$/.test(state.final_response.op_id) || state.final_response.type !== 'channel_final' || !Array.isArray(state.final_response.output) || state.final_response.output.length !== 0) throw new Error('corrupt');
    if (!same(state.final_response.checkpoint, state.final_checkpoint)) throw new Error('corrupt');
  }
}
async function persist(file: string, value: unknown): Promise<void> {
  const encoded = JSON.stringify(value) + '\n'; if (Buffer.byteLength(encoded) > MAX_JOURNAL) throw new Error('journal_limit');
  await mkdir(dirname(file), { recursive: true, mode: 0o700 }); const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = await open(temp, 'wx', 0o600); try { await fd.writeFile(encoded, 'utf8'); await fd.sync(); } finally { await fd.close(); }
  await rename(temp, file); const dir = await open(dirname(file), 'r'); try { await dir.sync(); } finally { await dir.close(); }
}
