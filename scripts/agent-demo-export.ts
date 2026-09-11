/** Explicit operator-only role export. Never imported by the HTTP/image graph.
 * Reads current testnet authority; performs no chain mutation, model call or
 * runtime start. Existing/partial targets are never overwritten or repaired.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { NativeChain, readKey, save, type NativeConfig } from './native-chain.js';
import { NativeNames } from './native-names.js';
import { NativeLock } from './native-lock.js';
import { canonicalDemoJson } from './agent-demo-event-contract.js';
import { strictJson } from './native-peer.js';
import { readDemoHostConfig, type DemoHostConfig } from './agent-demo-server.js';
import type { SetupManifest } from './native-setup-helper.js';

const fail = (code: string): never => { throw Error(code); };
const same = (a: unknown, b: unknown) => canonicalDemoJson(a) === canonicalDemoJson(b);
const secretRoot = '/data/m2m/secrets';
const SAFE = new Set(['invalid_export_arguments', 'invalid_export_source', 'invalid_export_config', 'export_identity_mismatch',
  'export_target_exists', 'export_target_unsafe', 'credential_unavailable', 'state_directory_in_use']);
export function exportFailure(error: unknown): string {
  return error instanceof Error && SAFE.has(error.message) ? error.message : 'export_failed';
}
async function protectedPath(path: string, directory = false): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes('\0')) fail('export_target_unsafe');
  const meta = await lstat(path);
  if (meta.isSymbolicLink() || (directory ? !meta.isDirectory() : !meta.isFile()) || (meta.mode & 0o077) !== 0 ||
      (!directory && meta.size > 256 * 1024) || await realpath(path) !== path) fail('export_target_unsafe');
  return path;
}
async function json<T>(path: string): Promise<T> {
  await protectedPath(path);
  return strictJson(await readFile(path, 'utf8')) as T;
}
async function secret(path: string, token = false): Promise<string> {
  await protectedPath(path);
  const value = (await readFile(path, 'utf8')).replace(/\r?\n$/u, '');
  if (!value || Buffer.byteLength(value) > 16 * 1024 || /[\u0000-\u001f\u007f]/u.test(value) ||
      (token && (!/^[0-9a-f]{64}$/.test(value) || /^0+$/.test(value)))) fail('credential_unavailable');
  return value;
}
async function saveSecret(path: string, value: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
async function freshTarget(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path || path === dirname(path)) fail('export_target_unsafe');
  await protectedPath(dirname(path), true);
  const existing = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) fail('export_target_exists');
}
function validateHosts(coordinator: DemoHostConfig, provider: DemoHostConfig): void {
  if (coordinator.role !== 'coordinator' || provider.role !== 'provider' || coordinator.network !== 'testnet' || provider.network !== 'testnet' ||
      coordinator.conversation !== provider.conversation || !same(coordinator.agents, provider.agents) || !same(coordinator.config, provider.config) ||
      !same(coordinator.runtime, provider.runtime) || coordinator.provider_base_url !== provider.provider_base_url) fail('invalid_export_config');
  // Export writes only these fixed role-relative destinations, never arbitrary
  // config paths. Model/API keys are not accepted inline or from ambient env.
  for (const host of [coordinator, provider]) {
    if (host.model_api_key_file !== `${secretRoot}/model.key` || host.observer_token_file !== `${secretRoot}/observer.token`) fail('invalid_export_config');
  }
  if (coordinator.wallet_file !== `${secretRoot}/controller.json` || coordinator.viewer_token_file !== `${secretRoot}/viewer.token` ||
      coordinator.operator_token_file !== `${secretRoot}/operator.token` || provider.search_api_key_file !== `${secretRoot}/search.key`) fail('invalid_export_config');
  const privateHost = new URL(provider.provider_base_url);
  const publicHost = new URL(coordinator.public_origin!);
  if (!/^[a-z][a-z0-9-]{1,61}\.internal$/.test(privateHost.hostname) || privateHost.port !== '8081' ||
      !/^[a-z][a-z0-9-]{1,61}\.fly\.dev$/.test(publicHost.hostname) || publicHost.port ||
      privateHost.hostname.slice(0, -9) === publicHost.hostname.slice(0, -8)) fail('invalid_export_config');
}

export async function runDemoExport(argv = process.argv.slice(2)): Promise<{ version: 1; state: 'exported'; conversation: string; configuration_hash: string }> {
  const fields = ['setup-state', 'coordinator-config', 'provider-config', 'coordinator-root', 'provider-root', 'wallet',
    'model-key-file', 'search-key-file', 'viewer-token-file', 'operator-token-file', 'observer-token-file'] as const;
  const options = Object.fromEntries(fields.map(field => [field, { type: 'string' as const }]));
  let values: Record<string, string | boolean | undefined>;
  try { values = parseArgs({ args: argv, options, strict: true, allowPositionals: false }).values; } catch { fail('invalid_export_arguments'); }
  if (fields.some(field => typeof values[field] !== 'string' || !isAbsolute(values[field] as string))) fail('invalid_export_arguments');
  const value = (field: typeof fields[number]) => values[field] as string;
  const source = await protectedPath(value('setup-state'), true);
  const targets = { coordinator: value('coordinator-root'), provider: value('provider-root') };
  for (const target of Object.values(targets)) {
    if (target === source || target.startsWith(`${source}/`) || source.startsWith(`${target}/`)) fail('export_target_unsafe');
    await freshTarget(target);
  }
  if (targets.coordinator === targets.provider || targets.coordinator.startsWith(`${targets.provider}/`) || targets.provider.startsWith(`${targets.coordinator}/`)) fail('export_target_unsafe');
  const coordinator = await readDemoHostConfig(await protectedPath(value('coordinator-config')));
  const provider = await readDemoHostConfig(await protectedPath(value('provider-config')));
  validateHosts(coordinator, provider);
  const lock = await NativeLock.acquire(join(source, '.setup.lock'));
  try {
    const manifest = await json<SetupManifest>(join(source, 'setup-manifest.json'));
    const config = await json<NativeConfig>(join(source, 'chain.json'));
    if (manifest.version !== 1 || !manifest.initialized || manifest.mode !== 'separate' || manifest.network !== 'testnet' ||
        manifest.controller_wallet === manifest.name_wallet || Object.keys(manifest.in_flight ?? {}).length ||
        !same(config, { network: manifest.network, rpc_url: manifest.rpc_url, chain_id: manifest.chain_id, package_id: manifest.package_id, domain: manifest.domain }) ||
        !manifest.role_keys || !manifest.agents?.local || !manifest.agents?.research) fail('invalid_export_source');
    await protectedPath(value('wallet'));
    const controller = await readKey(value('wallet'));
    if (controller.toSuiAddress() !== manifest.controller_wallet) fail('export_identity_mismatch');
    const chain = new NativeChain(config);
    for (const [role, ref] of [['local', coordinator.agents.buyer], ['research', coordinator.agents.provider]] as const) {
      if (!same(chain.reference(manifest.agents[role]), ref)) fail('export_identity_mismatch');
    }
    const keys = await Promise.all((['local', 'research'] as const).map(async role => {
      await protectedPath(join(source, role), true);
      const read = async (purpose: string) => readKey(await protectedPath(join(source, role, `${purpose}.json`)));
      const [transport, economic, iroh] = await Promise.all([read('transport'), read('economic'), read('iroh-key')]);
      const transportPublic = [...transport.getPublicKey().toRawBytes()], economicPublic = [...economic.getPublicKey().toRawBytes()];
      if (same(transportPublic, economicPublic) || !iroh.getPublicKey().equals(transport.getPublicKey()) ||
          !same(manifest.role_keys[role], { transport_key: transportPublic, economic_key: economicPublic, iroh_key: transportPublic })) fail('export_identity_mismatch');
      return { transport, economic, transportPublic, economicPublic };
    }));
    const secrets = { model: await secret(value('model-key-file')), search: await secret(value('search-key-file')),
      viewer: await secret(value('viewer-token-file'), true), operator: await secret(value('operator-token-file'), true), observer: await secret(value('observer-token-file'), true) };
    if (new Set([secrets.viewer, secrets.operator, secrets.observer]).size !== 3) fail('invalid_export_config');
    await chain.validate();
    const names = new NativeNames(chain);
    const checked = await Promise.all([names.resolve('local.nozomi.sui', coordinator.agents.buyer), names.resolve('research.nozomi.sui', coordinator.agents.provider)]);
    for (let index = 0; index < checked.length; index++) {
      const result = checked[index]!, key = keys[index]!;
      if (result.parent.owner !== manifest.name_wallet || result.authorization.controller !== controller.toSuiAddress() ||
          !same(result.authorization.transport_key, key.transportPublic) || !same(result.authorization.economic_key, key.economicPublic)) fail('export_identity_mismatch');
    }
    const configuration_hash = createHash('sha256').update(canonicalDemoJson({ config: coordinator.config, agents: coordinator.agents })).digest('hex');
    // All authority/config/credential checks precede either private export.
    // mkdir is exclusive. A failure leaves a protected, visibly partial root;
    // rerunning never replaces it or generates another identity.
    for (const [index, role, localRole, host] of [[0, 'coordinator', 'local', coordinator], [1, 'provider', 'research', provider]] as const) {
      const target = targets[role], key = keys[index]!;
      await mkdir(target, { mode: 0o700 });
      await save(join(target, 'export.json'), { version: 1, state: 'pending', role, conversation: host.conversation, configuration_hash });
      await mkdir(join(target, localRole), { mode: 0o700 }); await mkdir(join(target, 'secrets'), { mode: 0o700 });
      await save(join(target, 'chain.json'), config);
      await save(join(target, 'public-identities.json'), { version: 1, agents: host.agents, names: checked });
      await save(join(target, localRole, 'transport.json'), { secret_key: key.transport.getSecretKey() });
      await save(join(target, localRole, 'iroh-key.json'), { secret_key: [...decodeSuiPrivateKey(key.transport.getSecretKey()).secretKey] });
      await save(join(target, localRole, 'economic.json'), { secret_key: key.economic.getSecretKey() });
      await save(join(target, localRole, 'identity.json'), { agent: checked[index]!.authorization.agent.agent, controller: checked[index]!.authorization.controller });
      await save(join(target, localRole, 'authorization.json'), checked[index]!.authorization);
      await saveSecret(join(target, 'secrets', 'model.key'), secrets.model);
      await saveSecret(join(target, 'secrets', 'observer.token'), secrets.observer);
      if (role === 'coordinator') {
        await save(join(target, 'secrets', 'controller.json'), { secret_key: controller.getSecretKey() });
        await saveSecret(join(target, 'secrets', 'viewer.token'), secrets.viewer); await saveSecret(join(target, 'secrets', 'operator.token'), secrets.operator);
      } else await saveSecret(join(target, 'secrets', 'search.key'), secrets.search);
      // Reconstruct from the validated allowlist; never copy source directories
      // or arbitrary fields that could contain a parent/counterpart secret.
      await save(join(target, 'host.json'), host);
    }
    for (const role of ['coordinator', 'provider'] as const) await save(join(targets[role], 'export.json'),
      { version: 1, state: 'exported', role, conversation: coordinator.conversation, configuration_hash });
    return { version: 1, state: 'exported', conversation: coordinator.conversation, configuration_hash };
  } finally { await lock.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runDemoExport().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => {
    process.stderr.write(JSON.stringify({ version: 1, code: exportFailure(error) }) + '\n'); process.exitCode = 1;
  });
}
