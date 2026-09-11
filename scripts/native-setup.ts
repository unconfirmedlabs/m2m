import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { NativeChain, readKey, readOptional, save, TESTNET_RPC, type NativeConfig } from './native-chain.js';
import { NativeNames } from './native-names.js';
import { NativeLock } from './native-lock.js';
import { provisionNativeDemo, type NativeSetupPorts, type SetupAuthorization, type SetupConfig, type SetupManifest, type SetupRoleInput } from './native-setup-helper.js';

export * from './native-setup-helper.js';

interface SetupArgs {
  wallet?: string;
  state?: string;
  network?: string;
  'create-names'?: boolean;
  'name-wallet'?: string;
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      wallet: { type: 'string' },
      state: { type: 'string' },
      network: { type: 'string', default: 'testnet' },
      'create-names': { type: 'boolean', default: false },
      'name-wallet': { type: 'string' },
    },
    strict: true,
  });
  const args = values as SetupArgs;
  if (!args.wallet) throw new Error('--wallet must name a local testnet key file (never pass the key itself)');
  if (args.network !== 'testnet' && args.network !== 'localnet') throw new Error('Only testnet/localnet are supported');
  const network = args.network;
  const rpc = network === 'testnet' ? TESTNET_RPC : 'http://127.0.0.1:9000';
  if (args['create-names'] && network !== 'testnet') throw new Error('Names are testnet only');
  if (args['name-wallet'] && !args['create-names']) throw new Error('--name-wallet requires --create-names');
  const state = resolve(args.state ?? `.m2m/native-${network}`);
  await mkdir(state, { recursive: true, mode: 0o700 });
  const lock = await NativeLock.acquire(`${state}/.setup.lock`);
  try {
    const wallet = await readKey(resolve(args.wallet));
    const nameWallet = args['name-wallet'] ? await readKey(resolve(args['name-wallet'])) : wallet;
    if (args['name-wallet'] && wallet.toSuiAddress() === nameWallet.toSuiAddress()) {
      throw new Error('Demo controller and name wallet must be different addresses');
    }

    const priorManifest = await readOptional<SetupManifest>(`${state}/setup-manifest.json`);
    if (!priorManifest) {
      const initializedArtifacts = [
        'chain.json', 'publish.tx.json', 'domain.tx.json', 'names.tx.json',
        'local/transport.json', 'local/economic.json', 'local/iroh-key.json', 'local/identity.json', 'local/authorization.json', 'local/register.tx.json',
        'research/transport.json', 'research/economic.json', 'research/iroh-key.json', 'research/identity.json', 'research/authorization.json', 'research/register.tx.json',
      ];
      for (const relative of initializedArtifacts) {
        try { await stat(`${state}/${relative}`); throw new Error('Initialized setup manifest is required'); }
        catch (error) { if (error instanceof Error && error.message === 'Initialized setup manifest is required') throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
    const roles: SetupRoleInput[] = [];
    for (const role of ['local', 'research'] as const) {
      const roleState = `${state}/${role}`;
      await mkdir(roleState, { recursive: true, mode: 0o700 });
      const purposeKeys: Record<'transport' | 'economic', Ed25519Keypair> = {} as Record<'transport' | 'economic', Ed25519Keypair>;
      for (const purpose of ['transport', 'economic'] as const) {
        const path = `${roleState}/${purpose}.json`;
        if (!await readOptional(path)) {
          if (priorManifest) throw new Error(`Missing pinned ${role} ${purpose} key`);
          const key = Ed25519Keypair.generate();
          await save(path, { secret_key: key.getSecretKey(), address: key.toSuiAddress() });
        }
        purposeKeys[purpose] = await readKey(path);
      }
      if (purposeKeys.transport.getPublicKey().equals(purposeKeys.economic.getPublicKey())) throw new Error('Operational keys must differ');
      if (!await readOptional(`${roleState}/iroh-key.json`)) {
        if (priorManifest) throw new Error(`Missing pinned ${role} transport key`);
        await save(`${roleState}/iroh-key.json`, { secret_key: Array.from(decodeSuiPrivateKey(purposeKeys.transport.getSecretKey()).secretKey) });
      }
      const irohKey = await readKey(`${roleState}/iroh-key.json`);
      if (!irohKey.getPublicKey().equals(purposeKeys.transport.getPublicKey())) throw new Error(`Pinned ${role} iroh transport key mismatch`);
      const identity = await readOptional<{ agent: string; controller: string }>(`${roleState}/identity.json`) ??
        (priorManifest?.agents[role] ? { agent: priorManifest.agents[role], controller: priorManifest.controller_wallet } : undefined);
      roles.push({ role, transport_key: Array.from(purposeKeys.transport.getPublicKey().toRawBytes()), economic_key: Array.from(purposeKeys.economic.getPublicKey().toRawBytes()), iroh_key: Array.from(irohKey.getPublicKey().toRawBytes()), existing: identity });
    }
    const initialConfig = await readOptional<NativeConfig>(`${state}/chain.json`);
    let activeChain: NativeChain | undefined;
    let checkedChainId: string | undefined;
    const getChain = (): NativeChain => {
      if (!activeChain) throw new Error('Native chain is not initialized');
      return activeChain;
    };
    const chainPort = {
      checkNetwork: async (): Promise<string> => {
        if (activeChain) return activeChain.checkNetwork();
        const client = new SuiGrpcClient({ network, baseUrl: rpc });
        const [{ chainIdentifier }, { response: info }] = await Promise.all([client.core.getChainIdentifier(), client.ledgerService.getServiceInfo({})]);
        if (info.chain === 'mainnet' || (network === 'testnet' && info.chain !== 'testnet')) throw new Error('Unexpected network before provisioning');
        checkedChainId = chainIdentifier;
        activeChain = new NativeChain({ network, rpc_url: rpc, chain_id: chainIdentifier, package_id: normalizeSuiAddress('0'), domain: normalizeSuiAddress('0') });
        return chainIdentifier;
      },
      validate: async (value: SetupConfig): Promise<void> => { activeChain = new NativeChain(value); await activeChain.validate(); },
      clock: async (): Promise<bigint> => getChain().clock(),
      resolve: async (agent: string): Promise<SetupAuthorization> => { const value = await getChain().resolve(getChain().reference(agent)); return { controller: value.controller, transport_key: value.transport_key, economic_key: value.economic_key }; },
    };
    const transactionPort = {
      publish: async (input: { sender: Ed25519Keypair; journal: string; operation: string }) => {
        let build = await readOptional<{ modules: string[]; dependencies: string[] }>(`${state}/build.json`);
        if (!build) { const { stdout } = await promisify(execFile)('bash', ['scripts/sui.sh', 'move', 'build', '--path', 'move/streaming', '--dump-bytecode-as-base64'], { maxBuffer: 16 * 1024 * 1024 }); build = JSON.parse(stdout) as { modules: string[]; dependencies: string[] }; await save(`${state}/build.json`, build); }
        if (!build.modules.length) throw new Error('Missing native Move bytecode');
        const tx = new Transaction(); tx.setGasBudget(100_000_000); const [cap] = tx.publish(build); tx.transferObjects([cap], input.sender.toSuiAddress());
        const result = await getChain().execute(tx, input.sender, input.journal, input.operation) as { digest: string; created: Array<{ id: string; type?: string }> }; const packageId = result.created.find((item: { id: string; type?: string }) => item.type === 'package')?.id; if (!packageId) throw new Error('Publication did not create a package');
        activeChain = new NativeChain({ network, rpc_url: rpc, chain_id: checkedChainId!, package_id: packageId, domain: normalizeSuiAddress('0') });
        return { digest: result.digest, package_id: packageId };
      },
      moveCall: async (input: { sender: Ed25519Keypair; module: 'identity'; function: 'create_domain' | 'register'; args: readonly unknown[]; journal: string; operation: string }) => {
        const chain = getChain(); const tx = new Transaction();
        if (input.function === 'create_domain') {
          const network = Array.isArray(input.args[0]) ? input.args[0] as number[] : Array.from(Buffer.from(String(input.args[0])));
          chain.call(tx, 'identity', 'create_domain', [tx.pure.vector('u8', network)]);
        }
        else chain.call(tx, 'identity', 'register', [tx.object(String(input.args[0])), tx.pure.vector('u8', input.args[1] as number[]), tx.pure.vector('u8', input.args[2] as number[]), tx.pure.u64(String(input.args[3])), tx.object(String(input.args[4]))]);
        const result = await chain.execute(tx, input.sender, input.journal, input.operation) as { digest: string; created: Array<{ id: string; type?: string }> };
        if (input.function === 'create_domain') { const domain = result.created.find((item: { id: string; type?: string }) => item.type?.endsWith('::identity::Domain'))?.id; if (!domain) throw new Error('Missing native Domain'); activeChain = new NativeChain({ network, rpc_url: rpc, chain_id: checkedChainId!, package_id: chain.config.package_id, domain }); return { digest: result.digest, object_id: domain }; }
        const agent = result.created.find((item: { id: string; type?: string }) => item.type?.endsWith('::identity::Agent'))?.id; if (!agent) throw new Error('Missing registered Agent'); return { digest: result.digest, agent };
      },
    };
    const namesPort = {
      parent: async () => { if (!activeChain) await chainPort.checkNetwork(); return getChain().config.network === 'testnet' ? new NativeNames(getChain()).parent() : Promise.reject(new Error('Names are testnet only')); },
      createLeaves: async (input: { targets: { local: string; research: string }; signer: { toSuiAddress(): string }; journal: string }) => new NativeNames(getChain()).createLeaves(input.targets, nameWallet, input.journal),
    };
    const ports: NativeSetupPorts = { chain: chainPort, transactions: transactionPort, names: namesPort,
      hasJournal: async journal => { try { await stat(journal); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } },
      loadManifest: async () => priorManifest,
      saveManifest: async manifest => save(`${state}/setup-manifest.json`, manifest),
    };
    const result = await provisionNativeDemo({ network, rpc_url: rpc, controller: wallet, nameWallet: args['name-wallet'] ? nameWallet : undefined, createNames: Boolean(args['create-names']), stateDir: state, initialConfig, roles, ports });
    await save(`${state}/chain.json`, result.config);
    for (const role of ['local', 'research'] as const) {
      await save(`${state}/${role}/identity.json`, { agent: result.agents[role], controller: wallet.toSuiAddress() });
      await save(`${state}/${role}/authorization.json`, await getChain().resolve(getChain().reference(result.agents[role])));
    }
    console.log(JSON.stringify({ network, controller_wallet: wallet.toSuiAddress(), name_wallet: nameWallet.toSuiAddress(), package_id: result.config.package_id, domain: result.config.domain, agents: result.agents, names: result.namesCreated, transactions: result.manifest.transactions }));
  } finally {
    await lock.close();
  }
}

export { main as runNativeSetup };

function safeSetupFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const safe = new Set([
    '--wallet must name a local testnet key file (never pass the key itself)',
    'Only testnet/localnet are supported', 'Names are testnet only',
    '--name-wallet requires --create-names', 'Demo controller and name wallet must be different addresses',
    'Name creation requires a SuiNS port', 'Name wallet does not control the parent registration',
    'Initialized setup manifest is required', 'Invalid initialized setup manifest',
    'Existing setup manifest is required for recovery', 'Existing setup authority or network pin mismatch',
    'Existing setup deployment pin mismatch', 'Recovery required: exact submitted transaction journal is missing',
    'Native setup failed',
  ]);
  if (safe.has(message) || /^Existing (local|research) Agent (authority|pin) mismatch$/.test(message) ||
      /^Existing (local|research) operational key pin mismatch$/.test(message) ||
      /^Missing pinned (local|research) (transport|economic) key$/.test(message) ||
      /^Pinned (local|research) iroh transport key mismatch$/.test(message)) return message;
  if (/^Recovery required for (publish|domain|local|research|names); exact submitted journal is missing$/.test(message)) return 'Recovery required: exact submitted transaction journal is missing';
  // The CLI is a fixed public error surface. Never forward SDK, RPC, child
  // process, filesystem, request, or serialized response text.
  return 'Native setup failed';
}

export { safeSetupFailure };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(safeSetupFailure(error)); process.exitCode = 1; });
}
