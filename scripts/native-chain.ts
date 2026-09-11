import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { ObjectError } from '@mysten/sui/client';
import { bcs } from '@mysten/sui/bcs';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { save } from './chain.js';
import { Clock, Domain } from './codec.js';
import { NativeLock } from './native-lock.js';

export const TESTNET_RPC = 'https://fullnode.testnet.sui.io:443';
export const NativeAgent = bcs.struct('Agent', {
  id: bcs.Address, deployment: bcs.Address, controller: bcs.Address,
  transport_key: bcs.vector(bcs.u8()), economic_key: bcs.vector(bcs.u8()),
  generation: bcs.u64(), expires_ms: bcs.u64(),
});
export interface AgentRef { network: number[]; package_id: string; domain: string; agent: string }
export interface Authorization {
  agent: AgentRef; controller: string; transport_key: number[]; economic_key: number[];
  generation: string; read_at_ms: string; valid_until_ms: string;
}

export interface NativeConfig {
  network: 'testnet' | 'localnet'; rpc_url: string; chain_id: string;
  package_id: string; domain: string;
}
/** Validate before creating an RPC client: even a diagnostic must not call mainnet. */
export function checkRpcScope(config: NativeConfig) {
  const url = new URL(config.rpc_url);
  if (url.username || url.password || url.search || url.hash) throw new Error('RPC credentials are not supported in configuration');
  if (config.network === 'testnet') {
    if (url.href !== new URL(TESTNET_RPC).href) throw new Error('Native testnet PoC requires the public testnet RPC');
  } else if (config.network === 'localnet') {
    if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Native localnet RPC must use loopback');
    }
  } else throw new Error('Native PoC permits only testnet/localnet');
  if (!config.chain_id || !/^[a-zA-Z0-9_-]{1,64}$/.test(config.chain_id)) throw new Error('A pinned chain identifier is required');
}
export async function readKey(path: string) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || (value.secretKey !== undefined && value.secret_key !== undefined)) throw new Error();
    const secret = value.secretKey ?? value.secret_key;
    if (Array.isArray(secret)) {
      if (secret.length !== 32 || secret.some(v => !Number.isInteger(v) || v < 0 || v > 255)) throw new Error();
      return Ed25519Keypair.fromSecretKey(Uint8Array.from(secret));
    }
    if (typeof secret !== 'string') throw new Error();
    return Ed25519Keypair.fromSecretKey(secret);
  } catch {
    // Parse/SDK errors can include key material; never forward their text.
    throw new Error('Unable to read native Ed25519 key file');
  }
}
export async function readOptional<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export class NativeChain {
  readonly client: SuiGrpcClient;
  constructor(readonly config: NativeConfig) {
    checkRpcScope(config);
    this.client = new SuiGrpcClient({network: config.network, baseUrl: config.rpc_url});
  }
  async checkNetwork() {
    const [{chainIdentifier},{response}] = await Promise.all([
      this.client.core.getChainIdentifier(), this.client.ledgerService.getServiceInfo({}),
    ]);
    if (response.chain === 'mainnet' || (this.config.network === 'testnet' && response.chain !== 'testnet')) throw new Error('RPC network is outside the authorized PoC scope');
    if (this.config.chain_id && chainIdentifier !== this.config.chain_id) throw new Error('RPC chain identifier changed');
    return chainIdentifier;
  }
  async object(id: string, module: string, name: string) {
    const {object} = await this.client.getObject({objectId:id,include:{json:true,content:true}});
    const expected = `${normalizeSuiAddress(this.config.package_id)}::${module}::${name}`;
    if (object.type !== expected) throw new Error(`Unexpected object type: expected ${expected}, got ${object.type}`);
    if (object.objectId !== normalizeSuiAddress(id)) throw new Error('RPC returned the wrong object');
    return object;
  }
  async validate() {
    await this.checkNetwork();
    const domain = Domain.parse((await this.object(this.config.domain, 'identity', 'Domain')).content);
    if (domain.id !== normalizeSuiAddress(this.config.domain) || domain.package_id !== normalizeSuiAddress(this.config.package_id) ||
        Buffer.from(domain.network).toString('utf8') !== this.config.chain_id) throw new Error('Native Domain binding mismatch');
    return domain;
  }
  async clock() {
    const {object} = await this.client.getObject({objectId: '0x6', include: {content: true}});
    if (object.type !== `${normalizeSuiAddress('0x2')}::clock::Clock`) throw new Error('Unexpected Clock type');
    return BigInt(Clock.parse(object.content).timestamp_ms);
  }
  reference(id: string): AgentRef {
    return {network: Array.from(Buffer.from(this.config.chain_id)), package_id: normalizeSuiAddress(this.config.package_id),
      domain: normalizeSuiAddress(this.config.domain), agent: normalizeSuiAddress(id)};
  }
  async resolve(ref: AgentRef): Promise<Authorization> {
    const expected = this.reference(ref.agent);
    if (ref.agent !== expected.agent || ref.domain !== expected.domain || ref.package_id !== expected.package_id ||
        !Buffer.from(ref.network).equals(Buffer.from(expected.network))) throw new Error('Qualified Agent reference mismatch');
    const started = BigInt(Date.now());
    await this.validate();
    const [object, now] = await Promise.all([this.object(ref.agent, 'identity', 'Agent'), this.clock()]);
    const a = NativeAgent.parse(object.content);
    if (a.id !== ref.agent || a.deployment !== ref.domain) throw new Error('Agent Domain mismatch');
    if (a.transport_key.length !== 32 || a.economic_key.length !== 32 ||
        Buffer.from(a.transport_key).equals(Buffer.from(a.economic_key))) throw new Error('Invalid operational key separation');
    const localNow = BigInt(Date.now());
    if (now > localNow + 5000n || localNow > now + 5000n) throw new Error('Local and Sui clocks differ by more than five seconds');
    const until = BigInt(a.expires_ms) < started + 30000n ? BigInt(a.expires_ms) : started + 30000n;
    if (until <= localNow || BigInt(a.expires_ms) <= now) throw new Error('Agent authority is expired or resolution was too slow');
    return {agent: ref, controller: a.controller, transport_key: a.transport_key, economic_key: a.economic_key,
      generation: a.generation, read_at_ms: started.toString(), valid_until_ms: until.toString()};
  }
  call(tx: Transaction, module: string, fn: string, args: Parameters<Transaction['moveCall']>[0]['arguments']) {
    return tx.moveCall({target:`${this.config.package_id}::${module}::${fn}`,arguments:args});
  }
  /** Persist exact signed transaction before submission; uncertain retries reuse those bytes. */
  async execute(tx: Transaction, signer: Ed25519Keypair, journal: string, operation: string) {
    await this.checkNetwork();
    if (!operation || operation.length > 1024) throw new Error('Transaction operation identity is required');
    await mkdir(dirname(journal), {recursive: true, mode: 0o700});
    const lock = await NativeLock.acquire(`${journal}.lock`);
    try {
    const binding = {network:this.config.network,chain_id:this.config.chain_id,
      package_id:this.config.package_id,domain:this.config.domain,signer:signer.toSuiAddress(),operation};
    let attempt = await readOptional<any>(journal);
    if (attempt && JSON.stringify(attempt.binding) !== JSON.stringify(binding)) throw new Error('Transaction journal operation or authority mismatch');
    if (attempt?.state === 'confirmed') return attempt;
    if (attempt?.state === 'failed') throw new Error(`Prior transaction failed; inspect ${journal}`);
    if (!attempt) {
      tx.setSender(signer.toSuiAddress());
      tx.setGasBudgetIfNotSet(50_000_000);
      const bytes = await tx.build({client:this.client});
      const signed = await signer.signTransaction(bytes);
      attempt = {state:'submitted',binding,
        digest:await tx.getDigest({client:this.client}),bytes:signed.bytes,signature:signed.signature};
      await save(journal,attempt);
    }
    if (attempt.state !== 'submitted' || typeof attempt.bytes !== 'string' || typeof attempt.signature !== 'string') throw new Error('Invalid transaction journal');
    // Resubmitting identical transaction bytes is idempotent at Sui's transaction layer.
    const result = await this.client.executeTransaction({transaction:new Uint8Array(Buffer.from(attempt.bytes,'base64')),
      signatures:[attempt.signature],include:{effects:true,objectTypes:true,balanceChanges:true}});
    if (result.$kind !== 'Transaction' || !result.Transaction.status.success) {
      await save(journal,{...attempt,state:'failed'});
      throw new Error(`Transaction failed: ${JSON.stringify(result.$kind === 'Transaction' ? result.Transaction.status.error : result.$kind)}`);
    }
    await this.client.waitForTransaction({digest:result.Transaction.digest});
    const out = {state:'confirmed',binding,
      digest:result.Transaction.digest,gas:result.Transaction.effects.gasUsed,
      created:result.Transaction.effects.changedObjects.filter(o=>o.idOperation==='Created')
        .map(o=>({id:o.objectId,type:result.Transaction.objectTypes[o.objectId]})),
      balances:result.Transaction.balanceChanges};
    await save(journal,out);
    return out;
    } finally { await lock.close(); }
  }
}

export {save, ObjectError};
