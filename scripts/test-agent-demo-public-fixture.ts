/** Independent coherence oracle for test inputs, not live UI/backend evidence. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicSessionFixture } from '../tests/agent-demo/public-session.js';
import { BudgetLedger } from './agent-coordinator.js';
import { checkpointHash, hash, policyHash, price, validateSigned } from './streaming-codec.js';
import type { CheckpointData, CreditData, SignedData } from './streaming-codec.js';

if (process.argv.length > 2) throw Error('fixture_test_takes_no_arguments');
const fixture = createPublicSessionFixture();
const { snapshot, events, pins, receipt } = fixture;
const economy = snapshot.channels[0], offer = economy.offer.payload;
assert.match(fixture.notice, /TEST FIXTURE/);
assert.equal(snapshot.selected_channel, economy.channel);
assert.equal(snapshot.projection_sequence, String(events.length));
assert.equal(snapshot.config.price.input_rate, '2');
assert.equal(snapshot.config.price.output_rate, '3');
assert.deepEqual(economy.policy.rates, ['2', '3']);
assert.deepEqual(offer.policy_hash, policyHash(economy.policy));
validateSigned('offer', economy.offer, offer.provider_key);
assert.equal(pins.agents.buyer.agent, offer.buyer);
assert.equal(pins.agents.provider.agent, offer.provider);
for (const identity of Object.values(snapshot.identities)) {
  assert.match(identity.agent.agent, /^0x[0-9a-f]{64}$/);
  assert.equal(identity.transport_key.length, 32);
  assert.equal(identity.economic_key.length, 32);
  assert.notDeepEqual(identity.transport_key, identity.economic_key);
  assert.deepEqual(identity.agent.network, offer.network);
  assert.equal(identity.agent.package_id, offer.package_id);
  assert.equal(identity.agent.domain, offer.deployment);
}
const ids = new Map<string, bigint>();
const decoder = new TextDecoder('utf-8', { fatal: true });
let text = '', deliveredUnits = ['0', '0'];
let deliveredPrice = '0', authorized = '0';
let lastDelivery: SignedData<CheckpointData> | undefined;
for (const [index, item] of events.entries()) {
  assert.equal(item.sequence, String(index + 1));
  const e = item.event, key = `${item.source}/${e.role}`;
  assert.equal(e.conversation, pins.conversation);
  const id = (ids.get(key) ?? 0n) + 1n;
  assert.equal(e.id, String(id)); ids.set(key, id);
  if (e.type === 'authorization') {
    assert.equal(item.source, 'coordinator'); assert.equal(e.role, 'host');
    const credit = e.data.credit as SignedData<CreditData>;
    validateSigned('credit', credit, offer.buyer_key);
    assert.equal(credit.payload.channel, economy.channel);
    assert.equal(credit.payload.cumulative_amount, price(economy.policy, credit.payload.units));
    authorized = credit.payload.cumulative_amount;
  } else if (e.type === 'delivery') {
    assert.equal(item.source, 'coordinator'); assert.equal(e.role, 'host');
    const cp = e.data.checkpoint as SignedData<CheckpointData>, bytes = e.data.output as number[];
    validateSigned('checkpoint', cp, offer.provider_key);
    assert.equal(cp.payload.final, false);
    assert.deepEqual(cp.payload.output_hash, hash(bytes));
    assert.equal(BigInt(cp.payload.units[1]) - BigInt(deliveredUnits[1]), BigInt(bytes.length));
    assert.equal(cp.payload.cumulative_amount, price(economy.policy, cp.payload.units));
    assert.ok(BigInt(cp.payload.cumulative_amount) <= BigInt(authorized));
    text += decoder.decode(Uint8Array.from(bytes), { stream: true });
    deliveredUnits = cp.payload.units; deliveredPrice = cp.payload.cumulative_amount; lastDelivery = cp;
  } else if (e.type === 'channel_final') {
    const cp = e.data.checkpoint as SignedData<CheckpointData>;
    validateSigned('checkpoint', cp, offer.provider_key);
    assert.equal(cp.payload.final, true);
    assert.deepEqual(cp.payload.units, deliveredUnits);
  }
}
text += decoder.decode();
assert.equal(text, fixture.expected.research_text);
assert.equal(deliveredPrice, fixture.expected.delivered_mist);
assert.equal(authorized, fixture.expected.signed_mist);
assert.equal(price(economy.policy, economy.delivered_units), economy.delivered_mist);
assert.deepEqual(receipt.checkpoint_hash, checkpointHash(lastDelivery!.payload));
assert.equal(receipt.generated_output, String(Buffer.byteLength(text)));
assert.equal(receipt.discarded_output, '0');
assert.equal(economy.outstanding_mist, String(BigInt(authorized) - BigInt(deliveredPrice)));
assert.equal(economy.budget.remaining_mist, '23962');
assert.equal(economy.status, 'unknown');
for (const key of ['redeemed_mist', 'locked_mist', 'refunded_mist', 'observed_at_ms', 'terminal'] as const) assert.equal(economy[key], null);
assert.deepEqual(economy.opening, { state: 'unknown', digest: null, gas: null });
assert.equal(events.some(e => e.event.type === 'chain_observation' || e.event.type === 'settlement'), false);
assert.deepEqual(createPublicSessionFixture(), fixture, 'repeatable test input generation is not investor-demo scripting');

// Compare the handwritten public budget shape with the actual durable ledger,
// not a second copy of its arithmetic. These inputs remain explicitly injected
// accounting observations, not chain RPCs or evidence of funded objects.
const root = await mkdtemp(join(tmpdir(), 'm2m-demo-public-budget-'));
let ledger: BudgetLedger | undefined;
const ledgerOptions = { stateDir: root, buyer: pins.agents.buyer, provider: pins.agents.provider, limits: pins.config.budget };
try {
  ledger = await BudgetLedger.open({ ...ledgerOptions, create: true });
  const nonce = Buffer.from(offer.opening_nonce).toString('hex');
  await ledger.reserveFunding(nonce, offer.deposit);
  await ledger.bindChannel({ channel: economy.channel, opening_nonce: nonce, deposit: offer.deposit, policy: economy.policy });
  await ledger.beginRequest(receipt.request, ['0', '0']);
  for (const item of events) {
    const e = item.event;
    if (e.type === 'authorization') {
      const credit = e.data.credit as SignedData<CreditData>;
      const reservation = { channel: economy.channel, request: receipt.request,
        ceilings: credit.payload.units as [string, string], delivered_units: ledger.currentUnits(),
        request_start_units: ['0', '0'] as [string, string] };
      await ledger.reserveCredit(reservation);
      const beforeReplay = ledger.snapshot();
      await ledger.reserveCredit(reservation);
      assert.deepEqual(ledger.snapshot(), beforeReplay);
    } else if (e.type === 'delivery') {
      const cp = e.data.checkpoint as SignedData<CheckpointData>;
      await ledger.observe({ channel: economy.channel, status: 'open', redeemed_mist: '0',
        delivered_units: cp.payload.units as [string, string], authorized_units: ledger.reservedUnits() });
    }
  }
  await ledger.completeRequest(receipt.request);
  assert.deepEqual(ledger.snapshot(), economy.budget);
  await ledger.close(); ledger = undefined;
  ledger = await BudgetLedger.open({ ...ledgerOptions, create: false });
  assert.deepEqual(ledger.snapshot(), economy.budget, 'actual budget journal reopen preserves the public fixture amounts');
} finally {
  await ledger?.close();
  await rm(root, { recursive: true, force: true });
}
console.log('PASS shared public TEST FIXTURE: pins, signatures, event cursors, UTF-8 and real budget replay/reopen; no chain/live claim');
