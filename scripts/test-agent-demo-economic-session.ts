/** Generate/check shared signed economic test inputs through the real engine.
 * Test-only public seeds; no model, transport, RPC, funds or settlement exists.
 * --print emits the checked fixture for apply_patch; default verifies the file.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeLock } from './native-lock.js';
import { StreamingEngine } from './streaming-engine.js';
import { streamingFixture } from './test-streaming-fixtures.js';
import { researchRequestHash } from './research-conversation.js';
import {
  checkpointHash, hash, makePolicy, policyHash, price, signStatement,
  validateSigned, type AckData, type CheckpointData, type CreditData, type SignedData,
} from './streaming-codec.js';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--print')) throw Error('fixture_test_invalid_arguments');

async function generate() {
  const root = await mkdtemp(join(tmpdir(), 'm2m-demo-economic-fixture-'));
  let lock: NativeLock | undefined;
  try {
    lock = await NativeLock.acquire(join(root, '.fixture.lock'));
    const seed = await streamingFixture();
    const policy = makePolicy(['input_utf8_bytes', 'output_utf8_bytes'], ['2', '3'], '1');
    const offer = await signStatement('offer', { ...seed.offer.payload, policy_hash: policyHash(policy) }, seed.provider);
    const binding = { channel: seed.channel, offer, policy };
    let buyer = await StreamingEngine.open(join(root, 'buyer.json'), 'buyer', binding, seed.buyer);
    let provider = await StreamingEngine.open(join(root, 'provider.json'), 'provider', binding, seed.provider);
    const request = { version: 2 as const, conversation: '31'.repeat(32), request: '32'.repeat(32), sequence: '1', prompt: 'x' };
    const request_hash = researchRequestHash(binding.channel, request);
    const output = new TextEncoder().encode('Hi 🌍!');
    assert.equal(output.length, 8);
    const steps: Array<
      { kind: 'authorization'; credit: SignedData<CreditData>; ack: SignedData<AckData> } |
      { kind: 'delivery'; checkpoint: SignedData<CheckpointData>; output: number[] } |
      { kind: 'channel_final'; checkpoint: SignedData<CheckpointData> }
    > = [];

    async function authorize(ceilings: [string, string]) {
      const credit = await buyer.authorize(request.sequence, request_hash, ceilings);
      const ack = await provider.acceptCredit(credit);
      await buyer.receiveAck(ack);
      validateSigned('credit', credit, offer.payload.buyer_key);
      validateSigned('ack', ack, offer.payload.provider_key);
      steps.push({ kind: 'authorization', credit, ack });
      // A duplicate retained credit/Ack is a no-op, not a second authorization.
      assert.deepEqual(await provider.acceptCredit(credit), ack);
      await buyer.receiveAck(ack);
      return credit;
    }
    async function deliver(units: [string, string], bytes: Uint8Array) {
      const checkpoint = await provider.deliver(units, bytes);
      validateSigned('checkpoint', checkpoint, offer.payload.provider_key);
      await buyer.receiveCheckpoint(checkpoint, bytes);
      const beforeReplay = buyer.snapshot();
      await buyer.receiveCheckpoint(checkpoint, bytes);
      assert.deepEqual(buyer.snapshot(), beforeReplay);
      steps.push({ kind: 'delivery', checkpoint, output: [...bytes] });
      return checkpoint;
    }

    const firstCredit = await authorize(['1', '4']);
    await deliver(['1', '0'], new Uint8Array());
    const partial = await deliver(['1', '4'], output.slice(0, 4));
    // Byte four is the first byte of the four-byte globe. Independent complete
    // decoding must fail; a request-scoped streaming decoder retains it.
    assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(output.slice(0, 4)));
    await assert.rejects(() => provider.deliver(['1', '5'], output.slice(4, 5)), /exhausted credit/);

    // Reopen actual retained journals before authorizing the next window.
    const before = { buyer: buyer.snapshot(), provider: provider.snapshot() };
    buyer = await StreamingEngine.open(join(root, 'buyer.json'), 'buyer', binding, seed.buyer);
    provider = await StreamingEngine.open(join(root, 'provider.json'), 'provider', binding, seed.provider);
    assert.deepEqual(buyer.snapshot(), before.buyer);
    assert.deepEqual(provider.snapshot(), before.provider);
    const secondCredit = await authorize(['1', '12']);
    assert.deepEqual(secondCredit.payload.previous_checkpoint, checkpointHash(partial.payload));
    const delivered = await deliver(['1', '8'], output.slice(4));
    const final = await provider.deliver(['1', '8'], new Uint8Array(), { final: true });
    await buyer.receiveCheckpoint(final, new Uint8Array());
    steps.push({ kind: 'channel_final', checkpoint: final });
    assert.equal(buyer.snapshot().frozen, true);
    assert.equal(provider.snapshot().frozen, true);
    assert.equal(firstCredit.payload.cumulative_amount, '14');
    assert.equal(secondCredit.payload.cumulative_amount, '38');
    assert.equal(delivered.payload.cumulative_amount, '26');
    assert.equal(price(policy, delivered.payload.units), '26');

    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '', outputBytes = 0;
    for (const step of steps) {
      if (step.kind !== 'delivery') continue;
      const bytes = Uint8Array.from(step.output);
      assert.deepEqual(hash(bytes), step.checkpoint.payload.output_hash);
      text += decoder.decode(bytes, { stream: true }); outputBytes += bytes.length;
    }
    text += decoder.decode();
    assert.equal(text, 'Hi 🌍!'); assert.equal(outputBytes, 8);
    const altered = structuredClone(delivered); altered.signature[0] ^= 1;
    assert.throws(() => validateSigned('checkpoint', altered, offer.payload.provider_key), /signature/);

    return {
      version: 1,
      notice: 'TEST FIXTURE — no live agents or payments',
      generated_by: 'scripts/test-agent-demo-economic-session.ts',
      provenance: 'Actual StreamingEngine with public test-only seeds, local temporary journals and no network. Final consent is NOT chain settlement.',
      binding, request, request_hash, steps,
      expected: {
        authorized_mist: '38', delivered_units: ['1', '8'], delivered_mist: '26',
        unsettled_authorization_exposure_mist: '12', output_text: text,
        output_utf8_bytes: '8', chain_observation: null,
      },
    };
  } finally {
    await lock?.close();
    await rm(root, { recursive: true, force: true });
  }
}

const fixture = await generate();
if (args[0] === '--print') console.log(JSON.stringify(fixture, null, 2));
else {
  const existing = JSON.parse(await readFile(new URL('../tests/agent-demo/economic-session.json', import.meta.url), 'utf8'));
  assert.deepEqual(existing, fixture, 'shared signed economic session must match the real engine');
  console.log('Signed demo fixture: real credit/Ack/checkpoint checks, renewal, byte limit, reopen, replay and split UTF-8 passed; no live agents or payments.');
}
