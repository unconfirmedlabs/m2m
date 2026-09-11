import { mkdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { readOptional, save } from './native-chain.js';
import { NativeLock } from './native-lock.js';
import { strictJson } from './native-peer.js';
import { canonicalDemoJson, validateDemoEvent, validateDemoSourceEvent, validateSourceCursor } from './agent-demo-event-contract.js';
import type { AgentPublicEvent } from './agent-events.js';
import type { DemoEvent, DemoValidationPins, MachineRole, SourceCursor, SourcedEvent, U64 } from './demo-types.js';

const MAX_PROJECTION_BYTES = 16 * 1024 * 1024;
const MAX_PROJECTION_RECORDS = 16_384;
const MAX_REPLAY_BATCH = 256;
const SOURCE_ROLES = ['coordinator', 'research', 'host'] as const;

type ProjectionJournal = {
  version: 1;
  conversation: string;
  pins: DemoValidationPins;
  events: DemoEvent[];
};

type SourceCursors = Record<MachineRole, SourceCursor>;

function fixed(code: string): never { throw new Error(code); }
function own(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fixed('projection_corrupt');
  return value as Record<string, unknown>;
}
function exact(value: unknown, expected: readonly string[]): Record<string, unknown> {
  const object = own(value); const actual = Object.keys(object).sort(); const fields = [...expected].sort();
  if (actual.length !== fields.length || actual.some((key, index) => key !== fields[index])) return fixed('projection_corrupt');
  return object;
}
function clone<T>(value: T): T { return structuredClone(value); }
function emptyCursor(): SourceCursor { return { coordinator: '0', research: '0', host: '0' }; }
function emptyCursors(): SourceCursors { return { coordinator: emptyCursor(), provider: emptyCursor() }; }
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
function decimal(value: unknown): value is U64 { return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= (1n << 64n) - 1n; }

function cursorFromEvents(events: DemoEvent[], pins: DemoValidationPins): SourceCursors {
  const cursors = emptyCursors();
  for (const item of events) {
    const wrapper = validateDemoEvent(item, pins);
    const role = wrapper.event.role;
    const previous = BigInt(cursors[wrapper.source][role]);
    const current = BigInt(wrapper.event.id);
    if (current !== previous + 1n) fixed('projection_corrupt');
    cursors[wrapper.source][role] = wrapper.event.id as U64;
  }
  return cursors;
}

function validateJournal(value: unknown, pins: DemoValidationPins, conversation: string): ProjectionJournal {
  const root = exact(value, ['version', 'conversation', 'pins', 'events']);
  if (root.version !== 1 || root.conversation !== conversation || canonicalDemoJson(root.pins) !== canonicalDemoJson(pins)) fixed('projection_pin_mismatch');
  const rawEvents = root.events;
  if (!Array.isArray(rawEvents) || rawEvents.length > MAX_PROJECTION_RECORDS) fixed('projection_corrupt');
  const events: DemoEvent[] = [];
  let sequence = 0n;
  for (const raw of rawEvents) {
    const wrapper = exact(raw, ['version', 'sequence', 'source', 'event']);
    if (wrapper.version !== 1 || !decimal(wrapper.sequence) || BigInt(wrapper.sequence) !== ++sequence || (wrapper.source !== 'coordinator' && wrapper.source !== 'provider')) fixed('projection_corrupt');
    try { events.push(validateDemoEvent(wrapper, pins)); } catch { fixed('projection_corrupt'); }
  }
  cursorFromEvents(events, pins);
  return { version: 1, conversation, pins: clone(pins), events };
}

function serializedSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8');
}

export class DemoProjection {
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly listeners = new Set<(event: DemoEvent) => void>();
  private readonly cursors: SourceCursors;

  private constructor(
    readonly stateDir: string,
    private journal: ProjectionJournal,
    private readonly lock: NativeLock,
  ) { this.cursors = cursorFromEvents(journal.events, journal.pins); }

  static async open(options: { stateDir: string; create: boolean; conversation: string; pins: DemoValidationPins }): Promise<DemoProjection> {
    if (!isAbsolute(options.stateDir) || !identifier(options.conversation)) fixed('invalid_projection_config');
    const stateDir = resolve(options.stateDir); const path = join(stateDir, 'projection.json'); const marker = `${path}.initialized`;
    if (!options.create) {
      const existing = await stat(stateDir).catch(() => undefined);
      if (!existing?.isDirectory()) fixed('journal_missing');
    }
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const lock = await NativeLock.acquire(join(stateDir, 'NativeLock'));
    try {
      const size = await stat(path).then(item => item.size, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; });
      if (size > MAX_PROJECTION_BYTES) fixed('projection_limit');
      const raw = await readFile(path, 'utf8').then(text => strictJson(text) as unknown, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
      const initialized = await readOptional(marker);
      if (!raw) {
        if (!options.create || initialized) fixed('journal_missing');
        const initial: ProjectionJournal = { version: 1, conversation: options.conversation, pins: clone(options.pins), events: [] };
        if (serializedSize(initial) > MAX_PROJECTION_BYTES) fixed('projection_limit');
        await save(path, initial); await save(marker, { version: 1 });
        return new DemoProjection(stateDir, initial, lock);
      }
      if (!initialized) fixed('journal_missing');
      const journal = validateJournal(raw, options.pins, options.conversation);
      return new DemoProjection(stateDir, journal, lock);
    } catch (error) {
      await lock.close();
      if (error instanceof Error && /^(projection_|journal_|invalid_projection_|state_directory_)/.test(error.message)) throw error;
      throw new Error('projection_corrupt');
    }
  }

  ingest(input: SourcedEvent): Promise<DemoEvent | null> {
    return this.enqueue(async () => {
      if (this.closed) fixed('projection_closed');
      const source = input.source;
      if (source !== 'coordinator' && source !== 'provider') fixed('invalid_event');
      let event: AgentPublicEvent;
      try { event = validateDemoSourceEvent(input.event, { ...this.journal.pins, source }); } catch { fixed('invalid_event'); }
      const duplicate = this.journal.events.find(item => item.source === source && item.event.role === event.role && item.event.id === event.id);
      if (duplicate) {
        if (canonicalDemoJson(duplicate.event) !== canonicalDemoJson(event)) fixed('projection_conflict');
        return null;
      }
      const previous = BigInt(this.cursors[source][event.role]);
      const current = BigInt(event.id);
      if (current !== previous + 1n) fixed(current <= previous ? 'projection_conflict' : 'projection_gap');
      if (this.journal.events.length >= MAX_PROJECTION_RECORDS) fixed('projection_limit');
      const next: DemoEvent = { version: 1, sequence: String(BigInt(this.journal.events.at(-1)?.sequence ?? '0') + 1n) as U64, source, event: clone(event) };
      const journal: ProjectionJournal = { ...this.journal, events: [...this.journal.events, next] };
      if (serializedSize(journal) > MAX_PROJECTION_BYTES) fixed('projection_limit');
      await save(join(this.stateDir, 'projection.json'), journal);
      this.journal = journal; this.cursors[source][event.role] = event.id as U64;
      const publicEvent = clone(next);
      for (const listener of this.listeners) { try { listener(clone(publicEvent)); } catch { /* observers cannot corrupt the durable projection */ } }
      return publicEvent;
    });
  }

  replay(after: U64, limit = MAX_REPLAY_BATCH): DemoEvent[] {
    if (!decimal(after) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REPLAY_BATCH) fixed('invalid_event_cursor');
    if (BigInt(after) > BigInt(this.highWater())) fixed('future_cursor');
    return clone(this.journal.events.filter(item => BigInt(item.sequence) > BigInt(after)).slice(0, limit));
  }

  cursor(source: MachineRole): SourceCursor {
    if (source !== 'coordinator' && source !== 'provider') fixed('invalid_event_cursor');
    return clone(this.cursors[source]);
  }

  highWater(): U64 { return this.journal.events.at(-1)?.sequence ?? '0'; }

  subscribe(listener: (event: DemoEvent) => void): () => void {
    if (typeof listener !== 'function') fixed('invalid_projection_listener');
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    await this.lock.close();
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }
}
