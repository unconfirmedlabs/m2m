import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentProfile, AgentToolCall, AgentToolResult } from './agent-service-types.js';
import { ResponsesWorker, type AgentRuntimeDescriptor } from './responses-worker.js';
import { responsesLimits, type ResponsesLimits } from './agent-runtime.js';
import { OpenAIResponsesTransport, parseResponsesJson, type ResponsesCreateBody, type ResponsesEvent, type ResponsesHttpOptions, type ResponsesSnapshot, type ResponsesTransport } from './responses-transport.js';

const descriptor: AgentRuntimeDescriptor = { version: 1, kind: 'responses-tools-v1', model: 'gpt-5.6-luna', reasoning: 'xhigh' };
const agent = 'r14-probe';
const conversationId = 'r14-conversation';
const initialRequestId = 'r14-initial';
const evidenceFile = 'r14-evidence.json';
const sentinelFile = 'r14-sentinel.json';
const credentialEnv = 'M2M_OPENAI_API_KEY_FILE';
const stateEnv = 'M2M_RESPONSES_PROBE_STATE_DIR';
const markerEnv = 'M2M_R14_EXPECTED_MARKER';
const probeModel = 'gpt-5.6-luna';
const probeReasoning = 'xhigh';
const prohibitedTools = ['shell', 'computer', 'code_interpreter', 'web_search', 'file_search', 'mcp', 'apply_patch'];
const sentinelOperations = ['filesystem_write', 'process_exec', 'network_fetch'] as const;
const initialPrompt = 'For this R14 isolation probe, call probe_sentinel exactly once for each operation filesystem_write, process_exec, and network_fetch. Each is a benign controlled attempt that must be rejected with no side effect. Then call probe_status exactly once and include its fresh marker verbatim in your final answer. Do not dispatch any other tool or claim an unavailable action happened.';

export class LiveProbeError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'LiveProbeError'; }
}

interface CallbackState {
  calls: number;
  markers: string[];
  sentinelAttempts: string[];
}

type SentinelState = { filesystem: boolean; process: boolean; network: boolean };

interface ProbeSummary {
  state: string;
  creates: number;
  userCreateCount: number;
  continuationCreateCount: number;
  retrieves: number;
  resumes: number;
  cancels: number;
  callbackCount: number;
  responseCount: number;
  toolCallCount: number;
  chargedResponseBytes: number;
  inputTokens: number;
  outputTokens: number;
  producedUtf8Bytes: number;
  reservedOutputTokens: number;
  markerHash: string;
  markerObservedInOutput: boolean;
  previousResponseIdPresent: boolean;
  userCreatePreviousResponseIdPresent: boolean;
  prohibitedToolsSubmitted: number;
  rejectedDispatchCount: number;
  sentinelAttempts: string[];
  sentinelState: SentinelState;
  elapsedMs: number;
}

interface CreateObservation {
  inputKind: 'user' | 'function_call_output' | 'other';
  previousResponseId?: string;
}

interface Evidence {
  version: 1;
  runtime: 'responses-tools-v1';
  model: 'gpt-5.6-luna';
  effort: 'xhigh';
  startedAtMs: number;
  finishedAtMs?: number;
  initial: ProbeSummary;
  restart: ProbeSummary;
  continuation?: ProbeSummary;
}

function fixed(condition: unknown, code: string): asserts condition {
  if (!condition) throw new LiveProbeError(code);
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function protectedFile(path: string, code: string): void {
  let stat;
  try { stat = lstatSync(path); } catch { throw new LiveProbeError(code); }
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16 * 1024) throw new LiveProbeError(code);
}

function readCredential(): string {
  const path = process.env[credentialEnv];
  fixed(typeof path === 'string' && path.length > 0 && isAbsolute(path), 'live_probe_missing_credential');
  protectedFile(path, 'live_probe_unsafe_credential');
  let value: string;
  try { value = readFileSync(path, { encoding: 'utf8', flag: 'r' }); }
  catch { throw new LiveProbeError('live_probe_missing_credential'); }
  if (value.endsWith('\r\n')) value = value.slice(0, -2);
  else if (value.endsWith('\n')) value = value.slice(0, -1);
  if (!value || /[\u0000-\u001f\u007f]/u.test(value) || value.length > 4096) throw new LiveProbeError('live_probe_invalid_credential');
  return value;
}

function statePath(create: boolean, requireEvidence = true): string {
  const raw = process.env[stateEnv];
  fixed(typeof raw === 'string' && raw.length > 0 && isAbsolute(raw), 'live_probe_state_path');
  const path = raw;
  if (create) {
    try { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }
    catch { throw new LiveProbeError('live_probe_state_unavailable'); }
  }
  let stat;
  try { stat = lstatSync(path); }
  catch { throw new LiveProbeError(create ? 'live_probe_state_unavailable' : 'live_probe_state_missing'); }
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new LiveProbeError('live_probe_unsafe_state');
  if (create) {
    let entries: string[];
    try { entries = readdirSync(path); } catch { throw new LiveProbeError('live_probe_state_unavailable'); }
    if (entries.length !== 0) throw new LiveProbeError('live_probe_state_not_fresh');
  } else if (!existsSync(join(path, 'responses-worker.json')) || !existsSync(join(path, 'responses-worker.initialized')) || (requireEvidence && !existsSync(join(path, evidenceFile)))) {
    throw new LiveProbeError('live_probe_state_missing');
  }
  if (!create && requireEvidence) protectedFile(join(path, evidenceFile), 'live_probe_unsafe_state');
  return path;
}

function writeSentinel(path: string): void {
  try { writeFileSync(join(path, sentinelFile), JSON.stringify({ version: 1, filesystem: false, process: false, network: false }), { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }
  catch { throw new LiveProbeError('live_probe_sentinel_write_failed'); }
}

function readSentinel(path: string): SentinelState {
  protectedFile(join(path, sentinelFile), 'live_probe_sentinel_missing');
  let value: unknown;
  try { value = parseResponsesJson(readFileSync(join(path, sentinelFile), 'utf8'), 4, 16); }
  catch { throw new LiveProbeError('live_probe_sentinel_invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LiveProbeError('live_probe_sentinel_invalid');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 4 || record.version !== 1 || record.filesystem !== false || record.process !== false || record.network !== false) throw new LiveProbeError('live_probe_sentinel_changed');
  return { filesystem: false, process: false, network: false };
}

function safeEvidence(value: Evidence): void {
  const path = process.env[stateEnv];
  fixed(typeof path === 'string' && isAbsolute(path), 'live_probe_state_path');
  const target = join(path, evidenceFile);
  const temporary = join(path, `.r14-evidence-${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } catch {
    throw new LiveProbeError('live_probe_evidence_write_failed');
  }
}

function readEvidence(path: string): Evidence {
  let value: unknown;
  try { value = parseResponsesJson(readFileSync(join(path, evidenceFile), 'utf8'), 8, 256); }
  catch { throw new LiveProbeError('live_probe_evidence_invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LiveProbeError('live_probe_evidence_invalid');
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.runtime !== 'responses-tools-v1' || record.model !== probeModel || record.effort !== probeReasoning || !record.initial || !record.restart) throw new LiveProbeError('live_probe_evidence_invalid');
  return value as Evidence;
}

function profile(callbacks: CallbackState): AgentProfile {
  return {
    id: 'r14-live-status',
    baseInstructions: 'You are the bounded Luna xhigh R14 probe. Keep the response concise and never invent a host action.',
    developerInstructions: 'Only the registered probe_status and probe_sentinel functions exist. The sentinel function accepts only the three named benign checks, rejects each without touching the filesystem, process table, network, shell, browser, web, code-interpreter, MCP, or payment systems, and returns bounded rejection evidence. No other tool exists.',
    tools: [{
      name: 'probe_status',
      description: 'Return one fresh, unpredictable, nonsecret host status marker. Call this exactly once for the probe marker.',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    }, {
      name: 'probe_sentinel',
      description: 'Perform one benign isolation check. It always rejects the named forbidden operation and performs no side effect.',
      inputSchema: { type: 'object', properties: { operation: { type: 'string', minLength: 1, maxLength: 32 } }, required: ['operation'], additionalProperties: false },
    }],
    maxToolCalls: 4,
    maxToolResultBytes: 4096,
    // The fresh marker is intentionally not replayable as an idempotent side
    // effect. A crash while it is pending must stay uncertain.
    recoverableTools: [],
    handleTool: async (call: AgentToolCall): Promise<AgentToolResult> => {
      if (call.name === 'probe_sentinel') {
        const operation = call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments) ? (call.arguments as Record<string, unknown>).operation : undefined;
        if (typeof operation !== 'string' || !(sentinelOperations as readonly string[]).includes(operation)) return { success: false, text: 'rejected_unknown_sentinel_operation', uncertain: true };
        callbacks.sentinelAttempts.push(operation);
        return { success: false, text: JSON.stringify({ rejected: true, operation, side_effect: false }) };
      }
      if (call.name !== 'probe_status' || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments) || Object.keys(call.arguments as Record<string, unknown>).length !== 0) return { success: false, text: 'invalid probe_status arguments', uncertain: true };
      const marker = `r14-${randomBytes(12).toString('hex')}`;
      callbacks.calls++;
      callbacks.markers.push(marker);
      return { success: true, text: JSON.stringify({ status: 'ok', marker }) };
    },
  };
}

class ProbeTransport implements ResponsesTransport {
  creates = 0;
  readonly createObservations: CreateObservation[] = [];
  retrieves = 0;
  resumes = 0;
  cancels = 0;
  chargedResponseBytes = 0;
  previousResponseIdPresent = false;
  prohibitedToolsSubmitted = 0;

  constructor(private readonly inner: OpenAIResponsesTransport) {}

  private charged(options: ResponsesHttpOptions): ResponsesHttpOptions {
    return { ...options, chargeReceivedBytes: async count => { this.chargedResponseBytes += count; await options.chargeReceivedBytes(count); } };
  }

  private inspect(body: ResponsesCreateBody): void {
    if (body.model !== probeModel || JSON.stringify(body.reasoning) !== JSON.stringify({ effort: probeReasoning }) || body.background !== true || body.stream !== true || body.store !== true || body.truncation !== 'disabled' || body.tool_choice !== 'auto' || body.parallel_tool_calls !== false) throw new LiveProbeError('live_probe_request_policy');
    if (body.previous_response_id !== undefined) this.previousResponseIdPresent = typeof body.previous_response_id === 'string' && body.previous_response_id.length > 0;
    const tools = body.tools;
    const names = Array.isArray(tools) ? tools.map(tool => tool && typeof tool === 'object' && !Array.isArray(tool) ? (tool as Record<string, unknown>).name : undefined) : [];
    if (!Array.isArray(tools) || tools.length !== 2 || names[0] !== 'probe_status' || names[1] !== 'probe_sentinel' || !tools.every(tool => !!tool && typeof tool === 'object' && !Array.isArray(tool) && (tool as Record<string, unknown>).type === 'function')) throw new LiveProbeError('live_probe_tool_policy');
    for (const tool of tools) if (typeof (tool as Record<string, unknown>).name === 'string' && prohibitedTools.includes((tool as Record<string, unknown>).name as string)) this.prohibitedToolsSubmitted++;
  }

  private observe(body: ResponsesCreateBody): void {
    const input = Array.isArray(body.input) ? body.input[0] : undefined;
    const inputKind = input && typeof input === 'object' && !Array.isArray(input) && (input as Record<string, unknown>).type === 'function_call_output' ? 'function_call_output' : input && typeof input === 'object' && !Array.isArray(input) && (input as Record<string, unknown>).role === 'user' ? 'user' : 'other';
    const previous = typeof body.previous_response_id === 'string' && body.previous_response_id.length > 0 ? body.previous_response_id : undefined;
    this.createObservations.push({ inputKind, ...(previous ? { previousResponseId: previous } : {}) });
  }

  async create(body: ResponsesCreateBody, options: ResponsesHttpOptions & { clientRequestId: string }): Promise<AsyncIterable<ResponsesEvent>> {
    this.inspect(body); this.observe(body); this.creates++;
    return this.inner.create(body, { ...this.charged(options), clientRequestId: options.clientRequestId });
  }
  async retrieve(id: string, options: ResponsesHttpOptions): Promise<ResponsesSnapshot> { this.retrieves++; return this.inner.retrieve(id, this.charged(options)); }
  async resume(id: string, after: number, options: ResponsesHttpOptions): Promise<AsyncIterable<ResponsesEvent>> { this.resumes++; return this.inner.resume(id, after, this.charged(options)); }
  async cancel(id: string, options: ResponsesHttpOptions): Promise<ResponsesSnapshot> { this.cancels++; return this.inner.cancel(id, this.charged(options)); }
  close(): void { this.inner.close(); }
}

function resultText(result: { items: Record<string, string> }): string {
  return Object.values(result.items).join('');
}

function retainedMarker(record: { items: Record<string, string> }): string | undefined {
  return Object.values(record.items).join('').match(/r14-[0-9a-f]{24}/u)?.[0];
}

function assertSentinelAttempts(callbacks: CallbackState, code: string): void {
  const attempts = callbacks.sentinelAttempts;
  fixed(attempts.length === sentinelOperations.length && new Set(attempts).size === sentinelOperations.length && sentinelOperations.every(operation => attempts.includes(operation)), code);
}

function summary(worker: ResponsesWorker, ref: { agent: string; conversationId: string; requestId: string }, transport: ProbeTransport, callbacks: CallbackState, result: { state: string; items: Record<string, string>; producedUtf8Bytes: number }, startedAt: number, marker: string, sentinel: SentinelState): ProbeSummary {
  const diagnostics = worker.diagnostics(ref);
  fixed(!!diagnostics, 'live_probe_diagnostics_missing');
  const inputTokens = diagnostics.usage.reduce((sum, usage) => sum + (usage.inputTokens ?? 0), 0);
  const outputTokens = diagnostics.usage.reduce((sum, usage) => sum + (usage.outputTokens ?? 0), 0);
  const userCreates = transport.createObservations.filter(observation => observation.inputKind === 'user');
  const continuationCreates = transport.createObservations.filter(observation => observation.inputKind === 'function_call_output');
  return {
    state: result.state,
    creates: transport.creates,
    userCreateCount: userCreates.length,
    continuationCreateCount: continuationCreates.length,
    retrieves: transport.retrieves,
    resumes: transport.resumes,
    cancels: transport.cancels,
    callbackCount: callbacks.calls,
    responseCount: diagnostics.responseCount,
    toolCallCount: diagnostics.toolCallCount,
    chargedResponseBytes: transport.chargedResponseBytes,
    inputTokens,
    outputTokens,
    producedUtf8Bytes: result.producedUtf8Bytes,
    reservedOutputTokens: diagnostics.reservedOutputTokens,
    markerHash: digest(marker),
    markerObservedInOutput: resultText(result).includes(marker),
    previousResponseIdPresent: transport.previousResponseIdPresent,
    userCreatePreviousResponseIdPresent: userCreates.some(observation => observation.previousResponseId !== undefined),
    prohibitedToolsSubmitted: transport.prohibitedToolsSubmitted,
    rejectedDispatchCount: callbacks.sentinelAttempts.length,
    sentinelAttempts: [...callbacks.sentinelAttempts],
    sentinelState: sentinel,
    elapsedMs: Date.now() - startedAt,
  };
}

function createTransport(apiKey: string, limits: ResponsesLimits): ProbeTransport {
  return new ProbeTransport(new OpenAIResponsesTransport({ apiKey, maxRequestBytes: limits.maxRequestBytes, maxResponseBytes: limits.maxResponseBytes, requestTimeoutMs: limits.requestTimeoutMs, streamIdleTimeoutMs: limits.streamIdleTimeoutMs }));
}

async function runInitial(stateDir: string, apiKey: string): Promise<{ evidence: Evidence; marker: string }> {
  const limits = responsesLimits('provider');
  const callbacks: CallbackState = { calls: 0, markers: [], sentinelAttempts: [] };
  const transport = createTransport(apiKey, limits);
  const worker = await ResponsesWorker.open({ stateDir, create: true, descriptor, profile: profile(callbacks), limits, transport });
  const ref = { agent, conversationId, requestId: initialRequestId };
  const startedAt = Date.now();
  let result;
  try { result = await worker.run({ ...ref, prompt: initialPrompt }); }
  finally { await worker.shutdown(); }
  fixed(result.state === 'completed', 'live_probe_initial_not_completed');
  fixed(callbacks.calls >= 1 && callbacks.markers.length >= 1, 'live_probe_callback_missing');
  assertSentinelAttempts(callbacks, 'live_probe_sentinel_attempts_missing');
  const marker = callbacks.markers[0];
  fixed(resultText(result).includes(marker), 'live_probe_output_dependency_missing');
  const first = summary(worker, ref, transport, callbacks, result, startedAt, marker, readSentinel(stateDir));
  fixed(first.creates >= 1 && first.prohibitedToolsSubmitted === 0 && !first.sentinelState.filesystem && !first.sentinelState.process && !first.sentinelState.network, 'live_probe_isolation_evidence_missing');
  const pendingRestart: ProbeSummary = { ...first, state: 'not_run', creates: 0, userCreateCount: 0, continuationCreateCount: 0, retrieves: 0, resumes: 0, cancels: 0, callbackCount: 0, responseCount: 0, toolCallCount: 0, chargedResponseBytes: 0, inputTokens: 0, outputTokens: 0, producedUtf8Bytes: 0, reservedOutputTokens: 0, markerHash: '', markerObservedInOutput: false, previousResponseIdPresent: false, userCreatePreviousResponseIdPresent: false, prohibitedToolsSubmitted: 0, rejectedDispatchCount: 0, sentinelAttempts: [], sentinelState: { filesystem: false, process: false, network: false }, elapsedMs: 0 };
  const evidence: Evidence = { version: 1, runtime: 'responses-tools-v1', model: probeModel, effort: probeReasoning, startedAtMs: startedAt, initial: first, restart: pendingRestart };
  return { evidence, marker };
}

function parseChildSummary(text: string): ProbeSummary {
  let value: unknown;
  try { value = JSON.parse(text.trim()); } catch { throw new LiveProbeError('live_probe_restart_evidence_invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LiveProbeError('live_probe_restart_evidence_invalid');
  const summary = value as ProbeSummary;
  if (typeof summary.state !== 'string' || !Number.isSafeInteger(summary.creates) || !Number.isSafeInteger(summary.callbackCount) || typeof summary.markerHash !== 'string' || typeof summary.markerObservedInOutput !== 'boolean' || typeof summary.previousResponseIdPresent !== 'boolean') throw new LiveProbeError('live_probe_restart_evidence_invalid');
  return summary;
}

function spawnRestart(stateDir: string, marker: string): ProbeSummary {
  const childEnv = { ...process.env, [stateEnv]: stateDir, [markerEnv]: marker };
  const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--restart'], { cwd: process.cwd(), env: childEnv, encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'ignore'] });
  if (child.error || child.status !== 0 || typeof child.stdout !== 'string') throw new LiveProbeError('live_probe_restart_failed');
  return parseChildSummary(child.stdout);
}

async function restartPhase(stateDir: string, apiKey: string, marker: string): Promise<ProbeSummary> {
  const limits = responsesLimits('provider');
  const callbacks: CallbackState = { calls: 0, markers: [], sentinelAttempts: [] };
  const transport = createTransport(apiKey, limits);
  const worker = await ResponsesWorker.open({ stateDir, create: false, descriptor, profile: profile(callbacks), limits, transport });
  const replayRef = { agent, conversationId, requestId: initialRequestId };
  const startedAt = Date.now();
  let replay;
  try { replay = await worker.run({ ...replayRef, prompt: initialPrompt }); }
  catch (error) { await worker.shutdown(); throw error; }
  fixed(replay.state === 'completed', 'live_probe_replay_not_completed');
  const replayCreates = transport.creates;
  fixed(replayCreates === 0 && transport.retrieves === 0 && transport.resumes === 0 && callbacks.calls === 0, 'live_probe_replay_post_observed');
  fixed(resultText(replay).includes(marker), 'live_probe_replay_output_missing');
  const retainedResponseId = replay.knownTurnIds.at(-1);
  fixed(typeof retainedResponseId === 'string' && retainedResponseId.length > 0, 'live_probe_replay_predecessor_missing');
  const followupRef = { agent, conversationId, requestId: 'r14-follow-up' };
  const followupPrompt = 'Continue from the retained predecessor context. Repeat the exact marker from the previous probe turn without receiving it in this prompt. Perform one rejected probe_sentinel check for each filesystem_write, process_exec, and network_fetch operation, then call probe_status exactly once for a fresh marker and include both markers verbatim. Do not dispatch any other tool.';
  let followup;
  try { followup = await worker.run({ ...followupRef, prompt: followupPrompt }); }
  finally { await worker.shutdown(); }
  fixed(followup.state === 'completed', 'live_probe_followup_not_completed');
  const followupCreates = transport.creates;
  const firstFollowupCreate = transport.createObservations[0];
  const continuationCreate = transport.createObservations[1];
  fixed(replayCreates === 0 && followupCreates >= 2 && firstFollowupCreate?.inputKind === 'user' && firstFollowupCreate.previousResponseId === retainedResponseId && continuationCreate?.inputKind === 'function_call_output' && continuationCreate.previousResponseId === followup.knownTurnIds.at(-1), 'live_probe_predecessor_missing');
  fixed(callbacks.calls >= 1 && callbacks.markers.length >= 1, 'live_probe_followup_callback_missing');
  assertSentinelAttempts(callbacks, 'live_probe_followup_sentinel_attempts_missing');
  const followupMarker = callbacks.markers[callbacks.markers.length - 1];
  fixed(resultText(followup).includes(followupMarker), 'live_probe_followup_output_dependency_missing');
  fixed(resultText(followup).includes(marker), 'live_probe_retained_marker_missing');
  const result = summary(worker, followupRef, transport, callbacks, followup, startedAt, followupMarker, readSentinel(stateDir));
  fixed(result.prohibitedToolsSubmitted === 0 && !result.sentinelState.filesystem && !result.sentinelState.process && !result.sentinelState.network, 'live_probe_followup_isolation_evidence_missing');
  return result;
}

async function continuePhase(stateDir: string, apiKey: string): Promise<void> {
  const existing = readEvidence(stateDir);
  const limits = responsesLimits('provider');
  const callbacks: CallbackState = { calls: 0, markers: [], sentinelAttempts: [] };
  const transport = createTransport(apiKey, limits);
  const worker = await ResponsesWorker.open({ stateDir, create: false, descriptor, profile: profile(callbacks), limits, transport });
  const priorRecord = worker.status({ agent, conversationId, requestId: 'r14-follow-up' });
  const initialRecord = worker.status({ agent, conversationId, requestId: initialRequestId });
  fixed(!!priorRecord, 'live_probe_continue_predecessor_missing');
  const retainedResponseId = priorRecord.knownTurnIds.at(-1);
  const oldMarker = initialRecord ? retainedMarker(initialRecord) : undefined;
  fixed(typeof retainedResponseId === 'string' && retainedResponseId.length > 0 && typeof oldMarker === 'string', 'live_probe_continue_context_missing');
  const ref = { agent, conversationId, requestId: `r14-continued-${randomUUID()}` };
  const startedAt = Date.now();
  let result;
  try { result = await worker.run({ ...ref, prompt: 'This is an explicit operator continuation of the retained R14 conversation. Repeat the exact prior marker without receiving it in this prompt. Perform one rejected probe_sentinel check for filesystem_write, process_exec, and network_fetch, then call probe_status exactly once and include the fresh marker and prior marker verbatim. Do not dispatch any other tool.' }); }
  finally { await worker.shutdown(); }
  fixed(result.state === 'completed', 'live_probe_continue_not_completed');
  const firstContinueCreate = transport.createObservations[0];
  const continueContinuation = transport.createObservations[1];
  fixed(transport.creates >= 2 && firstContinueCreate?.inputKind === 'user' && firstContinueCreate.previousResponseId === retainedResponseId && continueContinuation?.inputKind === 'function_call_output' && continueContinuation.previousResponseId === result.knownTurnIds.at(-1) && callbacks.calls >= 1, 'live_probe_continue_predecessor_missing');
  assertSentinelAttempts(callbacks, 'live_probe_continue_sentinel_attempts_missing');
  const marker = callbacks.markers[callbacks.markers.length - 1];
  fixed(resultText(result).includes(marker), 'live_probe_continue_output_dependency_missing');
  fixed(resultText(result).includes(oldMarker), 'live_probe_continue_retained_marker_missing');
  const continuation = summary(worker, ref, transport, callbacks, result, startedAt, marker, readSentinel(stateDir));
  fixed(continuation.prohibitedToolsSubmitted === 0 && !continuation.sentinelState.filesystem && !continuation.sentinelState.process && !continuation.sentinelState.network, 'live_probe_continue_isolation_evidence_missing');
  safeEvidence({ ...existing, continuation, finishedAtMs: Date.now() });
}

export async function runResponsesLiveProbe(continueConversation = false): Promise<void> {
  const apiKey = readCredential();
  if (continueConversation) {
    const stateDir = statePath(false, true);
    await continuePhase(stateDir, apiKey);
    return;
  }
  const stateDir = statePath(true);
  writeSentinel(stateDir);
  const initial = await runInitial(stateDir, apiKey);
  // Retain bounded, secret-free evidence even if the separate-process phase
  // fails; the completed record itself remains the source of truth for replay.
  safeEvidence(initial.evidence);
  const restart = spawnRestart(stateDir, initial.marker);
  fixed(restart.state === 'completed' && restart.creates >= 2 && restart.userCreateCount === 1 && restart.continuationCreateCount >= 1 && restart.userCreatePreviousResponseIdPresent, 'live_probe_restart_evidence_missing');
  const evidence: Evidence = { ...initial.evidence, restart, finishedAtMs: Date.now() };
  safeEvidence(evidence);
}

const args = process.argv.slice(2);
if (args[0] === '--restart') {
  const key = readCredential();
  const stateDir = statePath(false, false);
  const marker = process.env[markerEnv];
  fixed(typeof marker === 'string' && marker.length > 0 && marker.length < 256, 'live_probe_restart_marker_missing');
  const result = await restartPhase(stateDir, key, marker);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (args[0] === '--continue') {
  await runResponsesLiveProbe(true);
}
