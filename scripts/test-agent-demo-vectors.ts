/** Checks shared synthetic vectors; this is not UI, chain or live-agent evidence. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makePolicy, price } from './streaming-codec.js';

const vectors = JSON.parse(await readFile(new URL('../tests/agent-demo/accounting-vectors.json', import.meta.url), 'utf8'));
assert.equal(vectors.version, 1);
assert.equal(vectors.notice, 'TEST FIXTURE — no live agents or payments');
for (const vector of vectors.prices) {
  const policy = makePolicy(['input_utf8_bytes', 'output_utf8_bytes'], vector.rates, vector.denominator);
  assert.equal(price(policy, vector.units), vector.expected_mist, vector.name);
}
const difference = (a: string, b: string) => (BigInt(a) > BigInt(b) ? BigInt(a) - BigInt(b) : 0n).toString();
for (const vector of vectors.accounting) {
  // Independent arithmetic oracle, not a replacement runtime or UI reducer.
  const signed = vector.signed_cumulative_observations.at(-1) ?? '0';
  const refundKnown = vector.terminal_confirmed && ['closed', 'refunded'].includes(vector.status) &&
    vector.locked_mist === '0' && vector.redeemed_mist !== null;
  const result = {
    signed_authorized_mist: signed,
    outstanding_mist: refundKnown ? '0' : difference(signed, vector.delivered_mist),
    reserved_exposure_mist: refundKnown ? '0' : difference(vector.reserved_mist, vector.delivered_mist),
    refunded_mist: refundKnown ? (BigInt(vector.deposit_mist) - BigInt(vector.redeemed_mist)).toString() : null,
    redeemed_above_delivery: vector.redeemed_mist === null ? null : BigInt(vector.redeemed_mist) > BigInt(vector.delivered_mist),
  };
  assert.deepEqual(result, vector.expected, vector.name);
}
const decoder = new TextDecoder('utf-8', { fatal: true });
const seen = new Map<string, number[]>();
let text = '', outputBytes = 0n;
for (const frame of vectors.utf8_delivery.frames) {
  const prior = seen.get(frame.sequence);
  if (prior) { assert.deepEqual(frame.output, prior); continue; }
  seen.set(frame.sequence, frame.output);
  text += decoder.decode(Uint8Array.from(frame.output), { stream: true });
  outputBytes += BigInt(frame.output.length);
}
text += decoder.decode();
assert.equal(text, vectors.utf8_delivery.expected_text);
assert.equal(outputBytes.toString(), vectors.utf8_delivery.expected_output_bytes);
const sources = new Map<string, string>();
for (const record of vectors.source_identity.records) {
  const key = JSON.stringify([record.source, record.role, record.id]);
  if (sources.has(key)) assert.equal(record.value, sources.get(key));
  else sources.set(key, record.value);
}
assert.equal(sources.size, vectors.source_identity.expected_unique_records);
console.log('Shared demo vectors: exact price, cumulative ceilings, unknown chain/refund, split UTF-8 and source identity passed (fixtures only).');
