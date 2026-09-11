import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentServiceClient } from './agent-service-client.js';
import { BudgetLedger } from './agent-coordinator.js';
import { ResearchNotDispatchedError, type ResearchNotDispatchedCode } from './agent-service-types.js';
import type { AgentExchange, AgentServiceReply } from './agent-service-exchange.js';
import { utf8 as peerUtf8, type SignedEnvelope } from './native-peer.js';
import { StreamingEngine } from './streaming-engine.js';
import { checkpointHash, hash, makeAck, makeCheckpoint, makePolicy, policyHash, signStatement, type ChannelData, type CreditData, type OfferData, type SignedData } from './streaming-codec.js';
import { streamingFixture } from './test-streaming-fixtures.js';

const id = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const requestId = (n: number): string => n.toString(16).padStart(64, '0');
const isTyped = (code: ResearchNotDispatchedCode) => (error: unknown): boolean => error instanceof ResearchNotDispatchedError && error.code === code;

const limits = (deadline: string) => ({ max_total_mist: '100000', max_channel_deposit_mist: '50000', max_turn_mist: '50000',
  max_outstanding_mist: '50000', max_requests: 4, deadline_ms: deadline, output_tranche_bytes: 128 });

async function setup(root: string) {
  const fixture = await streamingFixture();
  const policy = makePolicy(['input_utf8_bytes', 'output_utf8_bytes'], ['1', '1'], '1');
  const offerPayload: OfferData = { ...fixture.offer.payload, policy_hash: policyHash(policy),
    offer_expires_ms: String(Date.now() + 300_000), work_deadline_ms: String(Date.now() + 600_000), claim_deadline_ms: String(Date.now() + 1_200_000) };
  const offer = await signStatement('offer', offerPayload, fixture.provider);
  const binding = { offer, policy, channel: fixture.channel };
  const agent = (agent: string) => ({ network: offerPayload.network, package_id: offerPayload.package_id, domain: offerPayload.deployment, agent });
  const buyer = agent(offerPayload.buyer), provider = agent(offerPayload.provider);
  let channel: ChannelData = { id: fixture.channel, offer: offerPayload, policy, funds: offerPayload.deposit, redeemed_amount: '0',
    redeemed_sequence: '0', redeemed_units: ['0', '0'], status: 0, terminal_tx: [], close_hash: Array(32).fill(0) };
  const budget = await BudgetLedger.open({ stateDir: join(root, 'budget'), create: true, limits: limits(offerPayload.work_deadline_ms), buyer, provider });
  await budget.reserveFunding(Buffer.from(offerPayload.opening_nonce).toString('hex'), offerPayload.deposit);
  await budget.bindChannel({ channel: fixture.channel, opening_nonce: Buffer.from(offerPayload.opening_nonce).toString('hex'), deposit: offerPayload.deposit, policy });
  const engine = await StreamingEngine.open(join(root, 'buyer.json'), 'buyer', binding, fixture.buyer);
  return { fixture, offer, offerPayload, policy, binding, buyer, provider, budget, engine, channel: () => structuredClone(channel), setChannel: (next: ChannelData) => { channel = next; } };
}

function envelope(body: Record<string, unknown>): SignedEnvelope {
  const message = { purpose: peerUtf8('m2m/core/message/v1'), sender: { network: [116], package_id: id(3), domain: id(4), agent: id(6) },
    recipient: { network: [116], package_id: id(3), domain: id(4), agent: id(5) }, generation: '0', id: Array(32).fill(7), correlation: null,
    created_ms: String(Date.now()), expires_ms: String(Date.now() + 30_000), kind: 'message.receipt', payload: Array.from(Buffer.from(JSON.stringify({ session: Array(32).fill(0), message_id: Array(32).fill(0), commitment: Array(32).fill(0), state: 'completed', result: Array.from(Buffer.from(JSON.stringify(body))) }))) };
  // Runtime client tests do not reopen terminal proof records; the durable
  // exchange owns signature verification.  Keep the envelope shape explicit.
  return { message, signature: Array(64).fill(0) } as SignedEnvelope;
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'm2m-client-cancellation-'));
  let budget: BudgetLedger | undefined;
  try {
    const fixture = await setup(root); ({ budget } = fixture);
    let op = 0; let currentRequest: any; let currentCredit: SignedData<CreditData> | undefined; let spoof = false; let pollDelivered = false;
    let deliveredUnits: [string, string] = ['0', '0']; let lastCheckpointHash = Array(32).fill(0);
    const commands: Record<string, unknown>[] = [];
    const exchange: AgentExchange = {
      remaining: () => 512,
      call: async command => {
        commands.push(structuredClone(command));
        const bodyBase = { version: 2, op_id: requestId(++op) };
        if (command.op === 'credit') {
          currentRequest = command.request; currentCredit = command.credit as SignedData<CreditData>; pollDelivered = false;
          if (spoof) throw Error('budget_rejected');
          const ack = await signStatement('ack', makeAck(fixture.offerPayload, currentCredit.payload), fixture.fixture.provider);
          return { body: { ...bodyBase, type: 'ack', ack }, envelope: envelope({ ...bodyBase, type: 'ack', ack }) };
        }
        if (command.op === 'start') {
          const body = { ...bodyBase, type: 'started', request_hash: command.request_hash };
          return { body, envelope: envelope(body) };
        }
        if (command.op === 'poll') {
          assert(currentRequest && currentCredit);
          if (!pollDelivered) {
            const units: [string, string] = [String(BigInt(deliveredUnits[0]) + BigInt(Buffer.byteLength(currentRequest.prompt))), deliveredUnits[1]];
            const checkpoint = await signStatement('checkpoint', makeCheckpoint(fixture.offerPayload, currentCredit.payload, fixture.policy, units, hash([]), false), fixture.fixture.provider);
            deliveredUnits = units; lastCheckpointHash = checkpointHash(checkpoint.payload); pollDelivered = true;
            return { body: { ...bodyBase, type: 'delivery', checkpoint, output: [] }, envelope: envelope({ ...bodyBase, type: 'delivery', checkpoint, output: [] }) };
          }
          const receipt = { version: 2, conversation: currentRequest.conversation, request: currentRequest.request, request_hash: currentCredit.payload.request_hash,
            sequence: currentRequest.sequence, outcome: 'completed', reason: null, checkpoint_hash: lastCheckpointHash, delivered_units: deliveredUnits,
            generated_output: '0', discarded_output: '0', continuation: 'ready', citations: [] };
          return { body: { ...bodyBase, type: 'turn_terminal', receipt }, envelope: envelope({ ...bodyBase, type: 'turn_terminal', receipt }) };
        }
        throw Error(`unexpected_${String(command.op)}`);
      },
    };

    let holdReserve = false; let releaseReserve!: () => void; let reservePersisted!: () => void;
    const reserveReady = new Promise<void>(resolve => { reservePersisted = resolve; });
    const reserveGate = new Promise<void>(resolve => { releaseReserve = resolve; });
    const realReserve = budget.reserveCredit.bind(budget);
    const heldBudget = new Proxy(budget, {
      get(target, property) {
        if (property === 'reserveCredit') return async (input: Parameters<BudgetLedger['reserveCredit']>[0]) => {
          await realReserve(input); reservePersisted();
          if (holdReserve) { holdReserve = false; await reserveGate; }
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as BudgetLedger;
    const options = { stateDir: join(root, 'client'), create: true, conversation: requestId(901), engine: fixture.engine,
      budget: heldBudget, exchange, observeChannel: async () => ({ channel: fixture.channel(), now_ms: String(Date.now()) }),
      settle: async () => ({ channel: fixture.channel(), digest: 'fixture' }), pollMs: 1 };
    let client = await AgentServiceClient.open(options);

    // A cancellation before execute creates a durable local tombstone, even
    // though no client request record or engine credit exists yet.
    const preCancel = requestId(1);
    await assert.rejects(() => client.cancel(preCancel), isTyped('cancelled_before_dispatch'));
    assert.equal(commands.length, 0); assert.equal(fixture.engine.replay().length, 0);
    client = await AgentServiceClient.open({ ...options, create: false });
    await assert.rejects(() => client.execute({ requestId: preCancel, prompt: 'must remain rejected' }), isTyped('cancelled_before_dispatch'));
    assert.equal(commands.length, 0); assert.equal(fixture.engine.replay().length, 0);

    // Hold the real durable reserve after its save completes. Cancellation can
    // win in this await window, retaining the reservation but preventing both
    // credit intent creation and engine signing.
    holdReserve = true;
    const longPrompt = 'long prompt establishes the reserved input ceiling';
    const raceId = requestId(2);
    const executing = client.execute({ requestId: raceId, prompt: longPrompt });
    await Promise.race([reserveReady, new Promise<never>((_, reject) => setTimeout(() => reject(Error('reserve_race_timeout')), 5000))]);
    const reserved = fixture.budget.reservedUnits();
    assert.deepEqual(reserved, [String(Buffer.byteLength(longPrompt)), '128']);
    await assert.rejects(() => client.cancel(raceId), isTyped('cancelled_before_dispatch'));
    releaseReserve();
    await assert.rejects(() => executing, isTyped('cancelled_before_dispatch'));
    assert.equal(commands.length, 0); assert.equal(fixture.engine.replay().length, 0);
    assert.deepEqual(fixture.budget.reservedUnits(), reserved);
    assert.equal(fixture.budget.snapshot().requests_remaining, 3);

    // A shorter next prompt carries the retained input/output ceilings.  The
    // first actual credit starts at sequence one: the rejected attempt caused
    // no channel sequence gap.
    const nextId = requestId(3);
    const next = await client.execute({ requestId: nextId, prompt: 'x' });
    assert.equal(next.receipt.outcome, 'completed');
    const credits = commands.filter(command => command.op === 'credit') as Array<{ credit: SignedData<CreditData> }>;
    assert.equal(credits.length, 1); assert.equal(credits[0].credit.payload.sequence, '1');
    assert.deepEqual(credits[0].credit.payload.units, reserved);
    await fixture.budget.completeRequest(nextId);

    // A peer/plain transport error containing a reserved code is not host
    // proof. The signed credit remains uncertain and all prior liability/count
    // state remains durable; it must not become a typed local rejection.
    spoof = true;
    const spoofId = requestId(4);
    await assert.rejects(() => client.execute({ requestId: spoofId, prompt: 'a prompt long enough to raise the input ceiling' }), error => !(error instanceof ResearchNotDispatchedError) && (error as Error).message === 'budget_rejected');
    assert.equal(fixture.budget.snapshot().uncertain, true);
    assert.equal(fixture.budget.snapshot().requests_remaining, 1);
    assert.deepEqual(fixture.budget.reservedUnits(), ['50', '128']);
    const journal = JSON.parse(await readFile(join(root, 'client', 'client.json'), 'utf8'));
    assert.equal(journal.rejections[preCancel], 'cancelled_before_dispatch');
    assert.equal(journal.rejections[raceId], 'cancelled_before_dispatch');
    assert.equal(journal.rejections[spoofId], undefined);
    assert.equal(fixture.engine.replay().at(-1)?.credit.payload.sequence, '2');
    console.log('agent client cancellation tests: ok');
  } finally {
    await budget?.close();
    await rm(root, { recursive: true, force: true });
  }
}

await main();
