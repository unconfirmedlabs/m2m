import { bcs } from '@mysten/sui/bcs';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { blake2b } from '@noble/hashes/blake2.js';

/**
 * The channel codec is deliberately independent from the Rust implementation.
 * These schemas are the TypeScript/Move interoperability boundary; do not
 * replace them with JSON or a generated Rust representation.
 */
const bytes = () => bcs.vector(bcs.u8());

export const Offer = bcs.struct('ChannelOffer', {
  purpose: bytes(),
  method: bytes(),
  version: bcs.u8(),
  network: bytes(),
  package_id: bcs.Address,
  deployment: bcs.Address,
  buyer: bcs.Address,
  provider: bcs.Address,
  buyer_key: bytes(),
  provider_key: bytes(),
  refund: bcs.Address,
  payee: bcs.Address,
  opening_nonce: bytes(),
  terms_hash: bytes(),
  deposit: bcs.u64(),
  offer_expires_ms: bcs.u64(),
  work_deadline_ms: bcs.u64(),
  claim_deadline_ms: bcs.u64(),
});

export const Credit = bcs.struct('ChannelCredit', {
  purpose: bytes(),
  method: bytes(),
  version: bcs.u8(),
  network: bytes(),
  package_id: bcs.Address,
  deployment: bcs.Address,
  buyer: bcs.Address,
  provider: bcs.Address,
  channel: bcs.Address,
  offer_hash: bytes(),
  sequence: bcs.u64(),
  cumulative_amount: bcs.u64(),
  request_hash: bytes(),
  previous_transcript_hash: bytes(),
});

export const Ack = bcs.struct('ChannelAck', {
  purpose: bytes(),
  method: bytes(),
  version: bcs.u8(),
  network: bytes(),
  package_id: bcs.Address,
  deployment: bcs.Address,
  buyer: bcs.Address,
  provider: bcs.Address,
  channel: bcs.Address,
  offer_hash: bytes(),
  sequence: bcs.u64(),
  cumulative_amount: bcs.u64(),
  credit_hash: bytes(),
});

export const ResultStatement = bcs.struct('ChannelResultStatement', {
  purpose: bytes(),
  method: bytes(),
  version: bcs.u8(),
  network: bytes(),
  package_id: bcs.Address,
  deployment: bcs.Address,
  buyer: bcs.Address,
  provider: bcs.Address,
  channel: bcs.Address,
  offer_hash: bytes(),
  request_hash: bytes(),
  credit_hash: bytes(),
  result_hash: bytes(),
});

export const Close = bcs.struct('ChannelClose', {
  purpose: bytes(),
  method: bytes(),
  version: bcs.u8(),
  network: bytes(),
  package_id: bcs.Address,
  deployment: bcs.Address,
  buyer: bcs.Address,
  provider: bcs.Address,
  channel: bcs.Address,
  offer_hash: bytes(),
  final_sequence: bcs.u64(),
  final_amount: bcs.u64(),
  transcript_hash: bytes(),
});

export const FixtureTerms = bcs.struct('FixtureTerms', {
  purpose: bytes(),
  result_hash: bytes(),
  unit_price: bcs.u64(),
  max_jobs: bcs.u64(),
  max_unfulfilled_jobs: bcs.u8(),
});

export const RequestDescriptor = bcs.struct('RequestDescriptor', {
  purpose: bytes(),
  channel: bcs.Address,
  terms_hash: bytes(),
  request_id: bytes(),
  request_sequence: bcs.u64(),
});

export const TranscriptStart = bcs.struct('TranscriptStart', {
  purpose: bytes(),
  channel: bcs.Address,
  offer_hash: bytes(),
});

export const TranscriptStep = bcs.struct('TranscriptStep', {
  purpose: bytes(),
  previous_transcript_hash: bytes(),
  request_hash: bytes(),
  credit_hash: bytes(),
  ack_hash: bytes(),
  result_statement_hash: bytes(),
});

export const Channel = bcs.struct('Channel', {
  id: bcs.Address,
  offer: Offer,
  funds: bcs.u64(),
  redeemed_amount: bcs.u64(),
  redeemed_sequence: bcs.u64(),
  status: bcs.u8(),
  terminal_tx: bytes(),
  close_hash: bytes(),
});

export const OpeningKey = bcs.struct('OpeningKey', { nonce: bytes() });

export type OfferData = typeof Offer.$inferType;
export type CreditData = typeof Credit.$inferType;
export type AckData = typeof Ack.$inferType;
export type ResultStatementData = typeof ResultStatement.$inferType;
export type CloseData = typeof Close.$inferType;
export type FixtureTermsData = typeof FixtureTerms.$inferType;
export type RequestDescriptorData = typeof RequestDescriptor.$inferType;
export type TranscriptStartData = typeof TranscriptStart.$inferType;
export type TranscriptStepData = typeof TranscriptStep.$inferType;
export type ChannelData = typeof Channel.$inferType;
export type OpeningKeyData = typeof OpeningKey.$inferType;

export interface SignedData<T> {
  payload: T;
  signature: number[];
}

export interface CloseCertificateData {
  close: CloseData;
  buyer_signature: number[];
  provider_signature: number[];
}

export const METHOD = 'sui.channel.v1';
export const VERSION = 1;
export const OFFER_PURPOSE = 'm2m/channel/offer/v1';
export const CREDIT_PURPOSE = 'm2m/channel/credit/v1';
export const ACK_PURPOSE = 'm2m/channel/ack/v1';
export const RESULT_PURPOSE = 'm2m/channel/result/v1';
export const CLOSE_PURPOSE = 'm2m/channel/close/v1';
export const TERMS_PURPOSE = 'm2m/channel/fixture-terms/v1';
export const REQUEST_PURPOSE = 'm2m/channel/request/v1';
export const TRANSCRIPT_START_PURPOSE = 'm2m/channel/transcript-start/v1';
export const TRANSCRIPT_STEP_PURPOSE = 'm2m/channel/transcript-step/v1';

export const utf8 = (value: string): number[] => Array.from(new TextEncoder().encode(value));
export const hash = (value: Uint8Array): Uint8Array => blake2b(value, { dkLen: 32 });
export const hex = (value: Uint8Array | number[]): string =>
  Buffer.from(value instanceof Uint8Array ? value : Uint8Array.from(value)).toString('hex');
export const fromHex = (value: string): number[] => {
  if (!/^(?:[0-9a-f]{2})*$/i.test(value)) throw new Error('invalid hex');
  return Array.from(Buffer.from(value, 'hex'));
};

const U64_MAX = (1n << 64n) - 1n;
const ZERO_ADDRESS = `0x${'0'.repeat(64)}`;
const PREFIX_KEYS = [
  'purpose', 'method', 'version', 'network', 'package_id', 'deployment', 'buyer', 'provider',
] as const;

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  const record = object(value, name);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    throw new Error(`${name} has unknown or missing fields`);
  }
  return record;
}

function u8(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 255) {
    throw new Error(`${name} must be a u8`);
  }
  return value as number;
}

export function u64(value: unknown, name = 'u64'): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${name} must be a canonical decimal string`);
  }
  let parsed: bigint;
  try { parsed = BigInt(value); } catch { throw new Error(`${name} is not a u64`); }
  if (parsed > U64_MAX) throw new Error(`${name} is not a u64`);
  return value;
}

function byteArray(value: unknown, name: string, length?: number): number[] {
  if (!Array.isArray(value) || value.some(item => !Number.isInteger(item) || item < 0 || item > 255)) {
    throw new Error(`${name} must be a byte array`);
  }
  if (length !== undefined && value.length !== length) throw new Error(`${name} must be ${length} bytes`);
  return value as number[];
}

function address(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value) || value === ZERO_ADDRESS) {
    throw new Error(`${name} must be a nonzero canonical address`);
  }
  try {
    const normalized = normalizeSuiAddress(value);
    if (normalized !== value) throw new Error('noncanonical address');
    return value;
  } catch { throw new Error(`${name} must be a nonzero canonical address`); }
}

function text(value: unknown, name: string, min = 1, max = 1024): string {
  const bytesValue = byteArray(value, name);
  if (bytesValue.length < min || bytesValue.length > max) throw new Error(`${name} has invalid length`);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytesValue)); }
  catch { throw new Error(`${name} must be UTF-8`); }
}

function prefix(value: unknown, purpose: string, keys: readonly string[] = PREFIX_KEYS): Record<string, unknown> {
  const record = exactKeys(value, keys, purpose);
  const actualPurpose = text(record.purpose, `${purpose}.purpose`);
  if (actualPurpose !== purpose) throw new Error(`${purpose}.purpose mismatch`);
  if (text(record.method, `${purpose}.method`) !== METHOD) throw new Error(`${purpose}.method mismatch`);
  if (u8(record.version, `${purpose}.version`) !== VERSION) throw new Error(`${purpose}.version mismatch`);
  const network = byteArray(record.network, `${purpose}.network`);
  if (network.length < 1 || network.length > 64) throw new Error(`${purpose}.network length`);
  const buyer = address(record.buyer, `${purpose}.buyer`);
  const provider = address(record.provider, `${purpose}.provider`);
  address(record.package_id, `${purpose}.package_id`);
  address(record.deployment, `${purpose}.deployment`);
  if (buyer === provider) throw new Error(`${purpose}.buyer and provider must differ`);
  return record;
}

function commonStatement(value: unknown, purpose: string, suffix: readonly string[]): Record<string, unknown> {
  return prefix(value, purpose, [...PREFIX_KEYS, ...suffix]);
}

export function validateOffer(value: unknown): asserts value is OfferData {
  const r = commonStatement(value, OFFER_PURPOSE, [
    'buyer_key', 'provider_key', 'refund', 'payee', 'opening_nonce', 'terms_hash',
    'deposit', 'offer_expires_ms', 'work_deadline_ms', 'claim_deadline_ms',
  ]);
  byteArray(r.buyer_key, 'offer.buyer_key', 32); byteArray(r.provider_key, 'offer.provider_key', 32);
  address(r.refund, 'offer.refund'); address(r.payee, 'offer.payee');
  byteArray(r.opening_nonce, 'offer.opening_nonce', 32); byteArray(r.terms_hash, 'offer.terms_hash', 32);
  u64(r.deposit, 'offer.deposit'); u64(r.offer_expires_ms, 'offer.offer_expires_ms');
  u64(r.work_deadline_ms, 'offer.work_deadline_ms'); u64(r.claim_deadline_ms, 'offer.claim_deadline_ms');
  if (!(BigInt(r.deposit as string) > 0n)) throw new Error('offer.deposit must be positive');
  if (!(BigInt(r.offer_expires_ms as string) > 0n &&
        BigInt(r.offer_expires_ms as string) < BigInt(r.work_deadline_ms as string) &&
        BigInt(r.work_deadline_ms as string) < BigInt(r.claim_deadline_ms as string))) {
    throw new Error('offer deadlines must be ordered');
  }
  if (BigInt(r.claim_deadline_ms as string) - BigInt(r.work_deadline_ms as string) < 10_000n) {
    throw new Error('offer recovery grace is too short');
  }
}

export function validateCredit(value: unknown): asserts value is CreditData {
  const r = commonStatement(value, CREDIT_PURPOSE, [
    'channel', 'offer_hash', 'sequence', 'cumulative_amount', 'request_hash', 'previous_transcript_hash',
  ]);
  address(r.channel, 'credit.channel'); byteArray(r.offer_hash, 'credit.offer_hash', 32);
  u64(r.sequence, 'credit.sequence'); u64(r.cumulative_amount, 'credit.cumulative_amount');
  byteArray(r.request_hash, 'credit.request_hash', 32);
  byteArray(r.previous_transcript_hash, 'credit.previous_transcript_hash', 32);
  if (BigInt(r.sequence as string) === 0n) throw new Error('credit.sequence must be positive');
  if (BigInt(r.cumulative_amount as string) === 0n) throw new Error('credit.cumulative_amount must be positive');
}

export function validateAck(value: unknown): asserts value is AckData {
  const r = commonStatement(value, ACK_PURPOSE, ['channel', 'offer_hash', 'sequence', 'cumulative_amount', 'credit_hash']);
  address(r.channel, 'ack.channel'); byteArray(r.offer_hash, 'ack.offer_hash', 32);
  u64(r.sequence, 'ack.sequence'); u64(r.cumulative_amount, 'ack.cumulative_amount');
  byteArray(r.credit_hash, 'ack.credit_hash', 32);
  if (BigInt(r.sequence as string) === 0n) throw new Error('ack.sequence must be positive');
  if (BigInt(r.cumulative_amount as string) === 0n) throw new Error('ack.cumulative_amount must be positive');
}

export function validateResultStatement(value: unknown): asserts value is ResultStatementData {
  const r = commonStatement(value, RESULT_PURPOSE, ['channel', 'offer_hash', 'request_hash', 'credit_hash', 'result_hash']);
  address(r.channel, 'result.channel'); byteArray(r.offer_hash, 'result.offer_hash', 32);
  byteArray(r.request_hash, 'result.request_hash', 32); byteArray(r.credit_hash, 'result.credit_hash', 32);
  byteArray(r.result_hash, 'result.result_hash', 32);
}

export function validateClose(value: unknown): asserts value is CloseData {
  const r = commonStatement(value, CLOSE_PURPOSE, ['channel', 'offer_hash', 'final_sequence', 'final_amount', 'transcript_hash']);
  address(r.channel, 'close.channel'); byteArray(r.offer_hash, 'close.offer_hash', 32);
  u64(r.final_sequence, 'close.final_sequence'); u64(r.final_amount, 'close.final_amount');
  byteArray(r.transcript_hash, 'close.transcript_hash', 32);
  if ((BigInt(r.final_sequence as string) === 0n) !== (BigInt(r.final_amount as string) === 0n)) {
    throw new Error('close sequence and amount must be both zero or both positive');
  }
}

export function validateTerms(value: unknown): asserts value is FixtureTermsData {
  const r = exactKeys(value, ['purpose', 'result_hash', 'unit_price', 'max_jobs', 'max_unfulfilled_jobs'], 'terms');
  if (text(r.purpose, 'terms.purpose') !== TERMS_PURPOSE) throw new Error('terms.purpose mismatch');
  byteArray(r.result_hash, 'terms.result_hash', 32); u64(r.unit_price, 'terms.unit_price');
  u64(r.max_jobs, 'terms.max_jobs'); u8(r.max_unfulfilled_jobs, 'terms.max_unfulfilled_jobs');
  if (BigInt(r.unit_price as string) === 0n || BigInt(r.max_jobs as string) < 1n || BigInt(r.max_jobs as string) > 1000n) {
    throw new Error('terms limits invalid');
  }
  if (r.max_unfulfilled_jobs !== 1) throw new Error('terms.max_unfulfilled_jobs must be 1');
}

export function validateRequest(value: unknown): asserts value is RequestDescriptorData {
  const r = exactKeys(value, ['purpose', 'channel', 'terms_hash', 'request_id', 'request_sequence'], 'request');
  if (text(r.purpose, 'request.purpose') !== REQUEST_PURPOSE) throw new Error('request.purpose mismatch');
  address(r.channel, 'request.channel'); byteArray(r.terms_hash, 'request.terms_hash', 32);
  const id = text(r.request_id, 'request.request_id', 1, 64);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('request.request_id has invalid characters');
  u64(r.request_sequence, 'request.request_sequence');
  if (BigInt(r.request_sequence as string) === 0n) throw new Error('request sequence must be positive');
}

export function validateTranscriptStart(value: unknown): asserts value is TranscriptStartData {
  const r = exactKeys(value, ['purpose', 'channel', 'offer_hash'], 'transcript_start');
  if (text(r.purpose, 'transcript_start.purpose') !== TRANSCRIPT_START_PURPOSE) throw new Error('transcript start purpose mismatch');
  address(r.channel, 'transcript_start.channel'); byteArray(r.offer_hash, 'transcript_start.offer_hash', 32);
}

export function validateTranscriptStep(value: unknown): asserts value is TranscriptStepData {
  const r = exactKeys(value, ['purpose', 'previous_transcript_hash', 'request_hash', 'credit_hash', 'ack_hash', 'result_statement_hash'], 'transcript_step');
  if (text(r.purpose, 'transcript_step.purpose') !== TRANSCRIPT_STEP_PURPOSE) throw new Error('transcript step purpose mismatch');
  byteArray(r.previous_transcript_hash, 'transcript_step.previous_transcript_hash', 32);
  byteArray(r.request_hash, 'transcript_step.request_hash', 32); byteArray(r.credit_hash, 'transcript_step.credit_hash', 32);
  byteArray(r.ack_hash, 'transcript_step.ack_hash', 32); byteArray(r.result_statement_hash, 'transcript_step.result_statement_hash', 32);
}

export function validateChannel(value: unknown): asserts value is ChannelData {
  const r = exactKeys(value, ['id', 'offer', 'funds', 'redeemed_amount', 'redeemed_sequence', 'status', 'terminal_tx', 'close_hash'], 'channel');
  address(r.id, 'channel.id'); validateOffer(r.offer); u64(r.funds, 'channel.funds');
  u64(r.redeemed_amount, 'channel.redeemed_amount'); u64(r.redeemed_sequence, 'channel.redeemed_sequence');
  const status = u8(r.status, 'channel.status');
  const terminalTx = byteArray(r.terminal_tx, 'channel.terminal_tx');
  const closeHash = byteArray(r.close_hash, 'channel.close_hash');
  if (status > 2) throw new Error('channel.status invalid');
  const funds = BigInt(r.funds as string);
  const paid = BigInt(r.redeemed_amount as string);
  const deposit = BigInt(r.offer.deposit as string);
  // Terminal channels have already returned the unused deposit to the buyer.
  if (paid > deposit || (status === 0 ? funds + paid !== deposit : funds !== 0n)) {
    throw new Error('channel funds conservation');
  }
  if ((BigInt(r.redeemed_sequence as string) === 0n) !== (BigInt(r.redeemed_amount as string) === 0n)) {
    throw new Error('channel redeemed sequence and amount must agree');
  }
  if (status === 0 && terminalTx.length !== 0) throw new Error('open channel has terminal tx');
  if (status === 0 && closeHash.length !== 0) throw new Error('open channel has close hash');
  if (status === 1 && terminalTx.length !== 32) throw new Error('closed channel terminal tx');
  if (status === 1 && closeHash.length !== 32) throw new Error('closed channel close hash');
  if (status === 2 && terminalTx.length !== 32) throw new Error('refunded channel terminal tx');
  if (status === 2 && closeHash.length !== 0) throw new Error('refunded channel close hash');
}

export function termsHash(value: FixtureTermsData): Uint8Array {
  validateTerms(value); return hash(FixtureTerms.serialize(value).toBytes());
}
export function offerHash(value: OfferData): Uint8Array {
  validateOffer(value); return hash(Offer.serialize(value).toBytes());
}
export function requestHash(value: RequestDescriptorData): Uint8Array {
  validateRequest(value); return hash(RequestDescriptor.serialize(value).toBytes());
}
export function creditHash(value: CreditData): Uint8Array {
  validateCredit(value); return hash(Credit.serialize(value).toBytes());
}
export function ackHash(value: AckData): Uint8Array {
  validateAck(value); return hash(Ack.serialize(value).toBytes());
}
export function resultStatementHash(value: ResultStatementData): Uint8Array {
  validateResultStatement(value); return hash(ResultStatement.serialize(value).toBytes());
}
export function transcriptStart(channel: string, offer: OfferData): Uint8Array {
  validateOffer(offer); const value: TranscriptStartData = {
    purpose: utf8(TRANSCRIPT_START_PURPOSE), channel: normalizeSuiAddress(channel), offer_hash: Array.from(offerHash(offer)),
  };
  return hash(TranscriptStart.serialize(value).toBytes());
}
export function transcriptNext(
  previous: number[], request: RequestDescriptorData, credit: CreditData,
  ack: AckData, result: ResultStatementData,
): Uint8Array {
  byteArray(previous, 'previous transcript hash', 32); validateRequest(request); validateCredit(credit);
  validateAck(ack); validateResultStatement(result);
  const value: TranscriptStepData = {
    purpose: utf8(TRANSCRIPT_STEP_PURPOSE), previous_transcript_hash: previous,
    request_hash: Array.from(requestHash(request)), credit_hash: Array.from(creditHash(credit)),
    ack_hash: Array.from(ackHash(ack)), result_statement_hash: Array.from(resultStatementHash(result)),
  };
  return hash(TranscriptStep.serialize(value).toBytes());
}

export function validateSignature(value: unknown, name = 'signature'): asserts value is number[] {
  byteArray(value, name, 64);
}

export function validateSigned<T>(value: unknown, validate: (payload: unknown) => void, name: string): asserts value is SignedData<T> {
  const r = exactKeys(value, ['payload', 'signature'], name);
  validate(r.payload); validateSignature(r.signature, `${name}.signature`);
}

export function validateCloseCertificate(value: unknown): asserts value is CloseCertificateData {
  const r = exactKeys(value, ['close', 'buyer_signature', 'provider_signature'], 'close_certificate');
  validateClose(r.close); validateSignature(r.buyer_signature, 'close_certificate.buyer_signature');
  validateSignature(r.provider_signature, 'close_certificate.provider_signature');
}
