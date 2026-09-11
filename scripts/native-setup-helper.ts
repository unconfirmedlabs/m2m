/**
 * Import-safe orchestration for native demo provisioning.
 *
 * This module deliberately knows nothing about Sui clients, filesystem key
 * material, or process arguments.  The CLI supplies the real ports and the
 * tests supply recording ports.  In particular, transaction ports own the
 * exact signed-journal/replay implementation; this layer only fixes the
 * authority and ordering contract around it.
 */

export type SetupNetwork = 'testnet' | 'localnet';
export type SetupRole = 'local' | 'research';
export type SetupMode = 'legacy' | 'separate';

export interface SetupSigner {
  toSuiAddress(): string;
}

export interface SetupConfig {
  network: SetupNetwork;
  rpc_url: string;
  chain_id: string;
  package_id: string;
  domain: string;
}

export interface SetupAgent {
  agent: string;
  controller: string;
}

export interface SetupAuthorization {
  controller: string;
  transport_key: number[];
  economic_key: number[];
}

export interface SetupRoleInput {
  role: SetupRole;
  transport_key: number[];
  economic_key: number[];
  /** Public key derived from the role's persisted iroh-key.json secret. */
  iroh_key: number[];
  existing?: SetupAgent;
}

export interface SetupTransactionResult {
  digest: string;
  created?: Array<{ id: string; type?: string }>;
}

export interface SetupTransactionPort {
  publish(input: {
    sender: SetupSigner;
    journal: string;
    operation: string;
  }): Promise<SetupTransactionResult & { package_id: string }>;
  moveCall(input: {
    sender: SetupSigner;
    module: 'identity';
    function: 'create_domain' | 'register';
    args: readonly unknown[];
    journal: string;
    operation: string;
  }): Promise<SetupTransactionResult & { object_id?: string; agent?: string }>;
}

export interface SetupChainPort {
  /** Must perform the network/chain-identifier check before any mutation. */
  checkNetwork(): Promise<string>;
  validate(config: SetupConfig): Promise<void>;
  clock(): Promise<bigint>;
  resolve(agent: string): Promise<SetupAuthorization>;
}

export interface SetupParent {
  name: string;
  registration: string;
  owner: string;
  expires_ms: string;
}

export interface SetupNamesPort {
  parent(): Promise<SetupParent>;
  createLeaves(input: {
    targets: { local: string; research: string };
    signer: SetupSigner;
    journal: string;
  }): Promise<unknown>;
}

export interface SetupManifest {
  version: 1;
  initialized: true;
  mode: SetupMode;
  network: SetupNetwork;
  rpc_url: string;
  chain_id: string;
  package_id: string;
  domain: string;
  controller_wallet: string;
  name_wallet: string;
  agents: Record<SetupRole, string>;
  role_keys: Record<SetupRole, { transport_key: number[]; economic_key: number[]; iroh_key: number[] }>;
  transactions: Record<string, string>;
  operations: Record<'publish' | 'domain' | 'local' | 'research' | 'names', string>;
  /** Set before an effect begins and cleared only after its result is retained. */
  in_flight?: Record<string, { journal: string; operation: string }>;
}

export interface NativeSetupPorts {
  chain: SetupChainPort;
  transactions: SetupTransactionPort;
  names?: SetupNamesPort;
  /** Recovery admission must distinguish an existing exact journal from a lost one. */
  hasJournal?: (journal: string) => Promise<boolean>;
  loadManifest?: () => Promise<SetupManifest | undefined>;
  saveManifest?: (manifest: SetupManifest) => Promise<void>;
}

export interface NativeSetupOptions {
  network: string;
  rpc_url: string;
  controller: SetupSigner;
  /** Explicitly supplied only for SuiNS leaf creation. */
  nameWallet?: SetupSigner;
  createNames: boolean;
  stateDir: string;
  initialConfig?: SetupConfig;
  roles: readonly SetupRoleInput[];
  ports: NativeSetupPorts;
}

export interface NativeSetupResult {
  config: SetupConfig;
  agents: Record<SetupRole, string>;
  namesCreated: boolean;
  manifest: SetupManifest;
}

function requireRoleInputs(roles: readonly SetupRoleInput[]): [SetupRoleInput, SetupRoleInput] {
  const byRole = new Map<SetupRole, SetupRoleInput>();
  for (const input of roles) {
    if (input.role !== 'local' && input.role !== 'research') throw new Error('unsupported setup role');
    if (byRole.has(input.role)) throw new Error('duplicate setup role');
    byRole.set(input.role, input);
  }
  const local = byRole.get('local');
  const research = byRole.get('research');
  if (!local || !research) throw new Error('both local and research setup roles are required');
  for (const role of [local, research]) {
    if (!keyBytes(role.transport_key) || !keyBytes(role.economic_key) || !keyBytes(role.iroh_key) ||
        Buffer.from(role.transport_key).equals(Buffer.from(role.economic_key)) || !Buffer.from(role.transport_key).equals(Buffer.from(role.iroh_key))) {
      throw new Error(`Invalid ${role.role} operational keys`);
    }
  }
  return [local, research];
}

function assertDifferentWallets(controller: SetupSigner, nameWallet: SetupSigner): void {
  if (controller.toSuiAddress() === nameWallet.toSuiAddress()) {
    throw new Error('Demo controller and name wallet must be different addresses');
  }
}

function assertExistingControllers(
  roles: readonly SetupRoleInput[],
  controller: SetupSigner,
): void {
  const expected = controller.toSuiAddress();
  for (const role of roles) {
    if (role.existing && role.existing.controller !== expected) {
      throw new Error(`Existing ${role.role} Agent belongs to a different controller`);
    }
  }
}

const OPERATION_IDS: SetupManifest['operations'] = {
  publish: 'publish-native-v1', domain: 'create-native-domain',
  local: 'register:local', research: 'register:research', names: 'create-leaves',
};

function setupMode(options: NativeSetupOptions): SetupMode {
  return options.nameWallet ? 'separate' : 'legacy';
}

function emptyAgents(roles: readonly SetupRoleInput[]): Record<SetupRole, string> {
  return {
    local: roles.find(role => role.role === 'local')?.existing?.agent ?? '',
    research: roles.find(role => role.role === 'research')?.existing?.agent ?? '',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function keyBytes(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === 32 && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255);
}

function roleKeyPins(value: unknown): value is SetupManifest['role_keys'] {
  if (!isRecord(value)) return false;
  for (const role of ['local', 'research'] as const) {
    const pins = value[role];
    if (!isRecord(pins) || !keyBytes(pins.transport_key) || !keyBytes(pins.economic_key) || !keyBytes(pins.iroh_key) ||
        Buffer.from(pins.transport_key).equals(Buffer.from(pins.economic_key)) || !Buffer.from(pins.transport_key).equals(Buffer.from(pins.iroh_key))) return false;
  }
  return true;
}

function assertManifestShape(manifest: SetupManifest): void {
  if (!manifest || manifest.version !== 1 || manifest.initialized !== true ||
      (manifest.mode !== 'legacy' && manifest.mode !== 'separate') ||
      (manifest.network !== 'testnet' && manifest.network !== 'localnet') ||
      typeof manifest.rpc_url !== 'string' || !manifest.rpc_url || typeof manifest.chain_id !== 'string' || !manifest.chain_id ||
      typeof manifest.package_id !== 'string' || typeof manifest.domain !== 'string' ||
      typeof manifest.controller_wallet !== 'string' || !manifest.controller_wallet || typeof manifest.name_wallet !== 'string' || !manifest.name_wallet ||
      !isRecord(manifest.agents) || typeof manifest.agents.local !== 'string' || typeof manifest.agents.research !== 'string' ||
      !roleKeyPins(manifest.role_keys) ||
      !isRecord(manifest.transactions) || Object.values(manifest.transactions).some(value => typeof value !== 'string') ||
      !isRecord(manifest.operations) ||
      Object.entries(OPERATION_IDS).some(([key, value]) => manifest.operations[key as keyof SetupManifest['operations']] !== value)) {
    throw new Error('Invalid initialized setup manifest');
  }
  if (manifest.in_flight !== undefined) {
    if (!isRecord(manifest.in_flight) || Object.values(manifest.in_flight).some(value => !isRecord(value) || typeof value.journal !== 'string' || !value.journal || typeof value.operation !== 'string' || !value.operation)) {
      throw new Error('Invalid initialized setup manifest');
    }
  }
}

function assertManifestAdmission(
  manifest: SetupManifest,
  options: NativeSetupOptions,
  config: SetupConfig | undefined,
  roles: readonly SetupRoleInput[],
  nameWallet: SetupSigner,
  chainId: string,
): void {
  assertManifestShape(manifest);
  if (manifest.mode !== setupMode(options) || manifest.network !== options.network || manifest.rpc_url !== options.rpc_url ||
      manifest.chain_id !== chainId || manifest.controller_wallet !== options.controller.toSuiAddress() ||
      manifest.name_wallet !== nameWallet.toSuiAddress()) throw new Error('Existing setup authority or network pin mismatch');
  if (config && (manifest.package_id !== config.package_id || manifest.domain !== config.domain)) throw new Error('Existing setup deployment pin mismatch');
  for (const role of roles) {
    const pinned = manifest.agents[role.role];
    if (pinned && role.existing?.agent !== pinned) throw new Error(`Existing ${role.role} Agent pin mismatch`);
    if (pinned && !role.existing) throw new Error(`Existing ${role.role} Agent pin is missing locally`);
    const keys = manifest.role_keys[role.role];
    if (!Buffer.from(keys.transport_key).equals(Buffer.from(role.transport_key)) ||
        !Buffer.from(keys.economic_key).equals(Buffer.from(role.economic_key)) ||
        !Buffer.from(keys.iroh_key).equals(Buffer.from(role.iroh_key))) throw new Error(`Existing ${role.role} operational key pin mismatch`);
  }
}

function manifestFor(options: NativeSetupOptions, config: SetupConfig | undefined, chainId: string, nameWallet: SetupSigner, roles: readonly SetupRoleInput[], prior?: SetupManifest): SetupManifest {
  const agents = emptyAgents(roles);
  if (prior?.agents.local) agents.local = prior.agents.local;
  if (prior?.agents.research) agents.research = prior.agents.research;
  return {
    version: 1, initialized: true, mode: setupMode(options), network: options.network as SetupNetwork,
    rpc_url: options.rpc_url, chain_id: chainId, package_id: config?.package_id ?? prior?.package_id ?? '',
    domain: config?.domain ?? prior?.domain ?? '', controller_wallet: options.controller.toSuiAddress(),
    name_wallet: nameWallet.toSuiAddress(), agents,
    role_keys: prior?.role_keys ?? {
      local: { transport_key: [...roles.find(role => role.role === 'local')!.transport_key], economic_key: [...roles.find(role => role.role === 'local')!.economic_key], iroh_key: [...roles.find(role => role.role === 'local')!.iroh_key] },
      research: { transport_key: [...roles.find(role => role.role === 'research')!.transport_key], economic_key: [...roles.find(role => role.role === 'research')!.economic_key], iroh_key: [...roles.find(role => role.role === 'research')!.iroh_key] },
    },
    transactions: { ...(prior?.transactions ?? {}) }, operations: { ...OPERATION_IDS }, in_flight: { ...(prior?.in_flight ?? {}) },
  };
}

async function preflightExisting(
  roles: readonly SetupRoleInput[],
  controller: SetupSigner,
  config: SetupConfig | undefined,
  chain: SetupChainPort,
): Promise<Map<SetupRole, SetupAuthorization>> {
  const existing = roles.filter(role => role.existing);
  if (!existing.length) return new Map();
  if (!config) throw new Error('Existing Agents require a pinned setup deployment');
  await chain.validate(config);
  const resolved = await Promise.all(existing.map(async role => [role.role, await chain.resolve(role.existing!.agent)] as const));
  const expected = controller.toSuiAddress();
  const result = new Map<SetupRole, SetupAuthorization>();
  for (const [role, authorization] of resolved) {
    const input = roles.find(candidate => candidate.role === role)!;
    if (authorization.controller !== expected ||
        !Buffer.from(authorization.transport_key).equals(Buffer.from(input.transport_key)) ||
        !Buffer.from(authorization.economic_key).equals(Buffer.from(input.economic_key))) {
      throw new Error(`Existing ${role} Agent authority mismatch`);
    }
    result.set(role, authorization);
  }
  return result;
}

/**
 * Provision the two native demo Agents with explicit authority separation.
 *
 * `nameWallet` is intentionally not a general transaction signer: it is only
 * passed to `names.createLeaves`.  Without that option the old one-wallet
 * localnet/testnet behavior is retained.  All public mutations pass a
 * journal and deterministic operation identity to the transaction port.
 */
export async function provisionNativeDemo(options: NativeSetupOptions): Promise<NativeSetupResult> {
  const { controller, ports } = options;
  const [local, research] = requireRoleInputs(options.roles);
  if (options.network !== 'testnet' && options.network !== 'localnet') {
    throw new Error('Only testnet/localnet are supported');
  }
  if (options.createNames && options.network !== 'testnet') {
    throw new Error('Names are testnet only');
  }
  if (options.nameWallet && !options.createNames) {
    throw new Error('--name-wallet requires --create-names');
  }
  const nameWallet = options.nameWallet ?? controller;
  if (options.nameWallet) {
    assertDifferentWallets(controller, nameWallet);
    if (!ports.names) throw new Error('Name creation requires a SuiNS port');
    // This read is deliberately first: wrong parent ownership must not be
    // discovered after publication, domain creation, or Agent registration.
    const parent = await ports.names.parent();
    if (parent.owner !== nameWallet.toSuiAddress()) {
      throw new Error('Name wallet does not control the parent registration');
    }
  }

  // A local state record is enough to reject an authority mismatch before any
  // new transaction.  The chain port performs the stronger authority checks
  // for every existing Agent after the immutable deployment is selected.
  assertExistingControllers(options.roles, controller);
  const chainId = await ports.chain.checkNetwork();
  let config = options.initialConfig;
  const prior = await ports.loadManifest?.();
  if (!prior && (config || options.roles.some(role => role.existing))) {
    throw new Error('Existing setup manifest is required for recovery');
  }
  if (prior) assertManifestAdmission(prior, options, config, options.roles, nameWallet, chainId);
  if (!config && prior?.package_id && prior.domain) config = { network: options.network as SetupNetwork, rpc_url: options.rpc_url, chain_id: chainId, package_id: prior.package_id, domain: prior.domain };
  const existingAuthorizations = await preflightExisting(options.roles, controller, config, ports.chain);
  let manifest = manifestFor(options, config, chainId, nameWallet, options.roles, prior);
  const persistManifest = async (): Promise<void> => { if (ports.saveManifest) await ports.saveManifest(manifest); };
  if (!prior) await persistManifest();
  const transactions: Record<string, string> = manifest.transactions;
  const effectJournal = (key: keyof SetupManifest['operations']): string => {
    if (key === 'publish') return `${options.stateDir}/publish.tx.json`;
    if (key === 'domain') return `${options.stateDir}/domain.tx.json`;
    if (key === 'local') return `${options.stateDir}/local/register.tx.json`;
    if (key === 'research') return `${options.stateDir}/research/register.tx.json`;
    return `${options.stateDir}/names.tx.json`;
  };
  const effectTransaction = (key: keyof SetupManifest['operations']): string => key === 'local' ? 'register_local' : key === 'research' ? 'register_research' : key;
  const beginEffect = async (key: keyof SetupManifest['operations']): Promise<void> => {
    const journal = effectJournal(key); const pending = manifest.in_flight?.[key];
    if (pending && (pending.journal !== journal || pending.operation !== manifest.operations[key])) throw new Error('Invalid initialized setup manifest');
    if ((pending || manifest.transactions[effectTransaction(key)]) && (!ports.hasJournal || !await ports.hasJournal(journal))) throw new Error(`Recovery required for ${key}; exact submitted journal is missing`);
    manifest.in_flight = { ...(manifest.in_flight ?? {}), [key]: { journal, operation: manifest.operations[key] } };
    await persistManifest();
  };
  const completeEffect = async (key: keyof SetupManifest['operations']): Promise<void> => {
    if (manifest.in_flight) { const next = { ...manifest.in_flight }; delete next[key]; manifest.in_flight = next; }
    await persistManifest();
  };
  if (config) {
    if (config.network !== options.network || config.rpc_url !== options.rpc_url || config.chain_id !== chainId) {
      throw new Error('Existing setup network mismatch');
    }
    // A saved package/domain pin is the retained result boundary for those
    // effects. Clear only their in-flight markers after proving the exact
    // submitted journals still exist; never turn a missing journal into a
    // fresh publish/domain operation.
    let clearedConfigurationMarkers = false;
    for (const key of ['publish', 'domain'] as const) {
      if (!manifest.in_flight?.[key]) continue;
      const journal = effectJournal(key);
      if (!ports.hasJournal || !await ports.hasJournal(journal)) throw new Error(`Recovery required for ${key}; exact submitted journal is missing`);
      const next = { ...(manifest.in_flight ?? {}) }; delete next[key]; manifest.in_flight = next; clearedConfigurationMarkers = true;
    }
    if (clearedConfigurationMarkers) await persistManifest();
  } else {
    await beginEffect('publish');
    const published = await ports.transactions.publish({
      sender: controller,
      journal: `${options.stateDir}/publish.tx.json`,
      operation: 'publish-native-v1',
    });
    config = {
      network: options.network,
      rpc_url: options.rpc_url,
      chain_id: chainId,
      package_id: published.package_id,
      domain: '',
    };
    transactions.publish = published.digest;
    manifest = manifestFor(options, config, chainId, nameWallet, options.roles, { ...manifest, transactions });
    await persistManifest();
    await completeEffect('publish');
    await beginEffect('domain');
    const domain = await ports.transactions.moveCall({
      sender: controller,
      module: 'identity',
      function: 'create_domain',
      args: [Array.from(Buffer.from(chainId))],
      journal: `${options.stateDir}/domain.tx.json`,
      operation: 'create-native-domain',
    });
    if (!domain.object_id) throw new Error('Domain transaction did not return a Domain');
    transactions.domain = domain.digest;
    config = { ...config, domain: domain.object_id };
    manifest = manifestFor(options, config, chainId, nameWallet, options.roles, manifest);
    await persistManifest();
    await completeEffect('domain');
  }
  await ports.chain.validate(config);

  const agents: Partial<Record<SetupRole, string>> = {};
  for (const role of [local, research]) {
    let identity = role.existing;
    if (!identity) {
      const expires = (await ports.chain.clock() + 86_400_000n).toString();
      await beginEffect(role.role);
      const registered = await ports.transactions.moveCall({
        sender: controller,
        module: 'identity',
        function: 'register',
        args: [config.domain, role.transport_key, role.economic_key, expires, '0x6'],
        journal: `${options.stateDir}/${role.role}/register.tx.json`,
        operation: `register:${role.role}`,
      });
      if (!registered.agent) throw new Error(`Missing registered ${role.role} Agent`);
      identity = { agent: registered.agent, controller: controller.toSuiAddress() };
      transactions[`register_${role.role}`] = registered.digest;
    }
    if (identity.controller !== controller.toSuiAddress()) {
      throw new Error(`Setup ${role.role} controller mismatch`);
    }
    const authorization = existingAuthorizations.get(role.role) ?? await ports.chain.resolve(identity.agent);
    if (authorization.controller !== controller.toSuiAddress() ||
        !Buffer.from(authorization.transport_key).equals(Buffer.from(role.transport_key)) ||
        !Buffer.from(authorization.economic_key).equals(Buffer.from(role.economic_key))) throw new Error(`Existing ${role.role} Agent authority mismatch`);
    agents[role.role] = identity.agent;
    manifest = manifestFor(options, config, chainId, nameWallet, options.roles, { ...manifest, agents: { ...manifest.agents, [role.role]: identity.agent }, transactions });
    await persistManifest();
    if (!role.existing) await completeEffect(role.role);
  }
  if (!agents.local || !agents.research) throw new Error('Missing registered demo Agents');

  if (options.createNames) {
    if (!ports.names) throw new Error('Name creation requires a SuiNS port');
    await beginEffect('names');
    const named = await ports.names.createLeaves({
      targets: { local: agents.local, research: agents.research },
      signer: nameWallet,
      journal: `${options.stateDir}/names.tx.json`,
    });
    // The name port owns its exact transaction result; it must retain the
    // journal even when all leaves already exist.  The manifest only pins the
    // public deployment addresses and operation digests.
    void named;
    transactions.names = transactions.names ?? 'completed';
    await persistManifest();
    await completeEffect('names');
  }
  manifest = manifestFor(options, config, chainId, nameWallet, options.roles, { ...manifest, agents: { local: agents.local, research: agents.research }, transactions });
  await persistManifest();
  return { config, agents: manifest.agents, namesCreated: options.createNames, manifest };
}

export interface RoleKeyExportInput {
  role: 'buyer' | 'provider';
  transport_secret_key: string;
  economic_secret_key: string;
  /** Buyer controller key is allowed only in the buyer export. */
  buyer_controller_secret_key?: string;
}

/** Build a role export without ever copying the parent or counterpart key. */
export function buildRoleKeyExport(input: RoleKeyExportInput): Record<string, string> {
  const result: Record<string, string> = {
    role: input.role,
    transport_secret_key: input.transport_secret_key,
    economic_secret_key: input.economic_secret_key,
  };
  if (input.role === 'buyer' && input.buyer_controller_secret_key) {
    result.buyer_controller_secret_key = input.buyer_controller_secret_key;
  }
  return result;
}
