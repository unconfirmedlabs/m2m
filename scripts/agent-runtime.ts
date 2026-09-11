/**
 * Host-owned configuration for the bounded Responses runtime.
 *
 * This module deliberately contains no provider or Codex compatibility
 * fallback.  The production factory is kept behind the R14/Astra gate; the
 * candidate worker is opened directly by the isolated, injected tests.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import type { AgentProfile, AgentWorker } from './agent-service-types.js';
import { OpenAIResponsesTransport, parseResponsesJson } from './responses-transport.js';

export interface AgentRuntimeDescriptor {
  version: 1;
  kind: 'responses-tools-v1';
  model: 'gpt-5.6-luna';
  reasoning: 'xhigh';
}

export interface ResponsesLimits {
  maxDurationMs: number;
  maxOutputBytes: number;
  maxPromptBytes: number;
  maxOutputTokensPerResponse: number;
  maxReservedOutputTokens: number;
  maxResponses: number;
  maxToolResultTotalBytes: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxReceivedBytes: number;
  maxEvents: number;
  maxRecoveryAttempts: number;
  requestTimeoutMs: number;
  streamIdleTimeoutMs: number;
  cancelGraceMs: number;
}

const DEFAULTS: Record<'coordinator' | 'provider', ResponsesLimits> = {
  coordinator: {
    maxDurationMs: 300_000, maxOutputBytes: 32 * 1024, maxPromptBytes: 64 * 1024,
    maxOutputTokensPerResponse: 4096, maxReservedOutputTokens: 131072, maxResponses: 32,
    maxToolResultTotalBytes: 256 * 1024, maxRequestBytes: 256 * 1024,
    maxResponseBytes: 1024 * 1024, maxReceivedBytes: 16 * 1024 * 1024,
    maxEvents: 8192, maxRecoveryAttempts: 8, requestTimeoutMs: 15_000,
    streamIdleTimeoutMs: 30_000, cancelGraceMs: 3_000,
  },
  provider: {
    maxDurationMs: 120_000, maxOutputBytes: 32 * 1024, maxPromptBytes: 64 * 1024,
    maxOutputTokensPerResponse: 4096, maxReservedOutputTokens: 131072, maxResponses: 32,
    maxToolResultTotalBytes: 256 * 1024, maxRequestBytes: 256 * 1024,
    maxResponseBytes: 1024 * 1024, maxReceivedBytes: 16 * 1024 * 1024,
    maxEvents: 8192, maxRecoveryAttempts: 8, requestTimeoutMs: 15_000,
    streamIdleTimeoutMs: 30_000, cancelGraceMs: 3_000,
  },
};

const CEILINGS: ResponsesLimits = {
  maxDurationMs: 300_000, maxOutputBytes: 256 * 1024, maxPromptBytes: 64 * 1024,
  maxOutputTokensPerResponse: 16_384, maxReservedOutputTokens: 262_144, maxResponses: 64,
  maxToolResultTotalBytes: 512 * 1024, maxRequestBytes: 1024 * 1024,
  maxResponseBytes: 2 * 1024 * 1024, maxReceivedBytes: 32 * 1024 * 1024,
  maxEvents: 16_384, maxRecoveryAttempts: 16, requestTimeoutMs: 30_000,
  streamIdleTimeoutMs: 60_000, cancelGraceMs: 10_000,
};

export class RuntimeError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'RuntimeError'; }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Canonical JSON used for fingerprints and commitments. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 64) throw new RuntimeError('canonical_json_depth');
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RuntimeError('non_json_value');
    return JSON.stringify(value);
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new RuntimeError('non_json_value');
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item, depth + 1)).join(',')}]`;
  if (!isPlainObject(value)) throw new RuntimeError('non_json_value');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`).join(',')}}`;
}

export function responsesLimits(role: 'coordinator' | 'provider', lowerOrExplicitLimits: Partial<ResponsesLimits> = {}): ResponsesLimits {
  const defaults = DEFAULTS[role];
  const resolved = { ...defaults, ...lowerOrExplicitLimits };
  for (const key of Object.keys(defaults) as Array<keyof ResponsesLimits>) {
    const value = resolved[key]; const ceiling = CEILINGS[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling) throw new RuntimeError(`invalid_limit:${key}`);
  }
  // A lower response count/token cap must still leave a meaningful positive
  // allowance; these relationships are part of the fixed profile contract.
  if (resolved.maxReservedOutputTokens < resolved.maxOutputTokensPerResponse) throw new RuntimeError('invalid_limit:maxReservedOutputTokens');
  return resolved;
}

function validateResolvedLimits(limits: ResponsesLimits): void {
  for (const key of Object.keys(CEILINGS) as Array<keyof ResponsesLimits>) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > CEILINGS[key]) throw new RuntimeError(`invalid_limit:${key}`);
  }
  if (limits.maxReservedOutputTokens < limits.maxOutputTokensPerResponse) throw new RuntimeError('invalid_limit:maxReservedOutputTokens');
}

function validateStringSchema(schema: Record<string, unknown>): void {
  const allowed = new Set(['type', 'minLength', 'maxLength', 'description']);
  if (schema.type !== 'string' || Object.keys(schema).some(key => !allowed.has(key))) throw new RuntimeError('unsupported_tool_schema');
  for (const key of ['minLength', 'maxLength'] as const) if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || (schema[key] as number) < 0 || (schema[key] as number) > 64 * 1024)) throw new RuntimeError('unsupported_tool_schema');
  if (schema.minLength !== undefined && schema.maxLength !== undefined && (schema.minLength as number) > (schema.maxLength as number)) throw new RuntimeError('unsupported_tool_schema');
}

/** Validate the intentionally small strict-schema subset used by service profiles. */
export function validateResponsesProfile(profile: AgentProfile): void {
  if (!profile || typeof profile.id !== 'string' || profile.id.length < 1 || profile.id.length > 128 ||
      typeof profile.baseInstructions !== 'string' || typeof profile.developerInstructions !== 'string' ||
      typeof profile.handleTool !== 'function' || !Array.isArray(profile.tools) || !Array.isArray(profile.recoverableTools) ||
      !Number.isSafeInteger(profile.maxToolCalls) || profile.maxToolCalls < 1 || profile.maxToolCalls > 32 ||
      !Number.isSafeInteger(profile.maxToolResultBytes) || profile.maxToolResultBytes < 1 || profile.maxToolResultBytes > 64 * 1024) throw new RuntimeError('invalid_agent_profile');
  const names = new Set<string>();
  for (const tool of profile.tools) {
    if (!tool || typeof tool.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name) || names.has(tool.name) ||
        typeof tool.description !== 'string' || tool.description.length > 4096 || !isPlainObject(tool.inputSchema)) throw new RuntimeError('invalid_agent_profile');
    names.add(tool.name);
    const schema = tool.inputSchema;
    const keys = Object.keys(schema);
    if (schema.type !== 'object' || !isPlainObject(schema.properties) || schema.additionalProperties !== false ||
        !Array.isArray(schema.required) || keys.some(key => !new Set(['type', 'properties', 'required', 'additionalProperties', 'description']).has(key))) throw new RuntimeError('unsupported_tool_schema');
    for (const name of Object.keys(schema.properties)) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || !isPlainObject(schema.properties[name])) throw new RuntimeError('unsupported_tool_schema');
      validateStringSchema(schema.properties[name] as Record<string, unknown>);
    }
    const propertyNames = new Set(Object.keys(schema.properties));
    const seenRequired = new Set<string>();
    for (const required of schema.required) if (typeof required !== 'string' || seenRequired.has(required) || !propertyNames.has(required)) throw new RuntimeError('unsupported_tool_schema'); else seenRequired.add(required);
  }
  for (const name of profile.recoverableTools) if (typeof name !== 'string' || !names.has(name)) throw new RuntimeError('invalid_agent_profile');
}

export function agentRuntimeFingerprint(descriptor: AgentRuntimeDescriptor, profile: AgentProfile, limits: ResponsesLimits): string {
  if (descriptor.version !== 1 || descriptor.kind !== 'responses-tools-v1' || descriptor.model !== 'gpt-5.6-luna' || descriptor.reasoning !== 'xhigh') throw new RuntimeError('runtime_descriptor_mismatch');
  validateResolvedLimits(limits);
  validateResponsesProfile(profile);
  const value = {
    descriptor,
    origin: 'https://api.openai.com:443',
    request: { background: true, stream: true, store: true, truncation: 'disabled', toolChoice: 'auto', parallelToolCalls: false },
    profile: { id: profile.id, baseInstructions: profile.baseInstructions, developerInstructions: profile.developerInstructions,
      tools: profile.tools, maxToolCalls: profile.maxToolCalls, maxToolResultBytes: profile.maxToolResultBytes, recoverableTools: profile.recoverableTools },
    limits,
  };
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function readApiKey(options: { apiKeyFile?: string; apiKey?: string }): string {
  if (options.apiKeyFile && options.apiKey !== undefined) throw new RuntimeError('conflicting_openai_credentials');
  if (options.apiKeyFile) {
    let stat;
    try { stat = lstatSync(options.apiKeyFile); } catch { throw new RuntimeError('openai_credential_unavailable'); }
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16 * 1024) throw new RuntimeError('unsafe_openai_credential');
    let value: string;
    try { value = readFileSync(options.apiKeyFile, { encoding: 'utf8', flag: 'r' }); } catch { throw new RuntimeError('openai_credential_unavailable'); }
    if (value.endsWith('\r\n')) value = value.slice(0, -2); else if (value.endsWith('\n')) value = value.slice(0, -1);
    if (!value || /[\u0000-\u001f\u007f]/u.test(value)) throw new RuntimeError('invalid_openai_credential');
    return value;
  }
  if (options.apiKey === undefined || !options.apiKey || /[\u0000-\u001f\u007f]/u.test(options.apiKey)) throw new RuntimeError('missing_openai_credential');
  return options.apiKey;
}

function validateProbeSummary(value: unknown, restart: boolean): void {
  if (!isPlainObject(value)) throw new RuntimeError('invalid_live_evidence');
  const summary = value;
  if (summary.state !== 'completed' ||
      !Number.isSafeInteger(summary.creates) || (summary.creates as number) < (restart ? 2 : 1) ||
      !Number.isSafeInteger(summary.userCreateCount) || (summary.userCreateCount as number) < 1 ||
      !Number.isSafeInteger(summary.continuationCreateCount) || (summary.continuationCreateCount as number) < 1 ||
      !Number.isSafeInteger(summary.callbackCount) || (summary.callbackCount as number) < 1 ||
      summary.markerObservedInOutput !== true || summary.prohibitedToolsSubmitted !== 0 ||
      !Number.isSafeInteger(summary.rejectedDispatchCount) || (summary.rejectedDispatchCount as number) < 3 ||
      (restart && summary.userCreatePreviousResponseIdPresent !== true)) throw new RuntimeError('invalid_live_evidence');
  if (!isPlainObject(summary.sentinelState) || summary.sentinelState.filesystem !== false || summary.sentinelState.process !== false || summary.sentinelState.network !== false) throw new RuntimeError('invalid_live_evidence');
  const attempts = summary.sentinelAttempts;
  if (!Array.isArray(attempts) || attempts.length !== 3 || new Set(attempts).size !== 3 ||
      !['filesystem_write', 'process_exec', 'network_fetch'].every(operation => attempts.includes(operation))) throw new RuntimeError('invalid_live_evidence');
}

/* This is deliberately unset in source.  A production worker may only open
 * after an operator has reviewed a secret-free artifact produced from the
 * current source, profile, and effective limits, then compiled that exact
 * artifact digest into the release.  A writable 0600 file is not acceptance
 * evidence and local probe fixtures are not a substitute for RD-0. */
const ACCEPTED_RESPONSES_EVIDENCE_DIGEST: string | null = null;

/** Validate the bounded, secret-free R14 review artifact before live worker admission. */
export function assertResponsesLiveEvidence(path: string): void {
  let stat;
  try { stat = lstatSync(path); } catch { throw new RuntimeError('live_evidence_unavailable'); }
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 64 * 1024) throw new RuntimeError('unsafe_live_evidence');
  let value: unknown;
  try { value = parseResponsesJson(readFileSync(path, 'utf8'), 12, 4096); } catch { throw new RuntimeError('invalid_live_evidence'); }
  if (!isPlainObject(value) || value.version !== 1 || value.runtime !== 'responses-tools-v1' || value.model !== 'gpt-5.6-luna' || value.effort !== 'xhigh' || !value.initial || !value.restart) throw new RuntimeError('invalid_live_evidence');
  validateProbeSummary(value.initial, false); validateProbeSummary(value.restart, true);
  if (value.continuation !== undefined) validateProbeSummary(value.continuation, false);
}

function responsesEvidenceDigest(path: string, fingerprint: string): string {
  try { return createHash('sha256').update(readFileSync(path)).update('\n', 'utf8').update(fingerprint, 'utf8').digest('hex'); }
  catch { throw new RuntimeError('live_evidence_unavailable'); }
}

/**
 * Production factory. R14/R15 evidence is intentionally required before this
 * entry point can admit a live model connection. It is not a fixture selector.
 */
export async function openAgentWorker(options: {
  descriptor: AgentRuntimeDescriptor; stateDir: string; create: boolean; profile: AgentProfile;
  apiKeyFile?: string; apiKey?: string; limits: ResponsesLimits; evidenceFile?: string;
}): Promise<AgentWorker> {
  if (options.descriptor.version !== 1 || options.descriptor.kind !== 'responses-tools-v1' || options.descriptor.model !== 'gpt-5.6-luna' || options.descriptor.reasoning !== 'xhigh') throw new RuntimeError('runtime_descriptor_mismatch');
  const limits = responsesLimits('provider', options.limits);
  // Credential syntax/file safety is validated before the evidence gate for
  // compatibility with the existing factory diagnostics. This still opens no
  // transport or worker; evidence admission below remains fail closed.
  const key = readApiKey({ apiKeyFile: options.apiKeyFile, apiKey: options.apiKey });
  if (!options.evidenceFile) throw new RuntimeError('agent_tool_runtime_unvalidated');
  assertResponsesLiveEvidence(options.evidenceFile);
  const fingerprint = agentRuntimeFingerprint(options.descriptor, options.profile, limits);
  const evidenceDigest = responsesEvidenceDigest(options.evidenceFile, fingerprint);
  // No compiled acceptance digest exists in this checkout. Keep this branch
  // fail closed until the real R14 source/profile/limits review supplies one.
  // Including the current worker fingerprint in the digest means an accepted
  // artifact cannot be reused with a different profile or effective limits.
  if (ACCEPTED_RESPONSES_EVIDENCE_DIGEST === null || evidenceDigest !== ACCEPTED_RESPONSES_EVIDENCE_DIGEST) {
    throw new RuntimeError('agent_tool_runtime_unvalidated');
  }
  // Constructing the transport is side-effect free. Keep this here so the
  // gate cannot accidentally become an alternate backend or fixture path.
  const transport = new OpenAIResponsesTransport({ apiKey: key, maxRequestBytes: limits.maxRequestBytes, maxResponseBytes: limits.maxResponseBytes, requestTimeoutMs: limits.requestTimeoutMs, streamIdleTimeoutMs: limits.streamIdleTimeoutMs });
  try {
    const { ResponsesWorker } = await import('./responses-worker.js');
    return await ResponsesWorker.open({ stateDir: options.stateDir, create: options.create, descriptor: options.descriptor, profile: options.profile, limits, transport });
  } catch (error) {
    transport.close();
    throw error;
  }
}
