/** Offline, effect-free initialization for the two exported reduced-demo roots. */
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentEvents } from './agent-events.js';
import { DemoComponents } from './agent-demo-components.js';
import { DemoProjection } from './agent-demo-projection.js';
import { NativeLock } from './native-lock.js';
import { readDemoHostConfig, type DemoHostConfig } from './agent-demo-server.js';
import { canonicalDemoJson } from './agent-demo-event-contract.js';
import { makePolicy } from './streaming-codec.js';
import { save } from './native-chain.js';

export async function initializeReducedDemoState(config: DemoHostConfig): Promise<{ version: 1; state: 'initialized'; role: DemoHostConfig['role']; conversation: string; configuration_hash: string }> {
  const state = resolve(config.state_dir);
  let metadata;
  try { metadata = await lstat(state); } catch { throw Error('state_directory_missing'); }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) throw Error('state_directory_missing');
  const configurationHash = createConfigurationHash(config);
  const root = join(state, 'agent-services', config.conversation, config.role);
  try {
    const rootMetadata = await lstat(root);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw Error('already_initialized');
    const entries = await readdir(root);
    if (entries.some(entry => entry !== '.agent-services.lock')) throw Error('already_initialized');
    const lockMetadata = await lstat(join(root, '.agent-services.lock')).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (lockMetadata && (lockMetadata.isSymbolicLink() || !lockMetadata.isFile())) throw Error('already_initialized');
  } catch (error) {
    if (error instanceof Error && error.message === 'already_initialized') throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('state_directory_missing');
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = await NativeLock.acquire(join(root, '.agent-services.lock'));
  try {
    // Recheck after taking the lock. Only the lock file is harmless; every
    // other surviving entry may contain provider, economic, or identity state.
    const entries = await readdir(root);
    if (entries.some(entry => entry !== '.agent-services.lock')) throw Error('already_initialized');
    const pins = { role: config.role, conversation: config.conversation, configuration_hash: configurationHash, test_dependencies_used: false as const };
    const policy = makePolicy(['input_utf8_bytes', 'output_utf8_bytes'], [config.config.price.input_rate, config.config.price.output_rate], config.config.price.denominator);
    const projection = await DemoProjection.open({ stateDir: config.projection_state_dir, create: true, conversation: config.conversation,
      pins: { conversation: config.conversation, configuration_hash: configurationHash, config: structuredClone(config.config), agents: structuredClone(config.agents) } });
    await projection.close();
    await save(join(root, 'manifest.json'), { version: 1, role: config.role, conversation: config.conversation, agents: config.agents, config: config.config, configuration_hash: configurationHash, initialized: true });
    await save(join(root, 'initialized.json'), { version: 1 });
    await save(join(root, 'runtime.json'), { version: 1, role: config.role, conversation: config.conversation, desired: 'offline', generation: '0', spending_paused: false, controls: [], selected_channel: null, locator: null });
    const events = await AgentEvents.open(join(root, 'events.json'), config.conversation, () => {}, false);
    await events.close();
    await DemoComponents.open(root, true, pins);
    if (config.role === 'provider') await save(join(root, 'host.json'), { version: 2, conversation: config.conversation, agents: config.agents, policy, deposit: config.config.deposit_mist, quotes: [], channels: [], operations: [] });
    return { version: 1, state: 'initialized', role: config.role, conversation: config.conversation, configuration_hash: configurationHash };
  } finally { await lock.close(); }
}

function createConfigurationHash(config: DemoHostConfig): string {
  return createHash('sha256').update(canonicalDemoJson({ config: config.config, agents: config.agents }), 'utf8').digest('hex');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const configPath = process.argv[2];
  if (!configPath) { process.exitCode = 1; }
  else readDemoHostConfig(configPath).then(initializeReducedDemoState).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(() => { process.exitCode = 1; });
}
