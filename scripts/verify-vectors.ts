import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPublicKey, verify } from 'node:crypto';
import { Quote, Acceptance, acceptance } from './codec.js';

const v = JSON.parse(await readFile('fixtures/signing-vectors.json', 'utf8'));
const quoteBytes = Quote.serialize(v.quote).toBytes();
const acceptBytes = Acceptance.serialize(v.acceptance).toBytes();
assert.equal(Buffer.from(quoteBytes).toString('hex'), v.quote_bcs);
assert.equal(Buffer.from(acceptBytes).toString('hex'), v.acceptance_bcs);
assert.deepEqual(acceptance(v.acceptance.escrow, v.quote), v.acceptance);
function check(bytes: Uint8Array, signature: string, pk: number[]) {
  const key = createPublicKey({
    key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(pk)]),
    format:'der', type:'spki',
  });
  assert(verify(null, bytes, key, Buffer.from(signature,'hex')));
  const altered = Uint8Array.from(bytes); altered[altered.length-1] ^= 1;
  assert(!verify(null, altered, key, Buffer.from(signature,'hex')));
  assert(!verify(null, bytes, key, Buffer.from(signature,'hex').subarray(0,63)));
}
check(quoteBytes,v.quote_signature,v.quote.provider_key);
check(acceptBytes,v.acceptance_signature,v.quote.buyer_key);
console.log('Independent TypeScript BCS and Node Ed25519 verification passed (including tampering).');
