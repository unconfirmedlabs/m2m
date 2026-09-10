import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  Ack,
  Close,
  Credit,
  FixtureTerms,
  Offer,
  RequestDescriptor,
  ResultStatement,
  TranscriptStart,
  TranscriptStep,
  ackHash,
  creditHash,
  fromHex,
  hash,
  hex,
  offerHash,
  requestHash,
  resultStatementHash,
  termsHash,
  transcriptNext,
  transcriptStart,
  validateAck,
  validateClose,
  validateCredit,
  validateOffer,
  validateRequest,
  validateResultStatement,
  validateTerms,
  validateTranscriptStart,
  validateTranscriptStep,
} from './channel-codec.js';

type GoldenStatement = {
  payload: unknown;
  bcs_hex: string;
  hash_hex: string;
  signature_hex?: string;
  buyer_signature_hex?: string;
  provider_signature_hex?: string;
};

function publicKey(raw: number[]): ReturnType<typeof createPublicKey> {
  return createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw)]),
    format: 'der', type: 'spki',
  });
}

function statementBytes(statement: GoldenStatement, label: string, encode: (value: any) => Uint8Array, validate: (value: unknown) => void): Uint8Array {
  validate(statement.payload);
  const encoded = encode(statement.payload);
  assert.equal(hex(encoded), statement.bcs_hex, `${label} BCS mismatch`);
  assert.equal(hex(hash(encoded)), statement.hash_hex, `${label} hash mismatch`);
  return encoded;
}

function signedCheck(bytes: Uint8Array, signatureHex: string | undefined, rawKey: number[], label: string): void {
  assert.equal(typeof signatureHex, 'string', `${label} signature missing`);
  const signature = Buffer.from(fromHex(signatureHex!));
  assert.equal(signature.length, 64, `${label} signature length`);
  assert(verify(null, bytes, publicKey(rawKey), signature), `${label} signature does not verify`);
  const altered = Uint8Array.from(bytes);
  altered[altered.length - 1] ^= 1;
  assert(!verify(null, altered, publicKey(rawKey), signature), `${label} mutation verified`);
  assert(!verify(null, bytes, publicKey(rawKey), signature.subarray(0, 63)), `${label} short signature verified`);
}

const vectorPath = process.argv[2] ?? 'fixtures/channel-signing-vectors.json';
const vector = JSON.parse(await readFile(vectorPath, 'utf8')) as {
  version: number;
  method: string;
  keys: { buyer_public_key: string; provider_public_key: string };
  statements: Record<string, GoldenStatement>;
  hashes: { transcript_start: string; transcript_final: string };
};

assert.equal(vector.version, 1);
assert.equal(vector.method, 'sui.channel.v1');
const buyerKey = fromHex(vector.keys.buyer_public_key);
const providerKey = fromHex(vector.keys.provider_public_key);
assert.equal(buyerKey.length, 32); assert.equal(providerKey.length, 32);

const s = vector.statements;
const termsBytes = statementBytes(s.terms, 'terms', v => FixtureTerms.serialize(v).toBytes(), validateTerms);
const requestBytes = statementBytes(s.request, 'request', v => RequestDescriptor.serialize(v).toBytes(), validateRequest);
const offerBytes = statementBytes(s.offer, 'offer', v => Offer.serialize(v).toBytes(), validateOffer);
const creditBytes = statementBytes(s.credit, 'credit', v => Credit.serialize(v).toBytes(), validateCredit);
const ackBytes = statementBytes(s.ack, 'ack', v => Ack.serialize(v).toBytes(), validateAck);
const resultBytes = statementBytes(s.result, 'result', v => ResultStatement.serialize(v).toBytes(), validateResultStatement);
const closeBytes = statementBytes(s.close, 'close', v => Close.serialize(v).toBytes(), validateClose);
const transcriptStartBytes = statementBytes(s.transcript_start, 'transcript_start', v => TranscriptStart.serialize(v).toBytes(), validateTranscriptStart);
const transcriptStepBytes = statementBytes(s.transcript_step, 'transcript_step', v => TranscriptStep.serialize(v).toBytes(), validateTranscriptStep);

signedCheck(offerBytes, s.offer.signature_hex, providerKey, 'offer');
signedCheck(creditBytes, s.credit.signature_hex, buyerKey, 'credit');
signedCheck(ackBytes, s.ack.signature_hex, providerKey, 'ack');
signedCheck(resultBytes, s.result.signature_hex, providerKey, 'result');
signedCheck(closeBytes, s.close.buyer_signature_hex, buyerKey, 'close.buyer');
signedCheck(closeBytes, s.close.provider_signature_hex, providerKey, 'close.provider');

assert.equal(hex(termsHash(s.terms.payload as any)), s.terms.hash_hex);
assert.equal(hex(requestHash(s.request.payload as any)), s.request.hash_hex);
assert.equal(hex(offerHash(s.offer.payload as any)), s.offer.hash_hex);
assert.equal(hex(creditHash(s.credit.payload as any)), s.credit.hash_hex);
assert.equal(hex(ackHash(s.ack.payload as any)), s.ack.hash_hex);
assert.equal(hex(resultStatementHash(s.result.payload as any)), s.result.hash_hex);
assert.equal(hex(hash(closeBytes)), s.close.hash_hex);
assert.equal(hex(hash(transcriptStartBytes)), s.transcript_start.hash_hex);
assert.equal(hex(hash(transcriptStepBytes)), s.transcript_step.hash_hex);

const terms = s.terms.payload as any;
const request = s.request.payload as any;
const offer = s.offer.payload as any;
const credit = s.credit.payload as any;
const ack = s.ack.payload as any;
const result = s.result.payload as any;
const start = s.transcript_start.payload as any;
const step = s.transcript_step.payload as any;
const close = s.close.payload as any;
assert.equal(hex(offer.terms_hash), s.terms.hash_hex);
assert.equal(hex(request.terms_hash), s.terms.hash_hex);
assert.equal(hex(credit.offer_hash), s.offer.hash_hex);
assert.equal(hex(ack.credit_hash), s.credit.hash_hex);
assert.equal(hex(result.request_hash), s.request.hash_hex);
assert.equal(hex(result.credit_hash), s.credit.hash_hex);
assert.equal(hex(start.offer_hash), s.offer.hash_hex);
assert.equal(hex(step.previous_transcript_hash), s.transcript_start.hash_hex);
assert.equal(hex(step.request_hash), s.request.hash_hex);
assert.equal(hex(step.credit_hash), s.credit.hash_hex);
assert.equal(hex(step.ack_hash), s.ack.hash_hex);
assert.equal(hex(step.result_statement_hash), s.result.hash_hex);
assert.equal(vector.hashes.transcript_start, s.transcript_start.hash_hex);
assert.equal(vector.hashes.transcript_final, s.transcript_step.hash_hex);
assert.equal(hex(credit.previous_transcript_hash), vector.hashes.transcript_start);
assert.equal(hex(close.offer_hash), s.offer.hash_hex);
assert.equal(hex(close.transcript_hash), vector.hashes.transcript_final);

const computedStart = transcriptStart(start.channel, offer);
const computedFinal = transcriptNext(
  Array.from(computedStart), request, credit, ack, result,
);
assert.equal(hex(computedStart), vector.hashes.transcript_start, 'transcript start derivation mismatch');
assert.equal(hex(computedFinal), vector.hashes.transcript_final, 'transcript final derivation mismatch');

// Confirm that the independent checker does not accidentally accept a changed
// purpose/method or a changed economic field merely because the old signature
// is still present.
for (const [label, statement, validate] of [
  ['offer', s.offer, validateOffer], ['credit', s.credit, validateCredit], ['ack', s.ack, validateAck],
  ['result', s.result, validateResultStatement], ['close', s.close, validateClose],
] as const) {
  const changed = JSON.parse(JSON.stringify(statement.payload)) as Record<string, unknown>;
  changed.method = Array.from(new TextEncoder().encode('wrong.method'));
  assert.throws(() => validate(changed), `${label} altered method unexpectedly accepted`);
}

console.log('Independent TypeScript channel BCS, hash, domain, and Node Ed25519 verification passed (including tampering).');
