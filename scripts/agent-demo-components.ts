/** Lazy component creation under the enclosing runtime's exclusive lock.
 * A durable intent precedes construction. Only a completed constructor can
 * mark a component ready; interrupted creation never permits an empty reset.
 */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { readOptional, save } from './native-chain.js';
import { canonicalDemoJson } from './agent-demo-event-contract.js';
import { exactKeys } from './streaming-codec.js';

type Entry = { state: 'initializing' | 'ready'; files: string[] };
type Pins = { role: 'coordinator' | 'provider'; conversation: string; configuration_hash: string; test_dependencies_used: boolean };
type Journal = Pins & { version: 1; entries: Record<string, Entry> };
// These factory errors occur before construction of any durable worker state.
const WORKER_PREFLIGHT_ERRORS = new Set(['agent_tool_runtime_unvalidated', 'openai_credential_unavailable',
  'unsafe_openai_credential', 'invalid_openai_credential', 'missing_openai_credential', 'conflicting_openai_credentials', 'live_evidence_unavailable', 'unsafe_live_evidence', 'invalid_live_evidence', 'agent_runtime_gate_unavailable']);

function filesFor(name: string): string[] {
  if (name === 'budget') return ['budget/budget.json'];
  if (name === 'coordinator') return ['coordinator/coordinator.json'];
  if (name === 'supervisor') return ['supervisor/supervisor.json'];
  if (name === 'worker') return ['worker/responses-worker.json', 'worker/responses-worker.initialized'];
  if (name === 'exchange') return ['outbox.json'];
  const channel = /^(stream|client):(0x[0-9a-f]{64})$/.exec(name);
  if (channel) return [`channels/${channel[2]!.slice(2)}/${channel[1] === 'stream' ? 'stream.json' : 'client/client.json'}`];
  throw Error('journal_corrupt');
}

export class DemoComponents {
  private poisoned = false;
  private constructor(private root: string, private journal: Journal) {}
  private async exists(file: string): Promise<boolean> {
    const meta = await lstat(join(this.root, file)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!meta) return false;
    if (!meta.isFile() || meta.isSymbolicLink()) throw Error('journal_corrupt');
    return true;
  }
  static async open(root: string, create: boolean, pins: Pins): Promise<DemoComponents> {
    const previous = await readOptional<Journal>(join(root, 'components.json'));
    if (create && previous) throw Error('already_initialized');
    if (!create && !previous) throw Error('journal_missing');
    const journal = previous ?? { version: 1, ...pins, entries: {} };
    exactKeys(journal, ['version', 'role', 'conversation', 'configuration_hash', 'test_dependencies_used', 'entries']);
    if (journal.version !== 1 || journal.role !== pins.role || journal.conversation !== pins.conversation ||
        journal.configuration_hash !== pins.configuration_hash || journal.test_dependencies_used !== pins.test_dependencies_used ||
        !journal.entries || typeof journal.entries !== 'object' || Array.isArray(journal.entries) || Object.keys(journal.entries).length > 1024) throw Error('journal_corrupt');
    const result = new DemoComponents(root, journal);
    for (const [name, entry] of Object.entries(journal.entries)) {
      exactKeys(entry, ['state', 'files']);
      if (!['initializing', 'ready'].includes(entry.state) || canonicalDemoJson(entry.files) !== canonicalDemoJson(filesFor(name))) throw Error('journal_corrupt');
    }
    await result.validate();
    if (!previous) await result.persist();
    return result;
  }
  /** Check every recorded component before admitting workers or economic work. */
  async validate(): Promise<void> {
    if (this.poisoned) throw Error('storage_failure');
    for (const entry of Object.values(this.journal.entries)) {
      for (const file of entry.files) if (!await this.exists(file)) throw Error('journal_missing');
    }
  }
  private async persist(): Promise<void> {
    try { await save(join(this.root, 'components.json'), this.journal); }
    catch (error) { this.poisoned = true; throw error; }
  }
  async openComponent<T>(name: string, construct: (create: boolean) => Promise<T>): Promise<T> {
    if (this.poisoned) throw Error('storage_failure');
    const files = filesFor(name);
    const previous = this.journal.entries[name];
    if (previous) {
      for (const file of files) if (!await this.exists(file)) throw Error('journal_missing');
    } else {
      for (const file of files) if (await this.exists(file)) throw Error('journal_corrupt');
      this.journal.entries[name] = { state: 'initializing', files };
      await this.persist();
    }
    let value: T;
    try { value = await construct(!previous); }
    catch (error) {
      // A credential or gate refusal can be retried after operator repair,
      // provided it produced no durable worker artifacts.
      if (!previous && name === 'worker' && error instanceof Error && WORKER_PREFLIGHT_ERRORS.has(error.message) &&
          !(await Promise.all(files.map(file => this.exists(file)))).some(Boolean)) {
        delete this.journal.entries[name]; await this.persist();
      }
      throw error;
    }
    for (const file of files) if (!await this.exists(file)) throw Error('journal_missing');
    this.journal.entries[name] = { state: 'ready', files };
    await this.persist();
    return value;
  }
}
