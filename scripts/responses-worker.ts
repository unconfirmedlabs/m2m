import { createHash, randomUUID } from 'node:crypto';
import { existsSync, closeSync, chmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentProfile, AgentToolCall, AgentToolResult } from './agent-service-types.js';
import type { EventConsumer, RequestRecord, RequestRef, WorkRequest, WorkerEvent, ToolCallRecord } from './codex-worker.js';
import type { ResponsesEvent, ResponsesSnapshot, ResponsesTransport, ResponsesCreateBody } from './responses-transport.js';
import { ResponsesTransportError, parseResponsesJson } from './responses-transport.js';
import { agentRuntimeFingerprint, canonicalJson, responsesLimits, validateResponsesProfile, type AgentRuntimeDescriptor, type ResponsesLimits } from './agent-runtime.js';
export type { AgentRuntimeDescriptor } from './agent-runtime.js';
import { NativeLock } from './native-lock.js';

export interface ResponsesDiagnostics {
  runtime: 'responses-tools-v1';
  responseCount: number;
  toolCallCount: number;
  reservedOutputTokens: number;
  usage: Array<{ responseId: string; inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; reasoningOutputTokens: number | null }>;
}

type JsonObject = Record<string, unknown>;
type RequestState = RequestRecord['state'];
type Usage = ResponsesDiagnostics['usage'][number];
type ResponseCall = { itemId: string; name: string; argumentsText: string; complete: boolean };
type ResponseState = {
  id: string;
  cursor: number;
  seen: Record<string, string>;
  completed: boolean;
  status: 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'incomplete';
  textItems: Record<string, string>;
  itemTypes: Record<string, string>;
  contentOrder: Record<string, string[]>;
  calls: Record<string, ResponseCall>;
  itemToCall: Record<string, string>;
  outputOrder: string[];
  refusal?: boolean;
  usage: Omit<Usage, 'responseId'>;
};
type Intent = {
  clientRequestId: string;
  body: string;
  bodyHash: string;
  predecessor?: string;
  step: number;
  reservedOutputTokens: number;
  escaped: boolean;
  responseId?: string;
  continuationCallId?: string;
};
type DurableRecord = RequestRecord & {
  runtime: 'responses-tools-v1';
  receivedBytes: number;
  reservedOutputTokens: number;
  responseCount: number;
  recoveryAttempts: number;
  controlAttempts: number;
  upstreamEvents: number;
  toolResultBytes: number;
  controlReceivedBytes: number;
  prompt: string;
  currentResponseId?: string;
  previousResponseId?: string;
  pendingCallId?: string;
  continuationResult?: string;
  intent?: Intent;
  responses: Record<string, ResponseState>;
  toolCallUpstream: Record<string, string>;
};
type Conversation = { threadId: string; lastResponseId?: string; activeRequest?: string; requestCount: number };
type Journal = { version: 1; runtime: 'responses-tools-v1'; descriptor: AgentRuntimeDescriptor; fingerprint: string; conversations: Record<string, Conversation>; requests: Record<string, DurableRecord> };

export class ResponsesWorkerError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ResponsesWorkerError'; }
}

const terminal = (state: RequestState): boolean => state === 'completed' || state === 'failed' || state === 'cancelled';
const requestStates = new Set<RequestState>(['prepared', 'launching', 'running', 'completed', 'failed', 'cancelled', 'uncertain']);
const responseStatuses = new Set<ResponseState['status']>(['in_progress', 'completed', 'failed', 'cancelled', 'incomplete']);
const requestKey = (ref: RequestRef): string => `${ref.agent}\u0000${ref.conversationId}\u0000${ref.requestId}`;
const conversationKey = (ref: RequestRef): string => `${ref.agent}\u0000${ref.conversationId}`;
const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const utf8Bytes = (value: string): number => Buffer.byteLength(value, 'utf8');
const CONTROL_HEADROOM_BYTES = 64 * 1024;
const clone = <T>(value: T): T => structuredClone(value);
const has = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);
const dictionary = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

function isObject(value: unknown): value is JsonObject { return !!value && typeof value === 'object' && !Array.isArray(value); }
function ownValue(object: JsonObject, key: string): unknown { return has(object, key) ? object[key] : undefined; }
function validBoundaryString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && utf8Bytes(value) <= maxBytes && validUnicode(value) && !/[\u0000-\u001f\u007f]/u.test(value);
}
function validText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && utf8Bytes(value) <= maxBytes && validUnicode(value);
}
function validDigest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value); }
function validRef(ref: RequestRef): boolean {
  return !!ref && validBoundaryString(ref.agent, 512) && validBoundaryString(ref.conversationId, 512) && validBoundaryString(ref.requestId, 512);
}
function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function parseBoundedJson(text: string, maxDepth: number, maxEntries: number): unknown {
  try {
    return parseResponsesJson(text, maxDepth, maxEntries);
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid_unicode') throw new ResponsesWorkerError('invalid_unicode');
    if (error instanceof Error && error.message === 'json_depth_limit') throw new ResponsesWorkerError('json_depth_limit');
    if (error instanceof Error && error.message === 'json_entries_limit') throw new ResponsesWorkerError('json_entries_limit');
    if (error instanceof Error && error.message === 'duplicate_json_key') throw new ResponsesWorkerError('duplicate_json_key');
    throw new ResponsesWorkerError('malformed_json');
  }
}

function responseId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || /[/?#\u0000-\u001f\u007f]/u.test(value) || !validUnicode(value)) return undefined;
  return value;
}
function eventType(event: ResponsesEvent): string | undefined { const value = ownValue(event, 'type'); return typeof value === 'string' ? value : undefined; }
function eventResponse(event: ResponsesEvent): JsonObject | undefined { const value = ownValue(event, 'response'); return isObject(value) ? value : undefined; }

function schemaArguments(schema: Record<string, unknown>, text: string): unknown {
  const value = parseBoundedJson(text, 8, 256);
  if (!isObject(value) || schema.type !== 'object' || schema.additionalProperties !== false || !isObject(schema.properties) || !Array.isArray(schema.required)) throw new ResponsesWorkerError('tool_policy_violation');
  const properties = schema.properties;
  for (const key of Object.keys(value)) {
    if (!has(properties, key)) throw new ResponsesWorkerError('tool_policy_violation');
    const rule = properties[key];
    if (!isObject(rule) || (rule.type !== 'string' && rule.type !== undefined)) throw new ResponsesWorkerError('tool_policy_violation');
    if (rule.type === 'string') {
      if (typeof value[key] !== 'string' || !validUnicode(value[key] as string)) throw new ResponsesWorkerError('tool_policy_violation');
      if (rule.minLength !== undefined && typeof rule.minLength === 'number' && [...(value[key] as string)].length < rule.minLength) throw new ResponsesWorkerError('tool_policy_violation');
      if (rule.maxLength !== undefined && typeof rule.maxLength === 'number' && utf8Bytes(value[key] as string) > rule.maxLength) throw new ResponsesWorkerError('tool_policy_violation');
    }
  }
  for (const key of schema.required) if (typeof key !== 'string' || !has(value, key)) throw new ResponsesWorkerError('tool_policy_violation');
  return value;
}

function outputTools(profile: AgentProfile): unknown[] {
  return profile.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: true }));
}

function sameJson(left: unknown, right: unknown): boolean {
  try { return canonicalJson(left) === canonicalJson(right); } catch { return false; }
}

function emptyUsage(): Omit<Usage, 'responseId'> { return { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null }; }

interface Delivery {
  enqueue(event: WorkerEvent): void;
  finish(): Promise<void>;
}

export class ResponsesWorker {
  private readonly stateDir: string;
  private readonly file: string;
  private readonly marker: string;
  private readonly lock: NativeLock;
  private readonly descriptor: AgentRuntimeDescriptor;
  private readonly profile: AgentProfile;
  private readonly limits: ResponsesLimits;
  private readonly fingerprint: string;
  private readonly transport: ResponsesTransport;
  private readonly now: () => number;
  private journal: Journal;
  private closed = false;
  private poisoned = false;
  private lockReleased = false;
  private activeKey: string | undefined;
  private readonly operations = new Set<Promise<unknown>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly deliveries = new Map<string, Delivery>();

  private constructor(options: { stateDir: string; descriptor: AgentRuntimeDescriptor; profile: AgentProfile; limits: ResponsesLimits; transport: ResponsesTransport; now?: () => number; journal: Journal; lock: NativeLock; fingerprint: string }) {
    this.stateDir = options.stateDir;
    this.file = join(options.stateDir, 'responses-worker.json');
    this.marker = join(options.stateDir, 'responses-worker.initialized');
    this.lock = options.lock;
    this.descriptor = options.descriptor;
    this.profile = options.profile;
    this.limits = options.limits;
    this.transport = options.transport;
    this.now = options.now ?? Date.now;
    this.journal = options.journal;
    this.fingerprint = options.fingerprint;
  }

  static async open(options: { stateDir: string; create: boolean; descriptor: AgentRuntimeDescriptor; profile: AgentProfile; limits: ResponsesLimits; transport: ResponsesTransport; now?: () => number }): Promise<ResponsesWorker> {
    if (options.descriptor.version !== 1 || options.descriptor.kind !== 'responses-tools-v1' || options.descriptor.model !== 'gpt-5.6-luna' || options.descriptor.reasoning !== 'xhigh') throw new ResponsesWorkerError('runtime_descriptor_mismatch');
    validateResponsesProfile(options.profile);
    const limits = responsesLimits('provider', options.limits);
    const fingerprint = agentRuntimeFingerprint(options.descriptor, options.profile, limits);
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(options.stateDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ResponsesWorkerError('unsafe_state_directory');
    chmodSync(options.stateDir, 0o700);
    const file = join(options.stateDir, 'responses-worker.json');
    const marker = join(options.stateDir, 'responses-worker.initialized');
    const lockPath = join(options.stateDir, '.responses-worker.lock');
    if (existsSync(join(options.stateDir, 'worker.json'))) throw new ResponsesWorkerError('legacy_worker_journal');
    const fileExists = existsSync(file); const markerExists = existsSync(marker);
    if (options.create && (fileExists || markerExists)) throw new ResponsesWorkerError('journal_already_initialized');
    let lock: NativeLock;
    try { lock = await NativeLock.acquire(lockPath); } catch { throw new ResponsesWorkerError('worker_lock'); }
    try {
      let journal: Journal;
      if (!fileExists || !markerExists) {
        if (!options.create || fileExists || markerExists) throw new ResponsesWorkerError('journal_missing');
        journal = { version: 1, runtime: 'responses-tools-v1', descriptor: options.descriptor, fingerprint, conversations: dictionary(), requests: dictionary() };
        const worker = new ResponsesWorker({ ...options, limits, journal, lock, fingerprint });
        worker.persist();
        const fd = openSync(marker, 'wx', 0o600);
        try { writeFileSync(fd, JSON.stringify({ version: 1, runtime: 'responses-tools-v1' })); fsyncSync(fd); } finally { closeSync(fd); }
        const dir = openSync(dirname(marker), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
        return worker;
      }
      try {
        const fileStat = lstatSync(file); const markerStat = lstatSync(marker);
        if (!fileStat.isFile() || (fileStat.mode & 0o077) !== 0 || fileStat.size > 16 * 1024 * 1024 || !markerStat.isFile() || (markerStat.mode & 0o077) !== 0 || markerStat.size > 4096) throw new ResponsesWorkerError('journal_corrupt');
        const markerValue = parseBoundedJson(readFileSync(marker, 'utf8'), 8, 32);
        if (!isObject(markerValue) || Object.keys(markerValue).some(key => key !== 'version' && key !== 'runtime') || markerValue.version !== 1 || markerValue.runtime !== 'responses-tools-v1') throw new ResponsesWorkerError('journal_corrupt');
        journal = parseBoundedJson(readFileSync(file, 'utf8'), 64, 250_000) as Journal;
      } catch (error) { if (error instanceof ResponsesWorkerError) throw error; throw new ResponsesWorkerError('journal_corrupt'); }
      if (!journal || Object.keys(journal).some(key => !['version', 'runtime', 'descriptor', 'fingerprint', 'conversations', 'requests'].includes(key)) || journal.version !== 1 || journal.runtime !== 'responses-tools-v1' || !isObject(journal.conversations) || !isObject(journal.requests) || !sameJson(journal.descriptor, options.descriptor) || journal.fingerprint !== fingerprint) throw new ResponsesWorkerError('runtime_profile_mismatch');
      const worker = new ResponsesWorker({ ...options, limits, journal, lock, fingerprint });
      worker.validateJournal();
      return worker;
    } catch (error) { await lock.close(); throw error; }
  }

  private validateJournal(writeBack = true): void {
    let changed = false;
    const requestsByConversation = new Map<string, DurableRecord[]>();
    const allowed = (object: object, keys: string[]): boolean => Object.keys(object).every(key => keys.includes(key));
    const usageValid = (usage: unknown): boolean => usage === null || (isObject(usage) &&
      [usage.inputTokens, usage.outputTokens, usage.cachedInputTokens, usage.reasoningOutputTokens].every(value => value === null || (Number.isSafeInteger(value) && (value as number) >= 0)));
    for (const [key, conversation] of Object.entries(this.journal.conversations)) {
      if (!conversation || !allowed(conversation, ['threadId', 'lastResponseId', 'activeRequest', 'requestCount']) || !validBoundaryString(conversation.threadId, 256) || !conversation.threadId.startsWith('responses-conversation:') || !Number.isSafeInteger(conversation.requestCount) || conversation.requestCount < 0 || conversation.requestCount > 32 || (conversation.activeRequest !== undefined && (typeof conversation.activeRequest !== 'string' || conversation.activeRequest.length > 2048)) || (conversation.lastResponseId !== undefined && !responseId(conversation.lastResponseId))) throw new ResponsesWorkerError('journal_corrupt');
      const conversationParts = key.split('\u0000');
      if (conversationParts.length !== 2 || !validBoundaryString(conversationParts[0], 512) || !validBoundaryString(conversationParts[1], 512)) throw new ResponsesWorkerError('journal_corrupt');
    }
    for (const [key, record] of Object.entries(this.journal.requests)) {
      if (!record || !allowed(record, ['runtime', 'agent', 'conversationId', 'requestId', 'commitment', 'submittedInputHash', 'clientUserMessageId', 'state', 'threadId', 'turnId', 'knownTurnIds', 'startedAt', 'deadline', 'baselineUsage', 'upstreamUsage', 'usageObserved', 'producedUtf8Bytes', 'items', 'events', 'reason', 'cancelRequestedAt', 'toolCalls', 'receivedBytes', 'controlReceivedBytes', 'reservedOutputTokens', 'responseCount', 'recoveryAttempts', 'controlAttempts', 'upstreamEvents', 'toolResultBytes', 'prompt', 'currentResponseId', 'previousResponseId', 'pendingCallId', 'continuationResult', 'intent', 'responses', 'toolCallUpstream']) || record.runtime !== 'responses-tools-v1' || key !== requestKey(record) || !validBoundaryString(record.agent, 512) || !validBoundaryString(record.conversationId, 512) || !validBoundaryString(record.requestId, 512) || !validDigest(record.commitment) || !validDigest(record.submittedInputHash) || !validBoundaryString(record.clientUserMessageId, 256) || !requestStates.has(record.state) || !validBoundaryString(record.threadId, 256) || !Array.isArray(record.knownTurnIds) || !isObject(record.items) || !isObject(record.responses) || !Array.isArray(record.events) || record.events.length > this.limits.maxEvents || record.startedAt < 0 || record.deadline < record.startedAt || !usageValid(record.baselineUsage) || !usageValid(record.upstreamUsage) || record.usageObserved !== false || (record.reason !== undefined && !validBoundaryString(record.reason, 256))) throw new ResponsesWorkerError('journal_corrupt');
      const conversationKeyValue = conversationKey(record);
      const conversation = this.journal.conversations[conversationKeyValue];
      if (!conversation || record.threadId !== conversation.threadId) throw new ResponsesWorkerError('journal_corrupt');
      const list = requestsByConversation.get(conversationKeyValue) ?? []; list.push(record); requestsByConversation.set(conversationKeyValue, list);
      const counts = [record.receivedBytes, record.reservedOutputTokens, record.responseCount, record.recoveryAttempts, record.controlAttempts, record.upstreamEvents, record.toolResultBytes, record.producedUtf8Bytes];
      if (counts.some(value => !Number.isSafeInteger(value) || value < 0) || !validText(record.prompt, this.limits.maxPromptBytes) || digest(record.prompt) !== record.submittedInputHash || !Number.isSafeInteger(record.controlReceivedBytes) || record.controlReceivedBytes < 0 || record.controlReceivedBytes > CONTROL_HEADROOM_BYTES || record.receivedBytes > this.limits.maxReceivedBytes || record.reservedOutputTokens > this.limits.maxReservedOutputTokens || record.responseCount > this.limits.maxResponses || record.recoveryAttempts > this.limits.maxRecoveryAttempts || record.controlAttempts > 3 || record.upstreamEvents > this.limits.maxEvents || record.toolResultBytes > this.limits.maxToolResultTotalBytes || record.producedUtf8Bytes > this.limits.maxOutputBytes || record.reservedOutputTokens !== record.responseCount * this.limits.maxOutputTokensPerResponse || record.responseCount < Object.keys(record.responses).length || record.cancelRequestedAt !== undefined && (!Number.isSafeInteger(record.cancelRequestedAt) || record.cancelRequestedAt < record.startedAt)) throw new ResponsesWorkerError('journal_corrupt');
      if (record.knownTurnIds.some(id => !responseId(id)) || new Set(record.knownTurnIds).size !== record.knownTurnIds.length || (record.currentResponseId !== undefined && (!has(record.responses, record.currentResponseId) || !record.knownTurnIds.includes(record.currentResponseId))) || (record.turnId !== undefined && !record.knownTurnIds.includes(record.turnId)) || (record.previousResponseId !== undefined && !record.knownTurnIds.includes(record.previousResponseId))) throw new ResponsesWorkerError('journal_corrupt');
      let itemBytes = 0;
      for (const [itemId, text] of Object.entries(record.items)) { if (!validBoundaryString(itemId, 1024) || !validUnicode(text)) throw new ResponsesWorkerError('journal_corrupt'); itemBytes += utf8Bytes(text); }
      if (itemBytes !== record.producedUtf8Bytes) throw new ResponsesWorkerError('journal_corrupt');
      for (const [index, event] of record.events.entries()) {
        if (!event || !allowed(event, event.type === 'content' ? ['type', 'itemId', 'delta', 'producedUtf8Bytes', 'index', 'observedAt', 'requestId'] : ['type', 'state', 'reason', 'index', 'observedAt', 'requestId']) || event.index !== index || !Number.isSafeInteger(event.index) || event.requestId !== record.requestId || !Number.isSafeInteger(event.observedAt) || event.observedAt < 0) throw new ResponsesWorkerError('journal_corrupt');
        if (event.type === 'content') { if (!validBoundaryString(event.itemId, 1024) || !event.delta || !validUnicode(event.delta) || !Number.isSafeInteger(event.producedUtf8Bytes) || event.producedUtf8Bytes < 0 || event.producedUtf8Bytes > this.limits.maxOutputBytes) throw new ResponsesWorkerError('journal_corrupt'); }
        else if (event.type === 'state') { if (!requestStates.has(event.state) || (event.reason !== undefined && !validBoundaryString(event.reason, 256))) throw new ResponsesWorkerError('journal_corrupt'); }
        else throw new ResponsesWorkerError('journal_corrupt');
      }
      if (record.intent && (!allowed(record.intent, ['clientRequestId', 'body', 'bodyHash', 'predecessor', 'step', 'reservedOutputTokens', 'escaped', 'responseId', 'continuationCallId']) || !validBoundaryString(record.intent.clientRequestId, 256) || !validBoundaryString(record.intent.body, this.limits.maxRequestBytes) || record.intent.bodyHash !== digest(record.intent.body) || !Number.isSafeInteger(record.intent.step) || record.intent.step < 0 || record.intent.step >= record.responseCount || !Number.isSafeInteger(record.intent.reservedOutputTokens) || record.intent.reservedOutputTokens !== this.limits.maxOutputTokensPerResponse || typeof record.intent.escaped !== 'boolean' || (record.intent.predecessor !== undefined && !responseId(record.intent.predecessor)) || (record.intent.responseId !== undefined && !responseId(record.intent.responseId)) || (record.intent.continuationCallId !== undefined && !validDigest(record.intent.continuationCallId)))) throw new ResponsesWorkerError('journal_corrupt');
      if (record.intent && record.intent.predecessor !== undefined) { const expected = this.expectedBody(record); if (!expected || expected.previous_response_id !== record.intent.predecessor) throw new ResponsesWorkerError('journal_corrupt'); }
      if (record.intent?.responseId !== undefined && record.currentResponseId !== record.intent.responseId) throw new ResponsesWorkerError('journal_corrupt');
      for (const [id, response] of Object.entries(record.responses)) {
        if (!responseId(id) || !response || !allowed(response, ['id', 'cursor', 'seen', 'completed', 'status', 'textItems', 'itemTypes', 'contentOrder', 'calls', 'itemToCall', 'outputOrder', 'refusal', 'usage']) || response.id !== id || !Number.isSafeInteger(response.cursor) || response.cursor < -1 || response.cursor >= this.limits.maxEvents || typeof response.completed !== 'boolean' || !responseStatuses.has(response.status) || (response.completed !== (response.status === 'completed' || response.status === 'failed' || response.status === 'cancelled')) || (response.refusal !== undefined && typeof response.refusal !== 'boolean') || !usageValid(response.usage) || !isObject(response.seen) || !isObject(response.textItems) || !isObject(response.itemTypes) || !isObject(response.contentOrder) || !isObject(response.calls) || !isObject(response.itemToCall) || !Array.isArray(response.outputOrder)) throw new ResponsesWorkerError('journal_corrupt');
        if (!record.knownTurnIds.includes(id)) throw new ResponsesWorkerError('journal_corrupt');
        const seenSequences = Object.keys(response.seen).map(sequence => Number(sequence));
        if (seenSequences.some(sequence => !Number.isSafeInteger(sequence) || sequence < 0) || seenSequences.length > this.limits.maxEvents ||
            (response.cursor === -1 ? seenSequences.length !== 0 : seenSequences.length !== response.cursor + 1 || Math.max(...seenSequences) !== response.cursor || seenSequences.some((sequence, index) => sequence !== index)) ||
            new Set(response.outputOrder).size !== response.outputOrder.length || response.outputOrder.some(item => !validBoundaryString(item, 1024)) ||
            Object.keys(response.itemTypes).some(item => !validBoundaryString(item, 1024) || !['message', 'reasoning', 'function_call'].includes(response.itemTypes[item])) ||
            Object.keys(response.contentOrder).some(item => !validBoundaryString(item, 1024) || !Array.isArray(response.contentOrder[item]) || new Set(response.contentOrder[item]).size !== response.contentOrder[item].length || response.contentOrder[item].some(index => !/^\d+$/.test(index)))) throw new ResponsesWorkerError('journal_corrupt');
        if (response.outputOrder.some(item => !has(response.itemTypes, item)) || Object.keys(response.contentOrder).some(item => response.itemTypes[item] !== 'message') || Object.keys(response.textItems).some(item => !item.startsWith(`${id}:`))) throw new ResponsesWorkerError('journal_corrupt');
        for (const [item, text] of Object.entries(response.textItems)) if (!validBoundaryString(item, 2048) || !validUnicode(text)) throw new ResponsesWorkerError('journal_corrupt');
        for (const [callId, call] of Object.entries(response.calls)) if (!validBoundaryString(callId, 256) || !call || !allowed(call, ['itemId', 'name', 'argumentsText', 'complete']) || !validBoundaryString(call.itemId, 1024) || !validBoundaryString(call.name, 256) || !validUnicode(call.argumentsText) || typeof call.complete !== 'boolean' || response.itemToCall[call.itemId] !== callId) throw new ResponsesWorkerError('journal_corrupt');
        for (const [itemId, callId] of Object.entries(response.itemToCall)) if (!validBoundaryString(itemId, 1024) || !validBoundaryString(callId, 256) || !has(response.calls, callId)) throw new ResponsesWorkerError('journal_corrupt');
      }
      if (record.toolCalls !== undefined && !isObject(record.toolCalls)) throw new ResponsesWorkerError('journal_corrupt');
      for (const [localCallId, call] of Object.entries(record.toolCalls ?? {})) if (!validDigest(localCallId) || !call || !allowed(call, ['threadId', 'turnId', 'callId', 'name', 'arguments', 'argumentsDigest', 'state', 'success', 'text']) || call.threadId !== record.threadId || !responseId(call.turnId) || call.callId !== localCallId || !validBoundaryString(call.name, 256) || !validDigest(call.argumentsDigest) || !['pending', 'completed', 'failed', 'uncertain'].includes(call.state) || (call.success !== undefined && typeof call.success !== 'boolean') || (call.text !== undefined && !validUnicode(call.text))) throw new ResponsesWorkerError('journal_corrupt');
      if (!isObject(record.toolCallUpstream) || Object.keys(record.toolCallUpstream).some(local => !has(record.toolCalls ?? {}, local) || !validBoundaryString(record.toolCallUpstream[local], 256))) throw new ResponsesWorkerError('journal_corrupt');
      if (record.pendingCallId !== undefined && (!validDigest(record.pendingCallId) || !has(record.toolCalls ?? {}, record.pendingCallId) || (record.continuationResult !== undefined && typeof record.continuationResult !== 'string'))) throw new ResponsesWorkerError('journal_corrupt');
      if (record.pendingCallId === undefined && record.continuationResult !== undefined) throw new ResponsesWorkerError('journal_corrupt');
      if (record.continuationResult !== undefined) {
        const result = parseBoundedJson(record.continuationResult, 8, 64);
        if (!isObject(result) || typeof ownValue(result, 'success') !== 'boolean' || typeof ownValue(result, 'text') !== 'string' || !validUnicode(ownValue(result, 'text') as string) || utf8Bytes(ownValue(result, 'text') as string) > this.profile.maxToolResultBytes || Object.keys(result).some(key => key !== 'success' && key !== 'text')) throw new ResponsesWorkerError('journal_corrupt');
      }
      if (writeBack && record.intent && !record.intent.responseId && (record.state !== 'uncertain' || record.reason !== 'backend_launch_uncertain')) { record.state = 'uncertain'; record.reason = 'backend_launch_uncertain'; changed = true; }
    }
    for (const [key, conversation] of Object.entries(this.journal.conversations)) {
      const records = requestsByConversation.get(key) ?? [];
      if (records.length !== conversation.requestCount) throw new ResponsesWorkerError('journal_corrupt');
      if (conversation.activeRequest !== undefined) { const active = this.journal.requests[conversation.activeRequest]; if (!active || terminal(active.state) || conversationKey(active) !== key) throw new ResponsesWorkerError('journal_corrupt'); }
      if (conversation.lastResponseId !== undefined && !records.some(record => record.knownTurnIds.includes(conversation.lastResponseId!))) throw new ResponsesWorkerError('journal_corrupt');
    }
    if (changed && writeBack) this.persist();
  }

  private persist(): void {
    if (this.poisoned) throw new ResponsesWorkerError('worker_poisoned');
    if (this.lockReleased) throw new ResponsesWorkerError('worker_closed');
    // Validate the in-memory shape with the same strict parser and cross-record
    // invariants used at reopen.  This prevents the writer from manufacturing
    // a journal that its own bounded reader would reject after a crash.
    this.validateJournal(false);
    let encoded: string;
    try { encoded = JSON.stringify(this.journal); } catch { this.poisoned = true; throw new ResponsesWorkerError('journal_write_failed'); }
    if (!validUnicode(encoded) || Buffer.byteLength(encoded, 'utf8') > 16 * 1024 * 1024) { this.poisoned = true; throw new ResponsesWorkerError('worker_journal_limit'); }
    try { parseBoundedJson(encoded, 64, 250_000); } catch { this.poisoned = true; throw new ResponsesWorkerError('journal_write_failed'); }
    const temporary = `${this.file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      const fd = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(fd, encoded); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.file);
      const directory = openSync(dirname(this.file), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch { this.poisoned = true; throw new ResponsesWorkerError('journal_write_failed'); }
  }

  private ensureAdmission(): void { if (this.closed) throw new ResponsesWorkerError('worker_closed'); if (this.poisoned) throw new ResponsesWorkerError('worker_poisoned'); }
  private track<T>(operation: Promise<T>): Promise<T> { this.operations.add(operation); void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation)); return operation; }
  private runTracked<T>(fn: () => Promise<T>): Promise<T> { this.ensureAdmission(); return this.track(Promise.resolve().then(fn)); }

  private makeDelivery(ref: RequestRef, consume: EventConsumer | undefined, afterEvent: number): Delivery | undefined {
    if (!consume) return undefined;
    if (!Number.isSafeInteger(afterEvent) || afterEvent < -1) throw new ResponsesWorkerError('invalid_event_cursor');
    let stopped = false;
    let chain = Promise.resolve();
    const queue: WorkerEvent[] = [];
    const deliver = (event: WorkerEvent) => {
      if (stopped || event.index <= afterEvent) return;
      queue.push(clone(event));
      chain = chain.then(async () => {
        const next = queue.shift();
        if (!next || stopped) return;
        try {
          if (await consume(clone(next)) === false) {
            stopped = true;
            const record = this.requestRecord(ref);
            if (record) await this.cancelRecord(record, 'consumer_stopped');
          }
        } catch {
          stopped = true;
          const record = this.requestRecord(ref);
          if (record) await this.cancelRecord(record, 'consumer_failed');
        }
      });
    };
    const delivery = { enqueue: deliver, finish: async () => { for (;;) { const current = chain; await current; if (current === chain) break; } } } satisfies Delivery;
    this.deliveries.set(requestKey(ref), delivery);
    const record = this.requestRecord(ref);
    for (const event of record?.events ?? []) deliver(event);
    return delivery;
  }

  private addEvent(record: DurableRecord, body: { type: 'content'; itemId: string; delta: string; producedUtf8Bytes: number } | { type: 'state'; state: RequestState; reason?: string }): void {
    if (record.events.length >= this.limits.maxEvents) throw new ResponsesWorkerError('event_limit');
    const event = { ...body, index: record.events.length, observedAt: this.now(), requestId: record.requestId } as WorkerEvent;
    record.events.push(event);
    try { this.persist(); } catch (error) { record.events.pop(); throw error; }
    this.deliveries.get(requestKey(record))?.enqueue(event);
  }

  private state(record: DurableRecord, state: RequestState, reason?: string): void {
    if (record.state === state && record.reason === reason) return;
    const previousState = record.state; const previousReason = record.reason;
    record.state = state;
    if (reason) record.reason = reason; else delete record.reason;
    const conversation = this.journal.conversations[conversationKey(record)];
    if (terminal(state) && conversation?.activeRequest === requestKey(record)) delete conversation.activeRequest;
    if (record.events.length >= this.limits.maxEvents) {
      try { this.persist(); } catch { record.state = previousState; if (previousReason) record.reason = previousReason; else delete record.reason; throw new ResponsesWorkerError('worker_poisoned'); }
      return;
    }
    try { this.addEvent(record, { type: 'state', state, ...(reason ? { reason } : {}) }); }
    catch (error) {
      if (error instanceof ResponsesWorkerError && error.code === 'event_limit') {
        try { this.persist(); } catch { /* the writer is already poisoned */ }
        return;
      }
      record.state = previousState; if (previousReason) record.reason = previousReason; else delete record.reason;
      throw error;
    }
  }

  private content(record: DurableRecord, itemId: string, text: string): void {
    if (!itemId || !validUnicode(text)) throw new ResponsesWorkerError('invalid_content');
    if (!text) return;
    const bytes = utf8Bytes(text);
    if (record.producedUtf8Bytes + bytes > this.limits.maxOutputBytes) throw new ResponsesWorkerError('output_limit');
    if (record.events.length + 2 >= this.limits.maxEvents) throw new ResponsesWorkerError('event_headroom');
    const priorText = record.items[itemId] ?? '';
    const priorBytes = record.producedUtf8Bytes;
    record.items[itemId] = (record.items[itemId] ?? '') + text;
    record.producedUtf8Bytes += bytes;
    try { this.addEvent(record, { type: 'content', itemId, delta: text, producedUtf8Bytes: record.producedUtf8Bytes }); }
    catch (error) { record.items[itemId] = priorText; record.producedUtf8Bytes = priorBytes; throw error; }
  }

  private fullContent(record: DurableRecord, itemId: string, text: string): void {
    const existing = record.items[itemId] ?? '';
    if (!text.startsWith(existing)) throw new ResponsesWorkerError('content_recovery_conflict');
    this.content(record, itemId, text.slice(existing.length));
  }

  private requestRecord(ref: RequestRef): DurableRecord | undefined { return has(this.journal.requests, requestKey(ref)) ? this.journal.requests[requestKey(ref)] : undefined; }
  private publicRecord(record: DurableRecord): RequestRecord {
    return clone({ agent: record.agent, conversationId: record.conversationId, requestId: record.requestId, commitment: record.commitment, submittedInputHash: record.submittedInputHash, clientUserMessageId: record.clientUserMessageId, state: record.state, ...(record.threadId ? { threadId: record.threadId } : {}), ...(record.turnId ? { turnId: record.turnId } : {}), knownTurnIds: clone(record.knownTurnIds), startedAt: record.startedAt, deadline: record.deadline, baselineUsage: null, upstreamUsage: null, usageObserved: false, ...(record.lastThreadTotal ? { lastThreadTotal: undefined } : {}), producedUtf8Bytes: record.producedUtf8Bytes, items: clone(record.items), events: clone(record.events), ...(record.reason ? { reason: record.reason } : {}), ...(record.cancelRequestedAt ? { cancelRequestedAt: record.cancelRequestedAt } : {}), toolCalls: clone(record.toolCalls ?? dictionary<ToolCallRecord>()) } as RequestRecord);
  }
  status(ref: RequestRef): RequestRecord | undefined { if (!validRef(ref)) return undefined; const record = this.requestRecord(ref); return record ? this.publicRecord(record) : undefined; }

  private makeBody(record: DurableRecord, request: WorkRequest, predecessor: string | undefined, input: unknown): { body: ResponsesCreateBody; text: string } {
    const body: Record<string, unknown> = {
      model: 'gpt-5.6-luna', reasoning: { effort: 'xhigh' }, instructions: `${this.profile.baseInstructions}\n\n${this.profile.developerInstructions}`,
      tools: outputTools(this.profile), tool_choice: 'auto', parallel_tool_calls: false, background: true, stream: true,
      store: true, truncation: 'disabled', max_output_tokens: this.limits.maxOutputTokensPerResponse, input,
    };
    if (predecessor !== undefined) body.previous_response_id = predecessor;
    const text = JSON.stringify(body);
    if (utf8Bytes(text) > this.limits.maxRequestBytes) throw new ResponsesWorkerError('request_body_limit');
    void request; void record;
    return { body, text };
  }

  private expectedBody(record: DurableRecord): JsonObject | undefined {
    if (!record.intent) return undefined;
    const value = parseBoundedJson(record.intent.body, 32, 32768);
    return isObject(value) ? value : undefined;
  }

  private validateMetadata(record: DurableRecord, response: JsonObject): string {
    const id = responseId(ownValue(response, 'id'));
    if (!id) throw new ResponsesWorkerError('invalid_response_id');
    const expected = this.expectedBody(record);
    const expectedTools = outputTools(this.profile);
    const reasoningValue = ownValue(response, 'reasoning'); const reasoning = isObject(reasoningValue) ? reasoningValue : undefined;
    const responsePrevious = ownValue(response, 'previous_response_id');
    if (!expected || ownValue(response, 'model') !== 'gpt-5.6-luna' || !reasoning || ownValue(reasoning, 'effort') !== 'xhigh' ||
        !sameJson(ownValue(response, 'instructions'), expected.instructions) || !sameJson(ownValue(response, 'tools'), expectedTools) || ownValue(response, 'tool_choice') !== 'auto' ||
        ownValue(response, 'parallel_tool_calls') !== false || ownValue(response, 'background') !== true || ownValue(response, 'store') !== true ||
        ownValue(response, 'truncation') !== 'disabled' || ownValue(response, 'max_output_tokens') !== expected.max_output_tokens ||
        (expected.previous_response_id !== undefined ? responsePrevious !== expected.previous_response_id : has(response, 'previous_response_id') && responsePrevious !== null && responsePrevious !== undefined)) {
      throw new ResponsesWorkerError('backend_policy_mismatch');
    }
    return id;
  }

  private response(record: DurableRecord, id: string): ResponseState {
    if (!has(record.responses, id)) record.responses[id] = { id, cursor: -1, seen: dictionary(), completed: false, status: 'in_progress', textItems: dictionary(), itemTypes: dictionary(), contentOrder: dictionary(), calls: dictionary(), itemToCall: dictionary(), outputOrder: [], usage: emptyUsage() };
    return record.responses[id];
  }

  private ackResponse(record: DurableRecord, id: string): void {
    const intent = record.intent;
    if (!intent) throw new ResponsesWorkerError('missing_creation_intent');
    if (intent.responseId && intent.responseId !== id) throw new ResponsesWorkerError('conflicting_response_id');
    if (record.currentResponseId && !intent.responseId && record.currentResponseId === id) throw new ResponsesWorkerError('duplicate_response_id');
    const newlyAcknowledged = intent.responseId === undefined;
    intent.responseId = id;
    record.currentResponseId = id;
    if (!record.turnId) record.turnId = id;
    if (!record.knownTurnIds.includes(id)) record.knownTurnIds.push(id);
    this.response(record, id);
    // A response.created event is the durable acknowledgement that the
    // continuation POST escaped.  Bind and consume that exact saved result
    // now; an interrupted terminal stream must not submit it again on reopen.
    if (newlyAcknowledged && intent.continuationCallId !== undefined) {
      if (record.pendingCallId !== intent.continuationCallId || record.continuationResult === undefined) throw new ResponsesWorkerError('continuation_intent_conflict');
      delete record.pendingCallId;
      delete record.continuationResult;
    }
  }

  private appendOutputText(draft: DurableRecord, response: ResponseState, id: string, text: string): void {
    const existing = response.textItems[id] ?? '';
    if (!text.startsWith(existing)) throw new ResponsesWorkerError('content_recovery_conflict');
    response.textItems[id] = text;
    const previous = draft.items[id] ?? '';
    if (!text.startsWith(previous)) throw new ResponsesWorkerError('content_recovery_conflict');
    const suffix = text.slice(previous.length);
    if (suffix) {
      const bytes = utf8Bytes(suffix);
      if (draft.producedUtf8Bytes + bytes > this.limits.maxOutputBytes) throw new ResponsesWorkerError('output_limit');
      draft.items[id] = text;
      draft.producedUtf8Bytes += bytes;
      if (draft.events.length + 2 >= this.limits.maxEvents) throw new ResponsesWorkerError('event_headroom');
      draft.events.push({ type: 'content', itemId: id, delta: suffix, producedUtf8Bytes: draft.producedUtf8Bytes, index: draft.events.length, observedAt: this.now(), requestId: draft.requestId } as WorkerEvent);
    }
  }

  private validateOutput(draft: DurableRecord, response: ResponseState, output: unknown, appendText: boolean): void {
    if (!Array.isArray(output)) throw new ResponsesWorkerError('invalid_response_output');
    const order: string[] = [];
    let functionCount = 0;
    for (const item of output) {
      const itemType = isObject(item) ? ownValue(item, 'type') : undefined;
      if (typeof itemType !== 'string') throw new ResponsesWorkerError('invalid_response_output');
      if (itemType === 'reasoning') {
        const reasoningId = ownValue(item as JsonObject, 'id');
        if (reasoningId !== undefined && (!validBoundaryString(reasoningId, 1024) || order.includes(reasoningId))) throw new ResponsesWorkerError('invalid_response_output');
        if (typeof reasoningId === 'string') {
          const priorType = response.itemTypes[reasoningId];
          if (priorType !== undefined && priorType !== 'reasoning') throw new ResponsesWorkerError('output_identity_conflict');
          response.itemTypes[reasoningId] = 'reasoning'; order.push(reasoningId);
        }
        continue;
      }
      if (itemType === 'message') {
        const role = ownValue(item as JsonObject, 'role'); const itemId = ownValue(item as JsonObject, 'id'); const content = ownValue(item as JsonObject, 'content');
        const itemStatus = ownValue(item as JsonObject, 'status');
        if (role !== 'assistant' || !validBoundaryString(itemId, 1024) || !Array.isArray(content) || (itemStatus !== undefined && itemStatus !== 'completed')) throw new ResponsesWorkerError('invalid_response_output');
        if (order.includes(itemId)) throw new ResponsesWorkerError('output_identity_conflict');
        const priorType = response.itemTypes[itemId];
        if (priorType !== undefined && priorType !== 'message') throw new ResponsesWorkerError('output_identity_conflict');
        response.itemTypes[itemId] = 'message';
        order.push(itemId);
        const parts: string[] = [];
        for (let contentIndex = 0; contentIndex < content.length; contentIndex++) {
          const part = content[contentIndex]; const partType = isObject(part) ? ownValue(part, 'type') : undefined;
          if (!isObject(part) || (partType !== 'output_text' && partType !== 'refusal')) throw new ResponsesWorkerError('invalid_response_output');
          parts.push(String(contentIndex));
          if (partType === 'refusal') {
            const refusal = ownValue(part, 'refusal');
            if (typeof refusal !== 'string' || !validUnicode(refusal)) throw new ResponsesWorkerError('invalid_response_output');
            response.refusal = true;
          } else {
            const text = ownValue(part, 'text');
            if (typeof text !== 'string' || !validUnicode(text)) throw new ResponsesWorkerError('invalid_response_output');
            if (appendText) this.appendOutputText(draft, response, `${response.id}:${itemId}:${contentIndex}`, text);
          }
        }
        const priorParts = response.contentOrder[itemId] ?? [];
        if (priorParts.length > parts.length || priorParts.some((part, index) => part !== parts[index])) throw new ResponsesWorkerError('content_recovery_conflict');
        response.contentOrder[itemId] = parts;
        continue;
      }
      if (itemType === 'function_call') {
        const itemId = ownValue(item as JsonObject, 'id'); const callId = ownValue(item as JsonObject, 'call_id'); const name = ownValue(item as JsonObject, 'name'); const args = ownValue(item as JsonObject, 'arguments'); const itemStatus = ownValue(item as JsonObject, 'status');
        functionCount++;
        if (functionCount > 1 || !validBoundaryString(itemId, 1024) || !validBoundaryString(callId, 256) || !validBoundaryString(name, 256) || typeof args !== 'string' || !validUnicode(args) || (itemStatus !== undefined && itemStatus !== 'completed') || !this.profile.tools.some(tool => tool.name === name)) throw new ResponsesWorkerError('invalid_function_call');
        if (order.includes(itemId)) throw new ResponsesWorkerError('output_identity_conflict');
        const priorType = response.itemTypes[itemId];
        if (priorType !== undefined && priorType !== 'function_call') throw new ResponsesWorkerError('output_identity_conflict');
        response.itemTypes[itemId] = 'function_call';
        parseBoundedJson(args, 8, 256);
        order.push(itemId);
        const existing = response.calls[callId];
        if (existing && (existing.name !== name || existing.argumentsText !== args || existing.itemId !== itemId)) throw new ResponsesWorkerError('tool_call_conflict');
        response.calls[callId] = { itemId, name, argumentsText: args, complete: true };
        response.itemToCall[itemId] = callId;
        continue;
      }
      throw new ResponsesWorkerError('backend_tool_policy_violation');
    }
    const prior = response.outputOrder;
    if (prior.length > order.length || prior.some((id, index) => order[index] !== id)) throw new ResponsesWorkerError('output_identity_conflict');
    response.outputOrder = order;
  }

  private applyEvent(draft: DurableRecord, event: ResponsesEvent): void {
    const type = eventType(event);
    if (!type) throw new ResponsesWorkerError('invalid_upstream_event');
    const sequence = ownValue(event, 'sequence_number');
    if (!Number.isSafeInteger(sequence) || (sequence as number) < 0) throw new ResponsesWorkerError('missing_sequence');
    const sequenceNumber = sequence as number;
    let id = draft.currentResponseId;
    const payload = eventResponse(event);
    if (type === 'response.created') {
      if (!payload) throw new ResponsesWorkerError('missing_response_metadata');
      const createdId = responseId(ownValue(payload, 'id'));
      if (!createdId) throw new ResponsesWorkerError('invalid_response_id');
      const status = ownValue(payload, 'status');
      if (status !== 'in_progress' && status !== 'queued') throw new ResponsesWorkerError('invalid_response_status');
      this.ackResponse(draft, createdId);
      id = createdId;
      this.validateMetadata(draft, payload);
      if (draft.state === 'launching') draft.state = 'running';
    }
    if (!id) throw new ResponsesWorkerError('response_id_mismatch');
    const eventResponseId = ownValue(event, 'response_id');
    if (eventResponseId !== undefined && eventResponseId !== id) throw new ResponsesWorkerError('response_id_mismatch');
    const response = this.response(draft, id);
    const sequenceKey = String(sequenceNumber);
    const eventDigest = digest(canonicalJson(event));
    if (has(response.seen, sequenceKey)) {
      if (response.seen[sequenceKey] !== eventDigest) throw new ResponsesWorkerError('contradictory_event_duplicate');
      return;
    }
    if (sequenceNumber !== response.cursor + 1) throw new ResponsesWorkerError('event_sequence_conflict');
    if (draft.upstreamEvents >= this.limits.maxEvents) throw new ResponsesWorkerError('upstream_event_limit');
    if (type === 'response.output_text.delta') {
      const itemId = ownValue(event, 'item_id'); const contentIndex = ownValue(event, 'content_index'); const delta = ownValue(event, 'delta');
      if (!validBoundaryString(itemId, 1024) || !Number.isSafeInteger(contentIndex) || (contentIndex as number) < 0 || typeof delta !== 'string' || !validUnicode(delta)) throw new ResponsesWorkerError('invalid_text_delta');
      const item = `${id}:${itemId}:${contentIndex}`;
      const priorType = response.itemTypes[itemId];
      if (priorType !== undefined && priorType !== 'message') throw new ResponsesWorkerError('output_identity_conflict');
      response.itemTypes[itemId] = 'message';
      if (!response.outputOrder.includes(itemId)) response.outputOrder.push(itemId);
      const contentOrder = response.contentOrder[itemId] ?? (response.contentOrder[itemId] = []);
      if (!contentOrder.includes(String(contentIndex))) contentOrder.push(String(contentIndex));
      const current = response.textItems[item] ?? '';
      response.textItems[item] = current + delta;
      this.appendOutputText(draft, response, item, response.textItems[item]);
    } else if (type === 'response.output_item.added') {
      const itemValue = ownValue(event, 'item');
      const item = isObject(itemValue) ? itemValue : undefined;
      const itemType = item ? ownValue(item, 'type') : undefined;
      if (!item || typeof itemType !== 'string') throw new ResponsesWorkerError('invalid_output_item');
      const rawItemId = ownValue(item, 'id'); const rawCallId = ownValue(item, 'call_id');
      const itemId = typeof rawItemId === 'string' ? rawItemId : undefined;
      const itemStatus = ownValue(item, 'status');
      if (!validBoundaryString(itemId, 1024) || (itemStatus !== undefined && itemStatus !== 'in_progress' && itemStatus !== 'completed')) throw new ResponsesWorkerError('invalid_output_item');
      if (!response.outputOrder.includes(itemId)) response.outputOrder.push(itemId);
      if (itemType === 'function_call') {
        const rawName = ownValue(item, 'name');
        if (!validBoundaryString(rawCallId, 256) || !validBoundaryString(rawName, 256)) throw new ResponsesWorkerError('invalid_function_call');
        const priorType = response.itemTypes[itemId];
        if (priorType !== undefined && priorType !== 'function_call') throw new ResponsesWorkerError('output_identity_conflict');
        response.itemTypes[itemId] = 'function_call';
        const call = response.calls[rawCallId];
        if (call && (call.name !== rawName || call.itemId !== itemId)) throw new ResponsesWorkerError('tool_call_conflict');
        const rawArguments = ownValue(item, 'arguments');
        response.calls[rawCallId] = { itemId, name: rawName, argumentsText: typeof rawArguments === 'string' ? rawArguments : '', complete: false };
        response.itemToCall[itemId] = rawCallId;
      } else if (itemType !== 'message' && itemType !== 'reasoning') throw new ResponsesWorkerError('backend_tool_policy_violation');
      else {
        const priorType = response.itemTypes[itemId];
        if (priorType !== undefined && priorType !== itemType) throw new ResponsesWorkerError('output_identity_conflict');
        response.itemTypes[itemId] = itemType;
        if (itemType === 'message') response.contentOrder[itemId] ??= [];
      }
    } else if (type === 'response.function_call_arguments.delta') {
      const rawItemId = ownValue(event, 'item_id'); const rawCallId = ownValue(event, 'call_id'); const delta = ownValue(event, 'delta');
      const itemId = typeof rawItemId === 'string' ? rawItemId : undefined;
      const callId = itemId ? response.itemToCall[itemId] : typeof rawCallId === 'string' ? rawCallId : undefined;
      if (!callId || typeof delta !== 'string' || !validUnicode(delta)) throw new ResponsesWorkerError('invalid_function_call');
      const call = response.calls[callId];
      if (!call) throw new ResponsesWorkerError('invalid_function_call');
      call.argumentsText += delta;
    } else if (type === 'response.function_call_arguments.done') {
      const rawItemId = ownValue(event, 'item_id'); const rawCallId = ownValue(event, 'call_id'); const args = ownValue(event, 'arguments');
      const itemId = typeof rawItemId === 'string' ? rawItemId : undefined;
      const callId = itemId ? response.itemToCall[itemId] : typeof rawCallId === 'string' ? rawCallId : undefined;
      if (!callId || typeof args !== 'string' || !validUnicode(args)) throw new ResponsesWorkerError('invalid_function_call');
      const call = response.calls[callId];
      if (!call) throw new ResponsesWorkerError('invalid_function_call');
      call.argumentsText = args;
      call.complete = true;
      parseBoundedJson(call.argumentsText, 8, 256);
    } else if (type === 'response.output_item.done') {
      const itemValue = ownValue(event, 'item');
      const item = isObject(itemValue) ? itemValue : undefined;
      if (item && ownValue(item, 'type') === 'function_call') {
        const rawItemId = ownValue(item, 'id'); const rawCallId = ownValue(item, 'call_id'); const rawArguments = ownValue(item, 'arguments');
        const itemId = typeof rawItemId === 'string' ? rawItemId : undefined;
        const callId = typeof rawCallId === 'string' ? rawCallId : itemId ? response.itemToCall[itemId] : undefined;
        if (!callId || typeof rawArguments !== 'string') throw new ResponsesWorkerError('invalid_function_call');
        const call = response.calls[callId];
        if (!call || (itemId && call.itemId !== itemId)) throw new ResponsesWorkerError('tool_call_conflict');
        if (call.argumentsText && call.argumentsText !== rawArguments) throw new ResponsesWorkerError('tool_call_conflict');
        call.argumentsText = rawArguments; call.complete = true; parseBoundedJson(call.argumentsText, 8, 256);
      }
    } else if (type === 'response.completed') {
      if (!payload || this.validateMetadata(draft, payload) !== id || ownValue(payload, 'status') !== 'completed') throw new ResponsesWorkerError('invalid_terminal_response');
      this.validateOutput(draft, response, ownValue(payload, 'output'), true);
      response.completed = true; response.status = 'completed'; response.usage = this.parseUsage(ownValue(payload, 'usage'));
      if (response.refusal) draft.state = 'failed';
    } else if (type === 'response.failed' || type === 'response.cancelled' || type === 'response.incomplete') {
      const terminalStatus = type === 'response.cancelled' ? 'cancelled' : type === 'response.failed' ? 'failed' : 'incomplete';
      if (payload) {
        if (this.validateMetadata(draft, payload) !== id || ownValue(payload, 'status') !== terminalStatus) throw new ResponsesWorkerError('invalid_terminal_response');
        if (has(payload, 'output')) this.validateOutput(draft, response, ownValue(payload, 'output'), false);
      }
      response.status = terminalStatus;
      response.completed = type === 'response.cancelled' || type === 'response.failed';
    } else if (type !== 'response.created' && type !== 'response.in_progress' && type !== 'response.queued' && type !== 'response.content_part.added' && type !== 'response.content_part.done' && type !== 'response.output_text.done' && type !== 'response.reasoning_summary_text.delta' && type !== 'response.reasoning_summary_text.done') {
      throw new ResponsesWorkerError('unknown_response_event');
    }
    response.seen[sequenceKey] = eventDigest;
    response.cursor = sequenceNumber;
    draft.upstreamEvents++;
  }

  private processEvent(record: DurableRecord, event: ResponsesEvent): void {
    const priorEventCount = record.events.length;
    const priorState = record.state;
    if (eventType(event) === 'response.created') {
      const payload = eventResponse(event);
      const id = payload ? responseId(payload.id) : undefined;
      if (!id) throw new ResponsesWorkerError('invalid_response_id');
      this.ackResponse(record, id);
      this.persist();
    }
    const draft = clone(record) as DurableRecord;
    this.applyEvent(draft, event);
    for (const key of Object.keys(record)) delete (record as unknown as Record<string, unknown>)[key];
    Object.assign(record, draft);
    this.persist();
    if (priorState !== record.state && record.state === 'running') {
      if (record.events.length >= this.limits.maxEvents) throw new ResponsesWorkerError('event_limit');
      record.events.push({ type: 'state', state: 'running', index: record.events.length, observedAt: this.now(), requestId: record.requestId } as WorkerEvent);
      this.persist();
    }
    for (const emitted of record.events.slice(priorEventCount)) this.deliveries.get(requestKey(record))?.enqueue(emitted);
  }

  private parseUsage(value: unknown): ResponseState['usage'] {
    if (value === undefined || value === null) return emptyUsage();
    if (!isObject(value)) throw new ResponsesWorkerError('invalid_upstream_usage');
    const input = ownValue(value, 'input_tokens'); const output = ownValue(value, 'output_tokens');
    const rawDetails = ownValue(value, 'input_tokens_details'); const details = isObject(rawDetails) ? rawDetails : undefined;
    const rawOutputDetails = ownValue(value, 'output_tokens_details'); const outputDetails = isObject(rawOutputDetails) ? rawOutputDetails : undefined;
    const cached = details ? ownValue(details, 'cached_tokens') : undefined;
    const reasoning = ownValue(value, 'reasoning_tokens') ?? (outputDetails ? ownValue(outputDetails, 'reasoning_tokens') : undefined);
    const numbers = [input, output, cached, reasoning];
    if (numbers.some(item => item !== undefined && (!Number.isSafeInteger(item) || (item as number) < 0)) || (typeof cached === 'number' && typeof input === 'number' && cached > input) || (typeof reasoning === 'number' && typeof output === 'number' && reasoning > output)) throw new ResponsesWorkerError('invalid_upstream_usage');
    return { inputTokens: typeof input === 'number' ? input : null, outputTokens: typeof output === 'number' ? output : null, cachedInputTokens: typeof cached === 'number' ? cached : null, reasoningOutputTokens: typeof reasoning === 'number' ? reasoning : null };
  }

  private async charge(record: DurableRecord, count: number, control = false): Promise<void> {
    if (!Number.isSafeInteger(count) || count < 0) throw new ResponsesWorkerError('received_bytes_limit');
    if (control) {
      if (record.controlReceivedBytes + count > CONTROL_HEADROOM_BYTES) throw new ResponsesWorkerError('control_bytes_limit');
      record.controlReceivedBytes += count;
    } else {
      if (record.receivedBytes + count > this.limits.maxReceivedBytes) throw new ResponsesWorkerError('received_bytes_limit');
      record.receivedBytes += count;
    }
    this.persist();
  }

  private deadlineExceeded(record: DurableRecord): boolean { return this.now() >= record.deadline; }

  private async streamFor(record: DurableRecord, request: WorkRequest, operation: () => Promise<AsyncIterable<ResponsesEvent>>): Promise<void> {
    if (this.deadlineExceeded(record) || record.cancelRequestedAt) { this.state(record, 'uncertain', record.cancelRequestedAt ? 'cancel_requested' : 'duration_limit'); return; }
    const controller = new AbortController();
    const remaining = Math.max(0, record.deadline - this.now());
    const timer = setTimeout(() => controller.abort(), remaining);
    timer.unref();
    this.controllers.set(requestKey(record), controller);
    try {
      const stream = await operation();
      for await (const event of stream) {
        if (record.cancelRequestedAt || controller.signal.aborted || this.deadlineExceeded(record)) { this.state(record, 'uncertain', record.cancelRequestedAt ? 'cancel_requested' : 'duration_limit'); return; }
        this.processEvent(record, event);
      }
    } finally {
      clearTimeout(timer);
      if (this.controllers.get(requestKey(record)) === controller) this.controllers.delete(requestKey(record));
    }
    void request;
  }

  private async createResponse(record: DurableRecord, request: WorkRequest, predecessor: string | undefined, input: unknown): Promise<void> {
    if (record.intent) {
      if (!record.intent.responseId) { this.state(record, 'uncertain', 'backend_launch_uncertain'); return; }
      await this.recoverResponse(record, request, false);
      return;
    }
    if (record.responseCount >= this.limits.maxResponses || record.reservedOutputTokens + this.limits.maxOutputTokensPerResponse > this.limits.maxReservedOutputTokens) throw new ResponsesWorkerError('response_limit');
    if (record.events.length + 3 >= this.limits.maxEvents) throw new ResponsesWorkerError('event_headroom');
    const built = this.makeBody(record, request, predecessor, input);
    const continuationCallId = record.pendingCallId;
    const intent: Intent = { clientRequestId: randomUUID(), body: built.text, bodyHash: digest(built.text), ...(predecessor ? { predecessor } : {}), step: record.responseCount, reservedOutputTokens: this.limits.maxOutputTokensPerResponse, escaped: false, ...(continuationCallId ? { continuationCallId } : {}) };
    record.responseCount++;
    record.reservedOutputTokens += this.limits.maxOutputTokensPerResponse;
    record.intent = intent;
    this.persist();
    this.state(record, 'launching');
    try {
      intent.escaped = true;
      this.persist();
      await this.streamFor(record, request, () => this.transport.create(built.body, { signal: this.controllers.get(requestKey(record))!.signal, clientRequestId: intent.clientRequestId, chargeReceivedBytes: count => this.charge(record, count) }));
    } catch (error) {
      if (record.cancelRequestedAt || record.state === 'cancelled' || record.state === 'completed') return;
      if (record.currentResponseId && record.intent?.responseId && error instanceof ResponsesWorkerError && error.code === 'event_sequence_conflict') {
        await this.recoverResponse(record, request, false);
      } else if (record.currentResponseId && record.intent?.responseId && error instanceof ResponsesWorkerError && !['backend_launch_uncertain', 'response_id_mismatch'].includes(error.code)) {
        this.state(record, 'uncertain', error.code);
      } else if (record.currentResponseId && record.intent?.responseId) {
        await this.recoverResponse(record, request, false);
      } else if (error instanceof ResponsesTransportError && error.kind === 'definite') {
        this.state(record, 'failed', error.code);
      } else {
        this.state(record, 'uncertain', error instanceof ResponsesWorkerError ? error.code : 'backend_launch_uncertain');
      }
      return;
    }
    if (!record.currentResponseId || !record.intent?.responseId) { this.state(record, 'uncertain', 'backend_launch_uncertain'); return; }
    const response = record.responses[record.currentResponseId];
    if (!response.completed) { await this.recoverResponse(record, request, false); return; }
    delete record.intent;
    this.persist();
    if (response.status === 'failed') { this.state(record, 'failed', 'backend_failed'); return; }
    if (response.status === 'cancelled') { this.state(record, 'cancelled', 'backend_cancelled'); return; }
  }

  private reserveRecovery(record: DurableRecord, explicit: boolean): boolean {
    if (explicit) {
      if (record.controlAttempts >= 3) return false;
      record.controlAttempts++;
    } else {
      if (record.recoveryAttempts >= this.limits.maxRecoveryAttempts) return false;
      record.recoveryAttempts++;
    }
    this.persist();
    return true;
  }

  private async recoverResponse(record: DurableRecord, request: WorkRequest, explicit: boolean): Promise<void> {
    const id = record.intent?.responseId ?? record.currentResponseId;
    if (!id) { this.state(record, 'uncertain', 'backend_context_unavailable'); return; }
    if (!this.reserveRecovery(record, explicit)) { this.state(record, 'uncertain', 'recovery_limit'); return; }
    if (this.deadlineExceeded(record)) { this.state(record, 'uncertain', 'duration_limit'); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, record.deadline - this.now())); timer.unref();
    this.controllers.set(requestKey(record), controller);
    try {
      const snapshot = await this.transport.retrieve(id, { signal: controller.signal, chargeReceivedBytes: count => this.charge(record, count, explicit) });
      if (record.cancelRequestedAt || this.deadlineExceeded(record)) { this.state(record, 'uncertain', record.cancelRequestedAt ? 'cancel_requested' : 'duration_limit'); return; }
      this.processSnapshot(record, snapshot);
      const response = record.responses[id];
      if (!response.completed && ownValue(snapshot, 'status') === 'in_progress') {
        if (!this.reserveRecovery(record, explicit)) { this.state(record, 'uncertain', 'recovery_limit'); return; }
        // The provider's starting_after cursor is nonnegative.  A crash after
        // durable ID acknowledgement but before the first event leaves the
        // local cursor at -1; resume from sequence zero without replaying the
        // creation POST.
        const resumeAfter = Math.max(0, response.cursor);
        if (response.cursor < resumeAfter) response.cursor = resumeAfter;
        const stream = await this.transport.resume(id, resumeAfter, { signal: controller.signal, chargeReceivedBytes: count => this.charge(record, count, explicit) });
        let sequenceGap = false;
        try {
          for await (const event of stream) {
            if (controller.signal.aborted) { this.state(record, 'uncertain', 'duration_limit'); return; }
            try { this.processEvent(record, event); }
            catch (error) {
              if (error instanceof ResponsesWorkerError && error.code === 'event_sequence_conflict') { sequenceGap = true; break; }
              throw error;
            }
          }
        } catch (error) { throw error; }
        // A discontinuous resumed stream is not permission to POST again. Use
        // one bounded control read to obtain an atomic complete snapshot.
        if (sequenceGap) {
          if (!this.reserveRecovery(record, explicit)) { this.state(record, 'uncertain', 'recovery_limit'); return; }
          const reconciled = await this.transport.retrieve(id, { signal: controller.signal, chargeReceivedBytes: count => this.charge(record, count, explicit) });
          if (record.cancelRequestedAt || this.deadlineExceeded(record)) { this.state(record, 'uncertain', record.cancelRequestedAt ? 'cancel_requested' : 'duration_limit'); return; }
          this.processSnapshot(record, reconciled);
        }
      }
      if (!record.responses[id]?.completed) this.state(record, 'uncertain', 'backend_context_unavailable');
    } catch (error) { this.state(record, 'uncertain', error instanceof ResponsesWorkerError ? error.code : 'recovery_failed'); }
    finally { clearTimeout(timer); if (this.controllers.get(requestKey(record)) === controller) this.controllers.delete(requestKey(record)); }
    void request;
  }

  private applySnapshot(record: DurableRecord, snapshot: ResponsesSnapshot): void {
    if (!isObject(snapshot)) throw new ResponsesWorkerError('invalid_recovery_snapshot');
    const id = responseId(ownValue(snapshot, 'id'));
    if (!id) throw new ResponsesWorkerError('invalid_response_id');
    if (!record.currentResponseId && record.intent && !record.intent.responseId) this.ackResponse(record, id);
    if (record.currentResponseId && record.currentResponseId !== id) throw new ResponsesWorkerError('conflicting_response_id');
    if (record.intent && !record.intent.responseId) record.intent.responseId = id;
    record.currentResponseId = id;
    if (!record.turnId) record.turnId = id;
    if (!record.knownTurnIds.includes(id)) record.knownTurnIds.push(id);
    const response = this.response(record, id);
    const status = ownValue(snapshot, 'status');
    if (status === 'cancelled' || status === 'failed' || status === 'incomplete') {
      // The cancellation endpoint may return a deliberately small terminal
      // acknowledgement. If it supplies execution metadata, validate every
      // supplied field instead of letting a contradictory terminal snapshot
      // bypass the fixed request policy.
      if (has(snapshot, 'model') || has(snapshot, 'reasoning') || has(snapshot, 'tools') || has(snapshot, 'instructions')) this.validateMetadata(record, snapshot);
      if (has(snapshot, 'output')) this.validateOutput(record, response, ownValue(snapshot, 'output'), false);
      response.status = status; response.completed = status === 'cancelled' || status === 'failed'; return;
    }
    if (status !== 'completed' && status !== 'in_progress') throw new ResponsesWorkerError('invalid_response_status');
    this.validateMetadata(record, snapshot);
    if (status === 'completed') { this.validateOutput(record, response, ownValue(snapshot, 'output'), true); response.completed = true; response.status = 'completed'; response.usage = this.parseUsage(ownValue(snapshot, 'usage')); }
    // An in-progress snapshot is metadata/context only. It cannot invent
    // missed text or calls; resume starts strictly after the saved cursor.
  }

  private processSnapshot(record: DurableRecord, snapshot: ResponsesSnapshot): void {
    const id = isObject(snapshot) ? responseId(ownValue(snapshot, 'id')) : undefined;
    if (!id) throw new ResponsesWorkerError('invalid_response_id');
    const eventCount = record.events.length;
    const draft = clone(record) as DurableRecord;
    try {
      this.applySnapshot(draft, snapshot);
    } catch (error) {
      // The provider ID is durable evidence even when its metadata/output is
      // rejected. Retain it, but never retain partial output/event mutation
      // from a failed whole-snapshot validation.
      if (!record.currentResponseId && record.intent && !record.intent.responseId) {
        this.ackResponse(record, id);
        this.persist();
      }
      throw error;
    }
    for (const key of Object.keys(record)) delete (record as unknown as Record<string, unknown>)[key];
    Object.assign(record, draft);
    this.persist();
    for (const event of record.events.slice(eventCount)) this.deliveries.get(requestKey(record))?.enqueue(event);
  }

  private settleRecoveredResponse(record: DurableRecord): void {
    const id = record.currentResponseId;
    const response = id ? record.responses[id] : undefined;
    if (!response?.completed) return;
    // A completed GET is authoritative.  Clear the create intent before
    // either invoking a durable tool call or settling a text-only response;
    // otherwise an explicit reconcile can mistake a completed snapshot for a
    // still-launching POST and either repeat recovery or retain uncertainty.
    delete record.intent;
    const conversation = this.journal.conversations[conversationKey(record)];
    if (Object.values(response.calls).some(call => call.complete)) {
      if (record.state === 'uncertain') {
        record.state = 'running';
        delete record.reason;
        this.persist();
      }
      return;
    }
    if (conversation) conversation.lastResponseId = response.id;
    record.previousResponseId = response.id;
    if (response.status === 'failed') this.state(record, 'failed', 'backend_failed');
    else if (response.status === 'cancelled') this.state(record, 'cancelled', 'backend_cancelled');
    else this.state(record, response.refusal ? 'failed' : 'completed', response.refusal ? 'model_refusal' : undefined);
  }

  private async invokeCall(record: DurableRecord, request: WorkRequest): Promise<boolean> {
    const response = record.currentResponseId ? record.responses[record.currentResponseId] : undefined;
    if (!response) throw new ResponsesWorkerError('missing_response');
    const calls = Object.entries(response.calls).filter(([, call]) => call.complete);
    if (!calls.length) return false;
    if (calls.length > 1) throw new ResponsesWorkerError('parallel_tool_calls');
    const [upstreamCallId, call] = calls[0];
    const tool = this.profile.tools.find(item => item.name === call.name);
    if (!tool) throw new ResponsesWorkerError('unknown_tool');
    const args = schemaArguments(tool.inputSchema, call.argumentsText);
    const semantic = canonicalJson(args);
    const localCallId = digest(canonicalJson(['m2m/responses/host-call/v1', record.currentResponseId, upstreamCallId]));
    const existing = record.toolCalls?.[localCallId];
    if (existing) {
      if (existing.name !== call.name || existing.argumentsDigest !== digest(semantic)) throw new ResponsesWorkerError('tool_call_conflict');
      if (existing.state === 'completed' || existing.state === 'failed') {
        record.pendingCallId = localCallId;
        record.continuationResult = JSON.stringify({ success: existing.success === true, text: existing.text ?? '' });
        this.persist();
        return true;
      }
      if (existing.state === 'pending' && !this.profile.recoverableTools.includes(call.name)) {
        this.state(record, 'uncertain', 'pending_tool_call_uncertain');
        return false;
      }
      if (existing.state === 'uncertain' && !this.profile.recoverableTools.includes(call.name)) { this.state(record, 'uncertain', 'pending_tool_call_uncertain'); return false; }
    } else {
      if (Object.keys(record.toolCalls ?? {}).length >= this.profile.maxToolCalls) throw new ResponsesWorkerError('tool_call_limit');
      record.toolCalls ??= dictionary<ToolCallRecord>();
      const durable: ToolCallRecord = { threadId: record.threadId!, turnId: record.currentResponseId!, callId: localCallId, name: call.name, arguments: clone(args), argumentsDigest: digest(semantic), state: 'pending' };
      record.toolCalls[localCallId] = durable;
      record.toolCallUpstream[localCallId] = upstreamCallId;
      record.pendingCallId = localCallId;
      this.persist();
    }
    const durable = record.toolCalls![localCallId];
    if (this.deadlineExceeded(record) || record.cancelRequestedAt) { durable.state = 'uncertain'; this.persist(); this.state(record, 'uncertain', record.cancelRequestedAt ? 'cancel_requested' : 'duration_limit'); return false; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, record.deadline - this.now())); timer.unref();
    this.controllers.set(requestKey(record), controller);
    try {
      const value: AgentToolCall = { request: { agent: record.agent, conversationId: record.conversationId, requestId: record.requestId }, threadId: record.threadId!, turnId: record.currentResponseId!, callId: localCallId, name: call.name, arguments: clone(args), signal: controller.signal };
      let result: AgentToolResult;
      try { result = await this.profile.handleTool(value); }
      catch { durable.state = 'uncertain'; this.persist(); this.state(record, 'uncertain', 'tool_result_uncertain'); return false; }
      if (!result || typeof result.success !== 'boolean' || typeof result.text !== 'string' || (result.uncertain !== undefined && result.uncertain !== true) || (result.uncertain === true && result.success) || !validUnicode(result.text) || utf8Bytes(result.text) > this.profile.maxToolResultBytes) throw new ResponsesWorkerError('invalid_tool_result');
      if (controller.signal.aborted || record.cancelRequestedAt || this.deadlineExceeded(record)) { durable.state = 'uncertain'; durable.text = result.text; durable.success = false; this.persist(); this.state(record, 'uncertain', record.cancelRequestedAt ? 'cancel_requested' : 'duration_limit'); return false; }
      if (result.uncertain) { durable.state = 'uncertain'; durable.success = false; durable.text = result.text; this.persist(); this.state(record, 'uncertain', 'tool_result_uncertain'); return false; }
      if (durable.state === 'uncertain' || durable.text === undefined) {
        if (record.toolResultBytes + utf8Bytes(result.text) > this.limits.maxToolResultTotalBytes) throw new ResponsesWorkerError('tool_result_total_limit');
        record.toolResultBytes += utf8Bytes(result.text);
      }
      durable.state = result.success ? 'completed' : 'failed'; durable.success = result.success; durable.text = result.text;
      record.continuationResult = JSON.stringify({ success: result.success, text: result.text });
      this.persist();
      return true;
    } finally {
      clearTimeout(timer);
      if (this.controllers.get(requestKey(record)) === controller) this.controllers.delete(requestKey(record));
    }
  }

  private async cancelRecord(record: DurableRecord, reason: string): Promise<RequestRecord> {
    if (terminal(record.state)) return this.publicRecord(record);
    record.reason = reason;
    record.cancelRequestedAt ??= this.now();
    this.persist();
    this.controllers.get(requestKey(record))?.abort();
    // Never cancel a predecessor on behalf of a continuation whose POST has
    // escaped without an acknowledged successor ID.  That predecessor may be
    // perfectly terminal while the new request remains unknown.
    const id = record.intent ? record.intent.responseId : record.currentResponseId;
    if (!id) { if (record.intent) this.state(record, 'uncertain', 'cancellation_target_unknown'); else this.state(record, 'cancelled', reason); return this.publicRecord(record); }
    if (record.controlAttempts >= 3) { this.state(record, 'uncertain', 'cancellation_limit'); return this.publicRecord(record); }
    record.controlAttempts++;
    this.persist();
    const cancellationController = new AbortController();
    const cancellationTimer = setTimeout(() => cancellationController.abort(), this.limits.cancelGraceMs);
    cancellationTimer.unref();
    try {
      const snapshot = await this.transport.cancel(id, { signal: cancellationController.signal, chargeReceivedBytes: count => this.charge(record, count, true) });
      this.processSnapshot(record, snapshot);
      const pending = Object.values(record.toolCalls ?? {}).some(call => call.state === 'pending' || call.state === 'uncertain');
      if (pending) this.state(record, 'uncertain', 'cancellation_unconfirmed');
      else if (ownValue(snapshot, 'status') === 'cancelled') this.state(record, 'cancelled', reason);
      else if (ownValue(snapshot, 'status') === 'completed') this.state(record, 'completed');
      else this.state(record, 'uncertain', 'cancellation_unconfirmed');
    } catch { this.state(record, 'uncertain', 'cancellation_unconfirmed'); }
    finally { clearTimeout(cancellationTimer); }
    return this.publicRecord(record);
  }

  private async execute(request: WorkRequest, conversation: Conversation, record: DurableRecord | undefined, commitment: string, delivery: Delivery | undefined): Promise<RequestRecord> {
    const key = requestKey(request);
    if (!record) {
      if (conversation.requestCount >= 32) throw new ResponsesWorkerError('conversation_request_limit');
      const now = this.now();
      const created: DurableRecord = { runtime: 'responses-tools-v1', agent: request.agent, conversationId: request.conversationId, requestId: request.requestId, commitment, submittedInputHash: digest(request.prompt), clientUserMessageId: randomUUID(), state: 'prepared', knownTurnIds: [], startedAt: now, deadline: now + this.limits.maxDurationMs, baselineUsage: null, upstreamUsage: null, usageObserved: false, producedUtf8Bytes: 0, items: dictionary(), events: [], toolCalls: dictionary(), receivedBytes: 0, controlReceivedBytes: 0, reservedOutputTokens: 0, responseCount: 0, recoveryAttempts: 0, controlAttempts: 0, upstreamEvents: 0, toolResultBytes: 0, prompt: request.prompt, responses: dictionary(), toolCallUpstream: dictionary(), threadId: conversation.threadId };
      this.journal.requests[key] = created;
      record = created;
      conversation.activeRequest = key;
      conversation.requestCount++;
      this.persist();
    }
    if (record.state === 'uncertain' || record.cancelRequestedAt) { if (delivery) await delivery.finish(); return this.publicRecord(record); }
    // A terminal same-request replay is idempotent and must not reserve the
    // conversation. The reservation is only for an unresolved execution;
    // leaving this key behind makes the next distinct task spuriously busy.
    if (terminal(record.state)) {
      if (conversation.activeRequest === key) { delete conversation.activeRequest; this.persist(); }
      if (delivery) await delivery.finish();
      return this.publicRecord(record);
    }
    conversation.activeRequest = key;
    try {
      while (!terminal(record.state) && (record.state as string) !== 'uncertain') {
        if (record.cancelRequestedAt || this.deadlineExceeded(record)) { await this.cancelRecord(record, record.cancelRequestedAt ? record.reason ?? 'cancel_requested' : 'duration_limit'); break; }
        if (record.intent) {
          if (!record.intent.responseId) { this.state(record, 'uncertain', 'backend_launch_uncertain'); break; }
          if (record.responses[record.intent.responseId]?.completed) {
            delete record.intent;
            this.persist();
            continue;
          }
          await this.recoverResponse(record, request, false);
          if ((record.state as string) === 'uncertain') break;
          if (!record.responses[record.intent.responseId]?.completed) break;
          delete record.intent;
          this.persist();
          continue;
        }
        if (record.pendingCallId && record.continuationResult) {
          const previous = record.currentResponseId;
          const upstream = record.toolCallUpstream[record.pendingCallId];
          if (!previous || !upstream) { this.state(record, 'uncertain', 'missing_tool_identity'); break; }
          await this.createResponse(record, request, previous, [{ type: 'function_call_output', call_id: upstream, output: record.continuationResult }]);
          if ((record.state as string) === 'uncertain' || record.state === 'failed') break;
          delete record.pendingCallId;
          delete record.continuationResult;
          this.persist();
          continue;
        }
        const response = record.currentResponseId ? record.responses[record.currentResponseId] : undefined;
        if (!response || !response.completed) {
          const predecessor = record.responseCount === 0 ? conversation.lastResponseId : undefined;
          const input = [{ role: 'user', content: [{ type: 'input_text', text: request.prompt }] }];
          await this.createResponse(record, request, predecessor, input);
          if ((record.state as string) === 'uncertain' || record.state === 'failed') break;
          continue;
        }
        if (Object.values(response.calls).some(call => call.complete)) {
          if (!(await this.invokeCall(record, request))) break;
          continue;
        }
        conversation.lastResponseId = record.currentResponseId;
        record.previousResponseId = record.currentResponseId;
        this.state(record, response.refusal ? 'failed' : 'completed', response.refusal ? 'model_refusal' : undefined);
      }
    } catch (error) {
      if (!terminal(record.state) && (record.state as string) !== 'uncertain') this.state(record, 'uncertain', error instanceof ResponsesWorkerError ? error.code : 'worker_failed');
    }
    if (delivery) await delivery.finish();
    return this.publicRecord(record);
  }

  async run(request: WorkRequest, consume?: EventConsumer, afterEvent = -1): Promise<RequestRecord> {
    this.ensureAdmission();
    if (!validRef(request) || typeof request.prompt !== 'string' || !request.prompt.length || !validUnicode(request.prompt) || utf8Bytes(request.prompt) > this.limits.maxPromptBytes) throw new ResponsesWorkerError('invalid_request');
    if (!Number.isSafeInteger(afterEvent) || afterEvent < -1) throw new ResponsesWorkerError('invalid_event_cursor');
    const key = requestKey(request);
    if (this.activeKey) throw new ResponsesWorkerError('worker_busy');
    const commitment = digest(canonicalJson([request.agent, request.conversationId, request.requestId, request.prompt, this.descriptor, this.fingerprint]));
    const record = this.requestRecord(request);
    if (record && record.commitment !== commitment) throw new ResponsesWorkerError('request_content_conflict');
    const conversation = has(this.journal.conversations, conversationKey(request)) ? this.journal.conversations[conversationKey(request)] : (this.journal.conversations[conversationKey(request)] = { threadId: `responses-conversation:${randomUUID()}`, requestCount: 0 });
    if (conversation.activeRequest && conversation.activeRequest !== key) throw new ResponsesWorkerError('conversation_busy');
    if (conversation.lastResponseId && !Object.values(this.journal.requests).some(item => item.conversationId === request.conversationId && item.agent === request.agent && item.knownTurnIds.includes(conversation.lastResponseId!))) throw new ResponsesWorkerError('backend_context_unavailable');
    this.activeKey = key;
    const delivery = this.makeDelivery(request, consume, afterEvent);
    const operation = this.track(this.execute(request, conversation, record, commitment, delivery));
    try { return await operation; }
    finally { this.deliveries.delete(key); if (this.activeKey === key) this.activeKey = undefined; }
  }

  private async reconcileInternal(ref: RequestRef): Promise<RequestRecord | undefined> {
    const record = this.requestRecord(ref);
    if (!record) return undefined;
    if (terminal(record.state)) return this.publicRecord(record);
    if (record.intent && !record.intent.responseId) { this.state(record, 'uncertain', 'backend_launch_uncertain'); return this.publicRecord(record); }
    if (this.activeKey && this.activeKey !== requestKey(ref)) throw new ResponsesWorkerError('worker_busy');
    // Control attempts are bounded per explicit reconciliation invocation, not
    // spent forever by an earlier cancel/retrieve call.
    if (record.controlAttempts !== 0) { record.controlAttempts = 0; this.persist(); }
    this.activeKey = requestKey(ref);
    try {
      const request: WorkRequest = { agent: record.agent, conversationId: record.conversationId, requestId: record.requestId, prompt: record.prompt };
      if (record.intent?.responseId || (record.currentResponseId && !record.responses[record.currentResponseId]?.completed)) await this.recoverResponse(record, request, true);
      this.settleRecoveredResponse(record);
      if (record.state === 'uncertain' && record.pendingCallId) {
        const continued = await this.invokeCall(record, request);
        if (continued && record.state === 'uncertain') { record.state = 'running'; delete record.reason; this.persist(); }
      }
      if (record.state === 'running' || record.state === 'prepared') {
        const conversation = this.journal.conversations[conversationKey(record)];
        await this.execute(request, conversation, record, record.commitment, undefined);
      }
      return this.publicRecord(record);
    } finally { if (this.activeKey === requestKey(ref)) this.activeKey = undefined; }
  }

  async reconcile(ref: RequestRef): Promise<RequestRecord | undefined> {
    this.ensureAdmission();
    if (!validRef(ref)) throw new ResponsesWorkerError('invalid_request');
    if (this.activeKey) throw new ResponsesWorkerError('worker_busy');
    const key = requestKey(ref);
    // Reserve admission synchronously, before the tracked promise's first
    // microtask. This closes the same-key reconcile/reconcile race even when
    // the record is an unacknowledged launch that returns immediately.
    this.activeKey = key;
    const operation = this.runTracked(() => this.reconcileInternal(ref));
    return operation.finally(() => { if (this.activeKey === key) this.activeKey = undefined; });
  }

  async cancel(ref: RequestRef, reason = 'cancel_requested'): Promise<RequestRecord | undefined> {
    this.ensureAdmission();
    if (!validRef(ref)) throw new ResponsesWorkerError('invalid_request');
    if (this.activeKey && this.activeKey !== requestKey(ref)) throw new ResponsesWorkerError('worker_busy');
    const record = this.requestRecord(ref);
    if (!record) return undefined;
    if (record.controlAttempts !== 0) { record.controlAttempts = 0; this.persist(); }
    return this.runTracked(() => this.cancelRecord(record, reason));
  }

  diagnostics(ref: RequestRef): ResponsesDiagnostics | undefined {
    const record = this.requestRecord(ref);
    if (!record) return undefined;
    return { runtime: 'responses-tools-v1', responseCount: record.responseCount, toolCallCount: Object.keys(record.toolCalls ?? {}).length, reservedOutputTokens: record.reservedOutputTokens, usage: Object.values(record.responses).map(response => ({ responseId: response.id, ...response.usage })) };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const record of Object.values(this.journal.requests)) if (!terminal(record.state)) {
      const operation = this.track(this.cancelRecord(record, 'worker_closed'));
      void operation.catch(() => {});
    }
  }

  async shutdown(): Promise<void> {
    this.close();
    const deadline = Date.now() + this.limits.cancelGraceMs;
    while (this.operations.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    if (this.operations.size) throw new ResponsesWorkerError('worker_shutdown_uncertain');
    this.transport.close();
    if (!this.lockReleased) { this.lockReleased = true; await this.lock.close(); }
  }
}
