/** Provider setup/continuity binding. The v2 service owns request execution and metering. */
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { RequestRef } from './codex-worker.js';
import type { AgentWorker, Citation, PinnedAgents } from './agent-service-types.js';
import { readAgentJournal } from './agent-service-exchange.js';
import { save } from './native-chain.js';
import { strictJson } from './native-peer.js';
import { StreamingChain } from './native-streaming-chain.js';
import { StreamingEngine, type StreamingBinding } from './streaming-engine.js';
import { ResearchConversationService, researchRequestHash } from './research-conversation.js';
import { byteArray, equal, exactKeys, offerHash, policyHash, purpose, signStatement, u64, utf8, METHOD,
  validatePolicy, type PolicyData, type OfferData, type SignedData } from './streaming-codec.js';

const FEATURE = 'service.research.conversation.v2';
const canonical = (v: any): string => JSON.stringify(v, function(_key, value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value;
});
interface Quote { conversation: string; previous_channel: string | null; offer: SignedData<OfferData>; policy: PolicyData }
interface HostedChannel { binding: StreamingBinding; engine_initialized: boolean; service_initialized: boolean }
interface HostJournal { version: 2; conversation: string; agents: PinnedAgents; policy: PolicyData; deposit: string;
  quotes: Quote[]; channels: HostedChannel[]; operations: Array<{ command: Record<string, any>; response: Record<string, any> }> }
export interface AgentHostOptions {
  stateDir: string; create: boolean; conversation: string; agents: PinnedAgents; policy: PolicyData; deposit: string;
  chain: StreamingChain; signer: { sign(bytes: Uint8Array): Promise<Uint8Array> }; worker: AgentWorker;
  sources?: (ref: RequestRef) => Citation[];
}
export class AgentServiceHost {
  private queue: Promise<unknown> = Promise.resolve();
  private services = new Map<string, ResearchConversationService>();
  private engines = new Map<string, StreamingEngine>();
  private poisoned = false;
  private constructor(readonly path: string, private journal: HostJournal, private options: AgentHostOptions) {}
  static async open(options: AgentHostOptions) {
    validatePolicy(options.policy); u64(options.deposit);
    if (!/^[0-9a-f]{64}$/.test(options.conversation) || options.deposit === '0') throw Error('invalid_host_config');
    const path = join(options.stateDir, 'host.json');
    const existing = await readAgentJournal<HostJournal>(path, !options.create);
    const journal = existing ?? { version: 2 as const, conversation: options.conversation, agents: options.agents,
      policy: options.policy, deposit: options.deposit, quotes: [], channels: [], operations: [] };
    exactKeys(journal, ['version', 'conversation', 'agents', 'policy', 'deposit', 'quotes', 'channels', 'operations']);
    if (journal.version !== 2 || journal.conversation !== options.conversation || !equal(journal.agents, options.agents) ||
      !equal(journal.policy, options.policy) || journal.deposit !== options.deposit || !Array.isArray(journal.channels) ||
      !Array.isArray(journal.quotes) || !Array.isArray(journal.operations) || journal.operations.length > 512) throw Error('journal_corrupt');
    if (!existing) await save(path, journal);
    const host = new AgentServiceHost(path, journal, options);
    // Verify every initialized component, including predecessor channels, before admission.
    try { for (const entry of journal.channels) await host.service(entry); }
    catch (error) { await host.close().catch(() => {}); throw error; }
    return host;
  }
  private async persist() {
    if (this.poisoned) throw Error('storage_failure');
    if (Buffer.byteLength(JSON.stringify(this.journal, null, 2)) > 8 * 1024 * 1024) throw Error('journal_limit');
    try { await save(this.path, this.journal); } catch (e) { this.poisoned = true; throw e; }
  }
  private async service(entry: HostedChannel) {
    const id = entry.binding.channel;
    if (this.services.has(id)) return this.services.get(id)!;
    const directory = join(this.options.stateDir, 'channels', id.slice(2));
    const enginePath = join(directory, 'stream.json');
    if (entry.engine_initialized) await readAgentJournal(enginePath, true);
    const engine = await StreamingEngine.open(enginePath, 'provider', entry.binding, this.options.signer);
    this.engines.set(id, engine);
    if (!entry.engine_initialized) { entry.engine_initialized = true; await this.persist(); }
    const service = await ResearchConversationService.open({ stateDir: join(directory, 'service'), create: !entry.service_initialized,
      engine, worker: this.options.worker, conversation: this.journal.conversation, buyer: this.options.agents.buyer,
      provider: this.options.agents.provider, sources: this.options.sources,
      observeChannel: async () => ({ channel: await this.options.chain.channel(id), now_ms: String(await this.options.chain.clock()) }) });
    this.services.set(id, service);
    if (!entry.service_initialized) { entry.service_initialized = true; await this.persist(); }
    return service;
  }
  command(input: number[]): Promise<number[]> {
    const pending = this.queue.then(async () => {
      if (this.poisoned) throw Error('storage_failure');
      const cmd = strictJson(input);
      if (cmd.version !== 2 || !/^[0-9a-f]{64}$/.test(cmd.op_id)) throw Error('invalid_command');
      try {
        if (cmd.op === 'offer' || cmd.op === 'funded') return utf8(JSON.stringify(await this.setup(cmd)));
        const selected = this.journal.channels.at(-1);
        if (!selected) throw Error('channel_not_open');
        // Old economic requests can still replay their own retained channel evidence.
        let entry = selected;
        if (cmd.credit?.payload?.channel) entry = this.journal.channels.find(c => c.binding.channel === cmd.credit.payload.channel) ?? selected;
        if (cmd.request_hash || cmd.last_request_hash) {
          const digest = cmd.request_hash ?? cmd.last_request_hash;
          entry = this.journal.channels.find(c => this.engines.get(c.binding.channel)?.replay().some(r => equal(r.credit.payload.request_hash, digest))) ?? selected;
        }
        const service = await this.service(entry);
        return await service.command(input);
      } catch (e) {
        const allowed = ['invalid_command', 'unsupported_version', 'unsupported_service', 'operation_conflict', 'request_conflict',
          'unknown_request', 'conversation_busy', 'channel_mismatch', 'channel_not_open', 'work_expired', 'claim_expired',
          'credit_mismatch', 'credit_exhausted', 'checkpoint_cursor_mismatch', 'drain_required', 'worker_not_terminal',
          'uncertain_execution', 'journal_missing', 'journal_corrupt', 'storage_failure', 'limit_exceeded', 'backend_unavailable', 'search_unconfigured'];
        const code = allowed.includes((e as Error).message) ? (e as Error).message : 'invalid_command';
        return utf8(JSON.stringify({ version: 2, op_id: cmd.op_id, type: 'error', code }));
      }
    });
    this.queue = pending.catch(() => {}); return pending;
  }
  private async setup(cmd: Record<string, any>) {
    const previous = this.journal.operations.find(o => o.command.op_id === cmd.op_id);
    if (previous) {
      if (canonical(previous.command) !== canonical(cmd)) throw Error('operation_conflict');
      return previous.response;
    }
    if (this.journal.operations.length >= 512) throw Error('limit_exceeded');
    let response: Record<string, any>;
    if (cmd.op === 'offer') {
      exactKeys(cmd, ['version', 'op_id', 'op', 'conversation', 'nonce', 'previous_channel']); byteArray(cmd.nonce, 32);
      if (cmd.conversation !== this.journal.conversation || (cmd.previous_channel !== null && !/^0x[0-9a-f]{64}$/.test(cmd.previous_channel))) throw Error('invalid_command');
      let quote = this.journal.quotes.find(q => equal(q.offer.payload.opening_nonce, cmd.nonce));
      if (quote && (quote.conversation !== cmd.conversation || quote.previous_channel !== cmd.previous_channel)) throw Error('operation_conflict');
      if (!quote) {
        const selected = this.journal.channels.at(-1);
        if (selected) {
          if (cmd.previous_channel !== selected.binding.channel) throw Error('channel_mismatch');
          const ch = await this.options.chain.channel(selected.binding.channel);
          const engine = this.engines.get(ch.id)!;
          const state = engine.snapshot(), last = engine.replay().at(-1);
          if (ch.status === 0 || (last && !state.frozen && state.completed_request_sequence !== last.credit.payload.request_sequence)) throw Error('uncertain_execution');
        } else if (cmd.previous_channel !== null) throw Error('channel_mismatch');
        const pendingQuote = this.journal.quotes.at(-1);
        if (pendingQuote && !this.journal.channels.some(c => equal(c.binding.offer.payload.opening_nonce, pendingQuote.offer.payload.opening_nonce))) throw Error('conversation_busy');
        const { chain, agents } = this.options;
        const [buyer, provider, now] = await Promise.all([chain.resolve(agents.buyer), chain.resolve(agents.provider), chain.clock()]);
        const payload: OfferData = { purpose: purpose('offer'), method: utf8(METHOD), version: 1,
          network: agents.buyer.network, package_id: agents.buyer.package_id, deployment: agents.buyer.domain,
          buyer: agents.buyer.agent, provider: agents.provider.agent, buyer_key: buyer.economic_key, provider_key: provider.economic_key,
          refund: buyer.controller, payee: provider.controller, opening_nonce: cmd.nonce, policy_hash: policyHash(this.options.policy),
          deposit: this.options.deposit, offer_expires_ms: String(now + 120_000n), work_deadline_ms: String(now + 600_000n), claim_deadline_ms: String(now + 1_200_000n) };
        quote = { conversation: cmd.conversation, previous_channel: cmd.previous_channel,
          offer: await signStatement('offer', payload, this.options.signer), policy: this.options.policy };
        this.journal.quotes.push(quote); await this.persist();
      }
      response = { version: 2, op_id: cmd.op_id, type: 'offer', offer: quote.offer, policy: quote.policy, service: FEATURE };
    } else {
      exactKeys(cmd, ['version', 'op_id', 'op', 'conversation', 'channel']);
      if (cmd.conversation !== this.journal.conversation || !/^0x[0-9a-f]{64}$/.test(cmd.channel)) throw Error('invalid_command');
      const ch = await this.options.chain.channel(cmd.channel);
      const quote = this.journal.quotes.find(q => equal(offerHash(q.offer.payload), offerHash(ch.offer)));
      if (!quote) throw Error('channel_mismatch');
      let entry = this.journal.channels.find(c => c.binding.channel === ch.id);
      if (!entry) {
        if (ch.status !== 0) throw Error('channel_not_open');
        entry = { binding: { offer: quote.offer, policy: quote.policy, channel: ch.id }, engine_initialized: false, service_initialized: false };
        this.journal.channels.push(entry); await this.persist();
      }
      await this.service(entry);
      response = { version: 2, op_id: cmd.op_id, type: 'funded', channel: ch.id };
    }
    this.journal.operations.push({ command: cmd, response }); await this.persist(); return response;
  }
  async finish() { await Promise.all(Array.from(this.services.values(), service => service.finish())); }
  async close() { await Promise.all(Array.from(this.services.values(), service => service.close())); }
}
