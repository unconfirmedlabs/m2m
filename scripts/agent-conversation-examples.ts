/** Generate checked, deterministic v2 wire examples from the real service and
 * streaming engine. This fixture uses no network, model, or chain backend. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { strictJson } from './native-peer.js';
import { ResearchConversationService, RESEARCH_CONVERSATION_FEATURE, RESEARCH_CONVERSATION_VERSION, researchRequestHash } from './research-conversation.js';
import { StreamingEngine } from './streaming-engine.js';
import { checkpointHash, makePolicy, policyHash, purpose, utf8, METHOD, signStatement, validateSigned, ZERO_HASH, type ChannelData, type OfferData } from './streaming-codec.js';
import type { AgentRef } from './native-chain.js';
import type { RequestRecord, RequestRef, WorkRequest, WorkerEvent } from './codex-worker.js';

const root = fileURLToPath(new URL('../examples/messages/research-conversation-v2/', import.meta.url));
const schema = fileURLToPath(new URL('../schemas/research-conversation-v2.schema.json', import.meta.url));
const PAYMENT_FEATURE = 'payment.sui.streaming.v1';
const FIXED_NOW = 1_900_000_000_000;
const addr = (n: number) => `0x${n.toString(16).padStart(2, '0').repeat(32)}`;
const id = (n: number) => n.toString(16).padStart(64, '0');
const byteHash = (n: number) => Array(32).fill(n);

const buyerKey = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(61));
const providerKey = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(62));
const buyer: AgentRef = { network: utf8('example-net'), package_id: addr(1), domain: addr(5), agent: addr(3) };
const provider: AgentRef = { network: utf8('example-net'), package_id: addr(1), domain: addr(5), agent: addr(4) };
const channelId = addr(9);
const policy = makePolicy(['input_utf8_bytes', 'output_utf8_bytes'], ['2', '3'], '1');
const offerData: OfferData = {
  purpose: purpose('offer'), method: utf8(METHOD), version: 1, network: utf8('example-net'), package_id: addr(1), deployment: addr(5),
  buyer: buyer.agent, provider: provider.agent, buyer_key: Array.from(buyerKey.getPublicKey().toRawBytes()), provider_key: Array.from(providerKey.getPublicKey().toRawBytes()),
  refund: addr(6), payee: addr(7), opening_nonce: byteHash(8), policy_hash: policyHash(policy), deposit: '100000',
  offer_expires_ms: String(FIXED_NOW - 1_000_000), work_deadline_ms: String(FIXED_NOW + 60_000), claim_deadline_ms: String(FIXED_NOW + 120_000),
};

class ExampleWorker {
  private record?: RequestRecord;
  calls = 0;
  constructor(private readonly text: string) {}
  status(ref: RequestRef): RequestRecord | undefined { return this.record?.requestId === ref.requestId ? structuredClone(this.record) : undefined; }
  async reconcile(ref: RequestRef): Promise<RequestRecord | undefined> { return this.status(ref); }
  async cancel(ref: RequestRef): Promise<RequestRecord | undefined> {
    if (this.record?.requestId === ref.requestId && !['completed', 'failed', 'cancelled'].includes(this.record.state)) this.record.state = 'cancelled';
    return this.status(ref);
  }
  async run(request: WorkRequest, consume?: (event: WorkerEvent) => Promise<boolean | void>): Promise<RequestRecord> {
    this.calls++;
    if (this.record) return structuredClone(this.record);
    const events: WorkerEvent[] = [
      { type: 'state', state: 'running', index: 0, observedAt: 1, requestId: request.requestId },
      { type: 'content', itemId: 'answer', delta: this.text, producedUtf8Bytes: Buffer.byteLength(this.text), index: 1, observedAt: 2, requestId: request.requestId },
      { type: 'state', state: 'completed', index: 2, observedAt: 3, requestId: request.requestId },
    ];
    this.record = { ...request, commitment: 'example', submittedInputHash: 'example', clientUserMessageId: 'example', state: 'completed',
      knownTurnIds: [], startedAt: 1, deadline: FIXED_NOW + 60_000, baselineUsage: null, upstreamUsage: null, usageObserved: false,
      producedUtf8Bytes: Buffer.byteLength(this.text), items: { answer: this.text }, events, threadId: 'example-thread', turnId: 'example-turn' };
    for (const event of events) if (consume && await consume(event) === false) break;
    return structuredClone(this.record);
  }
  close(): void {}
}

interface Scenario { commands: any[]; responses: any[]; errors: string[]; }
async function createScenario(rootDir: string, text: string, request: any): Promise<{
  service: ResearchConversationService; buyerEngine: StreamingEngine; providerEngine: StreamingEngine; worker: ExampleWorker;
  offer: any; source: any; send: (command: any) => Promise<any>; scenario: Scenario;
}> {
  const offer = await signStatement('offer', offerData, providerKey);
  validateSigned('offer', offer, offer.payload.provider_key);
  const binding = { offer, policy, channel: channelId };
  const buyerEngine = await StreamingEngine.open(join(rootDir, 'buyer.json'), 'buyer', binding, buyerKey);
  const providerEngine = await StreamingEngine.open(join(rootDir, 'provider.json'), 'provider', binding, providerKey);
  const worker = new ExampleWorker(text);
  const source = { id: 's1', url: 'https://example.test/source', title: 'Deterministic source', retrieved_at_ms: String(FIXED_NOW), content_hash: byteHash(1) };
  const service = await ResearchConversationService.open({ stateDir: join(rootDir, 'service'), create: true, engine: providerEngine, worker,
    conversation: request.conversation, buyer, provider, observeChannel: async () => ({
      channel: { id: channelId, offer: offer.payload, policy, funds: offer.payload.deposit, redeemed_amount: '0', redeemed_sequence: '0', redeemed_units: ['0', '0'], status: 0, terminal_tx: [], close_hash: ZERO_HASH } as ChannelData,
      now_ms: String(FIXED_NOW - 2_000_000),
    }), sources: () => [source] });
  const scenario: Scenario = { commands: [], responses: [], errors: [] };
  const send = async (command: any) => {
    scenario.commands.push(structuredClone(command));
    if (command.op === 'credit') validateSigned('credit', command.credit, offer.payload.buyer_key);
    const response = JSON.parse(Buffer.from(await service.command(Array.from(Buffer.from(JSON.stringify(command))))).toString('utf8'));
    scenario.responses.push(structuredClone(response));
    if (response.type === 'error') scenario.errors.push(response.code);
    if (response.type === 'delivery') { validateSigned('checkpoint', response.checkpoint, offer.payload.provider_key); await buyerEngine.receiveCheckpoint(response.checkpoint, Uint8Array.from(response.output)); }
    if (response.type === 'ack') validateSigned('ack', response.ack, offer.payload.provider_key);
    if (response.type === 'channel_final') validateSigned('checkpoint', response.checkpoint, offer.payload.provider_key);
    return response;
  };
  return { service, buyerEngine, providerEngine, worker, offer, source, send, scenario };
}

async function runMainScenario(base: string): Promise<{ scenario: Scenario; offerCommand: any; offerResponse: any; fundedCommand: any; fundedResponse: any; hashVector: any }> {
  const conversation = '11'.repeat(32);
  const request = { version: 2 as const, conversation, request: '22'.repeat(32), sequence: '1', prompt: 'Compare the supplied sources.' };
  const h = researchRequestHash(channelId, request);
  const setup = await createScenario(join(base, 'main'), 'Sources [s1]', request);
  const send = setup.send;
  const credit = await setup.buyerEngine.authorize('1', h, ['29', '64']);
  const ack = await send({ version: 2, op_id: id(1), op: 'credit', request, credit }); await setup.buyerEngine.receiveAck(ack.ack);
  await send({ version: 2, op_id: id(2), op: 'start', request_hash: h });
  await send({ version: 2, op_id: id(3), op: 'status', request_hash: h });
  const input = await send({ version: 2, op_id: id(4), op: 'poll', request_hash: h, after_checkpoint: ZERO_HASH });
  await send({ version: 2, op_id: id(5), op: 'poll', request_hash: h, after_checkpoint: byteHash(77) });
  const output = await send({ version: 2, op_id: id(6), op: 'poll', request_hash: h, after_checkpoint: checkpointHash(input.checkpoint.payload) });
  assert.equal(output.type, 'delivery');
  const terminal = await send({ version: 2, op_id: id(7), op: 'finish', request_hash: h, discard_unpaid: false });
  assert.equal(terminal.type, 'turn_terminal');
  const second = { version: 2 as const, conversation, request: '33'.repeat(32), sequence: '2', prompt: 'Follow up.' };
  const h2 = researchRequestHash(channelId, second);
  await setup.buyerEngine.completeRequest('1');
  const credit2 = await setup.buyerEngine.authorize('2', h2, ['39', '80']);
  const ack2 = await send({ version: 2, op_id: id(8), op: 'credit', request: second, credit: credit2 }); await setup.buyerEngine.receiveAck(ack2.ack);
  await send({ version: 2, op_id: id(9), op: 'cancel', request_hash: h2 });
  const terminal2 = await send({ version: 2, op_id: id(10), op: 'finish', request_hash: h2, discard_unpaid: false });
  assert.equal(terminal2.receipt.continuation, 'requires_channel_close');
  const final = await send({ version: 2, op_id: id(11), op: 'close', conversation, last_request_hash: h2 });
  assert.equal(final.type, 'channel_final');
  await setup.service.close();
  const offerCommand = { version: 2, op_id: id(13), op: 'offer', conversation, nonce: setup.offer.payload.opening_nonce, previous_channel: null };
  const offerResponse = { version: 2, op_id: id(13), type: 'offer', offer: setup.offer, policy, service: RESEARCH_CONVERSATION_FEATURE };
  const fundedCommand = { version: 2, op_id: id(12), op: 'funded', conversation, channel: channelId };
  const fundedResponse = { version: 2, op_id: id(12), type: 'funded', channel: channelId };
  return { scenario: setup.scenario, offerCommand, offerResponse, fundedCommand, fundedResponse, hashVector: { channel: channelId, request, hash: h } };
}

async function runExhaustionScenario(base: string): Promise<Scenario> {
  const conversation = '44'.repeat(32);
  const request = { version: 2 as const, conversation, request: '55'.repeat(32), sequence: '1', prompt: 'x' };
  const h = researchRequestHash(channelId, request);
  const setup = await createScenario(join(base, 'exhausted'), 'abcdefghij'.repeat(4), request);
  const credit = await setup.buyerEngine.authorize('1', h, ['1', '20']);
  const ack = await setup.send({ version: 2, op_id: id(20), op: 'credit', request, credit }); await setup.buyerEngine.receiveAck(ack.ack);
  await setup.send({ version: 2, op_id: id(21), op: 'start', request_hash: h });
  const input = await setup.send({ version: 2, op_id: id(22), op: 'poll', request_hash: h, after_checkpoint: ZERO_HASH });
  const firstOutput = await setup.send({ version: 2, op_id: id(23), op: 'poll', request_hash: h, after_checkpoint: checkpointHash(input.checkpoint.payload) });
  const renewal = await setup.buyerEngine.authorize('1', h, ['1', '32']);
  const renewedAck = await setup.send({ version: 2, op_id: id(24), op: 'credit', request, credit: renewal }); await setup.buyerEngine.receiveAck(renewedAck.ack);
  await setup.send({ version: 2, op_id: id(25), op: 'poll', request_hash: h, after_checkpoint: checkpointHash(firstOutput.checkpoint.payload) });
  await setup.send({ version: 2, op_id: id(26), op: 'finish', request_hash: h, discard_unpaid: false });
  const discarded = await setup.send({ version: 2, op_id: id(27), op: 'finish', request_hash: h, discard_unpaid: true });
  assert.equal(discarded.type, 'turn_terminal');
  await setup.service.close();
  return setup.scenario;
}

async function generate(): Promise<Record<string, unknown>> {
  const temporary = await mkdtemp(join(tmpdir(), 'm2m-research-v2-examples-'));
  const main = await runMainScenario(temporary);
  const exhausted = await runExhaustionScenario(temporary);
  return {
    version: RESEARCH_CONVERSATION_VERSION, feature: RESEARCH_CONVERSATION_FEATURE,
    selected_features: [PAYMENT_FEATURE, RESEARCH_CONVERSATION_FEATURE],
    economic_commands: [main.offerCommand, main.fundedCommand], economic_responses: [main.offerResponse, main.fundedResponse],
    hash_vector: main.hashVector, commands: [...main.scenario.commands, ...exhausted.commands], responses: [...main.scenario.responses, ...exhausted.responses],
    branches: ['two-turn lifecycle', 'pre-start cancellation', 'terminal-but-draining', 'output exhaustion', 'explicit unpaid discard', 'terminal channel close', 'expired cursor error'],
    errors: [...main.scenario.errors, ...exhausted.errors],
  };
}

async function schemaCheck(file: string): Promise<void> {
  const checker = `import json,sys,jsonschema\nschema=json.load(open(sys.argv[1]))\nfixture=json.load(open(sys.argv[2]))\nfor key in ('economic_commands','economic_responses','commands','responses'):\n  for value in fixture[key]: jsonschema.Draft202012Validator(schema).validate(value)\n`;
  execFileSync('python3', ['-c', checker, schema, file], { stdio: 'pipe' });
}

async function main() {
  const write = process.argv.includes('--write'); const check = process.argv.includes('--check') || !write;
  const fixture = await generate();
  const files: Record<string, string> = {
    'README.json': JSON.stringify({ version: RESEARCH_CONVERSATION_VERSION, feature: RESEARCH_CONVERSATION_FEATURE,
      generated_by: 'scripts/agent-conversation-examples.ts', validation: ['strictJson duplicate-key parser', 'real StreamingEngine signatures', 'real ResearchConversationService', 'python jsonschema Draft 2020-12'],
      notes: 'Offline deterministic fixture; no Iroh, Sui network, or model backend is claimed.' }, null, 2) + '\n',
    'hash-vector.json': JSON.stringify(fixture.hash_vector, null, 2) + '\n', 'conversation.json': JSON.stringify(fixture, null, 2) + '\n',
  };
  if (write) { await mkdir(root, { recursive: true, mode: 0o755 }); for (const [name, value] of Object.entries(files)) await writeFile(join(root, name), value, { mode: 0o644 }); }
  if (check) {
    for (const [name, value] of Object.entries(files)) { const actual = await readFile(join(root, name), 'utf8'); if (actual !== value) throw new Error(`fixture mismatch: ${name}`); strictJson(actual); }
    await schemaCheck(join(root, 'conversation.json'));
    const duplicate = `{"version":2,"op_id":"${'a'.repeat(64)}","op":"status","request_hash":[],"request_hash":[]}`;
    assert.throws(() => strictJson(duplicate), /duplicate/);
    console.log('PASS research conversation v2 examples: real signed engine/service messages, two-turn/discard/final branches, schema and duplicate validation');
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'example failure'); process.exitCode = 1; });
