import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { buildRoleKeyExport, provisionNativeDemo, type SetupManifest, type SetupSigner } from './native-setup-helper.js';
import { runNativeSetup, safeSetupFailure } from './native-setup.js';
import type {
  NativeSetupPorts, SetupAgent, SetupAuthorization, SetupConfig, SetupNamesPort, SetupChainPort,
  SetupParent, SetupRoleInput, SetupTransactionPort, SetupTransactionResult,
} from './native-setup-helper.js';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { NativeChain, readOptional, save, type NativeConfig } from './native-chain.js';
import { NativeNames } from './native-names.js';
import { SuiGrpcClient } from '@mysten/sui/grpc';

const controller = Ed25519Keypair.generate();
const parentOwner = Ed25519Keypair.generate();
const wrongOwner = Ed25519Keypair.generate();
const transportLocal = Ed25519Keypair.generate();
const economicLocal = Ed25519Keypair.generate();
const transportResearch = Ed25519Keypair.generate();
const economicResearch = Ed25519Keypair.generate();
const config: SetupConfig = {
  network: 'testnet', rpc_url: 'https://fullnode.testnet.sui.io:443', chain_id: 'test-chain',
  package_id: '0x11', domain: '0x12',
};

function roles(existing?: Partial<Record<'local' | 'research', SetupAgent>>): SetupRoleInput[] {
  return [
    { role: 'local', transport_key: Array.from(transportLocal.getPublicKey().toRawBytes()), economic_key: Array.from(economicLocal.getPublicKey().toRawBytes()), iroh_key: Array.from(transportLocal.getPublicKey().toRawBytes()), existing: existing?.local },
    { role: 'research', transport_key: Array.from(transportResearch.getPublicKey().toRawBytes()), economic_key: Array.from(economicResearch.getPublicKey().toRawBytes()), iroh_key: Array.from(transportResearch.getPublicKey().toRawBytes()), existing: existing?.research },
  ];
}

class RecordingTransactions implements SetupTransactionPort {
  readonly events: string[] = [];
  readonly calls: Array<{ function: string; sender: string; args: readonly unknown[] }> = [];
  private readonly journals = new Map<string, { sender: string; operation: string; result: SetupTransactionResult & { package_id?: string; object_id?: string; agent?: string } }>();
  private next = 1;
  failAfterDomainOnce = false;
  constructor(private readonly timeline?: string[]) {}
  hasJournal(journal: string): boolean { return this.journals.has(journal); }
  dropJournal(journal: string): void { this.journals.delete(journal); }

  async publish(input: { sender: SetupSigner; journal: string; operation: string }): Promise<SetupTransactionResult & { package_id: string }> {
    return this.run(input, 'publish', [], { package_id: '0x100' }) as unknown as Promise<SetupTransactionResult & { package_id: string }>;
  }

  async moveCall(input: { sender: SetupSigner; module: 'identity'; function: 'create_domain' | 'register'; args: readonly unknown[]; journal: string; operation: string }): Promise<SetupTransactionResult & { object_id?: string; agent?: string }> {
    this.calls.push({ function: input.function, sender: input.sender.toSuiAddress(), args: input.args });
    const extra: Record<string, string> = input.function === 'create_domain' ? { object_id: '0x200' } : { agent: input.operation.endsWith('local') ? '0x301' : '0x302' };
    const result = await this.run(input, input.function, input.args, extra);
    if (input.function === 'create_domain' && this.failAfterDomainOnce) { this.failAfterDomainOnce = false; throw new Error('interrupted_after_submit'); }
    return result;
  }

  private async run(input: { sender: SetupSigner; journal: string; operation: string }, event: string, _args: readonly unknown[], extra: Record<string, string>): Promise<SetupTransactionResult & Record<string, string>> {
    const sender = input.sender.toSuiAddress();
    const old = this.journals.get(input.journal);
    if (old) {
      if (old.sender !== sender || old.operation !== input.operation) throw new Error('Transaction journal operation or authority mismatch');
      this.events.push(`replay:${event}`);
      this.timeline?.push(`replay:${event}`);
      return old.result as SetupTransactionResult & Record<string, string>;
    }
    const result = { digest: `digest-${this.next++}`, ...extra };
    this.journals.set(input.journal, { sender, operation: input.operation, result });
    this.events.push(event);
    this.timeline?.push(event);
    return result;
  }
}

class RecordingChain {
  readonly events: string[] = [];
  constructor(private readonly auth: SetupAuthorization) {}
  async checkNetwork(): Promise<string> { this.events.push('network'); return 'test-chain'; }
  async validate(_config: SetupConfig): Promise<void> { this.events.push('validate'); }
  async clock(): Promise<bigint> { this.events.push('clock'); return 1_000n; }
  async resolve(agent: string): Promise<SetupAuthorization> {
    this.events.push('resolve');
    if (agent === '0x302') {
      return { ...this.auth, transport_key: Array.from(transportResearch.getPublicKey().toRawBytes()), economic_key: Array.from(economicResearch.getPublicKey().toRawBytes()) };
    }
    return this.auth;
  }
}

class RecordingNames implements SetupNamesPort {
  readonly events: string[] = [];
  private readonly journals = new Set<string>();
  constructor(private readonly owner: string, private readonly timeline?: string[]) {}
  hasJournal(journal: string): boolean { return this.journals.has(journal); }
  async parent(): Promise<SetupParent> {
    this.events.push('parent');
    this.timeline?.push('parent');
    return { name: 'nozomi.sui', registration: '0x99', owner: this.owner, expires_ms: '999999999999' };
  }
  async createLeaves(input: { targets: { local: string; research: string }; signer: SetupSigner; journal: string }): Promise<unknown> {
    this.journals.add(input.journal);
    this.events.push(`leaves:${input.signer.toSuiAddress()}`);
    this.timeline?.push(`leaves:${input.signer.toSuiAddress()}`);
    return input.targets;
  }
}

function ports(tx: RecordingTransactions, names: RecordingNames, chain: SetupChainPort = new RecordingChain({
  controller: controller.toSuiAddress(),
  transport_key: Array.from(transportLocal.getPublicKey().toRawBytes()),
  economic_key: Array.from(economicLocal.getPublicKey().toRawBytes()),
})): NativeSetupPorts {
  return { chain, transactions: tx, names, hasJournal: async journal => tx.hasJournal(journal) || names.hasJournal(journal) };
}

async function expectCode(action: () => Promise<unknown>, text: string): Promise<void> {
  await assert.rejects(action, new RegExp(text));
}

async function main(): Promise<void> {
  // Actual CLI orchestration regression: an interrupted first effect leaves
  // the initialized manifest authoritative; losing only that manifest must
  // fail before a second SDK/transaction effect is admitted.
  {
    const root = mkdtempSync(join('/tmp', 'm2m-native-cli-admission-')); const walletPath = join(root, 'controller.key'); const nameWalletPath = join(root, 'name.key');
    const wallet = Ed25519Keypair.generate(); const nameWallet = Ed25519Keypair.generate();
    writeFileSync(walletPath, JSON.stringify({ secret_key: wallet.getSecretKey() }), { mode: 0o600 }); writeFileSync(nameWalletPath, JSON.stringify({ secret_key: nameWallet.getSecretKey() }), { mode: 0o600 });
    writeFileSync(join(root, 'build.json'), JSON.stringify({ modules: ['AA=='], dependencies: [] }), { mode: 0o600 });
    const client = new SuiGrpcClient({ network: 'testnet', baseUrl: config.rpc_url });
    const corePrototype = Object.getPrototypeOf(client.core) as { getChainIdentifier: () => Promise<{ chainIdentifier: string }> };
    const ledgerPrototype = Object.getPrototypeOf(client.ledgerService) as { getServiceInfo: () => Promise<{ response: { chain: string } }> };
    const oldChainId = corePrototype.getChainIdentifier; const oldServiceInfo = ledgerPrototype.getServiceInfo; const oldParent = NativeNames.prototype.parent; const oldExecute = NativeChain.prototype.execute;
    let executeCalls = 0;
    corePrototype.getChainIdentifier = async () => ({ chainIdentifier: 'fixture-chain' }); ledgerPrototype.getServiceInfo = async () => ({ response: { chain: 'testnet' } });
    NativeNames.prototype.parent = async () => ({ name: 'nozomi.sui', registration: '0x99', owner: nameWallet.toSuiAddress(), expires_ms: '999999999999' });
    NativeChain.prototype.execute = (async function(this: NativeChain): Promise<never> { executeCalls += 1; throw new Error('FIXTURE_STOP_BEFORE_SUBMIT'); }) as NativeChain['execute'];
    const args = ['--wallet', walletPath, '--name-wallet', nameWalletPath, '--create-names', '--state', root, '--network', 'testnet'];
    try {
      await expectCode(() => runNativeSetup(args), 'FIXTURE_STOP_BEFORE_SUBMIT');
      assert.ok(await readOptional<SetupManifest>(join(root, 'setup-manifest.json')));
      const changedTransport = Ed25519Keypair.generate(); writeFileSync(join(root, 'local', 'iroh-key.json'), JSON.stringify({ secret_key: changedTransport.getSecretKey() }), { mode: 0o600 });
      await expectCode(() => runNativeSetup(args), 'Pinned local iroh transport key mismatch'); assert.equal(executeCalls, 1);
      renameSync(join(root, 'setup-manifest.json'), join(root, 'setup-manifest.lost'));
      await expectCode(() => runNativeSetup(args), 'Initialized setup manifest is required');
      assert.equal(executeCalls, 1);
    } finally { corePrototype.getChainIdentifier = oldChainId; ledgerPrototype.getServiceInfo = oldServiceInfo; NativeNames.prototype.parent = oldParent; NativeChain.prototype.execute = oldExecute; rmSync(root, { recursive: true, force: true }); }
  }

  // The public CLI error surface is finite even when an SDK exposes a secret-
  // looking request/response sentinel.
  assert.equal(safeSetupFailure(new Error('fixture_token=NOT_A_REAL_CREDENTIAL')), 'Native setup failed');
  assert.equal(safeSetupFailure(new Error('--name-wallet requires --create-names')), '--name-wallet requires --create-names');

  // Separate mode: owner check is the first event and every ABI mutation is
  // sent by the demo controller; only leaves use the name wallet.
  {
    const timeline: string[] = [];
    const tx = new RecordingTransactions(timeline);
    const names = new RecordingNames(parentOwner.toSuiAddress(), timeline);
    const result = await provisionNativeDemo({
      network: 'testnet', rpc_url: config.rpc_url, stateDir: '/fixture/demo', controller,
      nameWallet: parentOwner, createNames: true, roles: roles(), ports: ports(tx, names),
    });
    assert.equal(timeline[0], 'parent');
    assert.equal(timeline[1], 'publish');
    assert.equal(result.manifest.controller_wallet, controller.toSuiAddress());
    assert.equal(result.manifest.name_wallet, parentOwner.toSuiAddress());
    assert.ok(tx.calls.every(call => call.sender === controller.toSuiAddress()));
    assert.equal(names.events.at(-1), `leaves:${parentOwner.toSuiAddress()}`);
    assert.deepEqual(tx.calls.map(call => call.function), ['create_domain', 'register', 'register']);
  }

  // A wrong parent owner fails before even the chain network read or a
  // transaction port call.
  {
    const tx = new RecordingTransactions();
    const names = new RecordingNames(wrongOwner.toSuiAddress());
    const chain = new RecordingChain({ controller: controller.toSuiAddress(), transport_key: [], economic_key: [] });
    await expectCode(() => provisionNativeDemo({
      network: 'testnet', rpc_url: config.rpc_url, stateDir: '/fixture/wrong-parent', controller,
      nameWallet: parentOwner, createNames: true, roles: roles(), ports: ports(tx, names, chain),
    }), 'parent registration');
    assert.deepEqual(tx.events, []);
    assert.deepEqual(chain.events, []);
  }

  // Existing authority mismatch is preflighted before publication.
  {
    const tx = new RecordingTransactions();
    const names = new RecordingNames(parentOwner.toSuiAddress());
    await expectCode(() => provisionNativeDemo({
      network: 'testnet', rpc_url: config.rpc_url, stateDir: '/fixture/wrong-agent', controller,
      nameWallet: parentOwner, createNames: true,
      roles: roles({ local: { agent: '0x301', controller: wrongOwner.toSuiAddress() } }), ports: ports(tx, names),
    }), 'different controller');
    assert.deepEqual(tx.events, []);
  }

  // Legacy one-wallet mode remains valid and uses one signer for both setup
  // transactions and leaf creation; it does not add the separate-mode parent
  // preflight ahead of publication.
  {
    const tx = new RecordingTransactions();
    const names = new RecordingNames(controller.toSuiAddress());
    await provisionNativeDemo({
      network: 'testnet', rpc_url: config.rpc_url, stateDir: '/fixture/legacy', controller,
      createNames: true, roles: roles(), ports: ports(tx, names),
    });
    assert.equal(tx.events[0], 'publish');
    assert.equal(names.events.at(-1), `leaves:${controller.toSuiAddress()}`);
  }

  await expectCode(() => provisionNativeDemo({
    network: 'mainnet', rpc_url: 'https://mainnet.invalid', stateDir: '/fixture/mainnet', controller,
    createNames: false, roles: roles(), ports: ports(new RecordingTransactions(), new RecordingNames(controller.toSuiAddress())),
  }), 'testnet/localnet');

  // Journal binding is signer- and operation-bound: exact replay is allowed,
  // while a changed signer cannot reuse a prior operation journal.
  {
    const tx = new RecordingTransactions();
    await tx.publish({ sender: controller, journal: '/fixture/replay.tx.json', operation: 'same-operation' });
    await tx.publish({ sender: controller, journal: '/fixture/replay.tx.json', operation: 'same-operation' });
    assert.equal(tx.events.join(','), 'publish,replay:publish');
    await expectCode(() => tx.publish({ sender: parentOwner, journal: '/fixture/replay.tx.json', operation: 'same-operation' }), 'authority mismatch');
  }

  // The protected setup manifest is admitted before effects, pins authority
  // selection/mode/network/deployment and preserves operation identities on a
  // retry after a committed-but-unacknowledged domain transaction.
  {
    const manifestRoot = mkdtempSync(join('/tmp', 'm2m-native-manifest-')); const manifestPath = join(manifestRoot, 'setup-manifest.json');
    try {
      const timeline: string[] = []; const tx = new RecordingTransactions(timeline); tx.failAfterDomainOnce = true;
      const names = new RecordingNames(parentOwner.toSuiAddress(), timeline);
      const manifestPorts = (chain = ports(tx, names).chain): NativeSetupPorts => ({ ...ports(tx, names, chain), loadManifest: async () => readOptional<SetupManifest>(manifestPath), saveManifest: async manifest => save(manifestPath, manifest) });
      await expectCode(() => provisionNativeDemo({ network: 'testnet', rpc_url: config.rpc_url, stateDir: '/fixture/manifest-retry', controller, nameWallet: parentOwner, createNames: true, roles: roles(), ports: manifestPorts() }), 'interrupted_after_submit');
      const stored = await readOptional<SetupManifest>(manifestPath);
      assert.ok(stored?.initialized); assert.equal(stored?.mode, 'separate'); assert.equal(stored?.controller_wallet, controller.toSuiAddress());
      const retry = await provisionNativeDemo({ network: 'testnet', rpc_url: config.rpc_url, stateDir: '/fixture/manifest-retry', controller, nameWallet: parentOwner, createNames: true, roles: roles(), ports: manifestPorts() });
      assert.deepEqual(timeline.slice(0, 3), ['parent', 'publish', 'create_domain']);
      assert.ok(timeline.includes('replay:publish')); assert.ok(timeline.includes('replay:create_domain')); assert.equal(retry.manifest.controller_wallet, controller.toSuiAddress());
      const effectsBeforeNoOp = tx.events.length;
      const noOp = await provisionNativeDemo({ network: 'testnet', rpc_url: config.rpc_url, stateDir: '/fixture/manifest-retry', controller, nameWallet: parentOwner, createNames: true, initialConfig: retry.config, roles: roles({ local: { agent: retry.agents.local, controller: controller.toSuiAddress() }, research: { agent: retry.agents.research, controller: controller.toSuiAddress() } }), ports: manifestPorts() });
      assert.deepEqual(noOp.manifest.agents, retry.manifest.agents); assert.equal(tx.events.length, effectsBeforeNoOp);
      const effectsBeforeReject = tx.events.length;
      const changedIroh = [...noOp.manifest.role_keys.local.iroh_key]; changedIroh[0] = (changedIroh[0] + 1) % 256;
      await save(manifestPath, { ...noOp.manifest, role_keys: { ...noOp.manifest.role_keys, local: { ...noOp.manifest.role_keys.local, iroh_key: changedIroh } } });
      await expectCode(() => provisionNativeDemo({ network: 'testnet', rpc_url: config.rpc_url, stateDir: '/fixture/manifest-retry', controller, nameWallet: parentOwner, createNames: true, roles: roles({ local: { agent: retry.agents.local, controller: controller.toSuiAddress() }, research: { agent: retry.agents.research, controller: controller.toSuiAddress() } }), ports: manifestPorts() }), 'Invalid initialized setup manifest');
      assert.equal(tx.events.length, effectsBeforeReject);
      await save(manifestPath, noOp.manifest);
      rmSync(manifestPath);
      await expectCode(() => provisionNativeDemo({ network: 'testnet', rpc_url: config.rpc_url, stateDir: '/fixture/manifest-retry', controller, nameWallet: parentOwner, createNames: true, initialConfig: retry.config, roles: roles({ local: { agent: retry.agents.local, controller: controller.toSuiAddress() }, research: { agent: retry.agents.research, controller: controller.toSuiAddress() } }), ports: manifestPorts() }), 'Existing setup manifest is required');
      assert.equal(tx.events.length, effectsBeforeReject);
      await save(manifestPath, noOp.manifest);
      await expectCode(() => provisionNativeDemo({ network: 'testnet', rpc_url: config.rpc_url, stateDir: '/fixture/manifest-retry', controller: Ed25519Keypair.generate(), nameWallet: parentOwner, createNames: true, roles: roles(), ports: manifestPorts() }), 'authority or network pin mismatch');
      assert.equal(tx.events.length, effectsBeforeReject);
      await expectCode(() => provisionNativeDemo({ network: 'testnet', rpc_url: config.rpc_url, stateDir: '/fixture/manifest-retry', controller, createNames: false, roles: roles(), ports: manifestPorts() }), 'authority or network pin mismatch');
      await expectCode(() => provisionNativeDemo({ network: 'testnet', rpc_url: 'https://other-testnet.invalid', stateDir: '/fixture/manifest-retry', controller, nameWallet: parentOwner, createNames: true, roles: roles(), ports: manifestPorts() }), 'authority or network pin mismatch');
      assert.equal(tx.events.length, effectsBeforeReject);
      await save(manifestPath, { ...noOp.manifest, operations: { ...noOp.manifest.operations, publish: 'changed-operation' } });
      await expectCode(() => provisionNativeDemo({ network: 'testnet', rpc_url: config.rpc_url, stateDir: '/fixture/manifest-retry', controller, nameWallet: parentOwner, createNames: true, roles: roles(), ports: manifestPorts() }), 'Invalid initialized setup manifest');
      assert.equal(tx.events.length, effectsBeforeReject);
      await save(manifestPath, { ...noOp.manifest, initialized: false });
      await expectCode(() => provisionNativeDemo({ network: 'testnet', rpc_url: config.rpc_url, stateDir: '/fixture/manifest-retry', controller, nameWallet: parentOwner, createNames: true, roles: roles(), ports: manifestPorts() }), 'Invalid initialized setup manifest');
    } finally { rmSync(manifestRoot, { recursive: true, force: true }); }
  }

  // An uncertain submitted operation may replay only its retained exact
  // journal. Removing that component is recovery-required, never a fresh
  // transaction build/sign attempt; the nearest-valid retained-journal retry
  // above remains the positive case.
  {
    const manifestRoot = mkdtempSync(join('/tmp', 'm2m-native-missing-journal-')); const manifestPath = join(manifestRoot, 'setup-manifest.json');
    try {
      const tx = new RecordingTransactions(); tx.failAfterDomainOnce = true; const names = new RecordingNames(parentOwner.toSuiAddress());
      const manifestPorts = (): NativeSetupPorts => ({ ...ports(tx, names), loadManifest: async () => readOptional<SetupManifest>(manifestPath), saveManifest: async manifest => save(manifestPath, manifest) });
      await expectCode(() => provisionNativeDemo({ network: 'testnet', rpc_url: config.rpc_url, stateDir: manifestRoot, controller, nameWallet: parentOwner, createNames: true, roles: roles(), ports: manifestPorts() }), 'interrupted_after_submit');
      tx.dropJournal(`${manifestRoot}/domain.tx.json`);
      const before = tx.events.length;
      await expectCode(() => provisionNativeDemo({ network: 'testnet', rpc_url: config.rpc_url, stateDir: manifestRoot, controller, nameWallet: parentOwner, createNames: true, roles: roles(), ports: manifestPorts() }), 'Recovery required');
      assert.equal(tx.events.length, before + 1); assert.equal(tx.events.at(-1), 'replay:publish');
    } finally { rmSync(manifestRoot, { recursive: true, force: true }); }
  }

  // All existing Agents are resolved before the first mutation. A bad second
  // role therefore cannot leave the first role or deployment half-provisioned.
  {
    const tx = new RecordingTransactions(); const names = new RecordingNames(parentOwner.toSuiAddress());
    const badChain = new RecordingChain({ controller: controller.toSuiAddress(), transport_key: Array.from(transportLocal.getPublicKey().toRawBytes()), economic_key: Array.from(economicLocal.getPublicKey().toRawBytes()) });
    badChain.resolve = async (agent: string) => { badChain.events.push('resolve'); return agent === '0x302' ? { controller: wrongOwner.toSuiAddress(), transport_key: Array.from(transportResearch.getPublicKey().toRawBytes()), economic_key: Array.from(economicResearch.getPublicKey().toRawBytes()) } : { controller: controller.toSuiAddress(), transport_key: Array.from(transportLocal.getPublicKey().toRawBytes()), economic_key: Array.from(economicLocal.getPublicKey().toRawBytes()) }; };
    const existingRoles = roles({ local: { agent: '0x301', controller: controller.toSuiAddress() }, research: { agent: '0x302', controller: controller.toSuiAddress() } });
    const existingManifest: SetupManifest = { version: 1, initialized: true, mode: 'legacy', network: 'testnet', rpc_url: config.rpc_url, chain_id: config.chain_id, package_id: config.package_id, domain: config.domain, controller_wallet: controller.toSuiAddress(), name_wallet: controller.toSuiAddress(), agents: { local: '0x301', research: '0x302' }, role_keys: { local: { transport_key: Array.from(transportLocal.getPublicKey().toRawBytes()), economic_key: Array.from(economicLocal.getPublicKey().toRawBytes()), iroh_key: Array.from(transportLocal.getPublicKey().toRawBytes()) }, research: { transport_key: Array.from(transportResearch.getPublicKey().toRawBytes()), economic_key: Array.from(economicResearch.getPublicKey().toRawBytes()), iroh_key: Array.from(transportResearch.getPublicKey().toRawBytes()) } }, transactions: {}, operations: { publish: 'publish-native-v1', domain: 'create-native-domain', local: 'register:local', research: 'register:research', names: 'create-leaves' } };
    const preflightPorts = (chain: SetupChainPort): NativeSetupPorts => ({ ...ports(tx, names, chain), loadManifest: async () => existingManifest });
    await expectCode(() => provisionNativeDemo({ network: 'testnet', rpc_url: config.rpc_url, stateDir: '/fixture/preflight-all', controller, initialConfig: config, createNames: false, roles: existingRoles, ports: preflightPorts(badChain) }), 'Existing research Agent authority mismatch');
    assert.deepEqual(tx.events, []); assert.deepEqual(badChain.events.filter(event => event === 'resolve'), ['resolve', 'resolve']);
    const keyMismatchChain = new RecordingChain({ controller: controller.toSuiAddress(), transport_key: Array.from(transportLocal.getPublicKey().toRawBytes()), economic_key: Array.from(economicLocal.getPublicKey().toRawBytes()) });
    keyMismatchChain.resolve = async (agent: string) => { keyMismatchChain.events.push('resolve'); return agent === '0x301'
      ? { controller: controller.toSuiAddress(), transport_key: Array.from(transportResearch.getPublicKey().toRawBytes()), economic_key: Array.from(economicLocal.getPublicKey().toRawBytes()) }
      : { controller: controller.toSuiAddress(), transport_key: Array.from(transportResearch.getPublicKey().toRawBytes()), economic_key: Array.from(economicResearch.getPublicKey().toRawBytes()) }; };
    await expectCode(() => provisionNativeDemo({ network: 'testnet', rpc_url: config.rpc_url, stateDir: '/fixture/preflight-keys', controller, initialConfig: config, createNames: false, roles: existingRoles, ports: preflightPorts(keyMismatchChain) }), 'Existing local Agent authority mismatch');
    assert.deepEqual(tx.events, []); assert.deepEqual(keyMismatchChain.events.filter(event => event === 'resolve'), ['resolve', 'resolve']);
  }

  // Exercise the actual NativeChain.execute journal/signature boundary with a
  // local mocked SDK transport: interrupted wait reopens the same signed bytes,
  // while a changed signer is rejected before another submission.
  {
    const root = mkdtempSync(join('/tmp', 'm2m-native-execute-')); const journal = join(root, 'operation.json');
    const signer = Ed25519Keypair.generate(); const changedSigner = Ed25519Keypair.generate(); let failSubmit = true; let failWait = true; const submissions: Array<{ bytes: string; signature: string }> = [];
    const fakeClient = {
      core: { getChainIdentifier: async () => ({ chainIdentifier: 'test-chain' }) },
      ledgerService: { getServiceInfo: async () => ({ response: { chain: 'testnet' } }) },
      executeTransaction: async (input: { transaction: Uint8Array; signatures: string[] }) => { if (failSubmit) { failSubmit = false; throw new Error('interrupted_submit'); } submissions.push({ bytes: Buffer.from(input.transaction).toString('base64'), signature: input.signatures[0] }); return { $kind: 'Transaction', Transaction: { status: { success: true }, digest: 'digest-native', effects: { gasUsed: { computationCost: '1' }, changedObjects: [], balanceChanges: [] }, objectTypes: {} } }; },
      waitForTransaction: async () => { if (failWait) { failWait = false; throw new Error('interrupted_wait'); } },
    };
    const nativeConfig: NativeConfig = { network: 'testnet', rpc_url: 'https://fullnode.testnet.sui.io:443', chain_id: 'test-chain', package_id: '0x11', domain: '0x12' };
    try {
      const chain = new NativeChain(nativeConfig); Object.defineProperty(chain, 'client', { value: fakeClient });
      const fakeTx = () => ({ setSender() {}, setGasBudgetIfNotSet() {}, build: async () => Uint8Array.from([1, 2, 3]), getDigest: async () => 'tx-digest' });
      await assert.rejects(() => chain.execute(fakeTx() as never, signer, journal, 'native-op'), /interrupted_submit/);
      await assert.rejects(() => chain.execute(fakeTx() as never, changedSigner, journal, 'native-op'), /authority mismatch/);
      await assert.rejects(() => chain.execute(fakeTx() as never, signer, journal, 'native-op'), /interrupted_wait/);
      const reopened = new NativeChain(nativeConfig); Object.defineProperty(reopened, 'client', { value: fakeClient });
      const confirmed = await reopened.execute(fakeTx() as never, signer, journal, 'native-op'); assert.equal(confirmed.state, 'confirmed'); assert.equal(submissions.length, 2); assert.equal(submissions[0].bytes, submissions[1].bytes); assert.equal(submissions[0].signature, submissions[1].signature);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  // Buyer may carry its own controller secret, but neither export can carry
  // the parent wallet or the other role's private material.
  {
    const buyer = buildRoleKeyExport({ role: 'buyer', transport_secret_key: 'buyer-transport', economic_secret_key: 'buyer-economic', buyer_controller_secret_key: 'buyer-controller' });
    const provider = buildRoleKeyExport({ role: 'provider', transport_secret_key: 'provider-transport', economic_secret_key: 'provider-economic', buyer_controller_secret_key: 'must-not-copy' });
    assert.equal(buyer.buyer_controller_secret_key, 'buyer-controller');
    assert.equal(provider.buyer_controller_secret_key, undefined);
    assert.equal(Object.values(buyer).includes(parentOwner.getSecretKey()), false);
    assert.equal(Object.values(provider).includes(controller.getSecretKey()), false);
    assert.equal(Object.values(provider).includes('buyer-transport'), false);
  }

  console.log('Agent demo setup: authoritative orchestration, authority preflight, immutable manifest/retry, ABI-sender, legacy, network and signed-journal guards passed (fixture-only; role export acceptance remains pending).');
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
