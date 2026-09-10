import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { ObjectError } from '@mysten/sui/client';
import { normalizeSuiAddress, toBase58 } from '@mysten/sui/utils';
import { readFile, mkdir, open, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, Clock, Domain, Escrow, type QuoteData } from './codec.js';

export interface ChainConfig {
  rpc_url: string;
  network: 'localnet' | 'testnet';
  chain_id: string;
  package_id: string;
  deployment: string;
}

// Files containing keys, signatures, and transaction attempts are private and
// replaced atomically. fsync both the file and directory before acknowledging.
export async function save(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  const f = await open(tmp, 'wx', 0o600);
  try { await f.writeFile(JSON.stringify(value, null, 2)); await f.sync(); }
  finally { await f.close(); }
  await rename(tmp, path);
  const d = await open(dirname(path), 'r');
  try { await d.sync(); } finally { await d.close(); }
}

export async function key(path: string): Promise<Ed25519Keypair> {
  const value = JSON.parse(await readFile(path, 'utf8')) as { secret_key: string };
  return Ed25519Keypair.fromSecretKey(value.secret_key);
}

export class Chain {
  readonly client: SuiGrpcClient;
  constructor(readonly config: ChainConfig) {
    if (!['localnet', 'testnet'].includes(config.network)) throw new Error('Only localnet/testnet are supported');
    this.client = new SuiGrpcClient({ baseUrl: config.rpc_url, network: config.network });
  }
  async validate() {
    const { chainIdentifier } = await this.client.core.getChainIdentifier();
    if (chainIdentifier !== this.config.chain_id) throw new Error('RPC chain identifier mismatch');
    const { response: info } = await this.client.ledgerService.getServiceInfo({});
    if (info.chain === 'mainnet') throw new Error('Mainnet is outside this PoC');
    if (this.config.network === 'testnet' && info.chain !== 'testnet') throw new Error('Expected Sui testnet');
    const domain = await this.domain();
    if (new TextDecoder().decode(Uint8Array.from(domain.network)) !== chainIdentifier ||
        domain.package_id !== normalizeSuiAddress(this.config.package_id)) throw new Error('Deployment domain mismatch');
  }
  async object(id: string, name: string) {
    const { object } = await this.client.getObject({ objectId: id, include: { content: true } });
    if (object.type !== `${normalizeSuiAddress(this.config.package_id)}::exchange::${name}`) {
      throw new Error(`Unexpected object type for ${id}: ${object.type}`);
    }
    return object.content;
  }
  async domain() { return Domain.parse(await this.object(this.config.deployment, 'Domain')); }
  async agent(id: string) {
    const agent = Agent.parse(await this.object(id, 'Agent'));
    if (agent.deployment !== normalizeSuiAddress(this.config.deployment)) throw new Error('Agent deployment mismatch');
    return agent;
  }
  async escrow(id: string) {
    const escrow = Escrow.parse(await this.object(id, 'Escrow'));
    if (escrow.quote.deployment !== normalizeSuiAddress(this.config.deployment)) throw new Error('Escrow deployment mismatch');
    return { ...escrow, terminal_digest: escrow.terminal_tx.length ? toBase58(Uint8Array.from(escrow.terminal_tx)) : null };
  }
  async clock() {
    const { object } = await this.client.getObject({ objectId: '0x6', include: { content: true } });
    return Clock.parse(object.content).timestamp_ms;
  }
  async lookup(buyer: string, nonce: string): Promise<string | null> {
    const a = await this.agent(buyer);
    try {
      const { dynamicField } = await this.client.getDynamicField({
        parentId: a.jobs.id, name: { type: 'u64', bcs: bcs.u64().serialize(nonce).toBytes() },
      });
      return bcs.Address.parse(dynamicField.value.bcs);
    } catch (error) {
      // Only a proven absent field means not-funded. RPC errors remain errors.
      if (error instanceof ObjectError && error.code === 'notExists') return null;
      throw error;
    }
  }
  call(tx: Transaction, method: string, args: Parameters<Transaction['moveCall']>[0]['arguments']) {
    return tx.moveCall({ target: `${this.config.package_id}::exchange::${method}`, arguments: args });
  }
  async execute(tx: Transaction, signer: Ed25519Keypair, journal?: string) {
    tx.setSender(signer.toSuiAddress());
    tx.setGasBudgetIfNotSet(50_000_000);
    const bytes = await tx.build({ client: this.client });
    const signed = await signer.signTransaction(bytes);
    const digest = await tx.getDigest({ client: this.client });
    if (journal) await save(journal, { digest, bytes: signed.bytes, signature: signed.signature, state: 'submitted_or_pending' });
    const result = await this.client.executeTransaction({
      transaction: bytes, signatures: [signed.signature],
      include: { effects: true, objectTypes: true, balanceChanges: true },
    });
    if (result.$kind === 'FailedTransaction') throw new Error(JSON.stringify(result.FailedTransaction.status.error));
    await this.client.waitForTransaction({ digest: result.Transaction.digest });
    const data = {
      digest: result.Transaction.digest,
      gas: result.Transaction.effects.gasUsed,
      created: result.Transaction.effects.changedObjects.filter(o => o.idOperation === 'Created').map(o => ({
        id: o.objectId, type: result.Transaction.objectTypes[o.objectId],
      })),
      balances: result.Transaction.balanceChanges,
    };
    if (journal) await save(journal, { ...data, state: 'confirmed' });
    return data;
  }
  async register(endpoint: number[], signer: Ed25519Keypair, journal?: string) {
    const tx = new Transaction();
    this.call(tx, 'register', [tx.object(this.config.deployment), tx.pure.vector('u8', endpoint)]);
    const result = await this.execute(tx, signer, journal);
    const id = result.created.find(o => o.type?.endsWith('::exchange::Agent'))?.id;
    if (!id) throw new Error('Registration did not return Agent');
    return { ...result, agent: id };
  }
  async fund(q: QuoteData, signature: number[], signer: Ed25519Keypair, journal?: string) {
    const tx = new Transaction();
    const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(q.amount)]);
    this.call(tx, 'fund', [
      tx.object(this.config.deployment), tx.object(q.buyer), tx.object(q.provider), payment,
      tx.pure.u64(q.nonce), tx.pure.vector('u8', q.request_hash), tx.pure.vector('u8', q.result_hash),
      tx.pure.u64(q.amount), tx.pure.u64(q.quote_expires_ms), tx.pure.u64(q.deadline_ms),
      tx.pure.vector('u8', signature), tx.object('0x6'),
    ]);
    const result = await this.execute(tx, signer, journal);
    const escrow = await this.lookup(q.buyer, q.nonce);
    if (!escrow) throw new Error('Funded transaction missing nonce mapping');
    return { ...result, escrow };
  }
  async settle(id: string, resultHash: number[], signature: number[], signer: Ed25519Keypair, journal?: string) {
    const tx = new Transaction();
    this.call(tx, 'settle', [tx.object(id), tx.pure.vector('u8', resultHash), tx.pure.vector('u8', signature), tx.object('0x6')]);
    return this.execute(tx, signer, journal);
  }
  async refund(id: string, signer: Ed25519Keypair, journal?: string) {
    const tx = new Transaction();
    this.call(tx, 'refund', [tx.object(id), tx.object('0x6')]);
    return this.execute(tx, signer, journal);
  }
  async rotate(id: string, endpoint: number[], signer: Ed25519Keypair, journal?: string) {
    const tx = new Transaction();
    this.call(tx, 'replace_endpoint', [tx.object(id), tx.pure.vector('u8', endpoint)]);
    return this.execute(tx, signer, journal);
  }
}

async function bridge() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 2_000_000) throw new Error('Bridge input too large');
  }
  const arg = JSON.parse(input);
  const chain = new Chain(arg.config);
  await chain.validate();
  let result: unknown;
  switch (arg.action) {
    case 'agent': result = await chain.agent(arg.id); break;
    case 'escrow': result = await chain.escrow(arg.id); break;
    case 'clock': result = { timestamp_ms: await chain.clock() }; break;
    case 'lookup': result = { escrow: await chain.lookup(arg.buyer, arg.nonce) }; break;
    case 'register': result = await chain.register(arg.endpoint, await key(arg.signer_file), arg.journal); break;
    case 'fund': result = await chain.fund(arg.quote, arg.signature, await key(arg.signer_file), arg.journal); break;
    case 'settle': result = await chain.settle(arg.id, arg.result_hash, arg.signature, await key(arg.signer_file), arg.journal); break;
    case 'refund': result = await chain.refund(arg.id, await key(arg.signer_file), arg.journal); break;
    case 'rotate': result = await chain.rotate(arg.id, arg.endpoint, await key(arg.signer_file), arg.journal); break;
    default: throw new Error(`Unknown bridge operation: ${arg.action}`);
  }
  process.stdout.write(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bridge().catch(error => { console.error(error.message); process.exitCode = 1; });
}
