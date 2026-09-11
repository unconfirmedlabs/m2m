/** Real native signatures and inbox; transport is explicitly an in-memory fixture. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { DurableAgentExchange } from './agent-service-exchange.js';
import { Envelope, NativeInbox, NativePeer, strictJson, utf8, type RawTransport } from './native-peer.js';
import { save, type AgentRef, type Authorization } from './native-chain.js';

const dir = await mkdtemp(join(tmpdir(), 'm2m-agent-exchange-'));
const address = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const buyer: AgentRef = { network: utf8('fixture'), package_id: address(1), domain: address(2), agent: address(3) };
const provider: AgentRef = { ...buyer, agent: address(4) };
const buyerKey = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(90));
const providerKey = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(91));
const economics = [92, 93].map(n => Array.from(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(n)).getPublicKey().toRawBytes()));
const resolve = async (ref: AgentRef): Promise<Authorization> => {
  const isBuyer = ref.agent === buyer.agent, now = Date.now();
  return { agent: ref, controller: address(isBuyer ? 5 : 6), generation: '0',
    transport_key: Array.from((isBuyer ? buyerKey : providerKey).getPublicKey().toRawBytes()), economic_key: economics[isBuyer ? 0 : 1],
    read_at_ms: String(now), valid_until_ms: String(now + 30000) };
};
class MemoryWire implements RawTransport {
  remoteKey: number[]; counterpart!: MemoryWire; ended = false; failNextReceipt = false;
  queue: number[][] = []; wake?: () => void;
  constructor(remote: number[]) { this.remoteKey = remote; }
  async send(bytes: number[]) { this.counterpart.queue.push(bytes); this.counterpart.wake?.(); }
  async receive() {
    while (!this.queue.length) { if (this.ended) throw Error('transport_closed'); await new Promise<void>(resolve => { this.wake = resolve; }); }
    const bytes = this.queue.shift()!;
    if (this.failNextReceipt && strictJson(bytes).message.kind === 'message.receipt') { this.failNextReceipt = false; throw Error('injected_lost_response'); }
    return bytes;
  }
  close() { this.ended = true; this.wake?.(); }
}
let dispatches = 0;
const commands: any[] = [];
async function pair(inbox: NativeInbox) {
  const a = new MemoryWire(Array.from(providerKey.getPublicKey().toRawBytes()));
  const b = new MemoryWire(Array.from(buyerKey.getPublicKey().toRawBytes())); a.counterpart = b; b.counterpart = a;
  const features = { required: ['payment.sui.streaming.v1', 'service.research.conversation.v2'], optional: [] };
  const client = new NativePeer(buyer, buyerKey, provider, resolve, a, features);
  const server = new NativePeer(provider, providerKey, buyer, resolve, b, features);
  // Model a durable application's op_id dedupe, not a second execution on new core IDs.
  const serving = server.accept().then(() => server.serve(inbox, async (_kind, body) => {
    const command = strictJson(body.content); commands.push(command);
    if (!commands.slice(0, -1).some(c => c.op_id === command.op_id)) dispatches++;
    return utf8(JSON.stringify({ version: 2, op_id: command.op_id, type: 'status', status: { phase: 'running' } }));
  })).catch(error => { if (error.message !== 'transport_closed') throw error; });
  await client.connect();
  return { client, a, close: async () => { a.close(); b.close(); await serving; } };
}

const conversation = 'a1'.repeat(32), command = { op: 'status', request_hash: Array(32).fill(1) };
let inbox = await NativeInbox.open(join(dir, 'inbox')), connection = await pair(inbox);
try {
  let exchange = await DurableAgentExchange.open({ stateDir: dir, create: true, conversation, peer: connection.client });
  connection.a.failNextReceipt = true;
  await assert.rejects(exchange.call(command, 'request-status'), /injected_lost_response/);
  await connection.close(); await inbox.close();
  const file = join(dir, 'outbox.json'), journal = JSON.parse(await readFile(file, 'utf8'));
  const op = journal.operations[0], firstId = op.signed.message.id;
  op.signed.message.created_ms = String(Date.now() - 60000); op.signed.message.expires_ms = String(Date.now() - 30000);
  op.signed.signature = Array.from(await buyerKey.sign(Envelope.serialize(op.signed.message).toBytes()));
  await save(file, journal); // Deliberately expired, correctly signed test evidence.
  inbox = await NativeInbox.open(join(dir, 'inbox')); connection = await pair(inbox);
  exchange = await DurableAgentExchange.open({ stateDir: dir, create: false, conversation, peer: connection.client });
  const reply = await exchange.recover(); assert.equal(reply!.body.type, 'status');
  const recovered = JSON.parse(await readFile(file, 'utf8')).operations[0];
  assert.notDeepEqual(recovered.signed.message.id, firstId);
  assert.deepEqual(recovered.signed.message.correlation, firstId);
  assert.equal(recovered.command.op_id, op.command.op_id); assert.equal(dispatches, 1);
  assert.equal(recovered.response.envelope.signature.length, 64);
  assert.deepEqual(await exchange.call({ request_hash: command.request_hash, op: 'status' }, 'request-status'), reply);
  assert.equal(commands.length, 2, 'semantic duplicate must not send again');
  await assert.rejects(exchange.call({ ...command, request_hash: Array(32).fill(2) }, 'request-status'), /operation_conflict/);
  const incompatible = Object.create(connection.client) as NativePeer; incompatible.selected = ['payment.sui.streaming.v1'];
  await assert.rejects(DurableAgentExchange.open({ stateDir: dir, create: false, conversation, peer: incompatible }), /unsupported_service/);
  console.log('PASS agent exchange: real native signatures, retained proof, expired core retry with stable op ID, pending restart and semantic dedupe (memory transport fixture)');
} finally { await connection.close(); await inbox.close(); }
