/** Explicit durable worker stub for lifecycle tests; never model evidence. */
import { join } from 'node:path';
import { readOptional, save } from '../../scripts/native-chain.js';
import type { AgentWorker } from '../../scripts/agent-service-types.js';

export async function fixtureWorkerState(options: { stateDir: string; create: boolean }, worker: AgentWorker): Promise<AgentWorker> {
  const files = ['responses-worker.json', 'responses-worker.initialized'].map(file => join(options.stateDir, file));
  const values = await Promise.all(files.map(file => readOptional(file)));
  if (options.create) {
    if (values.some(Boolean)) throw Error('already_initialized');
    for (const file of files) await save(file, { version: 1, fixture_only: true });
  } else if (!values.every(Boolean)) throw Error('journal_missing');
  return worker;
}
