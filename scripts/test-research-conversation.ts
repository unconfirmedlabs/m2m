import assert from 'node:assert/strict';
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { ResearchConversationService, RESEARCH_CONVERSATION_FEATURE, researchRequestHash, qualifiedAgentKey } from './research-conversation.js';
import { StreamingEngine } from './streaming-engine.js';
import { makePolicy, policyHash, purpose, utf8, METHOD, signStatement, ZERO_HASH, checkpointHash, type OfferData, type ChannelData } from './streaming-codec.js';
import type { AgentRef } from './native-chain.js';
import type { RequestRecord, RequestRef, WorkRequest, WorkerEvent } from './codex-worker.js';

const now = Date.now();
const addr = (n: number) => `0x${n.toString(16).padStart(2, '0').repeat(32)}`;
const policy = makePolicy(['input_utf8_bytes', 'output_utf8_bytes'], ['2', '3'], '1');
const buyerKey = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(41));
const providerKey = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(42));
const buyer: AgentRef = { network: utf8('localnet'), package_id: addr(1), domain: addr(5), agent: addr(3) };
const provider: AgentRef = { network: utf8('localnet'), package_id: addr(1), domain: addr(5), agent: addr(4) };
const channelId = addr(9);
const offerData: OfferData = {
  purpose: purpose('offer'), method: utf8(METHOD), version: 1, network: utf8('localnet'), package_id: addr(1), deployment: addr(5),
  buyer: buyer.agent, provider: provider.agent, buyer_key: Array.from(buyerKey.getPublicKey().toRawBytes()), provider_key: Array.from(providerKey.getPublicKey().toRawBytes()),
  refund: addr(6), payee: addr(7), opening_nonce: Array(32).fill(8), policy_hash: policyHash(policy), deposit: '100000',
  offer_expires_ms: String(now + 10_000), work_deadline_ms: String(now + 60_000), claim_deadline_ms: String(now + 120_000),
};
const channel = (offer: OfferData): ChannelData => ({ id: channelId, offer, policy, funds: '100000', redeemed_amount: '0', redeemed_sequence: '0', redeemed_units: ['0', '0'], status: 0, terminal_tx: [], close_hash: ZERO_HASH });

class DeterministicWorker {
  calls = 0;
  cancelled = false;
  record?: any;
  constructor(private readonly text: string) {}
  status(ref: RequestRef): RequestRecord | undefined { return this.record && this.record.requestId === ref.requestId ? structuredClone(this.record) : undefined; }
  async run(request: WorkRequest, consume?: (event: WorkerEvent) => Promise<boolean | void>): Promise<RequestRecord> {
    this.calls++;
    if (this.record) return structuredClone(this.record);
    const events: WorkerEvent[] = [
      { type: 'state', state: 'running', index: 0, observedAt: 1, requestId: request.requestId },
      { type: 'content', itemId: 'answer', delta: this.text, producedUtf8Bytes: Buffer.byteLength(this.text), index: 1, observedAt: 2, requestId: request.requestId },
      { type: 'state', state: 'completed', index: 2, observedAt: 3, requestId: request.requestId },
    ];
    this.record = { ...request, commitment: 'test', submittedInputHash: 'test', clientUserMessageId: 'test', state: 'completed', knownTurnIds: [], startedAt: 1, deadline: now + 60_000, baselineUsage: null, upstreamUsage: null, usageObserved: false, producedUtf8Bytes: Buffer.byteLength(this.text), items: { answer: this.text }, events, threadId: 'thread', turnId: 'turn' };
    for (const event of events) if (consume && await consume(event) === false) break;
    return structuredClone(this.record);
  }
  async reconcile(ref: RequestRef): Promise<RequestRecord | undefined> { return this.status(ref); }
  async cancel(ref: RequestRef): Promise<RequestRecord | undefined> { this.cancelled = true; if (this.record) this.record.state = 'cancelled'; return this.status(ref); }
  close(): void {}
}

async function setup(name: string, text = 'answer [s1]') {
  const root = await mkdtemp(join(tmpdir(), `m2m-research-v2-${name}-`));
  const offer = await signStatement('offer', offerData, providerKey);
  const binding = { offer, policy, channel: channelId };
  const buyerEngine = await StreamingEngine.open(join(root, 'buyer.json'), 'buyer', binding, buyerKey);
  const providerEngine = await StreamingEngine.open(join(root, 'provider.json'), 'provider', binding, providerKey);
  const worker = new DeterministicWorker(text);
  const source = { id: 's1', url: 'https://example.test/source', title: 'Fixture', retrieved_at_ms: String(now), content_hash: Array(32).fill(1) };
  const service = await ResearchConversationService.open({ stateDir: join(root, 'service'), create: true, engine: providerEngine, worker, conversation: '11'.repeat(32), buyer, provider,
    observeChannel: async () => ({ channel: channel(offerData), now_ms: String(now) }), sources: () => [source] });
  const encode = (value: unknown) => Array.from(Buffer.from(JSON.stringify(value)));
  const send = async (value: any, target: ResearchConversationService = service) => JSON.parse(Buffer.from(await target.command(encode(value))).toString('utf8'));
  return { root, offer, buyerEngine, providerEngine, worker, service, send, source, conversation: '11'.repeat(32) };
}
const op = (n: number) => n.toString(16).padStart(64, '0');
const idHash = (n: number) => Array(32).fill(n);

// Independent vector: expected bytes are reconstructed in this test, not by the
// implementation helper, to catch purpose/field/order regressions.
const request = { version: 2 as const, conversation: '11'.repeat(32), request: '22'.repeat(32), sequence: '1', prompt: 'abc' };
assert.equal(Buffer.from(researchRequestHash(channelId, request)).toString('hex'), 'f0bb3623294232a29b97daa020fd5a3a4da1d84ff81817b5dcbf8c7fface33fe');

const s = await setup('main');
const req = { version: 2 as const, conversation: s.conversation, request: '22'.repeat(32), sequence: '1', prompt: 'question' };
const reqHash = researchRequestHash(channelId, req);
const credit = await s.buyerEngine.authorize('1', reqHash, [String(Buffer.byteLength(req.prompt)), '40']);
const ack = await s.send({ version: 2, op_id: op(1), op: 'credit', request: req, credit });
assert.equal(ack.type, 'ack'); await s.buyerEngine.receiveAck(ack.ack);
assert.equal((await s.send({ version: 1, op_id: op(100), op: 'status', request_hash: reqHash })).code, 'unsupported_version');
assert.equal((await s.send({ version: 2, op_id: op(2), op: 'credit', request: req, credit })).type, 'ack');
assert.equal((await s.send({ version: 2, op_id: op(2), op: 'start', request_hash: reqHash })).code, 'operation_conflict');
assert.equal((await s.send({ version: 2, op_id: op(3), op: 'start', request_hash: reqHash })).type, 'started');
const input = await s.send({ version: 2, op_id: op(4), op: 'poll', request_hash: reqHash, after_checkpoint: ZERO_HASH });
assert.equal(input.type, 'delivery'); assert.equal(input.output.length, 0); await s.buyerEngine.receiveCheckpoint(input.checkpoint, Uint8Array.from(input.output));
assert.equal((await s.send({ version: 2, op_id: op(401), op: 'poll', request_hash: reqHash, after_checkpoint: idHash(77) })).code, 'checkpoint_cursor_mismatch');
const output = await s.send({ version: 2, op_id: op(5), op: 'poll', request_hash: reqHash, after_checkpoint: input.checkpoint.payload && (await import('./streaming-codec.js')).checkpointHash(input.checkpoint.payload) });
assert.equal(output.type, 'delivery'); await s.buyerEngine.receiveCheckpoint(output.checkpoint, Uint8Array.from(output.output));
const terminal = await s.send({ version: 2, op_id: op(6), op: 'finish', request_hash: reqHash, discard_unpaid: false });
assert.equal(terminal.type, 'turn_terminal'); assert.equal(terminal.receipt.continuation, 'ready'); assert.equal(terminal.receipt.citations[0].id, 's1');
await s.providerEngine.completeRequest('1'); await s.buyerEngine.completeRequest('1');

// A second request keeps the conversation/channel and request sequence, while
// a pre-start cancellation never dispatches or fabricates an input charge.
const req2 = { version: 2 as const, conversation: s.conversation, request: '33'.repeat(32), sequence: '2', prompt: 'follow up' };
const h2 = researchRequestHash(channelId, req2); const c2 = await s.buyerEngine.authorize('2', h2, ['17', '60']);
const a2 = await s.send({ version: 2, op_id: op(7), op: 'credit', request: req2, credit: c2 }); await s.buyerEngine.receiveAck(a2.ack);
await s.send({ version: 2, op_id: op(8), op: 'cancel', request_hash: h2 });
const t2 = await s.send({ version: 2, op_id: op(9), op: 'finish', request_hash: h2, discard_unpaid: false }); assert.equal(t2.type, 'turn_terminal'); assert.equal(t2.receipt.continuation, 'requires_channel_close');
const final = await s.send({ version: 2, op_id: op(10), op: 'close', conversation: s.conversation, last_request_hash: h2 }); assert.equal(final.type, 'channel_final'); assert.equal(final.output.length, 0); assert.equal(final.checkpoint.payload.final, true);
assert.equal(s.worker.calls, 1);

// Strict actual parser: duplicate keys are rejected before semantic dispatch.
await assert.rejects(() => s.service.command(Array.from(Buffer.from(`{"version":2,"op_id":"${op(11)}","op":"status","request_hash":${JSON.stringify(reqHash)},"request_hash":${JSON.stringify(reqHash)}}`))));
await s.service.close();

// Byte accounting deliberately crosses Unicode code-point boundaries: the
// worker text is 40 UTF-8 bytes, while renewal authorizes only 32 and the
// final eight bytes are explicitly discarded.
const exhausted = await setup('exhausted', 'αβγδ'.repeat(5));
const er = { version: 2 as const, conversation: exhausted.conversation, request: '44'.repeat(32), sequence: '1', prompt: 'x' };
const eh = researchRequestHash(channelId, er); const ec = await exhausted.buyerEngine.authorize('1', eh, ['1', '20']);
const ea = await exhausted.send({ version: 2, op_id: op(20), op: 'credit', request: er, credit: ec }); await exhausted.buyerEngine.receiveAck(ea.ack);
await exhausted.send({ version: 2, op_id: op(21), op: 'start', request_hash: eh });
const ei = await exhausted.send({ version: 2, op_id: op(22), op: 'poll', request_hash: eh, after_checkpoint: ZERO_HASH }); await exhausted.buyerEngine.receiveCheckpoint(ei.checkpoint, Uint8Array.from(ei.output));
const eo = await exhausted.send({ version: 2, op_id: op(23), op: 'poll', request_hash: eh, after_checkpoint: (await import('./streaming-codec.js')).checkpointHash(ei.checkpoint.payload) }); await exhausted.buyerEngine.receiveCheckpoint(eo.checkpoint, Uint8Array.from(eo.output));
const ec2 = await exhausted.buyerEngine.authorize('1', eh, ['1', '32']); const ea2 = await exhausted.send({ version: 2, op_id: op(230), op: 'credit', request: er, credit: ec2 }); await exhausted.buyerEngine.receiveAck(ea2.ack);
const eo2 = await exhausted.send({ version: 2, op_id: op(231), op: 'poll', request_hash: eh, after_checkpoint: (await import('./streaming-codec.js')).checkpointHash(eo.checkpoint.payload) }); await exhausted.buyerEngine.receiveCheckpoint(eo2.checkpoint, Uint8Array.from(eo2.output));
assert.equal((await exhausted.send({ version: 2, op_id: op(24), op: 'finish', request_hash: eh, discard_unpaid: false })).code, 'credit_exhausted');
const ed = await exhausted.send({ version: 2, op_id: op(25), op: 'finish', request_hash: eh, discard_unpaid: true }); assert.equal(ed.type, 'turn_terminal'); assert.equal(ed.receipt.generated_output, '40'); assert.equal(ed.receipt.discarded_output, '8');
await exhausted.service.close();

// Repeated buffered-only renewals must retain the immutable request baseline;
// each exact cursor advances once across the old and new credit records.
const repeatedRenewal = await setup('repeated-renewal', '0123456789'.repeat(4));
const rr = { version: 2 as const, conversation: repeatedRenewal.conversation, request: '99'.repeat(32), sequence: '1', prompt: 'x' };
const rrHash = researchRequestHash(channelId, rr); const rrCredit = await repeatedRenewal.buyerEngine.authorize('1', rrHash, ['1', '10']);
const rrAck = await repeatedRenewal.send({ version: 2, op_id: op(260), op: 'credit', request: rr, credit: rrCredit }); await repeatedRenewal.buyerEngine.receiveAck(rrAck.ack);
await repeatedRenewal.send({ version: 2, op_id: op(261), op: 'start', request_hash: rrHash });
const rrInput = await repeatedRenewal.send({ version: 2, op_id: op(262), op: 'poll', request_hash: rrHash, after_checkpoint: ZERO_HASH });
await repeatedRenewal.buyerEngine.receiveCheckpoint(rrInput.checkpoint, Uint8Array.from(rrInput.output));
let rrCursor = checkpointHash(rrInput.checkpoint.payload);
const rrFirstOutput = await repeatedRenewal.send({ version: 2, op_id: op(263), op: 'poll', request_hash: rrHash, after_checkpoint: rrCursor });
await repeatedRenewal.buyerEngine.receiveCheckpoint(rrFirstOutput.checkpoint, Uint8Array.from(rrFirstOutput.output));
assert.equal(rrFirstOutput.type, 'delivery'); rrCursor = checkpointHash(rrFirstOutput.checkpoint.payload);
for (const [limit, operation] of [['20', 264], ['30', 265], ['40', 266] ] as const) {
  const renewed = await repeatedRenewal.buyerEngine.authorize('1', rrHash, ['1', limit]);
  const renewedAck = await repeatedRenewal.send({ version: 2, op_id: op(operation), op: 'credit', request: rr, credit: renewed }); await repeatedRenewal.buyerEngine.receiveAck(renewedAck.ack);
  const delivered = await repeatedRenewal.send({ version: 2, op_id: op(operation + 10), op: 'poll', request_hash: rrHash, after_checkpoint: rrCursor });
  await repeatedRenewal.buyerEngine.receiveCheckpoint(delivered.checkpoint, Uint8Array.from(delivered.output));
  assert.equal(delivered.type, 'delivery'); rrCursor = checkpointHash(delivered.checkpoint.payload);
}
const rrTerminal = await repeatedRenewal.send({ version: 2, op_id: op(270), op: 'finish', request_hash: rrHash, discard_unpaid: false });
assert.equal(rrTerminal.type, 'turn_terminal'); assert.equal(rrTerminal.receipt.generated_output, '40'); assert.equal(rrTerminal.receipt.discarded_output, '0'); await repeatedRenewal.service.close();

// Provider restart fault fixtures. These mutate only the durable write-ahead
// marker after the corresponding engine fact exists, then reopen through the
// public service API and verify reconciliation/retention without rerunning a
// worker turn.
const pendingCredit = await setup('restart-credit', 'restart credit');
const pr = { version: 2 as const, conversation: pendingCredit.conversation, request: '55'.repeat(32), sequence: '1', prompt: 'credit restart' };
const prHash = researchRequestHash(channelId, pr); const prCredit = await pendingCredit.buyerEngine.authorize('1', prHash, ['14', '40']);
const prAck = await pendingCredit.send({ version: 2, op_id: op(30), op: 'credit', request: pr, credit: prCredit }); await pendingCredit.buyerEngine.receiveAck(prAck.ack);
await pendingCredit.service.close();
const pendingCreditPath = join(pendingCredit.root, 'service', 'service.json');
const pendingCreditState = JSON.parse(await readFile(pendingCreditPath, 'utf8'));
const pendingCreditRequest = pendingCreditState.requests[0];
pendingCreditRequest.credit_hash = null; pendingCreditRequest.ack = null; pendingCreditRequest.pending_credit = prCredit;
await writeFile(pendingCreditPath, JSON.stringify(pendingCreditState) + '\n');
await unlink(join(pendingCredit.root, 'service', 'initialized.json'));
pendingCredit.service = await ResearchConversationService.open({ stateDir: join(pendingCredit.root, 'service'), create: true,
  engine: pendingCredit.providerEngine, worker: pendingCredit.worker, conversation: pendingCredit.conversation, buyer, provider,
  observeChannel: async () => ({ channel: channel(pendingCredit.offer.payload), now_ms: String(now) }), sources: () => [pendingCredit.source] });
const replayCredit = await pendingCredit.send({ version: 2, op_id: op(31), op: 'credit', request: pr, credit: prCredit }, pendingCredit.service);
assert.equal(replayCredit.type, 'ack'); assert.equal(pendingCredit.worker.calls, 0); await pendingCredit.service.close();

const pendingDelivery = await setup('restart-delivery', 'restart delivery');
const dr = { version: 2 as const, conversation: pendingDelivery.conversation, request: '66'.repeat(32), sequence: '1', prompt: 'delivery restart' };
const drHash = researchRequestHash(channelId, dr); const drCredit = await pendingDelivery.buyerEngine.authorize('1', drHash, ['16', '40']);
const drAck = await pendingDelivery.send({ version: 2, op_id: op(32), op: 'credit', request: dr, credit: drCredit }); await pendingDelivery.buyerEngine.receiveAck(drAck.ack);
await pendingDelivery.send({ version: 2, op_id: op(33), op: 'start', request_hash: drHash });
const drInput = await pendingDelivery.send({ version: 2, op_id: op(34), op: 'poll', request_hash: drHash, after_checkpoint: ZERO_HASH }); await pendingDelivery.buyerEngine.receiveCheckpoint(drInput.checkpoint, Uint8Array.from(drInput.output));
const manualOutput = Buffer.from('res'); const manualCheckpoint = await pendingDelivery.providerEngine.deliver(['16', '3'], manualOutput, { final: false });
await pendingDelivery.service.close();
const pendingDeliveryPath = join(pendingDelivery.root, 'service', 'service.json');
const pendingDeliveryState = JSON.parse(await readFile(pendingDeliveryPath, 'utf8'));
pendingDeliveryState.requests[0].delivery_intent = { units: ['16', '3'], output_base64: manualOutput.toString('base64') };
await writeFile(pendingDeliveryPath, JSON.stringify(pendingDeliveryState) + '\n');
pendingDelivery.service = await ResearchConversationService.open({ stateDir: join(pendingDelivery.root, 'service'), create: false,
  engine: pendingDelivery.providerEngine, worker: pendingDelivery.worker, conversation: pendingDelivery.conversation, buyer, provider,
  observeChannel: async () => ({ channel: channel(pendingDelivery.offer.payload), now_ms: String(now) }), sources: () => [pendingDelivery.source] });
const replayDelivery = await pendingDelivery.send({ version: 2, op_id: op(35), op: 'poll', request_hash: drHash, after_checkpoint: drInput.checkpoint && checkpointHash(drInput.checkpoint.payload) }, pendingDelivery.service);
assert.equal(replayDelivery.type, 'delivery'); assert.deepEqual(replayDelivery.output, Array.from(manualOutput)); assert.equal(pendingDelivery.worker.calls, 1); await pendingDelivery.service.close();

const pendingTerminal = await setup('restart-terminal', 'terminal restart');
const tr = { version: 2 as const, conversation: pendingTerminal.conversation, request: '77'.repeat(32), sequence: '1', prompt: 'terminal restart' };
const trHash = researchRequestHash(channelId, tr); const trCredit = await pendingTerminal.buyerEngine.authorize('1', trHash, ['16', '40']);
const trAck = await pendingTerminal.send({ version: 2, op_id: op(36), op: 'credit', request: tr, credit: trCredit }); await pendingTerminal.buyerEngine.receiveAck(trAck.ack);
await pendingTerminal.send({ version: 2, op_id: op(37), op: 'start', request_hash: trHash });
const trInput = await pendingTerminal.send({ version: 2, op_id: op(38), op: 'poll', request_hash: trHash, after_checkpoint: ZERO_HASH }); await pendingTerminal.buyerEngine.receiveCheckpoint(trInput.checkpoint, Uint8Array.from(trInput.output));
const trOutput = await pendingTerminal.send({ version: 2, op_id: op(39), op: 'poll', request_hash: trHash, after_checkpoint: checkpointHash(trInput.checkpoint.payload) }); await pendingTerminal.buyerEngine.receiveCheckpoint(trOutput.checkpoint, Uint8Array.from(trOutput.output));
const trReceipt = await pendingTerminal.send({ version: 2, op_id: op(40), op: 'finish', request_hash: trHash, discard_unpaid: false }); assert.equal(trReceipt.type, 'turn_terminal');
await pendingTerminal.service.close();
pendingTerminal.service = await ResearchConversationService.open({ stateDir: join(pendingTerminal.root, 'service'), create: false,
  engine: pendingTerminal.providerEngine, worker: pendingTerminal.worker, conversation: pendingTerminal.conversation, buyer, provider,
  observeChannel: async () => ({ channel: channel(pendingTerminal.offer.payload), now_ms: String(now) }), sources: () => [pendingTerminal.source] });
const retainedTerminal = await pendingTerminal.send({ version: 2, op_id: op(41), op: 'finish', request_hash: trHash, discard_unpaid: false }, pendingTerminal.service);
assert.deepEqual(retainedTerminal.receipt, trReceipt.receipt); assert.equal(pendingTerminal.worker.calls, 1); await pendingTerminal.service.close();

// Citation validation is terminal quality evidence, not a payment rollback:
// an unknown model reference yields a failed receipt retaining paid units and
// still permits the channel's explicit final close.
const invalidCitation = await setup('invalid-citation', 'Answer [s99]');
const ir = { version: 2 as const, conversation: invalidCitation.conversation, request: '88'.repeat(32), sequence: '1', prompt: 'citation check' };
const ih = researchRequestHash(channelId, ir); const ic = await invalidCitation.buyerEngine.authorize('1', ih, ['14', '40']);
const ia = await invalidCitation.send({ version: 2, op_id: op(42), op: 'credit', request: ir, credit: ic }); await invalidCitation.buyerEngine.receiveAck(ia.ack);
await invalidCitation.send({ version: 2, op_id: op(43), op: 'start', request_hash: ih });
const ii = await invalidCitation.send({ version: 2, op_id: op(44), op: 'poll', request_hash: ih, after_checkpoint: ZERO_HASH });
const io = await invalidCitation.send({ version: 2, op_id: op(45), op: 'poll', request_hash: ih, after_checkpoint: checkpointHash(ii.checkpoint.payload) });
const it = await invalidCitation.send({ version: 2, op_id: op(46), op: 'finish', request_hash: ih, discard_unpaid: false });
assert.equal(it.type, 'turn_terminal'); assert.equal(it.receipt.outcome, 'failed'); assert.equal(it.receipt.reason, 'invalid_citation');
assert.deepEqual(it.receipt.citations, [invalidCitation.source]); assert.deepEqual(it.receipt.delivered_units, io.checkpoint.payload.units);
const iclose = await invalidCitation.send({ version: 2, op_id: op(47), op: 'close', conversation: invalidCitation.conversation, last_request_hash: ih });
assert.equal(iclose.type, 'channel_final'); await invalidCitation.service.close();
console.log('PASS research conversation v2: strict commands, independent hash, input checkpoint, replay, two-turn cancellation, close, qualified worker identity');
