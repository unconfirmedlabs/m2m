/** Bounded public projection. Callers supply only explicitly public data, never worker journals. */
import { readFile, stat } from 'node:fs/promises';
import { readOptional, save } from './native-chain.js';
import { strictJson } from './native-peer.js';
import { exactKeys, u64 } from './streaming-codec.js';

export const AGENT_EVENT_TYPES = ['task_started', 'model_text', 'tool_started', 'tool_result',
  'request_started', 'delivery', 'turn_terminal', 'budget', 'channel_final', 'settlement', 'error',
  // Additive local demo lifecycle records, not native wire message types.
  'runtime', 'connection', 'control', 'funding', 'authorization', 'chain_observation'] as const;
export type AgentEventType = typeof AGENT_EVENT_TYPES[number];
export type AgentEventRole = 'coordinator' | 'research' | 'host';
export interface AgentPublicEvent {
  version: 1;
  id: string;
  role: AgentEventRole;
  conversation: string;
  request: string | null;
  at_ms: string;
  type: AgentEventType;
  data: Record<string, unknown>;
}
interface EventJournal { version: 1; conversation: string; events: AgentPublicEvent[] }
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const roles: AgentEventRole[] = ['coordinator', 'research', 'host'];
// Match the duplicate-key/depth-checking parser's byte cap; never write a file
// that the next process would be unable to reopen.
const MAX_JOURNAL_BYTES = 1024 * 1024;
const MAX_RECORDS = 8192;

/** The caller owns the Agent-root NativeLock. A saved event always precedes its publication. */
export class AgentEvents {
  private queue: Promise<unknown> = Promise.resolve();
  private poisoned = false;
  private readonly listeners = new Set<(event: AgentPublicEvent) => void>();
  private constructor(readonly path: string, private journal: EventJournal,
    private publish: (event: AgentPublicEvent) => void) {}

  static async open(path: string, conversation: string,
    publish: (event: AgentPublicEvent) => void = () => {}, required = false): Promise<AgentEvents> {
    if (!identifier(conversation)) throw Error('invalid_conversation');
    const size = await stat(path).then(s => s.size, e => { if (e.code === 'ENOENT') return 0; throw e; });
    if (size > MAX_JOURNAL_BYTES) throw Error('event_journal_limit');
    const initialized = await readOptional(`${path}.initialized`);
    const existing = await readFile(path, 'utf8').then(text => strictJson(text) as EventJournal,
      e => { if (e.code === 'ENOENT') return undefined; throw e; });
    if (!existing && (required || initialized)) throw Error('journal_missing');
    const journal = existing ?? { version: 1 as const, conversation, events: [] };
    exactKeys(journal, ['version', 'conversation', 'events']);
    if (journal.version !== 1 || journal.conversation !== conversation || !Array.isArray(journal.events) || journal.events.length > MAX_RECORDS) throw Error('journal_corrupt');
    const last = { coordinator: 0n, research: 0n, host: 0n };
    for (const event of journal.events) {
      exactKeys(event, ['version', 'id', 'role', 'conversation', 'request', 'at_ms', 'type', 'data']);
      if (event.version !== 1 || event.conversation !== conversation || !roles.includes(event.role) ||
        (event.request !== null && !identifier(event.request)) || !AGENT_EVENT_TYPES.includes(event.type) ||
        !event.data || Array.isArray(event.data) || typeof event.data !== 'object') throw Error('journal_corrupt');
      u64(event.at_ms);
      if (BigInt(u64(event.id)) !== ++last[event.role]) throw Error('journal_corrupt');
      if (Buffer.byteLength(JSON.stringify(event)) > 65_536) throw Error('journal_corrupt');
    }
    if (!existing) await save(path, journal);
    await save(`${path}.initialized`, { version: 1 });
    return new AgentEvents(path, journal, publish);
  }

  append(role: AgentEventRole, type: AgentEventType, data: Record<string, unknown>, request: string | null = null): Promise<AgentPublicEvent> {
    const pending = this.queue.then(async () => {
      if (this.poisoned) throw Error('storage_failure');
      if (!roles.includes(role) || !AGENT_EVENT_TYPES.includes(type) || (request !== null && !identifier(request)) ||
        !data || Array.isArray(data) || typeof data !== 'object') throw Error('invalid_event');
      // Roundtrip now, before taking an ID, so unsupported/cyclic values cannot mutate state.
      const publicData = strictJson(JSON.stringify(data));
      const previous = this.journal.events.filter(e => e.role === role).at(-1)?.id ?? '0';
      const event: AgentPublicEvent = { version: 1, id: u64(String(BigInt(previous) + 1n)), role,
        conversation: this.journal.conversation, request, at_ms: String(Date.now()), type, data: publicData };
      if (Buffer.byteLength(JSON.stringify(event)) > 65_536 || this.journal.events.length >= MAX_RECORDS) throw Error('event_journal_limit');
      const next: EventJournal = { ...this.journal, events: [...this.journal.events, event] };
      // save() pretty prints, so enforce the actual stored representation size.
      if (Buffer.byteLength(JSON.stringify(next, null, 2)) + 1 > MAX_JOURNAL_BYTES) throw Error('event_journal_limit');
      try { await save(this.path, next); } catch (error) { this.poisoned = true; throw error; }
      this.journal = next;
      this.publish(structuredClone(event));
      for (const listener of this.listeners) { try { listener(structuredClone(event)); } catch { /* observers cannot corrupt the journal */ } }
      return structuredClone(event);
    });
    this.queue = pending.catch(() => {});
    return pending;
  }

  replay(after: Partial<Record<AgentEventRole, string>> = {}): AgentPublicEvent[] {
    for (const [role, id] of Object.entries(after)) {
      if (!roles.includes(role as AgentEventRole)) throw Error('invalid_event_cursor');
      u64(id);
    }
    return structuredClone(this.journal.events.filter(e => BigInt(e.id) > BigInt(after[e.role] ?? '0')));
  }

  /** Additive local subscription used by the embedded demo runtime. */
  subscribe(listener: (event: AgentPublicEvent) => void): () => void {
    if (typeof listener !== 'function') throw Error('invalid_event_listener');
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }

  /** The runtime owns the enclosing NativeLock; this waits for its writer queue. */
  async close(): Promise<void> { await this.queue; }
}
