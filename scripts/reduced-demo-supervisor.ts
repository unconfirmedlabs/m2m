/**
 * The reduced demo's coordinator is intentionally deterministic.  It accepts
 * a user request, persists its admission, and delegates the paid operation to
 * the existing ResearchPort.  It has no model, tool, planner, or autonomous
 * retry loop; AgentServiceClient remains the authority for payment and
 * provider continuity.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readOptional, save } from './native-chain.js';
import type { AgentProfile, ResearchPort, ResearchResult } from './agent-service-types.js';
import type { AgentRuntimeDescriptor } from './agent-runtime.js';
import type { AgentServiceConfig } from './agent-services.js';

type TaskState = 'running' | 'completed' | 'uncertain';
interface TaskRecord {
  id: string;
  prompt: string;
  state: TaskState;
  outcome: ResearchResult['receipt']['outcome'] | null;
  updated_at_ms: string;
  /** Retained terminal result makes exact replay local-only. */
  result?: ResearchResult;
}
interface SupervisorJournal {
  version: 1;
  conversation: string;
  configuration_hash: string;
  tasks: TaskRecord[];
}

const ID = /^[0-9a-f]{64}$/u;
const DECIMAL = /^(0|[1-9][0-9]*)$/u;

function fixed(value: unknown): never { throw new Error(typeof value === 'string' ? value : 'journal_corrupt'); }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fixed('journal_corrupt');
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return fixed('journal_corrupt');
  return value as Record<string, unknown>;
}

export function deterministicSupervisorProfile(): AgentProfile {
  return {
    id: 'm2m.reduced.user-driven.v1',
    baseInstructions: 'No model is used by the reduced coordinator.',
    developerInstructions: 'Forward the user prompt exactly once to the funded research service.',
    tools: [], maxToolCalls: 1, maxToolResultBytes: 1, recoverableTools: [],
    handleTool: async () => ({ success: false, text: 'tool dispatch is not part of the reduced coordinator' }),
  };
}

export class DeterministicDemoSupervisor {
  private active?: string;
  private activeRun?: Promise<ResearchResult>;
  private cancelRequested = false;
  private constructor(private readonly path: string, private readonly journal: SupervisorJournal,
    private readonly port: ResearchPort, private readonly maxRequests: number) {}

  static async open(options: {
    stateDir: string; create: boolean; conversation: string; configurationHash: string;
    port: ResearchPort; config: AgentServiceConfig;
  }): Promise<DeterministicDemoSupervisor> {
    if (!ID.test(options.conversation) || !ID.test(options.configurationHash) || !Number.isSafeInteger(options.config.budget.max_requests) || options.config.budget.max_requests < 1) throw Error('invalid_config');
    const path = join(options.stateDir, 'supervisor', 'supervisor.json');
    const existing = await readOptional<unknown>(path);
    if (existing && options.create) throw Error('already_initialized');
    const journal = existing ? DeterministicDemoSupervisor.validate(existing, options.conversation, options.configurationHash) :
      { version: 1 as const, conversation: options.conversation, configuration_hash: options.configurationHash, tasks: [] };
    if (!existing && !options.create) throw Error('journal_missing');
    let normalized = false;
    for (const task of journal.tasks) {
      // A process exit while the port was in flight is durable uncertainty,
      // never an implicit permission to dispatch again on the next boot.
      if (task.state === 'running') { task.state = 'uncertain'; task.updated_at_ms = String(Date.now()); normalized = true; }
    }
    if (normalized) await save(path, journal);
    if (!existing) await save(path, journal);
    return new DeterministicDemoSupervisor(path, journal, options.port, options.config.budget.max_requests);
  }

  private static validate(value: unknown, conversation: string, configurationHash: string): SupervisorJournal {
    const root = exact(value, ['version', 'conversation', 'configuration_hash', 'tasks']);
    if (root.version !== 1 || root.conversation !== conversation || root.configuration_hash !== configurationHash || !Array.isArray(root.tasks) || root.tasks.length > 32) return fixed('journal_corrupt');
    const seen = new Set<string>();
    const tasks = root.tasks.map(item => {
      if (!isRecord(item)) return fixed('journal_corrupt');
      const keys = Object.keys(item);
      if (keys.length !== 5 && keys.length !== 6) return fixed('journal_corrupt');
      const task = exact(item, keys.length === 6 ? ['id', 'prompt', 'state', 'outcome', 'updated_at_ms', 'result'] : ['id', 'prompt', 'state', 'outcome', 'updated_at_ms']);
      if (typeof task.id !== 'string' || !ID.test(task.id) || seen.has(task.id) || typeof task.prompt !== 'string' || Buffer.byteLength(task.prompt) > 64 * 1024 ||
        !['running', 'completed', 'uncertain'].includes(task.state as string) || (task.outcome !== null && !['completed', 'failed', 'cancelled'].includes(task.outcome as string)) ||
        typeof task.updated_at_ms !== 'string' || !DECIMAL.test(task.updated_at_ms) ||
        (task.result !== undefined && (!isRecord(task.result) || typeof task.result.text !== 'string' || !isRecord(task.result.receipt)))) return fixed('journal_corrupt');
      if (task.state === 'completed' && task.outcome === null) return fixed('journal_corrupt');
      seen.add(task.id);
      return structuredClone(task) as unknown as TaskRecord;
    });
    return { version: 1, conversation, configuration_hash: configurationHash, tasks };
  }

  private async persist(): Promise<void> { await save(this.path, structuredClone(this.journal)); }

  profile(): AgentProfile { return deterministicSupervisorProfile(); }
  fingerprint(descriptor: AgentRuntimeDescriptor): string {
    return createHash('sha256').update(JSON.stringify({ descriptor, supervisor: 'm2m.reduced.user-driven.v1', tools: [] })).digest('hex');
  }
  status(): { activeTask: string | null; activeRequest: string | null; state: 'idle' | 'running' | 'recovering' | 'uncertain' } {
    const task = this.active ? this.journal.tasks.find(item => item.id === this.active) : this.journal.tasks.find(item => item.state === 'running' || item.state === 'uncertain');
    return { activeTask: task?.id ?? null, activeRequest: task?.id ?? null,
      state: this.active ? 'running' : task?.state === 'running' ? 'recovering' : task?.state === 'uncertain' ? 'uncertain' : 'idle' };
  }
  taskState(id: string): TaskState | null { return this.journal.tasks.find(task => task.id === id)?.state ?? null; }
  submissionBlock(): 'conversation_busy' | 'uncertain_execution' | 'limit_exceeded' | null {
    if (this.active || this.journal.tasks.some(item => item.state === 'running')) return 'conversation_busy';
    if (this.journal.tasks.some(item => item.state === 'uncertain')) return 'uncertain_execution';
    if (this.journal.tasks.length >= this.maxRequests) return 'limit_exceeded';
    return null;
  }

  async run(input: { id: string; prompt: string }): Promise<ResearchResult> {
    if (!ID.test(input.id) || typeof input.prompt !== 'string' || Buffer.byteLength(input.prompt) > 64 * 1024) throw Error('invalid_request');
    if (this.active) throw Error('conversation_busy');
    let task = this.journal.tasks.find(item => item.id === input.id);
    if (task && task.prompt !== input.prompt) throw Error('request_conflict');
    if (!task) {
      if (this.journal.tasks.length >= this.maxRequests) throw Error('limit_exceeded');
      if (this.journal.tasks.some(item => item.state === 'running' || item.state === 'uncertain')) throw Error('conversation_busy');
      task = { id: input.id, prompt: input.prompt, state: 'running', outcome: null, updated_at_ms: String(Date.now()) };
      this.journal.tasks.push(task); await this.persist();
    } else if (task.state === 'uncertain') {
      // A retry is an explicit operator/user replay. AgentServiceClient will
      // resume its exact journal or return its retained terminal receipt.
      task.state = 'running'; task.updated_at_ms = String(Date.now()); await this.persist();
    } else if (task.state === 'completed') {
      if (!task.result) throw Error('replay_unavailable');
      return structuredClone(task.result);
    }
    this.active = input.id; this.cancelRequested = false;
    const run = this.port.execute({ requestId: input.id, prompt: input.prompt });
    this.activeRun = run;
    try {
      const result = await run;
      task.state = 'completed'; task.outcome = result.receipt.outcome; task.result = structuredClone(result); task.updated_at_ms = String(Date.now()); await this.persist();
      return result;
    } catch (error) {
      task.state = 'uncertain'; task.updated_at_ms = String(Date.now()); await this.persist().catch(() => {});
      throw error;
    } finally { this.active = undefined; this.activeRun = undefined; this.cancelRequested = false; }
  }

  async cancel(): Promise<{ confirmed: boolean }> {
    if (!this.active) return { confirmed: false };
    this.cancelRequested = true;
    return this.port.cancel(this.active);
  }

  async shutdown(): Promise<void> {
    if (this.activeRun) throw Error('worker_shutdown_uncertain');
  }
}
