// Export selected public chain facts. Never copy operational journals or key files.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { ChannelChain } from './channel-chain.js';
import type { ChainConfig } from './chain.js';

const root = resolve(process.argv[2] ?? '.m2m/channels-testnet');
const destination = resolve(process.argv[3] ?? `${root}/public-evidence.json`);
const config: ChainConfig = JSON.parse(await readFile(`${root}/chain.json`, 'utf8'));
const chain = new ChannelChain(config);
await chain.validate();

async function files(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...await files(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}
const digests = new Set<string>();
function collectDigests(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [name, entry] of Object.entries(value)) {
    if (name === 'digest' && typeof entry === 'string' && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(entry)) {
      digests.add(entry);
    } else if (typeof entry === 'object') collectDigests(entry);
  }
}
for (const path of await files(root)) {
  if (path.endsWith('.tx.json')) collectDigests(JSON.parse(await readFile(path, 'utf8')));
}
// Optional Fly reports contain projected public transaction records only.
const flyRuns = [];
for (const path of process.argv.slice(4)) {
  const report = JSON.parse(await readFile(resolve(path), 'utf8'));
  assert.equal(report.network, 'testnet');
  assert.equal(report.channel?.terminal, true, 'Fly channel must be reconciled before export');
  collectDigests(report.transactions);
  flyRuns.push({ run_id: report.run_id, app: report.app, path_requested: report.path_requested,
    machines: report.machines, image: report.image, channel: report.channel, connection: report.connection,
    chain_audit: report.chain_audit,
    timing_ms: report.timing_ms, cleanup: report.cleanup });
}
const transactions = [];
const channelIds = new Set<string>();
let netGas = 0n;
for (const digest of [...digests].sort()) {
  const fetched = await chain.client.getTransaction({
    digest, include: { effects: true, objectTypes: true, balanceChanges: true },
  });
  const tx = fetched.$kind === 'Transaction' ? fetched.Transaction : fetched.FailedTransaction;
  assert(tx.checkpoint, `Transaction ${digest} is not checkpointed`);
  const gas = tx.effects.gasUsed;
  const net = BigInt(gas.computationCost) + BigInt(gas.storageCost) - BigInt(gas.storageRebate);
  netGas += net;
  for (const object of tx.effects.changedObjects) {
    if (tx.objectTypes[object.objectId] === `${config.package_id}::channel::Channel`) channelIds.add(object.objectId);
  }
  transactions.push({ digest, checkpoint: tx.checkpoint, timestamp_ms: tx.timestampMs,
    success: tx.status.success, gas, net_gas_mist: String(net), balance_changes: tx.balanceChanges });
}
const channels = [];
for (const id of [...channelIds].sort()) {
  const channel = await chain.channel(id);
  assert.equal(await chain.lookupChannel(channel.offer.buyer, channel.offer.opening_nonce), id);
  if (channel.status !== 0) assert.equal(channel.funds, '0', 'Terminal channel retains funds');
  else assert.equal(BigInt(channel.funds) + BigInt(channel.redeemed_amount), BigInt(channel.offer.deposit));
  channels.push(channel);
}
const wallets = [];
for (const role of ['deployer', 'buyer-controller', 'provider-controller', 'provider-gas']) {
  // Select only the public address from this private file; never serialize its contents.
  const { address } = JSON.parse(await readFile(`${root}/${role}.json`, 'utf8')) as { address: string };
  const balance = await chain.client.getBalance({ owner: address });
  wallets.push({ role, address, balance_mist: balance.balance.balance });
}
const sourceHashes = [];
for (const folder of ['src', 'scripts', 'move/m2m/sources', 'move/m2m/tests', 'schemas']) {
  for (const path of await files(folder)) {
    if (!/\.(rs|ts|py|sh|move|json)$/.test(path)) continue;
    sourceHashes.push({ path: relative(process.cwd(), resolve(path)),
      sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
  }
}
const report = { checked_at: new Date().toISOString(), config,
  scope: flyRuns.length ? 'Same-server and cross-region Fly signed cumulative channels; no ZK proof or residential NAT diversity claim.' : 'Same-server signed cumulative channels; no ZK proof or two-network claim.',
  fly_runs: flyRuns,
  implementation_files: sourceHashes, transactions, channels, wallets,
  net_gas_mist: String(netGas),
  remaining_wallet_balance_mist: String(wallets.reduce((sum, w) => sum + BigInt(w.balance_mist), 0n)),
  open_channels: channels.filter(c => c.status === 0).length };
await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ evidence: destination, transactions: transactions.length,
  channels: channels.length, open_channels: report.open_channels, net_gas_mist: report.net_gas_mist }));
