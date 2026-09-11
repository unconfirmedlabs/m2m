import type { AgentPublicEvent } from './agent-events.js';
import type { AgentRef } from './native-chain.js';
import type { AgentServiceConfig } from './agent-services.js';
import type { BudgetLimits, BudgetSnapshot } from './agent-service-types.js';
import type { DemoConnection, DemoControl, DemoControlRecord, DemoEconomy, DemoEvent, DemoIdentity, DemoRoleStatus, DemoSessionResponse, DemoSnapshot, DemoStreamStatus, DemoTransaction, DemoValidationPins, ID, MachineRole, SourceCursor, SourceEventPage, U64 } from './demo-types.js';

export type DemoContractCode = 'invalid_json' | 'invalid_event' | 'invalid_event_cursor' | 'invalid_snapshot' | 'invalid_stream_status';

export class DemoContractError extends Error {
  readonly code: DemoContractCode;
  constructor(code: DemoContractCode) { super(code); this.name = 'DemoContractError'; this.code = code; }
}

const MAX_U64 = (1n << 64n) - 1n;
const MAX_EVENT_BYTES = 65_536;
const MAX_TEXT_BYTES = 32_768;
const ID_RE = /^[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-f]{64}$/;
const U64_RE = /^(0|[1-9][0-9]*)$/;
const BASE64URL_RE = /^(?:[A-Za-z0-9_-]{2,})(?:={0,2})?$/;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const SOURCE_ROLES = ['coordinator', 'research', 'host'] as const;
const EVENT_TYPES = ['task_started', 'model_text', 'tool_started', 'tool_result', 'request_started', 'delivery', 'turn_terminal', 'budget', 'channel_final', 'settlement', 'error', 'runtime', 'connection', 'control', 'funding', 'authorization', 'chain_observation'] as const;
const COORDINATOR_CODES = new Set('already_initialized backend_unavailable budget_policy_conflict budget_uncertain channel_mismatch channel_not_bound channel_not_open channel_open channel_status_conflict conversation_busy coordinator_closed credit_not_monotonic deadline_expired delivered_mismatch deposit_exceeded funding_conflict funding_limit integer_overflow invalid_agent invalid_argument invalid_budget_limits invalid_channel_binding invalid_coordinator_options invalid_credit invalid_integer invalid_json_value invalid_observation invalid_opening_nonce invalid_policy invalid_receipt invalid_request invalid_task invalid_tool_arguments invalid_units journal_corrupt journal_limit journal_missing ledger_closed limit_exceeded observation_lowered_authorization observation_regressed output_tranche_limit outstanding_limit profile_mismatch profile_not_bound request_active request_baseline_mismatch request_conflict request_limit storage_failure task_conflict total_limit turn_limit uncertain_execution unknown_request unknown_tool unreserved_authorization unsafe_state_directory worker_shutdown_uncertain'.split(' '));
const HOST_CODES = new Set([...COORDINATOR_CODES, ...'cancelled_before_dispatch budget_rejected deadline_exceeded request_limit_exceeded runtime_error backend_unavailable backend_context_unavailable backend_launch_uncertain agent_tool_runtime_unvalidated search_unconfigured identity_changed authority_unavailable runtime_profile_mismatch invalid_config invalid_control control_conflict control_not_allowed invalid_event invalid_event_cursor event_conversation_mismatch event_journal_limit projection_conflict projection_gap projection_limit provider_unavailable provider_start_failed connection_failed transport_closed spending_paused waiting_for_credit funding_uncertain settlement_uncertain uncredited_channel_requires_expiry_refund refund_not_eligible duration_limit output_limit response_limit recovery_limit tool_result_uncertain publication_pending publication_failed'.split(' ')]);

type Dict = Record<string, unknown>;
const isObject = (value: unknown): value is Dict => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (code: DemoContractCode): never => { throw new DemoContractError(code); };
const bad = (): never => fail('invalid_event');

function ownObject(value: unknown): Dict {
  if (!isObject(value)) return bad();
  try {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return bad();
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || key === '__proto__' || key === 'prototype' || key === 'constructor') return bad();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return bad();
    }
    return value;
  } catch { return bad(); }
}
function keys(value: unknown, expected: readonly string[]): Dict {
  const object = ownObject(value); const actual = Object.keys(object).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== [...expected].sort()[index]) || actual.some(key => key === '__proto__' || key === 'prototype' || key === 'constructor')) return bad();
  return object;
}
function detached<T>(value: T): T {
  if (Array.isArray(value)) return value.map(detached) as T;
  if (isObject(value)) { const result: Dict = {}; for (const key of Object.keys(value)) result[key] = detached(value[key]); return result as T; }
  return value;
}
function utf8Bytes(value: string): number[] {
  if (typeof value !== 'string') return bad();
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return bad();
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return bad();
  }
  try { return Array.from(new TextEncoder().encode(value)); } catch { return bad(); }
}
function text(value: unknown, max = MAX_TEXT_BYTES, nonempty = false): string {
  if (typeof value !== 'string') return bad();
  const bytes = utf8Bytes(value); if (bytes.length > max || (nonempty && bytes.length === 0)) return bad();
  return value;
}
function identifierText(value: unknown, max = 512): string {
  const result = text(value, max, true);
  if (/[\u0000-\u001F\u007F]/.test(result)) return bad();
  return result;
}
function id(value: unknown, positive = false): ID {
  if (typeof value !== 'string' || !ID_RE.test(value)) return bad();
  return value;
}
function address(value: unknown): string { if (typeof value !== 'string' || !ADDRESS_RE.test(value)) return bad(); return value; }
function u64(value: unknown, positive = false): U64 {
  if (typeof value !== 'string' || !U64_RE.test(value)) return bad();
  const number = BigInt(value); if (number > MAX_U64 || (positive && number === 0n)) return bad();
  return value;
}
function integer(value: unknown, min: number, max: number): number { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) return bad(); return value as number; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') return bad(); return value; }
function enumString<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) return bad();
  return value as T;
}
function denseArray(value: unknown, max?: number): unknown[] {
  if (!Array.isArray(value) || (max !== undefined && value.length > max)) return bad();
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return bad();
    const names = Reflect.ownKeys(value);
    let count = 0;
    for (const name of names) {
      if (name === 'length') continue;
      if (typeof name !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(name) || Number(name) >= value.length) return bad();
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return bad();
      count += 1;
    }
    if (count !== value.length) return bad();
    return value;
  } catch { return bad(); }
}
function bytes(value: unknown, exact?: number, max?: number): number[] {
  const array = denseArray(value, max);
  if ((exact !== undefined && array.length !== exact) || array.some(item => !Number.isInteger(item) || (item as number) < 0 || (item as number) > 255)) return bad();
  return array.map(item => item as number);
}
function equal(a: unknown, b: unknown): boolean { return canonicalDemoJson(a) === canonicalDemoJson(b); }
function sameBytes(a: unknown, b: unknown): boolean { return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index]); }
function exactAgent(value: unknown): AgentRef {
  const r = keys(value, ['network', 'package_id', 'domain', 'agent']);
  const network = bytes(r.network, undefined, 64); if (network.length === 0) return bad();
  try { new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(network)); } catch { return bad(); }
  return { network, package_id: address(r.package_id), domain: address(r.domain), agent: address(r.agent) };
}
function pinnedAgent(value: AgentRef, expected: AgentRef): void { if (!equal(value, expected)) bad(); }

class JsonParser {
  private offset = 0;
  constructor(private readonly source: string) {}
  parse(): unknown { const value = this.value(0); this.space(); if (this.offset !== this.source.length) fail('invalid_json'); return value; }
  private space(): void { while (this.offset < this.source.length && /[ \t\r\n]/.test(this.source[this.offset])) this.offset += 1; }
  private value(depth: number): unknown {
    if (depth > 64) fail('invalid_json'); this.space(); const c = this.source[this.offset];
    if (c === '{') return this.object(depth + 1); if (c === '[') return this.array(depth + 1); if (c === '"') return this.string();
    if (this.source.startsWith('true', this.offset)) { this.offset += 4; return true; }
    if (this.source.startsWith('false', this.offset)) { this.offset += 5; return false; }
    if (this.source.startsWith('null', this.offset)) { this.offset += 4; return null; }
    const start = this.offset; while (this.offset < this.source.length && !/[ \t\r\n,\]}]/.test(this.source[this.offset])) this.offset += 1;
    if (start === this.offset) fail('invalid_json'); const raw = this.source.slice(start, this.offset);
    if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(raw)) fail('invalid_json');
    const number = Number(raw); if (!Number.isFinite(number)) fail('invalid_json'); return number;
  }
  private string(): string {
    const start = this.offset; this.offset += 1; let escaped = false;
    while (this.offset < this.source.length) {
      const c = this.source[this.offset++];
      if (c === '"' && !escaped) {
        let value: unknown; try { value = JSON.parse(this.source.slice(start, this.offset)); } catch { fail('invalid_json'); }
        if (typeof value !== 'string' || /[\uD800-\uDFFF]/u.test(value)) fail('invalid_json'); return value as string;
      }
      if (c === '\\' && !escaped) escaped = true; else escaped = false;
      if (c < ' ' && !escaped) fail('invalid_json');
    }
    return fail('invalid_json');
  }
  private object(depth: number): Dict {
    this.offset += 1; this.space(); const result: Dict = {}; const seen = new Set<string>();
    if (this.source[this.offset] === '}') { this.offset += 1; return result; }
    while (true) {
      this.space(); if (this.source[this.offset] !== '"') fail('invalid_json'); const key = this.string();
      if (seen.has(key) || key === '__proto__' || key === 'prototype' || key === 'constructor') fail('invalid_json'); seen.add(key); this.space();
      if (this.source[this.offset++] !== ':') fail('invalid_json'); result[key] = this.value(depth); this.space();
      const end = this.source[this.offset++]; if (end === '}') return result; if (end !== ',') fail('invalid_json');
    }
  }
  private array(depth: number): unknown[] {
    this.offset += 1; this.space(); const result: unknown[] = []; if (this.source[this.offset] === ']') { this.offset += 1; return result; }
    while (true) { result.push(this.value(depth)); this.space(); const end = this.source[this.offset++]; if (end === ']') return result; if (end !== ',') fail('invalid_json'); }
  }
}

export function parseDemoJson(source: string, maxBytes = 1_048_576): unknown {
  if (typeof source !== 'string' || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 16 * 1024 * 1024) return fail('invalid_json');
  try { if (utf8Bytes(source).length > maxBytes) return fail('invalid_json'); } catch { return fail('invalid_json'); }
  try { return new JsonParser(source).parse(); } catch (error) { if (error instanceof DemoContractError) throw error; return fail('invalid_json'); }
}

function canonical(value: unknown, depth: number, seen: Set<object>): string {
  if (depth > 64) return fail('invalid_json');
  if (value === null) return 'null';
  if (typeof value === 'string') { utf8Bytes(value); return JSON.stringify(value); }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') { if (!Number.isFinite(value)) return fail('invalid_json'); return JSON.stringify(value); }
  if (typeof value !== 'object' || typeof value === 'function' || typeof value === 'bigint') return fail('invalid_json');
  if (seen.has(value)) return fail('invalid_json'); seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    let array: unknown[];
    try { array = denseArray(value); } catch { return fail('invalid_json'); }
    result = `[${array.map(item => canonical(item, depth + 1, seen)).join(',')}]`;
  } else {
    const object = value as Dict;
    try {
      const proto = Object.getPrototypeOf(object); if (proto !== Object.prototype && proto !== null) return fail('invalid_json');
      for (const key of Reflect.ownKeys(object)) {
        if (typeof key !== 'string' || key === '__proto__' || key === 'prototype' || key === 'constructor') return fail('invalid_json');
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return fail('invalid_json');
        utf8Bytes(key);
      }
    } catch (error) { if (error instanceof DemoContractError && error.code === 'invalid_json') throw error; return fail('invalid_json'); }
    const names = Object.keys(object); if (names.some(key => key === '__proto__' || key === 'prototype' || key === 'constructor')) return fail('invalid_json');
    const fields = names.sort().map(key => { const descriptor = Object.getOwnPropertyDescriptor(object, key); if (!descriptor || !('value' in descriptor)) return fail('invalid_json'); return `${JSON.stringify(key)}:${canonical(descriptor.value, depth + 1, seen)}`; });
    result = `{${fields.join(',')}}`;
  }
  seen.delete(value); return result;
}
export function canonicalDemoJson(value: unknown): string { try { return canonical(value, 0, new Set()); } catch (error) { if (error instanceof DemoContractError) throw error; return fail('invalid_json'); } }

export function validateSourceCursor(value: unknown): SourceCursor {
  const r = keys(value, ['coordinator', 'research', 'host']);
  return { coordinator: u64(r.coordinator), research: u64(r.research), host: u64(r.host) };
}
function base64Encode(value: Uint8Array): string {
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'; let output = '';
  for (let index = 0; index < value.length; index += 3) { const a = value[index]; const b = value[index + 1]; const c = value[index + 2]; const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0); output += table[(n >> 18) & 63] + table[(n >> 12) & 63] + (b === undefined ? '' : table[(n >> 6) & 63]) + (c === undefined ? '' : table[n & 63]); }
  return output;
}
function base64Decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return fail('invalid_event_cursor');
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'; const bytesOut: number[] = [];
  let buffer = 0; let bits = 0; for (const character of value) { buffer = (buffer << 6) | table.indexOf(character); bits += 6; if (bits >= 8) { bits -= 8; bytesOut.push((buffer >> bits) & 255); } }
  return Uint8Array.from(bytesOut);
}
export function encodeSourceCursor(value: unknown): string { const cursor = validateSourceCursor(value); return base64Encode(new TextEncoder().encode(canonicalDemoJson(cursor))); }
export function decodeSourceCursor(value: unknown): SourceCursor {
  if (typeof value !== 'string' || !BASE64URL_RE.test(value) || value.includes('=')) return fail('invalid_event_cursor');
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(base64Decode(value));
    const parsed = parseDemoJson(decoded); const cursor = validateSourceCursor(parsed); if (encodeSourceCursor(cursor) !== value) return fail('invalid_event_cursor'); return cursor;
  } catch { return fail('invalid_event_cursor'); }
}

function validUrl(value: unknown, hosts?: string[]): string {
  const url = text(value, 2_048, true); let parsed: URL;
  try { parsed = new URL(url); } catch { return bad(); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || (parsed.port && parsed.port !== '443') || (hosts && !hosts.includes(parsed.hostname))) return bad();
  return url;
}
function toolId(value: unknown): string { return identifierText(value, 512); }
function callId(value: unknown): ID { return id(value); }
function requestId(value: unknown): ID { return id(value); }
const utf8 = (value: string): number[] => Array.from(new TextEncoder().encode(value));
function query(value: unknown): string {
  const result = identifierText(value, 256);
  const words = result.trim().split(/\s+/u).filter(Boolean); if (!words.length || words.length > 50) return bad();
  return result;
}
function exactSigned(value: unknown, payload: (value: unknown) => unknown): unknown {
  const r = keys(value, ['payload', 'signature']); const parsed = payload(r.payload); bytes(r.signature, 64); return { payload: parsed, signature: [...(r.signature as number[])] };
}
function statementCommon(r: Dict, pins: DemoValidationPins, kind: string): void {
  const purpose = bytes(r.purpose, undefined, 64); const method = bytes(r.method, undefined, 64);
  if (!sameBytes(purpose, utf8(`m2m/streaming/${kind}/v1`)) || !sameBytes(method, utf8('sui.streaming.v1')) || r.version !== 1) bad();
  const network = bytes(r.network, undefined, 64); if (!network.length) bad(); try { new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(network)); } catch { bad(); }
  if (!sameBytes(network, pins.agents.buyer.network)) bad();
  if (address(r.package_id) !== pins.agents.buyer.package_id || address(r.deployment) !== pins.agents.buyer.domain || address(r.buyer) !== pins.agents.buyer.agent || address(r.provider) !== pins.agents.provider.agent) bad();
}
function statement(value: unknown, kind: 'offer' | 'credit' | 'checkpoint' | 'policy', pins: DemoValidationPins): unknown {
  const common = ['purpose', 'method', 'version', 'network', 'package_id', 'deployment', 'buyer', 'provider'];
  if (kind === 'policy') {
    const r = keys(value, ['purpose', 'version', 'units', 'rates', 'denominator']); const policyPurpose = bytes(r.purpose, undefined, 64); if (!sameBytes(policyPurpose, utf8('m2m/streaming/policy/v1')) || r.version !== 1) bad();
    const policyUnits = denseArray(r.units); if (policyUnits.length !== 2 || !sameBytes(policyUnits[0], utf8('input_utf8_bytes')) || !sameBytes(policyUnits[1], utf8('output_utf8_bytes'))) bad();
    const policyRates = denseArray(r.rates); const rates = policyRates.map(v => u64(v)); if (rates.length !== 2 || rates[0] !== pins.config.price.input_rate || rates[1] !== pins.config.price.output_rate || u64(r.denominator) !== pins.config.price.denominator) bad(); return { purpose: [...policyPurpose], version: 1, units: [bytes(policyUnits[0]), bytes(policyUnits[1])], rates, denominator: u64(r.denominator) };
  }
  const suffix: Record<'offer' | 'credit' | 'checkpoint', string[]> = {
    offer: ['buyer_key', 'provider_key', 'refund', 'payee', 'opening_nonce', 'policy_hash', 'deposit', 'offer_expires_ms', 'work_deadline_ms', 'claim_deadline_ms'],
    credit: ['channel', 'offer_hash', 'sequence', 'request_sequence', 'request_hash', 'previous_checkpoint', 'units', 'cumulative_amount'],
    checkpoint: ['channel', 'offer_hash', 'credit_hash', 'sequence', 'request_sequence', 'request_hash', 'previous_checkpoint', 'units', 'cumulative_amount', 'output_hash', 'final'],
  };
  const r = keys(value, [...common, ...suffix[kind]]); statementCommon(r, pins, kind);
  for (const field of suffix[kind]) {
    if (['buyer_key', 'provider_key', 'opening_nonce', 'policy_hash', 'offer_hash', 'credit_hash', 'request_hash', 'previous_checkpoint', 'output_hash'].includes(field)) bytes(r[field], 32);
    else if (['refund', 'payee', 'channel'].includes(field)) address(r[field]);
    else if (field === 'units') { const values = denseArray(r[field]); if (values.length !== 2) bad(); values.forEach(item => u64(item)); }
    else if (field === 'final') bool(r[field]); else u64(r[field], kind !== 'offer' && (field === 'sequence' || field === 'request_sequence'));
  }
  if (r.buyer === r.provider) bad();
  if (kind === 'offer') { if (u64(r.deposit) === '0' || !(BigInt(u64(r.offer_expires_ms)) < BigInt(u64(r.work_deadline_ms)) && BigInt(u64(r.work_deadline_ms)) < BigInt(u64(r.claim_deadline_ms)) && BigInt(u64(r.claim_deadline_ms)) - BigInt(u64(r.work_deadline_ms)) >= 10_000n)) bad(); }
  if (kind === 'credit' || kind === 'checkpoint') {
    const quantity = units(r.units); if (BigInt(u64(r.cumulative_amount)) !== BigInt(price(quantity, pins.config))) bad();
  }
  return detached(r);
}
function signedStatement(value: unknown, kind: 'offer' | 'credit' | 'checkpoint', pins: DemoValidationPins): unknown { return exactSigned(value, payload => statement(payload, kind, pins)); }

function budget(value: unknown, pins?: DemoValidationPins): BudgetSnapshot {
  const r = keys(value, ['limits', 'channel', 'authorized_mist', 'delivered_mist', 'redeemed_mist', 'settled_prior_mist', 'remaining_mist', 'outstanding_mist', 'requests_remaining', 'uncertain']);
  const limits = keys(r.limits, ['max_total_mist', 'max_channel_deposit_mist', 'max_turn_mist', 'max_outstanding_mist', 'max_requests', 'deadline_ms', 'output_tranche_bytes']);
  const parsedLimits: BudgetLimits = { max_total_mist: u64(limits.max_total_mist, true), max_channel_deposit_mist: u64(limits.max_channel_deposit_mist, true), max_turn_mist: u64(limits.max_turn_mist, true), max_outstanding_mist: u64(limits.max_outstanding_mist, true), max_requests: integer(limits.max_requests, 1, 32), deadline_ms: u64(limits.deadline_ms, true), output_tranche_bytes: integer(limits.output_tranche_bytes, 1, 262_144) };
  if (BigInt(parsedLimits.max_channel_deposit_mist) > BigInt(parsedLimits.max_total_mist)) bad();
  if (pins && !equal(parsedLimits, pins.config.budget)) bad();
  const channel = r.channel === null ? null : address(r.channel); const authorized = u64(r.authorized_mist); const delivered = u64(r.delivered_mist); const redeemed = u64(r.redeemed_mist); const settled = u64(r.settled_prior_mist); const remaining = u64(r.remaining_mist); const outstanding = u64(r.outstanding_mist); const requests = integer(r.requests_remaining, 0, parsedLimits.max_requests); const uncertain = bool(r.uncertain);
  if (BigInt(delivered) > BigInt(authorized) || BigInt(settled) + BigInt(authorized) > BigInt(parsedLimits.max_total_mist) || BigInt(outstanding) !== BigInt(authorized) - BigInt(delivered) || BigInt(remaining) !== BigInt(parsedLimits.max_total_mist) - BigInt(settled) - BigInt(authorized)) bad();
  return { limits: parsedLimits, channel, authorized_mist: authorized, delivered_mist: delivered, redeemed_mist: redeemed, settled_prior_mist: settled, remaining_mist: remaining, outstanding_mist: outstanding, requests_remaining: requests, uncertain };
}
function requestV2(value: unknown, conversation: ID): Dict { const r = keys(value, ['version', 'conversation', 'request', 'sequence', 'prompt']); if (r.version !== 2 || id(r.conversation) !== conversation || !id(r.request) || u64(r.sequence, true) === '0') bad(); text(r.prompt, 16_384, true); return detached(r); }
function citation(value: unknown, index: number, hosts?: string[]): Dict { const r = keys(value, ['id', 'url', 'title', 'retrieved_at_ms', 'content_hash']); if (r.id !== `s${index}`) bad(); return { id: r.id, url: validUrl(r.url, hosts), title: text(r.title, 256), retrieved_at_ms: u64(r.retrieved_at_ms), content_hash: bytes(r.content_hash, 32) }; }
function receipt(value: unknown, pins: DemoValidationPins, outerRequest?: string): Dict {
  const r = keys(value, ['version', 'conversation', 'request', 'request_hash', 'sequence', 'outcome', 'reason', 'checkpoint_hash', 'delivered_units', 'generated_output', 'discarded_output', 'continuation', 'citations']);
  if (r.version !== 2 || id(r.conversation) !== pins.conversation || (outerRequest && id(r.request) !== outerRequest)) bad();
  bytes(r.request_hash, 32); u64(r.sequence, true); const outcome = enumString(r.outcome, ['completed', 'failed', 'cancelled'] as const);
  if (r.reason !== null) enumString(r.reason, ['invalid_citation', 'cancelled', 'backend_unavailable'] as const); bytes(r.checkpoint_hash, 32);
  const deliveredUnits = denseArray(r.delivered_units); if (deliveredUnits.length !== 2) bad(); deliveredUnits.forEach((item: unknown) => u64(item));
  const generated = u64(r.generated_output); const discarded = u64(r.discarded_output); if (BigInt(discarded) > BigInt(generated)) bad(); const continuation = enumString(r.continuation, ['ready', 'requires_channel_close'] as const);
  const citationItems = denseArray(r.citations, 8); const citations = citationItems.map((item: unknown, index: number) => citation(item, index + 1, pins.config.allowed_hosts));
  return { ...detached(r), outcome, reason: r.reason, delivered_units: deliveredUnits.map(item => u64(item)), generated_output: generated, discarded_output: discarded, continuation, citations };
}

function base58(value: unknown): string {
  const input = identifierText(value, 64); if (!input || /[^1-9A-HJ-NP-Za-km-z]/.test(input)) return bad();
  let number = 0n;
  for (const char of input) number = number * 58n + BigInt(B58.indexOf(char));
  const bytesOut: number[] = [];
  while (number > 0n) { bytesOut.push(Number(number & 255n)); number >>= 8n; }
  for (let i = 0; i < input.length && input[i] === '1'; i += 1) bytesOut.push(0);
  bytesOut.reverse();
  if (bytesOut.length !== 32) return bad();
  let check = ''; let n = 0n; for (const byte of bytesOut) n = (n << 8n) | BigInt(byte);
  const reversed: string[] = []; while (n > 0n) { reversed.push(B58[Number(n % 58n)]); n /= 58n; }
  for (const byte of bytesOut) if (byte === 0) reversed.push('1'); else break;
  check = reversed.reverse().join(''); if (check !== input) return bad();
  return input;
}

function config(value: unknown): AgentServiceConfig {
  const r = keys(value, ['version', 'budget', 'deposit_mist', 'price', 'allowed_hosts']);
  const allowedHosts = denseArray(r.allowed_hosts, 32); if (r.version !== 1 || allowedHosts.length < 1) bad();
  const hosts = allowedHosts.map((host: unknown) => {
    const item = identifierText(host, 253); if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(item) || item.includes('..')) bad(); return item;
  });
  const p = keys(r.price, ['input_rate', 'output_rate', 'denominator']);
  const limits = keys(r.budget, ['max_total_mist', 'max_channel_deposit_mist', 'max_turn_mist', 'max_outstanding_mist', 'max_requests', 'deadline_ms', 'output_tranche_bytes']);
  const parsedBudget: BudgetLimits = {
    max_total_mist: u64(limits.max_total_mist), max_channel_deposit_mist: u64(limits.max_channel_deposit_mist),
    max_turn_mist: u64(limits.max_turn_mist, true), max_outstanding_mist: u64(limits.max_outstanding_mist, true),
    max_requests: integer(limits.max_requests, 1, 32), deadline_ms: u64(limits.deadline_ms, true), output_tranche_bytes: integer(limits.output_tranche_bytes, 1, 262_144),
  };
  const parsed = { version: 1 as const, budget: parsedBudget, deposit_mist: u64(r.deposit_mist),
    price: { input_rate: u64(p.input_rate), output_rate: u64(p.output_rate), denominator: u64(p.denominator) }, allowed_hosts: hosts };
  if (parsed.deposit_mist === '0' || parsed.price.denominator === '0' || parsed.budget.max_total_mist === '0' || parsed.budget.max_channel_deposit_mist === '0' || BigInt(parsed.budget.max_channel_deposit_mist) > BigInt(parsed.budget.max_total_mist)) bad();
  return parsed;
}

function runtime(value: unknown): Dict {
  const r = keys(value, ['version', 'kind', 'model', 'reasoning']);
  if (r.version !== 1 || r.kind !== 'responses-tools-v1' || r.model !== 'gpt-5.6-luna' || r.reasoning !== 'xhigh') bad();
  return { version: 1, kind: r.kind, model: r.model, reasoning: r.reasoning };
}
function connection(value: unknown): DemoConnection {
  const r = keys(value, ['desired', 'state', 'generation', 'path', 'changed_at_ms', 'code']);
  const desired = enumString(r.desired, ['online', 'offline'] as const); const state = enumString(r.state, ['disconnected', 'connecting', 'connected', 'recovering', 'failed'] as const);
  const path = enumString(r.path, ['direct', 'relay', 'unknown'] as const);
  u64(r.generation); u64(r.changed_at_ms); const code = r.code === null ? null : identifierText(r.code, 128); if (code !== null && !HOST_CODES.has(code)) bad();
  return { desired, state, generation: r.generation as U64, path, changed_at_ms: r.changed_at_ms as U64, code };
}
function transaction(value: unknown): DemoTransaction {
  const r = keys(value, ['state', 'digest', 'gas']);
  const state = enumString(r.state, ['pending', 'confirmed', 'failed', 'unknown'] as const);
  const digest = r.digest === null ? null : base58(r.digest);
  let gas: DemoTransaction['gas'] = null;
  if (r.gas !== null) { const g = keys(r.gas, ['computation_cost', 'storage_cost', 'storage_rebate', 'non_refundable_storage_fee']); gas = { computation_cost: u64(g.computation_cost), storage_cost: u64(g.storage_cost), storage_rebate: u64(g.storage_rebate), non_refundable_storage_fee: u64(g.non_refundable_storage_fee) }; }
  if (state === 'confirmed' && digest === null) bad();
  return { state, digest, gas };
}
function command(value: unknown): DemoControl['command'] {
  const r = ownObject(value); const op = r.op;
  if (op === 'start' || op === 'disconnect' || op === 'reconnect') { if (Object.keys(r).length !== 1) bad(); return { op }; }
  if (op === 'fund') { keys(r, ['op', 'configuration_hash', 'previous_channel']); return { op, configuration_hash: id(r.configuration_hash), previous_channel: r.previous_channel === null ? null : address(r.previous_channel) }; }
  if (op === 'task') { keys(r, ['op', 'prompt']); return { op, prompt: text(r.prompt, 16_384, true) }; }
  if (op === 'cancel') { keys(r, ['op', 'task']); return { op, task: id(r.task) }; }
  if (op === 'spending') { keys(r, ['op', 'paused']); return { op, paused: bool(r.paused) }; }
  if (op === 'close' || op === 'refund') { keys(r, ['op', 'channel']); return { op, channel: address(r.channel) }; }
  return bad();
}
function controlRecord(value: unknown, pins: DemoValidationPins): DemoControlRecord {
  const r = keys(value, ['version', 'id', 'command', 'state', 'code', 'accepted_at_ms', 'updated_at_ms', 'task', 'channel']);
  const state = enumString(r.state, ['accepted', 'running', 'completed', 'failed', 'uncertain'] as const); if (r.version !== 1) bad();
  const code = r.code === null ? null : identifierText(r.code, 128); if (code !== null && !HOST_CODES.has(code)) bad(); const accepted = u64(r.accepted_at_ms); const updated = u64(r.updated_at_ms); if (BigInt(updated) < BigInt(accepted)) bad();
  const task = r.task === null ? null : id(r.task); const channel = r.channel === null ? null : address(r.channel);
  const parsedCommand = command(r.command); if (parsedCommand.op === 'fund' && parsedCommand.configuration_hash !== pins.configuration_hash) bad();
  return { version: 1, id: id(r.id), command: parsedCommand, state, code,
    accepted_at_ms: accepted, updated_at_ms: updated, task, channel };
}
function identity(value: unknown, role: MachineRole, pins: DemoValidationPins): DemoIdentity {
  const r = keys(value, ['name', 'agent', 'controller', 'transport_key', 'economic_key', 'generation', 'authority_checked_at_ms', 'alias_state']);
  const expectedName = role === 'coordinator' ? 'local.nozomi.sui' : 'research.nozomi.sui';
  const aliasState = enumString(r.alias_state, ['verified', 'stale', 'changed'] as const); if (r.name !== expectedName) bad();
  const agent = exactAgent(r.agent); pinnedAgent(agent, role === 'coordinator' ? pins.agents.buyer : pins.agents.provider);
  const transportKey = bytes(r.transport_key, 32); const economicKey = bytes(r.economic_key, 32); if (sameBytes(transportKey, economicKey)) bad(); const controller = address(r.controller); const generation = u64(r.generation); const checkedAt = u64(r.authority_checked_at_ms);
  return { name: r.name as DemoIdentity['name'], agent, controller, transport_key: transportKey, economic_key: economicKey, generation, authority_checked_at_ms: checkedAt, alias_state: aliasState };
}
function cloneAgent(value: AgentRef): AgentRef {
  return { network: [...value.network], package_id: value.package_id, domain: value.domain, agent: value.agent };
}
function clonePins(value: DemoValidationPins): DemoValidationPins {
  return { conversation: value.conversation, configuration_hash: value.configuration_hash,
    config: detached(value.config), agents: { buyer: cloneAgent(value.agents.buyer), provider: cloneAgent(value.agents.provider) } };
}
function roleStatus(value: unknown, role: MachineRole, pins: DemoValidationPins): DemoRoleStatus {
  const r = keys(value, ['version', 'role', 'conversation', 'phase', 'code', 'runtime', 'profile_fingerprint', 'configuration_hash', 'active_task', 'active_request', 'spending_paused', 'waiting_for_credit', 'connection', 'cursor']);
  const phase = enumString(r.phase, ['initializing', 'ready', 'active', 'recovering', 'degraded', 'blocked', 'stopping'] as const); if (r.version !== 1 || r.role !== role || id(r.conversation) !== pins.conversation || id(r.profile_fingerprint) !== r.profile_fingerprint || id(r.configuration_hash) !== pins.configuration_hash) bad();
  const activeTask = r.active_task === null ? null : id(r.active_task); const activeRequest = r.active_request === null ? null : id(r.active_request);
  const roleCode = r.code === null ? null : identifierText(r.code, 128); if (roleCode !== null && !HOST_CODES.has(roleCode)) bad();
  return { version: 1, role, conversation: pins.conversation, phase, code: roleCode, runtime: runtime(r.runtime) as unknown as DemoRoleStatus['runtime'], profile_fingerprint: r.profile_fingerprint as ID, configuration_hash: pins.configuration_hash,
    active_task: activeTask, active_request: activeRequest, spending_paused: bool(r.spending_paused), waiting_for_credit: bool(r.waiting_for_credit), connection: connection(r.connection), cursor: validateSourceCursor(r.cursor) };
}

function price(units: [U64, U64], cfg: AgentServiceConfig): U64 {
  const total = BigInt(units[0]) * BigInt(cfg.price.input_rate) + BigInt(units[1]) * BigInt(cfg.price.output_rate);
  if (total > (1n << 128n) - 1n) return bad();
  const denominator = BigInt(cfg.price.denominator);
  const result = total / denominator + (total % denominator === 0n ? 0n : 1n); if (result > MAX_U64) return bad(); return String(result);
}
function units(value: unknown): [U64, U64] { const values = denseArray(value); if (values.length !== 2) return bad(); return [u64(values[0]), u64(values[1])]; }
function economy(value: unknown, pins: DemoValidationPins): DemoEconomy {
  const r = keys(value, ['channel', 'status', 'offer', 'policy', 'signed_credit', 'checkpoint', 'budget', 'delivered_units', 'delivered_mist', 'signed_authorized_mist', 'reserved_mist', 'outstanding_mist', 'reserved_exposure_mist', 'redeemed_mist', 'locked_mist', 'refunded_mist', 'observed_at_ms', 'opening', 'terminal']);
  const channel = address(r.channel); const status = enumString(r.status, ['open', 'closed', 'refunded', 'unknown'] as const);
  const offer = signedStatement(r.offer, 'offer', pins) as DemoEconomy['offer']; const policy = statement(r.policy, 'policy', pins) as DemoEconomy['policy'];
  const signedCredit = r.signed_credit === null ? null : signedStatement(r.signed_credit, 'credit', pins) as DemoEconomy['signed_credit'];
  const checkpoint = r.checkpoint === null ? null : signedStatement(r.checkpoint, 'checkpoint', pins) as DemoEconomy['checkpoint'];
  const parsedBudget = budget(r.budget, pins); const deliveredUnits = units(r.delivered_units);
  const delivered = u64(r.delivered_mist); const signed = u64(r.signed_authorized_mist); const reserved = u64(r.reserved_mist);
  const outstanding = u64(r.outstanding_mist); const reservedExposure = u64(r.reserved_exposure_mist);
  const redeemed = r.redeemed_mist === null ? null : u64(r.redeemed_mist); const locked = r.locked_mist === null ? null : u64(r.locked_mist); const refunded = r.refunded_mist === null ? null : u64(r.refunded_mist); const observed = r.observed_at_ms === null ? null : u64(r.observed_at_ms);
  const opening = transaction(r.opening); const terminal = r.terminal === null ? null : transaction(r.terminal);
  const terminalClear = (r.status === 'closed' || r.status === 'refunded') && terminal?.state === 'confirmed' && locked === '0' && redeemed !== null && observed !== null && terminal.digest !== null;
  if (offer.payload.deposit !== pins.config.deposit_mist) bad();
  if (terminalClear) { if (parsedBudget.channel !== null || parsedBudget.authorized_mist !== '0' || parsedBudget.delivered_mist !== '0' || parsedBudget.outstanding_mist !== '0') bad(); }
  else if (parsedBudget.channel !== channel || parsedBudget.authorized_mist !== reserved || parsedBudget.delivered_mist !== delivered || BigInt(parsedBudget.outstanding_mist) !== BigInt(reserved) - BigInt(delivered)) bad();
  if (signedCredit && signedCredit.payload.channel !== channel) bad();
  if (checkpoint && checkpoint.payload.channel !== channel) bad();
  if (BigInt(delivered) !== BigInt(price(deliveredUnits, pins.config))) bad();
  if (signedCredit && signedCredit.payload.cumulative_amount !== signed) bad();
  if (BigInt(delivered) > BigInt(signed) || (!terminalClear && BigInt(delivered) > BigInt(parsedBudget.authorized_mist)) || BigInt(signed) > BigInt(offer.payload.deposit) || BigInt(reserved) > BigInt(offer.payload.deposit) || BigInt(signed) > BigInt(reserved)) bad();
  if (!signedCredit && signed !== '0') bad();
  if (BigInt(delivered) > 0n && checkpoint === null) bad();
  if (checkpoint && (checkpoint.payload.cumulative_amount !== delivered || checkpoint.payload.units[0] !== deliveredUnits[0] || checkpoint.payload.units[1] !== deliveredUnits[1])) bad();
  if (redeemed !== null && BigInt(redeemed) > BigInt(offer.payload.deposit)) bad();
  if (locked !== null && BigInt(locked) > BigInt(offer.payload.deposit)) bad();
  if (refunded !== null) {
    if (!terminalClear || redeemed === null || BigInt(refunded) !== BigInt(offer.payload.deposit) - BigInt(redeemed)) bad();
  }
  const expectedOutstanding = BigInt(signed) > BigInt(delivered) ? BigInt(signed) - BigInt(delivered) : 0n;
  const expectedReserved = BigInt(reserved) > BigInt(delivered) ? BigInt(reserved) - BigInt(delivered) : 0n;
  if (BigInt(outstanding) !== (terminalClear ? 0n : expectedOutstanding) || BigInt(reservedExposure) !== (terminalClear ? 0n : expectedReserved)) bad();
  if (status === 'open' && terminal !== null) bad();
  return { channel, status, offer, policy, signed_credit: signedCredit, checkpoint,
    budget: parsedBudget, delivered_units: deliveredUnits, delivered_mist: delivered, signed_authorized_mist: signed,
    reserved_mist: reserved, outstanding_mist: outstanding, reserved_exposure_mist: reservedExposure, redeemed_mist: redeemed,
    locked_mist: locked, refunded_mist: refunded, observed_at_ms: observed, opening, terminal };
}
function pinSet(value: DemoSnapshot, supplied?: DemoValidationPins): DemoValidationPins {
  const cfg = config(value.config); const conversation = id(value.conversation); const configurationHash = id(value.configuration_hash);
  const ids = keys(value.identities, ['coordinator', 'provider']);
  // Validate the identity containers before dereferencing nested fields.  A
  // getter at a trusted boundary is malformed input, and must not execute.
  const coordinatorIdentity = ownObject(ids.coordinator);
  const providerIdentity = ownObject(ids.provider);
  const buyer = exactAgent(coordinatorIdentity.agent); const provider = exactAgent(providerIdentity.agent);
  if (!sameBytes(buyer.network, provider.network) || buyer.package_id !== provider.package_id || buyer.domain !== provider.domain) bad();
  const pins: DemoValidationPins = { conversation, configuration_hash: configurationHash, config: cfg, agents: { buyer, provider } };
  if (supplied) {
    if (!equal(supplied.config, cfg) || supplied.conversation !== conversation || supplied.configuration_hash !== configurationHash || !equal(supplied.agents, pins.agents)) bad();
    const suppliedBuyer = exactAgent(supplied.agents.buyer); const suppliedProvider = exactAgent(supplied.agents.provider);
    if (!sameBytes(suppliedBuyer.network, suppliedProvider.network) || suppliedBuyer.package_id !== suppliedProvider.package_id || suppliedBuyer.domain !== suppliedProvider.domain) bad();
    return clonePins({ conversation, configuration_hash: configurationHash, config: config(supplied.config), agents: { buyer: suppliedBuyer, provider: suppliedProvider } });
  }
  return clonePins(pins);
}
function validateDemoSnapshotInternal(value: unknown, pins?: DemoValidationPins): DemoSnapshot {
  const raw = keys(value, ['version', 'conversation', 'mode', 'network', 'configuration_hash', 'config', 'identities', 'roles', 'provider_observed_at_ms', 'selected_channel', 'channels', 'projection_sequence', 'available_controls']);
  const network = enumString(raw.network, ['testnet', 'localnet'] as const); if (raw.version !== 1 || raw.mode !== 'live') bad();
  const provisional = raw as unknown as DemoSnapshot; const checkedPins = pinSet(provisional, pins);
  const ids = keys(raw.identities, ['coordinator', 'provider']);
  const coordinatorIdentity = identity(ids.coordinator, 'coordinator', checkedPins); const providerIdentity = identity(ids.provider, 'provider', checkedPins);
  const roles = keys(raw.roles, ['coordinator', 'provider']);
  const coordinatorRole = roleStatus(roles.coordinator, 'coordinator', checkedPins);
  const providerRole = roles.provider === null ? null : roleStatus(roles.provider, 'provider', checkedPins);
  const providerObserved = raw.provider_observed_at_ms === null ? null : u64(raw.provider_observed_at_ms);
  const selected = raw.selected_channel === null ? null : address(raw.selected_channel);
  const channelInputs = denseArray(raw.channels, 32); const channels = channelInputs.map((item: unknown) => economy(item, checkedPins));
  if (new Set(channels.map(item => item.channel)).size !== channels.length) bad();
  if (selected !== null && !channels.some(item => item.channel === selected)) bad();
  const projection = u64(raw.projection_sequence); const availableControlValues = denseArray(raw.available_controls); if (new Set(availableControlValues).size !== availableControlValues.length) bad();
  const allowedControls = ['start', 'fund', 'task', 'cancel', 'spending', 'disconnect', 'reconnect', 'close', 'refund'];
  const controls = availableControlValues.map((item: unknown) => { if (typeof item !== 'string' || !allowedControls.includes(item)) bad(); return item as DemoSnapshot['available_controls'][number]; });
  return { version: 1, conversation: checkedPins.conversation, mode: 'live', network, configuration_hash: checkedPins.configuration_hash,
    config: checkedPins.config, identities: { coordinator: coordinatorIdentity, provider: providerIdentity }, roles: { coordinator: coordinatorRole, provider: providerRole }, provider_observed_at_ms: providerObserved,
    selected_channel: selected, channels, projection_sequence: projection, available_controls: controls };
}
export function validateDemoSnapshot(value: unknown, pins?: DemoValidationPins): DemoSnapshot {
  try { return validateDemoSnapshotInternal(value, pins); }
  catch (error) { if (error instanceof DemoContractError && error.code === 'invalid_snapshot') throw error; return fail('invalid_snapshot'); }
}

function eventBudgetData(value: unknown, pins: DemoValidationPins, paid: boolean): Dict {
  if (!paid) return budget(value, pins) as unknown as Dict;
  const r = keys(value, ['limits', 'channel', 'authorized_mist', 'delivered_mist', 'redeemed_mist', 'settled_prior_mist', 'remaining_mist', 'outstanding_mist', 'requests_remaining', 'uncertain', 'action']);
  if (r.action !== 'mechanical_credit') bad(); const copy: Dict = { ...r }; delete copy.action; const parsed = budget(copy, pins); return { ...parsed, action: 'mechanical_credit' };
}
function noDispatch(value: unknown): boolean { return typeof value === 'string' && ['cancelled_before_dispatch', 'budget_rejected', 'deadline_exceeded', 'request_limit_exceeded'].includes(value); }
function validateEventData(value: unknown, event: Dict, pins: DemoValidationPins, source: MachineRole): Dict {
  const type = event.type as string; const role = event.role as string; const request = event.request as string | null; const d = ownObject(value);
  if (type === 'task_started' && role === 'coordinator' && request === null) { const r = keys(d, ['task_id']); return { task_id: id(r.task_id) }; }
  if (type === 'model_text' && role === 'coordinator' && request === null) { const r = keys(d, ['text']); return { text: text(r.text) }; }
  if (type === 'tool_started' && role === 'coordinator' && request !== null) { const r = keys(d, ['name', 'call_id']); const name = enumString(r.name, ['research', 'follow_up'] as const); return { name, call_id: toolId(r.call_id) }; }
  if (type === 'tool_started' && role === 'research' && request !== null) { const r = keys(d, ['name', 'call_id', 'arguments']); const name = enumString(r.name, ['web_search', 'web_fetch'] as const); const args = keys(r.arguments, name === 'web_search' ? ['query'] : ['url']); if (name === 'web_search') return { name, call_id: toolId(r.call_id), arguments: { query: query(args.query) } }; return { name, call_id: toolId(r.call_id), arguments: { url: validUrl(args.url, pins.config.allowed_hosts) } }; }
  if (type === 'tool_result' && role === 'coordinator') {
    const r = ownObject(d);
    if (request === null) {
      if (r.name === 'budget') { const x = keys(r, ['name', 'call_id', 'result']); const result = keys(x.result, ['snapshot']); return { name: 'budget', call_id: toolId(x.call_id), result: { snapshot: budget(result.snapshot, pins) } }; }
      if (r.name === 'stop') { const x = keys(r, ['name', 'call_id', 'result']); const result = keys(x.result, ['stopped']); if (result.stopped !== true) bad(); return { name: 'stop', call_id: toolId(x.call_id), result: { stopped: true } }; }
    } else {
      if (r.name !== 'research' && r.name !== 'follow_up') bad();
      if (Object.keys(r).includes('success')) { const x = keys(r, ['name', 'call_id', 'success', 'code']); if (x.success !== false || !noDispatch(x.code)) bad(); return { name: x.name, call_id: toolId(x.call_id), success: false, code: x.code }; }
      const x = keys(r, ['name', 'call_id', 'result']); const result = keys(x.result, ['text', 'receipt']); return { name: x.name, call_id: toolId(x.call_id), result: { text: text(result.text, 65_536), receipt: receipt(result.receipt, pins, request) } };
    }
  }
  if (type === 'tool_result' && role === 'research' && request !== null) { const r = keys(d, ['name', 'call_id', 'success', 'result_bytes']); const name = enumString(r.name, ['web_search', 'web_fetch'] as const); return { name, call_id: toolId(r.call_id), success: bool(r.success), result_bytes: integer(r.result_bytes, 0, 65_536) }; }
  if (type === 'tool_result' && role === 'host' && source === 'coordinator') {
    const r = keys(d, ['name', 'call_id', 'result']); const name = enumString(r.name, ['operator.task', 'operator.status'] as const);
    if (name === 'operator.task') { if (request === null) bad(); const call = id(r.call_id); if (call !== request) bad(); const result = keys(r.result, ['state', 'text']); const state = enumString(result.state, ['completed', 'failed', 'cancelled', 'uncertain'] as const); return { name, call_id: call, result: { state, text: text(result.text) } }; }
    if (request !== null) bad(); const call = id(r.call_id); const result = keys(r.result, ['activeTask', 'activeRequest', 'state']); const state = enumString(result.state, ['idle', 'running', 'completed', 'failed', 'cancelled', 'uncertain'] as const); return { name, call_id: call, result: { activeTask: result.activeTask === null ? null : id(result.activeTask), activeRequest: result.activeRequest === null ? null : id(result.activeRequest), state } };
  }
  if (type === 'request_started' && role === 'host' && request !== null) { const r = keys(d, ['request', 'request_hash']); const req = requestV2(r.request, pins.conversation); if (req.request !== request) bad(); bytes(r.request_hash, 32); return { request: req, request_hash: [...(r.request_hash as number[])] }; }
  if (type === 'delivery' && role === 'host' && request !== null) { const r = keys(d, ['checkpoint', 'output']); bytes(r.output, undefined, 1_024); const cp = signedStatement(r.checkpoint, 'checkpoint', pins) as DemoEconomy['checkpoint']; if (cp?.payload.request_hash === undefined || cp.payload.request_sequence === '0' || cp.payload.final) bad(); return { checkpoint: cp, output: [...(r.output as number[])] }; }
  if (type === 'turn_terminal' && role === 'host' && request !== null) { const r = keys(d, ['receipt']); return { receipt: receipt(r.receipt, pins, request) }; }
  if (type === 'budget' && role === 'host') { return eventBudgetData(d, pins, request !== null); }
  if (type === 'channel_final' && role === 'host' && request === null) { const r = keys(d, ['checkpoint']); const checkpoint = signedStatement(r.checkpoint, 'checkpoint', pins) as DemoEconomy['checkpoint']; if (!checkpoint || checkpoint.payload.final !== true) bad(); return { checkpoint }; }
  if (type === 'settlement' && role === 'host' && request === null) { const r = keys(d, ['channel', 'status', 'digest', 'paid_mist', 'refund_mist']); if (r.status !== 'closed') bad(); return { channel: address(r.channel), status: 'closed', digest: base58(r.digest), paid_mist: u64(r.paid_mist), refund_mist: u64(r.refund_mist) }; }
  if (type === 'error' && (role === 'coordinator' || role === 'host') && (role === 'host' ? request === null : true)) { const r = keys(d, ['code']); const set = role === 'coordinator' ? COORDINATOR_CODES : HOST_CODES; if (typeof r.code !== 'string' || !set.has(r.code)) bad(); return { code: r.code }; }
  return bad();
}

function localEventData(value: unknown, event: Dict, pins: DemoValidationPins, source: MachineRole): Dict {
  const type = event.type as string; const request = event.request as string | null; const d = ownObject(value);
  if (type === 'runtime' && event.role === 'host' && request === null) {
    const r = keys(d, ['status']); const status = roleStatus(r.status, source, pins); if (BigInt(status.cursor.host) !== BigInt(event.id as string) - 1n) bad(); return { status };
  }
  if (type === 'connection' && event.role === 'host' && request === null) {
    const r = keys(d, ['connection', 'actor']); if (r.actor !== 'operator' && r.actor !== 'host') bad(); if (source === 'provider' && r.actor !== 'host') bad();
    return { connection: connection(r.connection), actor: r.actor };
  }
  if (type === 'control' && event.role === 'host' && source === 'coordinator' && request === null) {
    const r = keys(d, ['control']); return { control: controlRecord(r.control, pins) };
  }
  if (type === 'funding' && event.role === 'host' && source === 'coordinator' && request === null) {
    const r = keys(d, ['channel', 'opening_nonce', 'deposit_mist', 'transaction']); const deposit = u64(r.deposit_mist); if (deposit !== pins.config.deposit_mist) bad(); return { channel: r.channel === null ? null : address(r.channel), opening_nonce: id(r.opening_nonce), deposit_mist: deposit, transaction: transaction(r.transaction) };
  }
  if (type === 'authorization' && event.role === 'host' && source === 'coordinator' && request !== null) {
    const r = keys(d, ['channel', 'credit', 'actor']); if (r.actor !== 'host') bad(); const channel = address(r.channel); const credit = signedStatement(r.credit, 'credit', pins) as DemoEconomy['signed_credit']; if (!credit || credit.payload.channel !== channel) bad(); return { channel, credit, actor: 'host' };
  }
  if (type === 'chain_observation' && event.role === 'host' && source === 'coordinator' && request === null) {
    const r = keys(d, ['channel', 'status', 'redeemed_mist', 'locked_mist', 'refunded_mist', 'observed_at_ms', 'terminal']);
    const status = enumString(r.status, ['open', 'closed', 'refunded'] as const); const redeemed = u64(r.redeemed_mist); const locked = u64(r.locked_mist); const refunded = r.refunded_mist === null ? null : u64(r.refunded_mist); const terminal = r.terminal === null ? null : transaction(r.terminal);
    if (status === 'open' && (refunded !== null || terminal !== null)) bad();
    if (refunded !== null && BigInt(refunded) + BigInt(redeemed) !== BigInt(pins.config.deposit_mist)) bad();
    return { channel: address(r.channel), status, redeemed_mist: redeemed, locked_mist: locked, refunded_mist: refunded, observed_at_ms: u64(r.observed_at_ms), terminal };
  }
  return bad();
}

function validateSourceEventShape(value: unknown, pins: DemoValidationPins & { source: MachineRole }): AgentPublicEvent {
  const r = keys(value, ['version', 'id', 'role', 'conversation', 'request', 'at_ms', 'type', 'data']);
  if (r.version !== 1 || id(r.conversation) !== pins.conversation || !SOURCE_ROLES.includes(r.role as typeof SOURCE_ROLES[number]) || u64(r.id, true) === '0' || u64(r.at_ms) === undefined || !EVENT_TYPES.includes(r.type as typeof EVENT_TYPES[number])) bad();
  const role = r.role as typeof SOURCE_ROLES[number]; const request = r.request === null ? null : id(r.request); const type = r.type as string;
  const source = pins.source;
  if (source === 'provider' && !['research', 'host'].includes(role)) bad();
  if (source === 'coordinator' && !['coordinator', 'host'].includes(role)) bad();
  const coordinatorOnly = ['task_started', 'model_text'];
  if (coordinatorOnly.includes(type) && !(source === 'coordinator' && role === 'coordinator')) bad();
  if (['tool_started', 'tool_result'].includes(type) && role === 'research' && source !== 'provider') bad();
  if (['tool_started', 'tool_result'].includes(type) && role === 'host' && source !== 'coordinator') bad();
  if (['request_started', 'delivery', 'turn_terminal', 'budget', 'channel_final', 'settlement'].includes(type) && !(role === 'host' && source === 'coordinator')) bad();
  if (['runtime', 'connection'].includes(type) && role !== 'host') bad();
  if (['control', 'funding', 'authorization', 'chain_observation'].includes(type) && !(role === 'host' && source === 'coordinator')) bad();
  if (type === 'error' && source === 'provider' && role !== 'host') bad();
  if (type === 'error' && source === 'coordinator' && !['coordinator', 'host'].includes(role)) bad();
  if (type !== 'task_started' && type !== 'model_text' && type !== 'tool_result' && type !== 'tool_started' && type !== 'error' && type !== 'operator.status' && request !== null && !ID_RE.test(request)) bad();
  const data = ['runtime', 'connection', 'control', 'funding', 'authorization', 'chain_observation'].includes(type) ? localEventData(r.data, { ...r, role, request, type }, pins, source) : validateEventData(r.data, { ...r, role, request, type }, pins, source);
  const result: AgentPublicEvent = { version: 1, id: r.id as string, role, conversation: pins.conversation, request, at_ms: r.at_ms as U64, type: type as AgentPublicEvent['type'], data };
  try { if (utf8Bytes(canonicalDemoJson(result)).length > MAX_EVENT_BYTES) bad(); } catch { return bad(); }
  return result;
}

export function validateDemoSourceEvent(value: unknown, pins: DemoValidationPins & { source: MachineRole }): AgentPublicEvent {
  try { return validateSourceEventShape(value, pins); } catch (error) { if (error instanceof DemoContractError) throw error; return bad(); }
}
export function validateDemoEvent(value: unknown, pins: DemoValidationPins): DemoEvent {
  try {
    const r = keys(value, ['version', 'sequence', 'source', 'event']);
    const source = enumString(r.source, ['coordinator', 'provider'] as const); if (r.version !== 1 || u64(r.sequence, true) === '0') bad();
    const event = validateSourceEventShape(r.event, { ...pins, source });
    return { version: 1, sequence: r.sequence as U64, source, event };
  } catch (error) { if (error instanceof DemoContractError) throw error; return bad(); }
}
export function validateDemoSourcePage(value: unknown, pins: DemoValidationPins & { source: MachineRole }): SourceEventPage {
  try {
    const r = keys(value, ['version', 'conversation', 'source', 'events', 'high_water', 'has_more']);
    if (r.version !== 1 || id(r.conversation) !== pins.conversation || r.source !== pins.source || typeof r.has_more !== 'boolean') bad();
    const inputEvents = denseArray(r.events, 256); const events = inputEvents.map((item: unknown) => validateDemoSourceEvent(item, pins)); const highWater = validateSourceCursor(r.high_water);
    const last: Record<'coordinator' | 'research' | 'host', bigint> = { coordinator: 0n, research: 0n, host: 0n };
    for (const event of events) { const role = event.role; const previous = last[role]; if (event.conversation !== pins.conversation || BigInt(event.id) <= previous || (previous !== 0n && BigInt(event.id) !== previous + 1n)) bad(); last[role] = BigInt(event.id); }
    for (const role of ['coordinator', 'research', 'host'] as const) {
      if (BigInt(highWater[role]) < last[role]) bad();
      // A final page must cover the captured high water for roles it actually
      // contains. Future high water is valid only while more pages remain.
      if (!r.has_more && last[role] !== 0n && BigInt(highWater[role]) !== last[role]) bad();
    }
    if (utf8Bytes(canonicalDemoJson({ ...r, events })).length > 1_048_576) bad();
    return { version: 1, conversation: pins.conversation, source: pins.source, events, high_water: highWater, has_more: r.has_more as boolean };
  } catch (error) { if (error instanceof DemoContractError) throw error; return bad(); }
}
export function validateDemoStreamStatus(value: unknown, conversation: ID): DemoStreamStatus {
  try {
    const r = keys(value, ['version', 'conversation', 'state', 'high_water']); const state = enumString(r.state, ['replaying', 'live'] as const); if (r.version !== 1 || id(r.conversation) !== conversation) fail('invalid_stream_status');
    return { version: 1, conversation, state, high_water: u64(r.high_water) };
  } catch { return fail('invalid_stream_status'); }
}

export function validateDemoControl(value: unknown): DemoControl {
  try { const r = keys(value, ['version', 'id', 'command']); if (r.version !== 1) bad(); return { version: 1, id: id(r.id), command: command(r.command) }; } catch (error) { if (error instanceof DemoContractError) throw error; return bad(); }
}
export function validateDemoControlRecord(value: unknown, pins: DemoValidationPins): DemoControlRecord { try { return controlRecord(value, pins); } catch (error) { if (error instanceof DemoContractError) throw error; return bad(); } }
export function validateDemoRoleStatus(value: unknown, pins: DemoValidationPins & { source: MachineRole }): DemoRoleStatus {
  try { const r = ownObject(value); const role = enumString(r.role, ['coordinator', 'provider'] as const); if (role !== pins.source) bad(); return roleStatus(value, role, pins); } catch (error) { if (error instanceof DemoContractError) throw error; return bad(); }
}
export function validateDemoSessionResponse(value: unknown, pins?: DemoValidationPins): DemoSessionResponse {
  try {
    const r = keys(value, ['version', 'access', 'snapshot']); const access = enumString(r.access, ['viewer', 'operator'] as const); if (r.version !== 1) fail('invalid_snapshot');
    const snapshot = validateDemoSnapshot(r.snapshot, pins); return { version: 1, access, snapshot };
  } catch (error) { if (error instanceof DemoContractError && error.code === 'invalid_snapshot') throw error; return fail('invalid_snapshot'); }
}
