import { strictJson } from './native-peer.js';
import { canonicalDemoJson, validateDemoSnapshot, validateDemoSourceEvent } from './agent-demo-event-contract.js';
import { isIP } from 'node:net';
import type { DemoEvidence, DemoLocator, DemoRuntimeHandle, DemoValidationPins, DemoSnapshot } from './demo-types.js';

/*
 * Evidence is a second output boundary.  AgentEvents is intentionally a
 * journal of already-public records, but the runtime evidence getter is not a
 * sanitizer and may contain implementation-owned fields.  Keep this adapter
 * local to L2: the shared event contract remains the immutable source of
 * truth for events and snapshots.
 */
type Dict = Record<string, unknown>;
const MAX_U64 = (1n << 64n) - 1n;
const ID_RE = /^[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-f]{64}$/;

function bad(): never { throw new Error('invalid_evidence'); }
function object(value: unknown): Dict {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad();
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return bad();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || key === '__proto__' || key === 'prototype' || key === 'constructor') return bad();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return bad();
  }
  return value as Dict;
}
function exact(value: unknown, fields: readonly string[]): Dict {
  const result = object(value); const actual = Object.keys(result).sort(); const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return bad();
  return result;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max || Object.getPrototypeOf(value) !== Array.prototype) return bad();
  const keys = Reflect.ownKeys(value); if (keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) return bad();
  if (keys.filter(key => key !== 'length').length !== value.length) return bad();
  return value;
}
function u64(value: unknown, positive = false): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return bad();
  const n = BigInt(value); if (n > MAX_U64 || (positive && n === 0n)) return bad(); return value;
}
function id(value: unknown): string { if (typeof value !== 'string' || !ID_RE.test(value)) return bad(); return value; }
function address(value: unknown): string { if (typeof value !== 'string' || !ADDRESS_RE.test(value)) return bad(); return value; }
function bytes(value: unknown, exactLength?: number, max = 1_048_576): number[] {
  const result = array(value, max); if (exactLength !== undefined && result.length !== exactLength) return bad();
  if (result.some(item => !Number.isInteger(item) || (item as number) < 0 || (item as number) > 255)) return bad();
  return result.map(item => item as number);
}
function same(a: unknown, b: unknown): boolean { try { return canonicalDemoJson(a) === canonicalDemoJson(b); } catch { return false; } }
function pinnedRef(value: unknown, expected: { network: number[]; package_id: string; domain: string; agent: string }): Dict {
  const result = exact(value, ['network', 'package_id', 'domain', 'agent']);
  const network = bytes(result.network, undefined, 64); address(result.package_id); address(result.domain); address(result.agent);
  if (!same(network, expected.network) || result.package_id !== expected.package_id || result.domain !== expected.domain || result.agent !== expected.agent) return bad();
  return { network, package_id: result.package_id, domain: result.domain, agent: result.agent };
}
function statementCommon(value: Dict, pins: DemoValidationPins, kind: string): Dict {
  const purpose = bytes(value.purpose, undefined, 64); const method = bytes(value.method, undefined, 64); const network = bytes(value.network, undefined, 64);
  if (value.version !== 1 || !same(purpose, Array.from(new TextEncoder().encode(`m2m/streaming/${kind}/v1`))) || !same(method, Array.from(new TextEncoder().encode('sui.streaming.v1'))) || !same(network, pins.agents.buyer.network)) return bad();
  if (value.package_id !== pins.agents.buyer.package_id || value.deployment !== pins.agents.buyer.domain || value.buyer !== pins.agents.buyer.agent || value.provider !== pins.agents.provider.agent) return bad();
  return { purpose, method, version: 1, network, package_id: value.package_id, deployment: value.deployment, buyer: value.buyer, provider: value.provider };
}
function statement(value: unknown, kind: 'offer' | 'credit' | 'checkpoint' | 'policy', pins: DemoValidationPins): Dict {
  if (kind === 'policy') {
    const r = exact(value, ['purpose', 'version', 'units', 'rates', 'denominator']); const purpose = bytes(r.purpose, undefined, 64); const units = array(r.units, 2); const rates = array(r.rates, 2).map(item => u64(item));
    if (r.version !== 1 || !same(purpose, Array.from(new TextEncoder().encode('m2m/streaming/policy/v1'))) || !same(bytes(units[0], undefined, 64), Array.from(new TextEncoder().encode('input_utf8_bytes'))) || !same(bytes(units[1], undefined, 64), Array.from(new TextEncoder().encode('output_utf8_bytes'))) || rates.length !== 2 || rates[0] !== pins.config.price.input_rate || rates[1] !== pins.config.price.output_rate || u64(r.denominator) !== pins.config.price.denominator) return bad();
    return { purpose, version: 1, units: [bytes(units[0], undefined, 64), bytes(units[1], undefined, 64)], rates, denominator: u64(r.denominator) };
  }
  const suffix: Record<'offer' | 'credit' | 'checkpoint', string[]> = {
    offer: ['buyer_key', 'provider_key', 'refund', 'payee', 'opening_nonce', 'policy_hash', 'deposit', 'offer_expires_ms', 'work_deadline_ms', 'claim_deadline_ms'],
    credit: ['channel', 'offer_hash', 'sequence', 'request_sequence', 'request_hash', 'previous_checkpoint', 'units', 'cumulative_amount'],
    checkpoint: ['channel', 'offer_hash', 'credit_hash', 'sequence', 'request_sequence', 'request_hash', 'previous_checkpoint', 'units', 'cumulative_amount', 'output_hash', 'final'],
  };
  const r = exact(value, ['purpose', 'method', 'version', 'network', 'package_id', 'deployment', 'buyer', 'provider', ...suffix[kind]]); const result = statementCommon(r, pins, kind);
  for (const field of suffix[kind]) {
    if (['buyer_key', 'provider_key', 'opening_nonce', 'policy_hash', 'offer_hash', 'credit_hash', 'request_hash', 'previous_checkpoint', 'output_hash'].includes(field)) result[field] = bytes(r[field], 32);
    else if (['refund', 'payee', 'channel'].includes(field)) result[field] = address(r[field]);
    else if (field === 'units') { const values = array(r[field], 2).map(item => u64(item)); if (values.length !== 2) return bad(); result[field] = values; }
    else if (field === 'final') { if (typeof r[field] !== 'boolean') return bad(); result[field] = r[field]; }
    else result[field] = u64(r[field], kind !== 'offer' && (field === 'sequence' || field === 'request_sequence'));
  }
  if (result.buyer === result.provider) return bad();
  if (kind === 'offer' && (BigInt(result.deposit as string) === 0n || !(BigInt(result.offer_expires_ms as string) < BigInt(result.work_deadline_ms as string) && BigInt(result.work_deadline_ms as string) < BigInt(result.claim_deadline_ms as string) && BigInt(result.claim_deadline_ms as string) - BigInt(result.work_deadline_ms as string) >= 10_000n))) return bad();
  if (kind === 'credit' || kind === 'checkpoint') {
    const units = result.units as string[]; const total = BigInt(units[0]) * BigInt(pins.config.price.input_rate) + BigInt(units[1]) * BigInt(pins.config.price.output_rate); const denominator = BigInt(pins.config.price.denominator); const expected = total / denominator + (total % denominator === 0n ? 0n : 1n);
    if (expected !== BigInt(result.cumulative_amount as string)) return bad();
  }
  return result;
}
function signed(value: unknown, kind: 'offer' | 'credit' | 'checkpoint', pins: DemoValidationPins): Dict {
  const r = exact(value, ['payload', 'signature']); return { payload: statement(r.payload, kind, pins), signature: bytes(r.signature, 64) };
}
function terminalReceipt(value: unknown, pins: DemoValidationPins): unknown {
  const request = object(value).request;
  const checked = validateDemoSourceEvent({ version: 1, id: '1', role: 'host', conversation: pins.conversation, request, at_ms: '0', type: 'turn_terminal', data: { receipt: value } }, { ...pins, source: 'coordinator' });
  return (checked.data as { receipt: unknown }).receipt;
}
function signedEnvelope(value: unknown, pins: DemoValidationPins): Dict {
  const r = exact(value, ['message', 'signature']); const signature = bytes(r.signature, 64); const message = exact(r.message, ['purpose', 'sender', 'recipient', 'generation', 'id', 'correlation', 'created_ms', 'expires_ms', 'kind', 'payload']);
  const purpose = bytes(message.purpose, undefined, 64); if (!same(purpose, Array.from(new TextEncoder().encode('m2m/core/message/v1'))) || message.kind !== 'message.receipt' || message.correlation === null) return bad();
  const messageId = bytes(message.id, 32); const correlation = bytes(message.correlation, 32); const generation = u64(message.generation); const created = u64(message.created_ms); const expires = u64(message.expires_ms); if (BigInt(expires) <= BigInt(created)) return bad();
  const sender = pinnedRef(message.sender, pins.agents.provider); const recipient = pinnedRef(message.recipient, pins.agents.buyer); const payload = bytes(message.payload, undefined, 65_536);
  let body: Dict; try { body = exact(strictJson(payload), ['session', 'message_id', 'commitment', 'state', 'result']); } catch { return bad(); }
  const session = bytes(body.session, 32); const bodyMessageId = bytes(body.message_id, 32); const commitment = bytes(body.commitment, 32);
  if (body.state !== 'completed' || session.length !== 32 || !same(bodyMessageId, correlation) || commitment.length !== 32) return bad();
  const resultBytes = bytes(body.result, undefined, 65_536); let result: Dict; try { result = exact(strictJson(resultBytes), ['version', 'op_id', 'type', 'receipt']); } catch { return bad(); }
  if (result.version !== 2 || !ID_RE.test(String(result.op_id)) || result.type !== 'turn_terminal') return bad();
  const receipt = terminalReceipt(result.receipt, pins); if (!same(receipt, result.receipt)) return bad();
  return { message: { purpose, sender, recipient, generation, id: messageId, correlation, created_ms: created, expires_ms: expires, kind: 'message.receipt', payload }, signature };
}

export function sanitizeDemoLocator(value: unknown, pins: DemoValidationPins): DemoLocator {
  try {
    const r = exact(value, ['version', 'conversation', 'provider', 'configuration_hash', 'endpoint']);
    if (r.version !== 1 || r.conversation !== pins.conversation || r.configuration_hash !== pins.configuration_hash) return bad();
    const provider = pinnedRef(r.provider, pins.agents.provider);
    const endpoint = exact(r.endpoint, ['id', 'addrs']); id(endpoint.id);
    const addresses = array(endpoint.addrs, 32).map(item => {
      const address = exact(item, Object.keys(object(item)));
      if (Object.keys(address).length !== 1) return bad();
      if ('Relay' in address) {
        if (typeof address.Relay !== 'string') return bad(); let parsed: URL; try { parsed = new URL(address.Relay); } catch { return bad(); }
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.port && parsed.port !== '443')) return bad();
        return { Relay: address.Relay };
      }
      if ('Ip' in address) {
        if (typeof address.Ip !== 'string' || !/^\[[0-9a-f:]+\]:[1-9][0-9]*$/iu.test(address.Ip) && !/^[0-9.]+:[1-9][0-9]*$/u.test(address.Ip)) return bad();
        const host = address.Ip.startsWith('[') ? address.Ip.slice(1, address.Ip.indexOf(']')) : address.Ip.slice(0, address.Ip.lastIndexOf(':')); if (isIP(host) === 0) return bad();
        return { Ip: address.Ip };
      }
      return bad();
    });
    return { version: 1, conversation: pins.conversation, provider: provider as unknown as DemoLocator['provider'], configuration_hash: pins.configuration_hash, endpoint: { id: endpoint.id as string, addrs: addresses } };
  } catch (error) { if (error instanceof Error && error.message === 'invalid_evidence') throw error; return bad(); }
}

export function sanitizeDemoEvidence(value: unknown, pins: DemoValidationPins, runtime: DemoRuntimeHandle, network: 'testnet' | 'localnet', expectedChannel?: string): DemoEvidence {
  try {
    const raw = exact(value, ['version', 'conversation', 'channel', 'offer', 'policy', 'credits', 'checkpoints', 'terminal_receipts', 'economy']);
    if (raw.version !== 1 || raw.conversation !== pins.conversation || address(raw.channel) !== raw.channel || (expectedChannel !== undefined && raw.channel !== expectedChannel)) return bad();
    if (runtime.role !== 'coordinator') return bad();
    // Reuse the frozen nested public validator for the economy.  This rejects
    // extra fields at every signed statement, budget, transaction and status
    // boundary rather than copying a potentially private object wholesale.
    const context: DemoSnapshot = {
      version: 1, conversation: pins.conversation, mode: 'live', network,
      configuration_hash: pins.configuration_hash, config: structuredClone(pins.config), identities: runtime.identities(),
      roles: { coordinator: runtime.status(), provider: null }, provider_observed_at_ms: null,
      selected_channel: raw.channel as string, channels: [raw.economy as DemoSnapshot['channels'][number]], projection_sequence: '0', available_controls: [],
    };
    const checkedEconomy = validateDemoSnapshot(context, pins).channels[0]; if (!checkedEconomy) return bad();
    if (checkedEconomy.channel !== raw.channel || !same(raw.offer, checkedEconomy.offer) || !same(raw.policy, checkedEconomy.policy)) return bad();
    const creditsRaw = array(raw.credits, 256); const credits = creditsRaw.map(item => signed(item, 'credit', pins));
    const checkpointsRaw = array(raw.checkpoints, 256); const checkpoints = checkpointsRaw.map(item => signed(item, 'checkpoint', pins));
    for (const item of [...credits, ...checkpoints]) if ((item.payload as Dict).channel !== raw.channel) return bad();
    const receiptsRaw = array(raw.terminal_receipts, 64); const terminalReceipts = receiptsRaw.map(item => signedEnvelope(item, pins));
    const result = { version: 1 as const, conversation: pins.conversation, channel: raw.channel as string, offer: checkedEconomy.offer, policy: checkedEconomy.policy, credits: credits as unknown as DemoEvidence['credits'], checkpoints: checkpoints as unknown as DemoEvidence['checkpoints'], terminal_receipts: terminalReceipts as unknown as DemoEvidence['terminal_receipts'], economy: checkedEconomy };
    if (Buffer.byteLength(canonicalDemoJson(result), 'utf8') > 1_048_576) return bad();
    return result;
  } catch (error) { if (error instanceof Error && error.message === 'invalid_evidence') throw error; return bad(); }
}
