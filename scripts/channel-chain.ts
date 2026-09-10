import { createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { bcs } from '@mysten/sui/bcs';
import { ObjectError, type SuiClientTypes } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { GrpcWebFetchTransport, SuiGrpcClient } from '@mysten/sui/grpc';
import type { MethodInfo, RpcOptions, ServerStreamingCall, UnaryCall } from '@protobuf-ts/runtime-rpc';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress, toBase58 } from '@mysten/sui/utils';
import {
  Channel,
  Credit,
  OpeningKey,
  Offer,
  Close,
  hash,
  offerHash,
  type ChannelData,
  type CloseCertificateData,
  type CloseData,
  type CreditData,
  type OfferData,
  validateChannel,
  validateClose,
  validateCloseCertificate,
  validateCredit,
  validateOffer,
  validateSignature,
  hex,
} from './channel-codec.js';
import { Chain, key, save, type ChainConfig } from './chain.js';

/** TEST-ONLY opt-in RPC deny switch. Runtime C owns creation/removal of this file. */
export const RPC_DENY_FILE_ENV = 'M2M_CHANNEL_RPC_DENY_FILE';

export interface ChannelView extends ChannelData {
  terminal_digest: string | null;
}

export interface AgentData {
  id: string;
  deployment: string;
  controller: string;
  endpoint_key: number[];
  next_nonce: string;
  jobs: { id: string; size: string };
}

export interface PartiesView {
  buyer: AgentData;
  provider: AgentData;
  timestamp_ms: string;
}

export interface SnapshotView {
  channel: ChannelView;
  timestamp_ms: string;
}

export interface MutationView {
  channel: string;
  digest: string | null;
  state: ChannelView;
  gas: Record<string, unknown> | null;
  recovered: boolean;
  /** Whether the recovered result is attributable to this journal's tx. */
  resolution: 'own' | 'external';
}

interface ChannelRecord {
  view: ChannelView;
  previous_transaction: string | null;
}

interface JournalAttempt {
  digest: string;
  bytes: string;
  signature: string;
  state: 'submitted_or_pending' | 'confirmed' | 'confirmed_failed';
  error?: string;
}

interface JournalRecord {
  version: 1;
  action: string;
  state: 'prepared' | 'submitted_or_pending' | 'confirmed' | 'confirmed_failed' | 'unknown';
  attempts: JournalAttempt[];
  resolution?: 'own' | 'external';
  recovered?: boolean;
  digest?: string | null;
  [key: string]: unknown;
}

type IncludedChannelTransaction = SuiClientTypes.Transaction<{
  effects: true;
  objectTypes: true;
}>;

class ConfirmedFailure extends Error {
  constructor(message: string) { super(message); this.name = 'ConfirmedFailure'; }
}

class CountingTransport extends GrpcWebFetchTransport {
  private count = 0;
  private readonly denyFile: string | undefined;
  private readonly phase: string;

  constructor(baseUrl: string) {
    super({ baseUrl });
    this.denyFile = process.env[RPC_DENY_FILE_ENV];
    this.phase = process.env.M2M_CHANNEL_RPC_PHASE ?? 'channel-bridge';
  }

  private operation(method: MethodInfo): string {
    return `${method.service.typeName}/${method.name}`;
  }

  private start(method: MethodInfo): number {
    const call = ++this.count;
    const operation = this.operation(method);
    const denyFile = process.env[RPC_DENY_FILE_ENV] ?? this.denyFile;
    const denied = denyFile !== undefined && existsSync(denyFile);
    process.stderr.write(`${JSON.stringify({
      event: 'channel_rpc', operation, phase: this.phase, result: denied ? 'denied' : 'started',
      call_count: call, timestamp_ms: Date.now(),
    })}\n`);
    if (denied) throw new Error(`${RPC_DENY_FILE_ENV} denied ${operation}`);
    return call;
  }

  private finish(method: MethodInfo, call: number, result: 'ok' | 'failed'): void {
    process.stderr.write(`${JSON.stringify({
      event: 'channel_rpc', operation: this.operation(method), phase: this.phase, result,
      call_count: call, timestamp_ms: Date.now(),
    })}\n`);
  }

  override unary<I extends object, O extends object>(method: MethodInfo<I, O>, input: I, options: RpcOptions): UnaryCall<I, O> {
    const callNumber = this.start(method);
    let call: UnaryCall<I, O>;
    try { call = super.unary(method, input, options); }
    catch (error) { this.finish(method, callNumber, 'failed'); throw error; }
    void call.response.then(
      () => this.finish(method, callNumber, 'ok'),
      () => this.finish(method, callNumber, 'failed'),
    );
    return call;
  }

  override serverStreaming<I extends object, O extends object>(method: MethodInfo<I, O>, input: I, options: RpcOptions): ServerStreamingCall<I, O> {
    const callNumber = this.start(method);
    let call: ServerStreamingCall<I, O>;
    try { call = super.serverStreaming(method, input, options); }
    catch (error) { this.finish(method, callNumber, 'failed'); throw error; }
    call.responses.onError(() => this.finish(method, callNumber, 'failed'));
    void call.status.then(
      () => this.finish(method, callNumber, 'ok'),
      () => this.finish(method, callNumber, 'failed'),
    );
    return call;
  }
}

function equalBytes(a: number[] | Uint8Array, b: number[] | Uint8Array): boolean {
  return hex(a) === hex(b);
}

function publicKeyFromRaw(raw: number[]): ReturnType<typeof createPublicKey> {
  return createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw)]),
    format: 'der', type: 'spki',
  });
}

function verifyStatement(bytes: Uint8Array, signature: number[], publicKey: number[], label: string): void {
  validateSignature(signature, `${label}.signature`);
  if (!verify(null, bytes, publicKeyFromRaw(publicKey), Buffer.from(signature))) {
    throw new Error(`${label} signature verification failed`);
  }
}

function asGas(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class ChannelChain extends Chain {
  constructor(config: ChainConfig) {
    super(config);
    // Chain's public client is readonly at the type level. Replace it here so
    // all SDK calls, including transaction resolution/build calls, cross the
    // counting transport boundary.
    const client = new SuiGrpcClient({
      network: config.network,
      transport: new CountingTransport(config.rpc_url),
    });
    (this as unknown as { client: SuiGrpcClient }).client = client;
  }

  private channelType(): string {
    return `${normalizeSuiAddress(this.config.package_id)}::channel::Channel`;
  }

  private openingKeyType(): string {
    return `${normalizeSuiAddress(this.config.package_id)}::channel::OpeningKey`;
  }

  private channelCall(tx: Transaction, method: string, args: Parameters<Transaction['moveCall']>[0]['arguments']): void {
    tx.moveCall({ target: `${this.config.package_id}::channel::${method}`, arguments: args });
  }

  private async channelRecord(id: string): Promise<ChannelRecord> {
    const normalized = normalizeSuiAddress(id);
    const { object } = await this.client.getObject({
      objectId: normalized,
      include: { content: true, previousTransaction: true },
    });
    if (object.type !== this.channelType()) throw new Error(`Unexpected object type for ${id}: ${object.type}`);
    const data = Channel.parse(object.content);
    validateChannel(data);
    if (data.id !== normalized) throw new Error('Channel object ID mismatch');
    if (data.offer.package_id !== normalizeSuiAddress(this.config.package_id) ||
        data.offer.deployment !== normalizeSuiAddress(this.config.deployment)) {
      throw new Error('Channel deployment mismatch');
    }
    return {
      view: {
        ...data,
        terminal_digest: data.terminal_tx.length ? toBase58(Uint8Array.from(data.terminal_tx)) : null,
      },
      previous_transaction: object.previousTransaction ?? null,
    };
  }

  async channel(id: string): Promise<ChannelView> {
    return (await this.channelRecord(id)).view;
  }

  async lookupChannel(buyer: string, openingNonce: number[]): Promise<string | null> {
    const agent = await this.agent(normalizeSuiAddress(buyer));
    const nonce = OpeningKey.serialize({ nonce: openingNonce }).toBytes();
    try {
      const { dynamicField } = await this.client.getDynamicField({
        parentId: agent.id,
        name: { type: this.openingKeyType(), bcs: nonce },
      });
      if (!['0x2::object::ID', `${normalizeSuiAddress('0x2')}::object::ID`].includes(dynamicField.value.type)) {
        throw new Error(`Unexpected OpeningKey value type: ${dynamicField.value.type}`);
      }
      const id = normalizeSuiAddress(bcs.Address.parse(dynamicField.value.bcs));
      return id;
    } catch (error) {
      // Only the SDK's specific notExists response is evidence of an absent
      // opening. Transport errors remain unknown and must reach the caller.
      if (error instanceof ObjectError && error.code === 'notExists' && error.reason === 'notFound') return null;
      throw error;
    }
  }

  private async agentData(id: string): Promise<AgentData> {
    const agent = await this.agent(normalizeSuiAddress(id));
    return {
      id: agent.id,
      deployment: agent.deployment,
      controller: agent.controller,
      endpoint_key: [...agent.endpoint_key],
      next_nonce: agent.next_nonce,
      jobs: { id: agent.jobs.id, size: agent.jobs.size },
    };
  }

  async parties(buyer: string, provider: string): Promise<PartiesView> {
    const [buyerData, providerData, timestamp] = await Promise.all([
      this.agentData(buyer), this.agentData(provider), this.clock(),
    ]);
    return { buyer: buyerData, provider: providerData, timestamp_ms: timestamp };
  }

  async snapshot(id: string): Promise<SnapshotView> {
    const [channel, timestamp] = await Promise.all([this.channel(id), this.clock()]);
    return { channel, timestamp_ms: timestamp };
  }

  private async validateOfferContext(offer: OfferData): Promise<{ buyer: AgentData; provider: AgentData }> {
    validateOffer(offer);
    const [domain, parties] = await Promise.all([
      this.domain(), this.parties(offer.buyer, offer.provider),
    ]);
    if (new TextDecoder().decode(Uint8Array.from(offer.network)) !== this.config.chain_id ||
        offer.package_id !== normalizeSuiAddress(this.config.package_id) ||
        offer.deployment !== normalizeSuiAddress(this.config.deployment) ||
        domain.package_id !== normalizeSuiAddress(this.config.package_id) ||
        domain.id !== normalizeSuiAddress(this.config.deployment)) {
      throw new Error('Offer deployment/network binding mismatch');
    }
    if (offer.buyer !== parties.buyer.id || offer.provider !== parties.provider.id ||
        !equalBytes(offer.buyer_key, parties.buyer.endpoint_key) ||
        !equalBytes(offer.provider_key, parties.provider.endpoint_key) ||
        offer.refund !== parties.buyer.controller || offer.payee !== parties.provider.controller) {
      throw new Error('Offer party snapshot mismatch');
    }
    return parties;
  }

  private async validateCreditContext(credit: CreditData): Promise<ChannelRecord> {
    validateCredit(credit);
    const record = await this.channelRecord(credit.channel);
    const offer = record.view.offer;
    if (credit.offer_hash.length !== 32 || hex(credit.offer_hash) !== hex(offerHash(offer))) {
      throw new Error('Credit offer hash mismatch');
    }
    if (credit.network.length !== offer.network.length || !equalBytes(credit.network, offer.network) ||
        credit.package_id !== offer.package_id || credit.deployment !== offer.deployment ||
        credit.buyer !== offer.buyer || credit.provider !== offer.provider || credit.channel !== record.view.id) {
      throw new Error('Credit channel binding mismatch');
    }
    return record;
  }

  private async validateCloseContext(certificate: CloseCertificateData): Promise<ChannelRecord> {
    validateCloseCertificate(certificate);
    const record = await this.channelRecord(certificate.close.channel);
    const offer = record.view.offer;
    const close = certificate.close;
    if (close.offer_hash.length !== 32 ||
        hex(close.offer_hash) !== hex(offerHash(offer)) ||
        close.network.length !== offer.network.length || !equalBytes(close.network, offer.network) ||
        close.package_id !== offer.package_id || close.deployment !== offer.deployment ||
        close.buyer !== offer.buyer || close.provider !== offer.provider || close.channel !== record.view.id) {
      throw new Error('Close channel binding mismatch');
    }
    verifyStatement(Close.serialize(close).toBytes(), certificate.buyer_signature, offer.buyer_key, 'close.buyer');
    verifyStatement(Close.serialize(close).toBytes(), certificate.provider_signature, offer.provider_key, 'close.provider');
    return record;
  }

  private async readJournal(path: string): Promise<JournalRecord | null> {
    if (!path) throw new Error('transaction journal path is required');
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as JournalRecord;
      if (value.version !== 1 || !Array.isArray(value.attempts)) throw new Error('invalid channel transaction journal');
      if (value.resolution !== undefined && value.resolution !== 'own' && value.resolution !== 'external') {
        throw new Error('invalid channel transaction journal resolution');
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async prepareJournal(path: string, action: string, fields: Record<string, unknown>): Promise<JournalRecord> {
    if (!path) throw new Error(`${action} requires a transaction journal`);
    const old = await this.readJournal(path);
    if (old && old.action !== action) throw new Error('transaction journal action mismatch');
    if (old) {
      for (const [name, value] of Object.entries(fields)) {
        if (old[name] === undefined && old.attempts.length > 0) {
          throw new Error(`transaction journal lacks original ${name}`);
        }
        if (old[name] !== undefined && !isDeepStrictEqual(old[name], value)) {
          throw new Error(`transaction journal ${name} mismatch`);
        }
      }
    }
    const record: JournalRecord = old ?? { version: 1, action, state: 'prepared', attempts: [] };
    Object.assign(record, fields, { action, version: 1 });
    if (!old) record.state = 'prepared';
    await save(path, record);
    return record;
  }

  private mutationDigest(record: ChannelRecord): string | null {
    if (record.view.status !== 0) return record.view.terminal_digest;
    return record.previous_transaction;
  }

  private terminalDigestMatchesAction(journal: JournalRecord, current: ChannelView, digest: string): boolean {
    if (current.terminal_digest !== digest) return false;
    if (current.status === 1) return journal.action === 'channel_close';
    if (current.status === 2) return journal.action === 'channel_refund';
    return false;
  }

  private expectedChannelMutation(
    journal: JournalRecord,
    current: ChannelView,
    observed: IncludedChannelTransaction,
  ): boolean {
    const effects = observed.effects;
    const objectTypes = observed.objectTypes;
    if (!effects?.status.success || !objectTypes) return false;

    const channelId = normalizeSuiAddress(current.id);
    const changed = effects.changedObjects.find((object) => {
      try {
        return normalizeSuiAddress(object.objectId) === channelId;
      } catch {
        return false;
      }
    });
    const channelType = Object.entries(objectTypes).find(([objectId]) => {
      try {
        return normalizeSuiAddress(objectId) === channelId;
      } catch {
        return false;
      }
    })?.[1];
    if (!changed || channelType !== this.channelType()) return false;

    const sharedWrite = changed.inputState === 'Exists'
      && changed.outputState === 'ObjectWrite'
      && changed.idOperation === 'None';

    switch (journal.action) {
      case 'channel_open':
        return changed.inputState === 'DoesNotExist'
          && changed.outputState === 'ObjectWrite'
          && changed.idOperation === 'Created';
      case 'channel_redeem': {
        // A terminal digest belongs to the terminal action. It cannot also
        // prove that a redeem caused the terminal transition.
        if (current.terminal_digest === observed.digest || !sharedWrite) return false;
        const credit = journal.credit as CreditData | undefined;
        if (!credit) return false;
        try {
          validateCredit(credit);
          return BigInt(current.redeemed_amount) >= BigInt(credit.cumulative_amount)
            && BigInt(current.redeemed_sequence) >= BigInt(credit.sequence);
        } catch {
          return false;
        }
      }
      case 'channel_close':
        return sharedWrite
          && current.status === 1
          && current.terminal_digest === observed.digest;
      case 'channel_refund':
        return sharedWrite
          && current.status === 2
          && current.terminal_digest === observed.digest;
      default:
        return false;
    }
  }

  private async inspectAttempt(
    journal: JournalRecord,
    current: ChannelRecord,
    attempt: JournalAttempt,
  ): Promise<{ digest: string | null; failed?: string }> {
    try {
      const observed = await this.client.getTransaction({
        digest: attempt.digest,
        include: { effects: true, objectTypes: true, balanceChanges: true },
      });
      if (observed.$kind === 'FailedTransaction') {
        const error = JSON.stringify(observed.FailedTransaction.status.error);
        attempt.state = 'confirmed_failed'; attempt.error = error;
        return { digest: null, failed: error };
      }
      if (observed.Transaction.digest !== attempt.digest
          || !this.expectedChannelMutation(journal, current.view, observed.Transaction)) {
        return { digest: null };
      }
      return { digest: attempt.digest };
    } catch {
      return { digest: null };
    }
  }

  /**
   * Identify an own mutation without treating an unrelated successful
   * transaction as the journaled transaction. Terminal object digests are a
   * sufficient witness only for the action that can create that terminal
   * state; all other pending and confirmed attempts require matching effects.
   */
  private async ownAttempt(
    journal: JournalRecord,
    current: ChannelRecord,
  ): Promise<{ digest: string | null; failed?: string }> {
    const confirmed = [...journal.attempts].reverse().find(attempt => attempt.state === 'confirmed');
    if (confirmed) {
      if (this.terminalDigestMatchesAction(journal, current.view, confirmed.digest)) {
        return { digest: confirmed.digest };
      }
      return this.inspectAttempt(journal, current, confirmed);
    }

    const pending = [...journal.attempts].reverse().find(attempt => attempt.state === 'submitted_or_pending');
    if (!pending) return { digest: null };
    if (this.terminalDigestMatchesAction(journal, current.view, pending.digest)) {
      return { digest: pending.digest };
    }
    return this.inspectAttempt(journal, current, pending);
  }

  private async recoverFromChannel(journalPath: string, journal: JournalRecord, current: ChannelRecord): Promise<MutationView> {
    const own = await this.ownAttempt(journal, current);
    const resolution = own.digest === null ? 'external' : 'own';
    if (resolution === 'own') {
      for (const attempt of journal.attempts) {
        if (attempt.digest === own.digest) attempt.state = 'confirmed';
      }
      journal.state = 'confirmed';
      journal.digest = own.digest;
    } else if (own.failed) {
      journal.state = 'confirmed_failed';
      journal.error = own.failed;
      journal.digest = null;
    } else {
      // Preserve any unresolved own attempt. The channel state is recovered,
      // but no transaction digest is attributed to this journal.
      journal.state = 'unknown';
      journal.digest = null;
    }
    journal.recovered = true;
    journal.resolution = resolution;
    await save(journalPath, journal);
    return {
      channel: current.view.id,
      digest: own.digest,
      state: current.view,
      gas: resolution === 'own' && journal.gas && typeof journal.gas === 'object'
        ? journal.gas as Record<string, unknown> : null,
      recovered: true,
      resolution,
    };
  }

  private async reconcileRecovered(journalPath: string, journal: JournalRecord, recovered: MutationView): Promise<MutationView> {
    const current = await this.channelRecord(recovered.channel);
    return this.recoverFromChannel(journalPath, journal, current);
  }

  private async submit(
    action: string,
    tx: Transaction,
    signer: Ed25519Keypair,
    journal: string,
    reconcile: () => Promise<MutationView | null>,
    fields: Record<string, unknown> = {},
  ): Promise<MutationView> {
    if (!journal) throw new Error(`${action} requires a transaction journal`);
    const record = await this.prepareJournal(journal, action, fields);
    let signed: { bytes: string; signature: string };
    let digest: string;
    const prior = [...record.attempts].reverse().find(attempt =>
      attempt.state === 'submitted_or_pending' ||
      (record.state === 'unknown' && attempt.state === 'confirmed'),
    );
    if (prior) {
      // A signed transaction is safe to retry byte-for-byte. First ask the
      // ledger whether its digest is known. A transport failure here is still
      // unknown, so retain and resend the exact saved attempt below.
      try {
        const observed = await this.client.getTransaction({
          digest: prior.digest, include: { effects: true, objectTypes: true, balanceChanges: true },
        });
        if (observed.$kind === 'FailedTransaction') {
          const error = JSON.stringify(observed.FailedTransaction.status.error);
          prior.state = 'confirmed_failed'; prior.error = error;
          record.state = 'confirmed_failed'; record.error = error;
          await save(journal, record);
          throw new ConfirmedFailure(error);
        }
        prior.state = 'confirmed';
        record.state = 'confirmed';
        record.digest = prior.digest;
        const recovered = await reconcile();
        if (recovered) {
          return this.reconcileRecovered(journal, record, recovered);
        }
      } catch (error) {
        if (error instanceof ConfirmedFailure) throw error;
        // The transaction may be absent, pending, or the read may have failed.
        // All cases are safe to handle by resubmitting the identical bytes.
      }
      signed = { bytes: prior.bytes, signature: prior.signature };
      digest = prior.digest;
    } else {
      tx.setSender(signer.toSuiAddress());
      tx.setGasBudget(50_000_000);
      try {
        const bytes = await tx.build({ client: this.client });
        signed = await signer.signTransaction(bytes);
        digest = await tx.getDigest({ client: this.client });
        record.attempts.push({ digest, bytes: signed.bytes, signature: signed.signature, state: 'submitted_or_pending' });
        record.state = 'submitted_or_pending';
        await save(journal, record);
      } catch (error) {
        // Nothing was handed to executeTransaction because the attempt record
        // is created only after build/sign/digest all succeed. Keep the journal
        // retryable and preserve the preparation error for diagnostics.
        record.state = 'prepared';
        record.preparation_error = errorText(error);
        await save(journal, record);
        throw error;
      }
    }
    try {
      const result = await this.client.executeTransaction({
        transaction: Buffer.from(signed.bytes, 'base64'), signatures: [signed.signature],
        include: { effects: true, objectTypes: true, balanceChanges: true },
      });
      if (result.$kind === 'FailedTransaction') {
        const failed = result.FailedTransaction.status.error;
        const message = JSON.stringify(failed);
        const attempt = record.attempts[record.attempts.length - 1];
        attempt.state = 'confirmed_failed'; attempt.error = message;
        record.state = 'confirmed_failed'; record.error = message;
        await save(journal, record);
        throw new ConfirmedFailure(message);
      }
      const transaction = result.Transaction;
      const effects = transaction.effects;
      const gas = asGas(effects?.gasUsed);
      const attempt = record.attempts[record.attempts.length - 1];
      attempt.state = 'confirmed';
      record.state = 'confirmed'; record.digest = transaction.digest; record.gas = gas;
      record.resolution = 'own';
      // Execution effects already establish this outcome. Persist them before
      // waiting for ledger indexing, which can lag or become unavailable.
      await save(journal, record);
      await this.client.waitForTransaction({ digest: transaction.digest, timeout: 3_000,
        include: { effects: true, objectTypes: true, balanceChanges: true } });
      const state = await reconcile();
      if (!state) throw new Error(`${action} confirmed without recoverable channel state`);
      if (!this.expectedChannelMutation(record, state.state, transaction)) {
        throw new Error(`${action} effects do not match the expected channel mutation`);
      }
      return { ...state, digest: transaction.digest, gas, recovered: false, resolution: 'own' };
    } catch (error) {
      if (error instanceof ConfirmedFailure) throw error;
      try {
        const recovered = await reconcile();
        if (recovered) {
          return this.reconcileRecovered(journal, record, recovered);
        }
      } catch { /* The failed reconciliation keeps the outcome unknown. */ }
      record.state = 'unknown'; record.error = errorText(error);
      await save(journal, record);
      throw new Error(`${action} outcome is unknown; reconcile ${journal} before retrying: ${errorText(error)}`);
    }
  }

  async openChannel(offer: OfferData, signature: number[], signer: Ed25519Keypair, journal: string): Promise<MutationView> {
    validateOffer(offer);
    validateSignature(signature, 'offer.signature');
    const journalRecord = await this.prepareJournal(journal, 'channel_open', { offer, signature });
    const existing = await this.lookupChannel(offer.buyer, offer.opening_nonce);
    if (existing) {
      const current = await this.channelRecord(existing);
      if (hex(Offer.serialize(current.view.offer).toBytes()) !== hex(Offer.serialize(offer).toBytes())) {
        throw new Error('opening nonce already names a different offer');
      }
      verifyStatement(Offer.serialize(offer).toBytes(), signature, current.view.offer.provider_key, 'offer');
      return this.recoverFromChannel(journal, journalRecord, current);
    }
    const parties = await this.validateOfferContext(offer);
    verifyStatement(Offer.serialize(offer).toBytes(), signature, parties.provider.endpoint_key, 'offer');
    const tx = new Transaction();
    const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(offer.deposit)]);
    this.channelCall(tx, 'open', [
      tx.object(this.config.deployment), tx.object(offer.buyer), tx.object(offer.provider), payment,
      tx.pure.vector('u8', offer.opening_nonce), tx.pure.vector('u8', offer.terms_hash),
      tx.pure.u64(offer.deposit), tx.pure.u64(offer.offer_expires_ms), tx.pure.u64(offer.work_deadline_ms),
      tx.pure.u64(offer.claim_deadline_ms), tx.pure.vector('u8', signature), tx.object('0x6'),
    ]);
    return this.submit('channel_open', tx, signer, journal, async () => {
      const id = await this.lookupChannel(offer.buyer, offer.opening_nonce);
      if (!id) return null;
      const state = await this.channelRecord(id);
      if (hex(Offer.serialize(state.view.offer).toBytes()) !== hex(Offer.serialize(offer).toBytes())) {
        throw new Error('resolved opening has conflicting offer');
      }
      return { channel: id, digest: state.previous_transaction, state: state.view, gas: null, recovered: true, resolution: 'external' };
    }, { offer, signature });
  }

  async redeemChannel(credit: CreditData, signature: number[], signer: Ed25519Keypair, journal: string): Promise<MutationView> {
    validateSignature(signature, 'credit.signature');
    const record = await this.validateCreditContext(credit);
    verifyStatement(Credit.serialize(credit).toBytes(), signature, record.view.offer.buyer_key, 'credit');
    const journalRecord = await this.prepareJournal(journal, 'channel_redeem', { credit, signature });
    const requestedAmount = BigInt(credit.cumulative_amount);
    const requestedSequence = BigInt(credit.sequence);
    const covered = async (): Promise<MutationView | null> => {
      const current = await this.channelRecord(credit.channel);
      if (BigInt(current.view.redeemed_amount) >= requestedAmount && BigInt(current.view.redeemed_sequence) >= requestedSequence) {
        return {
          channel: current.view.id, digest: null, state: current.view, gas: null, recovered: true,
          resolution: 'external',
        };
      }
      if (current.view.status !== 0) throw new Error(`redemption is not covered; channel is terminal (${current.view.status})`);
      return null;
    };
    const already = await covered();
    if (already) return this.reconcileRecovered(journal, journalRecord, already);
    const tx = new Transaction();
    this.channelCall(tx, 'redeem', [
      tx.object(credit.channel), tx.pure.u64(credit.sequence), tx.pure.u64(credit.cumulative_amount),
      tx.pure.vector('u8', credit.request_hash), tx.pure.vector('u8', credit.previous_transcript_hash),
      tx.pure.vector('u8', signature), tx.object('0x6'),
    ]);
    return this.submit('channel_redeem', tx, signer, journal, covered, { credit, signature });
  }

  async closeChannel(certificate: CloseCertificateData, signer: Ed25519Keypair, journal: string): Promise<MutationView> {
    const record = await this.validateCloseContext(certificate);
    const close = certificate.close;
    const closeHash = hex(hash(Close.serialize(close).toBytes()));
    const journalRecord = await this.prepareJournal(journal, 'channel_close', { certificate });
    if (record.view.status === 1) {
      if (hex(record.view.close_hash) !== closeHash) throw new Error('channel already closed with a different close');
      return this.recoverFromChannel(journal, journalRecord, record);
    }
    if (record.view.status === 2) throw new Error('channel was refunded; close is impossible');
    if (BigInt(close.final_amount) < BigInt(record.view.redeemed_amount) ||
        BigInt(close.final_amount) > BigInt(record.view.offer.deposit) ||
        BigInt(close.final_sequence) < BigInt(record.view.redeemed_sequence)) {
      throw new Error('close is below already redeemed state');
    }
    const tx = new Transaction();
    this.channelCall(tx, 'close', [
      tx.object(close.channel), tx.pure.u64(close.final_sequence), tx.pure.u64(close.final_amount),
      tx.pure.vector('u8', close.transcript_hash), tx.pure.vector('u8', certificate.buyer_signature),
      tx.pure.vector('u8', certificate.provider_signature), tx.object('0x6'),
    ]);
    return this.submit('channel_close', tx, signer, journal, async () => {
      const current = await this.channelRecord(close.channel);
      if (current.view.status !== 1) return null;
      if (hex(current.view.close_hash) !== closeHash) throw new Error('terminal close hash mismatch');
      return { channel: current.view.id, digest: current.view.terminal_digest, state: current.view, gas: null, recovered: true, resolution: 'external' };
    }, { certificate });
  }

  async refundChannel(id: string, signer: Ed25519Keypair, journal: string): Promise<MutationView> {
    const initial = await this.channelRecord(id);
    const journalRecord = await this.prepareJournal(journal, 'channel_refund', { channel: initial.view.id });
    if (initial.view.status === 2) {
      return this.recoverFromChannel(journal, journalRecord, initial);
    }
    if (initial.view.status === 1) throw new Error('closed channel cannot be refunded');
    const tx = new Transaction();
    this.channelCall(tx, 'refund', [tx.object(initial.view.id), tx.object('0x6')]);
    return this.submit('channel_refund', tx, signer, journal, async () => {
      const current = await this.channelRecord(initial.view.id);
      if (current.view.status !== 2) return null;
      return { channel: current.view.id, digest: current.view.terminal_digest, state: current.view, gas: null, recovered: true, resolution: 'external' };
    }, { channel: initial.view.id });
  }
}

interface BridgeInput {
  config: ChainConfig;
  action: string;
  buyer?: string;
  provider?: string;
  id?: string;
  opening_nonce?: number[];
  offer?: OfferData;
  credit?: CreditData;
  signature?: number[];
  certificate?: CloseCertificateData;
  signer_file?: string;
  journal?: string;
}

async function bridge(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 2_000_000) throw new Error('Bridge input too large');
  }
  const arg = JSON.parse(input) as BridgeInput;
  if (!arg.config || typeof arg.action !== 'string') throw new Error('Invalid channel bridge request');
  const chain = new ChannelChain(arg.config);
  await chain.validate();
  let result: unknown;
  switch (arg.action) {
    case 'channel_parties': result = await chain.parties(arg.buyer!, arg.provider!); break;
    case 'channel_lookup': result = { channel: await chain.lookupChannel(arg.buyer!, arg.opening_nonce!) }; break;
    case 'channel_get': result = await chain.channel(arg.id!); break;
    case 'channel_snapshot': result = await chain.snapshot(arg.id!); break;
    case 'channel_open': result = await chain.openChannel(arg.offer!, arg.signature!, await key(arg.signer_file!), arg.journal!); break;
    case 'channel_redeem': result = await chain.redeemChannel(arg.credit!, arg.signature!, await key(arg.signer_file!), arg.journal!); break;
    case 'channel_close': result = await chain.closeChannel(arg.certificate!, await key(arg.signer_file!), arg.journal!); break;
    case 'channel_refund': result = await chain.refundChannel(arg.id!, await key(arg.signer_file!), arg.journal!); break;
    default: throw new Error(`Unknown channel bridge operation: ${arg.action}`);
  }
  process.stdout.write(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bridge().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
}
