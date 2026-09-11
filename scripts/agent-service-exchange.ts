/** Durable, serial application operations over verified native-core responses. */
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { NativePeer, strictJson, type SignedEnvelope } from './native-peer.js';
import { equal, exactKeys, utf8 } from './streaming-codec.js';

export interface AgentServiceReply { body: Record<string, any>; envelope: SignedEnvelope }
export interface AgentExchange {
  call(command: Record<string, unknown>, stableKey?: string): Promise<AgentServiceReply>;
  remaining?(): number;
}
interface Operation {
  key: string | null;
  command: Record<string, any>;
  signed: SignedEnvelope | null;
  response: AgentServiceReply | null;
}
interface ExchangeJournal { version: 2; conversation: string; operations: Operation[] }
const KIND = 'extension.payment.sui.streaming.v1';
const MAX_FILE = 8 * 1024 * 1024;
const canonical = (value: any): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

/** Byte arrays in retained envelopes must not incur pretty-print indentation per byte. */
async function saveExchange(path: string, journal: ExchangeJournal) {
  const encoded = JSON.stringify(journal) + '\n';
  if (Buffer.byteLength(encoded) > MAX_FILE) throw Error('journal_limit');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(encoded, 'utf8'); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Private bounded file reader. Wire messages use strictJson's separate 65KiB check. */
export async function readAgentJournal<T>(path: string, required = false, maximum = MAX_FILE): Promise<T | undefined> {
  let text: string;
  try {
    const size = (await stat(path)).size;
    if (size > maximum) throw Error('journal_limit');
    text = await readFile(path, 'utf8');
    if (Buffer.byteLength(text) > maximum) throw Error('journal_limit');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !required) return undefined;
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw Error('journal_missing');
    throw e;
  }
  try { return JSON.parse(text) as T; } catch { throw Error('journal_corrupt'); }
}

export class DurableAgentExchange implements AgentExchange {
  private queue: Promise<unknown> = Promise.resolve();
  private poisoned = false;
  private constructor(readonly path: string, private journal: ExchangeJournal, private peer: NativePeer) {}
  static async open(options: { stateDir: string; create: boolean; conversation: string; peer: NativePeer }) {
    if (!options.peer.selected.includes('payment.sui.streaming.v1') ||
      !options.peer.selected.includes('service.research.conversation.v2')) throw Error('unsupported_service');
    const path = join(options.stateDir, 'outbox.json');
    const existing = await readAgentJournal<ExchangeJournal>(path, !options.create);
    const journal = existing ?? { version: 2 as const, conversation: options.conversation, operations: [] };
    exactKeys(journal, ['version', 'conversation', 'operations']);
    if (journal.version !== 2 || journal.conversation !== options.conversation || !Array.isArray(journal.operations) || journal.operations.length > 512) throw Error('journal_corrupt');
    const ids = new Set<string>(), keys = new Set<string>();
    let pending = false;
    for (const op of journal.operations) {
      exactKeys(op, ['key', 'command', 'signed', 'response']);
      if (pending || typeof op.command?.op !== 'string' || op.command.version !== 2 ||
        !/^[0-9a-f]{64}$/.test(op.command.op_id) || ids.has(op.command.op_id)) throw Error('journal_corrupt');
      ids.add(op.command.op_id);
      if (op.key !== null) {
        if (typeof op.key !== 'string' || keys.has(op.key)) throw Error('journal_corrupt');
        keys.add(op.key);
      }
      if (op.response) {
        if (op.response.body.version !== 2 || op.response.body.op_id !== op.command.op_id || !op.signed || !op.response.envelope) throw Error('journal_corrupt');
        const receipt = strictJson(op.response.envelope.message.payload);
        if (!receipt.result || !equal(strictJson(receipt.result), op.response.body)) throw Error('journal_corrupt');
      } else pending = true;
    }
    if (!existing) await saveExchange(path, journal);
    return new DurableAgentExchange(path, journal, options.peer);
  }
  private async persist() {
    if (this.poisoned) throw Error('storage_failure');
    try { await saveExchange(this.path, this.journal); } catch (e) { this.poisoned = true; throw e; }
  }
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result;
  }
  /** Complete only the retained application operation. A new core ID never means new work. */
  recover(): Promise<AgentServiceReply | undefined> {
    return this.serialize(async () => {
      const pending = this.journal.operations.at(-1);
      return pending && !pending.response ? this.transmit(pending) : undefined;
    });
  }
  call(command: Record<string, unknown>, stableKey?: string): Promise<AgentServiceReply> {
    return this.serialize(async () => {
      if (this.poisoned) throw Error('storage_failure');
      if ('version' in command || 'op_id' in command || typeof command.op !== 'string') throw Error('invalid_command');
      const previous = stableKey === undefined ? undefined : this.journal.operations.find(op => op.key === stableKey);
      let op: Operation;
      if (previous) {
        const { version: _v, op_id: _id, ...saved } = previous.command;
        if (canonical(saved) !== canonical(command)) throw Error('operation_conflict');
        op = previous;
      } else {
        if (this.journal.operations.some(op => !op.response)) throw Error('pending_operation_requires_recovery');
        // Preserve room for cancellation, draining, finish and close.
        const cap = ['cancel', 'finish', 'close', 'poll', 'status'].includes(command.op as string) ? 512 : 480;
        if (this.journal.operations.length >= cap) throw Error('limit_exceeded');
        const complete = { version: 2, op_id: randomBytes(32).toString('hex'), ...command };
        if (Buffer.byteLength(JSON.stringify(complete)) > 65_536) throw Error('invalid_command');
        op = { key: stableKey ?? null, command: strictJson(JSON.stringify(complete)), signed: null, response: null };
        this.journal.operations.push(op); await this.persist();
      }
      if (op.response) return structuredClone(op.response);
      return this.transmit(op);
    });
  }
  remaining(): number {
    // A conservative recovery allowance in addition to the record-count cap.
    const bytes = Buffer.byteLength(JSON.stringify(this.journal)) + 1;
    return Math.min(512 - this.journal.operations.length, Math.floor((MAX_FILE - bytes) / 65_536));
  }
  /** Replace only the authenticated transport generation. Retained operation
   * IDs, signed envelopes and responses stay in this journal. */
  replacePeer(peer: NativePeer): Promise<void> {
    return this.serialize(async () => {
      if (!peer.selected.includes('payment.sui.streaming.v1') || !peer.selected.includes('service.research.conversation.v2')) throw Error('unsupported_service');
      this.peer = peer;
    });
  }
  private async transmit(op: Operation): Promise<AgentServiceReply> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!op.signed || BigInt(op.signed.message.expires_ms) <= BigInt(Date.now())) {
        op.signed = await this.peer.sign(KIND, { session: this.peer.session, content: utf8(JSON.stringify(op.command)) }, op.signed?.message.id ?? null);
        await this.persist();
      }
      const result = await this.peer.request(KIND, {}, op.signed);
      if (result.receipt.state === 'completed' && result.receipt.result !== null) {
        const body = strictJson(result.receipt.result);
        if (body.version !== 2 || body.op_id !== op.command.op_id || typeof body.type !== 'string') throw Error('invalid_service_response');
        op.response = { body, envelope: result.response };
        await this.persist(); return structuredClone(op.response);
      }
      // The service's op_id contract, not a generic retry assumption, permits this.
      op.signed = await this.peer.sign(KIND, { session: this.peer.session, content: utf8(JSON.stringify(op.command)) }, op.signed.message.id);
      await this.persist();
    }
    throw Error('uncertain_execution');
  }
}
