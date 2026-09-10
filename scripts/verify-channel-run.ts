/**
 * Independently audit one completed signed-channel run from Sui.
 *
 * Usage:
 *   tsx scripts/verify-channel-run.ts config.json expected.json output.json
 *
 * `expected.json` may be the normalized object described below or a Fly
 * runner report. The latter supplies channel/accounting/digest fields from
 * the report; buyer/provider may also be supplied at the top level. When a
 * Fly report predates those party fields, the successful open transaction's
 * public object inputs provide the expected Agent IDs.
 *
 * This file deliberately requests parsed transaction data, effects, object
 * types, and balance changes only. It never requests or serializes BCS,
 * signatures, journals, wallet files, or signed transaction bytes.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { ChannelChain } from './channel-chain.js';
import type { ChainConfig } from './chain.js';

const U64_MAX = (1n << 64n) - 1n;
const SUI_TYPE = `${normalizeSuiAddress('0x2')}::sui::SUI`;
const DIGEST = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const ADDRESS = /^0x[0-9a-f]{64}$/;

type JsonObject = Record<string, unknown>;

interface ExpectedRun {
  channel: string;
  buyer?: string;
  provider?: string;
  deposit: string;
  paid: string;
  open_digest: string;
  close_digest: string;
  source: 'normalized' | 'fly-report';
}

interface GasFacts {
  computation_cost: string;
  storage_cost: string;
  storage_rebate: string;
  non_refundable_storage_fee: string;
  net_gas_mist: string;
}

interface TransactionFacts {
  digest: string;
  checkpoint: string;
  success: true;
  sender: string;
  command: { package: string; module: string; function: string };
  channel_argument_matches: true;
  changed_channel: {
    id: string;
    input_state: string;
    output_state: string;
    id_operation: string;
  };
  gas: GasFacts;
}

function object(value: unknown, name: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value as JsonObject;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a nonempty string`);
  return value;
}

function canonicalAddress(value: unknown, name: string): string {
  const address = stringValue(value, name);
  if (!ADDRESS.test(address) || normalizeSuiAddress(address) !== address) {
    throw new Error(`${name} must be a canonical Sui address`);
  }
  return address;
}

function u64(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${name} must be a canonical decimal u64 string`);
  }
  let parsed: bigint;
  try { parsed = BigInt(value); } catch { throw new Error(`${name} is not a u64`); }
  if (parsed > U64_MAX) throw new Error(`${name} is not a u64`);
  return value;
}

function digest(value: unknown, name: string): string {
  const result = stringValue(value, name);
  if (!DIGEST.test(result)) throw new Error(`${name} must be a Sui digest`);
  return result;
}

function exactKeys(value: JsonObject, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${name} has unknown or missing fields`);
  }
}

function first(value: JsonObject, ...paths: string[]): unknown {
  for (const path of paths) {
    const candidate = value[path];
    if (candidate !== undefined && candidate !== null) return candidate;
  }
  return undefined;
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : undefined;
}

function transactionDigestFromRecords(value: unknown, suffix: 'open' | 'close'): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    const record = asObject(item);
    if (!record) continue;
    const file = typeof record.file === 'string' ? record.file : '';
    if (file.endsWith(`.${suffix}.tx.json`) && record.digest !== undefined) {
      return String(record.digest);
    }
  }
  return undefined;
}

function expectedInput(raw: unknown): ExpectedRun {
  const root = object(raw, 'expected');

  // The normalized form is intentionally exact so a caller cannot mistake
  // an unrelated report field for an audit expectation.
  if (typeof root.channel === 'string') {
    exactKeys(root, ['channel', 'buyer', 'provider', 'deposit', 'paid', 'open_digest', 'close_digest'], 'expected');
    return {
      channel: canonicalAddress(root.channel, 'expected.channel'),
      buyer: canonicalAddress(root.buyer, 'expected.buyer'),
      provider: canonicalAddress(root.provider, 'expected.provider'),
      deposit: u64(root.deposit, 'expected.deposit'),
      paid: u64(root.paid, 'expected.paid'),
      open_digest: digest(root.open_digest, 'expected.open_digest'),
      close_digest: digest(root.close_digest, 'expected.close_digest'),
      source: 'normalized',
    };
  }

  // Fly reports contain only a public projection. Do not copy the report to
  // the result; reduce it to the seven audit expectations above.
  const reportChannel = object(root.channel, 'expected Fly report channel');
  const accounting = asObject(reportChannel.accounting) ?? {};
  const confirmed = first(accounting, 'confirmed_transactions') ?? root.transactions;
  const channelId = first(reportChannel, 'id');
  const deposit = first(accounting, 'deposit') ?? first(reportChannel, 'deposit');
  const paid = first(accounting, 'paid') ?? first(reportChannel, 'redeemed');
  const openDigest = first(root, 'open_digest') ?? transactionDigestFromRecords(confirmed, 'open');
  const closeDigest = first(root, 'close_digest') ?? first(reportChannel, 'close_digest') ?? transactionDigestFromRecords(confirmed, 'close');
  const offer = asObject(reportChannel.offer) ?? asObject(root.offer);
  const buyer = first(root, 'buyer') ?? (offer ? offer.buyer : undefined);
  const provider = first(root, 'provider') ?? (offer ? offer.provider : undefined);
  if (channelId === undefined || deposit === undefined || paid === undefined ||
      openDigest === undefined || closeDigest === undefined) {
    throw new Error('expected Fly report lacks channel, accounting, or transaction digest fields');
  }
  return {
    channel: canonicalAddress(channelId, 'report.channel.id'),
    buyer: buyer === undefined ? undefined : canonicalAddress(buyer, 'report.buyer'),
    provider: provider === undefined ? undefined : canonicalAddress(provider, 'report.provider'),
    deposit: u64(String(deposit), 'report.deposit'),
    paid: u64(String(paid), 'report.paid'),
    open_digest: digest(openDigest, 'report.open_digest'),
    close_digest: digest(closeDigest, 'report.close_digest'),
    source: 'fly-report',
  };
}

function configInput(raw: unknown): ChainConfig {
  const value = object(raw, 'config');
  exactKeys(value, ['rpc_url', 'network', 'chain_id', 'package_id', 'deployment'], 'config');
  const rpcUrl = stringValue(value.rpc_url, 'config.rpc_url');
  try {
    if (new URL(rpcUrl).protocol !== 'https:') throw new Error('RPC must use HTTPS');
  } catch (error) {
    throw new Error(`config.rpc_url is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (value.network !== 'testnet') throw new Error('config.network must be testnet');
  const chainId = stringValue(value.chain_id, 'config.chain_id');
  const packageId = canonicalAddress(value.package_id, 'config.package_id');
  const deployment = canonicalAddress(value.deployment, 'config.deployment');
  return { rpc_url: rpcUrl, network: 'testnet', chain_id: chainId, package_id: packageId, deployment };
}

function jsonObject(value: unknown, name: string): JsonObject {
  return object(value, name);
}

function inputIndex(value: unknown): number | undefined {
  const arg = asObject(value);
  if (!arg || arg.$kind !== 'Input' || !Number.isInteger(arg.Input)) return undefined;
  return arg.Input as number;
}

function objectIdFromInput(tx: JsonObject, index: number): string | undefined {
  const transaction = asObject(tx.transaction);
  const inputs = transaction?.inputs;
  if (!Array.isArray(inputs)) return undefined;
  const input = asObject(inputs[index]);
  const inputObject = input ? asObject(input.Object) : undefined;
  if (!inputObject) return undefined;
  for (const name of ['SharedObject', 'ImmOrOwnedObject', 'Receiving']) {
    const reference = asObject(inputObject[name]);
    if (reference && typeof reference.objectId === 'string') return normalizeSuiAddress(reference.objectId);
  }
  return undefined;
}

function moveCall(tx: JsonObject, packageId: string, module: string, functionName: string): JsonObject {
  const transaction = asObject(tx.transaction);
  const commands = transaction?.commands;
  if (!Array.isArray(commands)) throw new Error('transaction has no parsed commands');
  const matches: JsonObject[] = [];
  for (const command of commands) {
    const value = asObject(command);
    if (!value || value.$kind !== 'MoveCall') continue;
    const call = asObject(value.MoveCall);
    if (!call || call.package !== packageId || call.module !== module || call.function !== functionName) continue;
    matches.push(call);
  }
  if (matches.length !== 1) throw new Error(`transaction must contain exactly one ${packageId}::${module}::${functionName} call`);
  return matches[0];
}

function gasFacts(tx: JsonObject): GasFacts {
  const effects = asObject(tx.effects);
  const gas = jsonObject(effects?.gasUsed, 'transaction gas');
  const computation = u64(String(gas.computationCost), 'gas.computationCost');
  const storage = u64(String(gas.storageCost), 'gas.storageCost');
  const rebate = u64(String(gas.storageRebate), 'gas.storageRebate');
  const nonRefundable = u64(String(gas.nonRefundableStorageFee), 'gas.nonRefundableStorageFee');
  const net = BigInt(computation) + BigInt(storage) - BigInt(rebate);
  return {
    computation_cost: computation,
    storage_cost: storage,
    storage_rebate: rebate,
    non_refundable_storage_fee: nonRefundable,
    net_gas_mist: String(net),
  };
}

function changedChannel(tx: JsonObject, channelId: string, packageId: string, expectedOperation: 'Created' | 'write'): TransactionFacts['changed_channel'] {
  const effects = asObject(tx.effects);
  const changed = effects?.changedObjects;
  const objectTypes = jsonObject(tx.objectTypes, 'transaction object types');
  if (!Array.isArray(changed)) throw new Error('transaction has no changed objects');
  const channelType = `${packageId}::channel::Channel`;
  for (const raw of changed) {
    const item = asObject(raw);
    if (!item || typeof item.objectId !== 'string') continue;
    if (normalizeSuiAddress(item.objectId) !== channelId) continue;
    if (objectTypes[item.objectId] !== channelType) continue;
    if (item.outputState !== 'ObjectWrite') continue;
    if (expectedOperation === 'Created' && item.idOperation !== 'Created') continue;
    if (expectedOperation === 'write' && item.inputState !== 'Exists') continue;
    return {
      id: channelId,
      input_state: String(item.inputState ?? ''),
      output_state: String(item.outputState),
      id_operation: String(item.idOperation ?? ''),
    };
  }
  throw new Error(`transaction did not change ${channelType} ${channelId}`);
}

function successfulTransaction(result: unknown, expectedDigest: string, label: string): JsonObject {
  const response = object(result, `${label} response`);
  if (response.$kind !== 'Transaction') throw new Error(`${label} is not a successful transaction`);
  const tx = jsonObject(response.Transaction, `${label} transaction`);
  if (tx.digest !== expectedDigest) throw new Error(`${label} digest mismatch`);
  if (tx.status === undefined || !jsonObject(tx.status, `${label} status`).success) {
    throw new Error(`${label} transaction did not succeed`);
  }
  const checkpoint = tx.checkpoint;
  if (typeof checkpoint !== 'string' || !/^\d+$/.test(checkpoint)) {
    throw new Error(`${label} transaction is not checkpointed`);
  }
  return tx;
}

function commandFacts(tx: JsonObject, packageId: string, functionName: string, channelId: string, operation: 'Created' | 'write'): TransactionFacts {
  const call = moveCall(tx, packageId, 'channel', functionName);
  const args = call.arguments;
  if (!Array.isArray(args)) throw new Error(`${functionName} call has no arguments`);
  if (functionName !== 'open') {
    const channelInput = inputIndex(args[0]);
    if (channelInput === undefined || objectIdFromInput(tx, channelInput) !== channelId) {
      throw new Error(`${functionName} command does not target the audited channel input`);
    }
  }
  const transaction = jsonObject(tx.transaction, `${functionName}.parsed transaction`);
  const sender = canonicalAddress(transaction.sender, `${functionName}.sender`);
  const gas = gasFacts(tx);
  return {
    digest: stringValue(tx.digest, `${functionName}.digest`),
    checkpoint: stringValue(tx.checkpoint, `${functionName}.checkpoint`),
    success: true,
    sender,
    command: { package: String(call.package), module: String(call.module), function: String(call.function) },
    channel_argument_matches: true,
    changed_channel: changedChannel(tx, channelId, packageId, operation),
    gas,
  };
}

function balanceDelta(tx: JsonObject, address: string): bigint {
  const changes = tx.balanceChanges;
  if (!Array.isArray(changes)) throw new Error('transaction has no balance changes');
  let total = 0n;
  for (const raw of changes) {
    const change = asObject(raw);
    if (!change || change.coinType !== SUI_TYPE) continue;
    if (typeof change.address !== 'string') continue;
    if (normalizeSuiAddress(change.address) !== address) continue;
    if (typeof change.amount !== 'string' || !/^-?(?:0|[1-9][0-9]*)$/.test(change.amount)) {
      throw new Error(`invalid SUI balance change for ${address}`);
    }
    total += BigInt(change.amount);
  }
  return total;
}

function transactionOutput(facts: TransactionFacts): JsonObject {
  return {
    digest: facts.digest,
    checkpoint: facts.checkpoint,
    success: facts.success,
    sender: facts.sender,
    command: facts.command,
    channel_argument_matches: facts.channel_argument_matches,
    changed_channel: facts.changed_channel,
    gas: facts.gas,
  };
}

async function audit(config: ChainConfig, expected: ExpectedRun): Promise<JsonObject> {
  const chain = new ChannelChain(config);
  await chain.validate();

  const fresh = await chain.channel(expected.channel);
  const offer = fresh.offer;
  if (fresh.id !== expected.channel) throw new Error('fresh channel ID does not match expected channel');
  if (fresh.status !== 1) throw new Error(`fresh channel is not closed (status ${fresh.status})`);
  if (fresh.funds !== '0') throw new Error(`fresh channel retains ${fresh.funds} MIST`);
  if (fresh.offer.deposit !== expected.deposit) throw new Error('channel offer deposit does not match expected deposit');
  if (fresh.redeemed_amount !== expected.paid) throw new Error('channel redeemed amount does not match expected paid amount');
  if (BigInt(expected.paid) > BigInt(expected.deposit)) throw new Error('expected paid amount exceeds deposit');
  if (fresh.terminal_digest !== expected.close_digest) throw new Error('channel terminal digest does not match expected close digest');

  const [openResult, closeResult] = await Promise.all([
    chain.client.getTransaction({
      digest: expected.open_digest,
      include: { effects: true, objectTypes: true, balanceChanges: true, transaction: true },
    }),
    chain.client.getTransaction({
      digest: expected.close_digest,
      include: { effects: true, objectTypes: true, balanceChanges: true, transaction: true },
    }),
  ]);
  const openTx = successfulTransaction(openResult, expected.open_digest, 'open');
  const closeTx = successfulTransaction(closeResult, expected.close_digest, 'close');
  const openFacts = commandFacts(openTx, config.package_id, 'open', expected.channel, 'Created');
  const closeFacts = commandFacts(closeTx, config.package_id, 'close', expected.channel, 'write');

  const openCall = moveCall(openTx, config.package_id, 'channel', 'open');
  const openArgs = openCall.arguments;
  if (!Array.isArray(openArgs)) throw new Error('open call has no arguments');
  const buyerInput = inputIndex(openArgs[1]);
  const providerInput = inputIndex(openArgs[2]);
  const txBuyer = buyerInput === undefined ? undefined : objectIdFromInput(openTx, buyerInput);
  const txProvider = providerInput === undefined ? undefined : objectIdFromInput(openTx, providerInput);
  const buyer = expected.buyer ?? txBuyer;
  const provider = expected.provider ?? txProvider;
  if (!buyer || !provider) throw new Error('buyer/provider expectation is missing and cannot be derived from open transaction');
  if (offer.buyer !== buyer) throw new Error('channel offer buyer does not match expected buyer');
  if (offer.provider !== provider) throw new Error('channel offer provider does not match expected provider');
  if (txBuyer !== offer.buyer || txProvider !== offer.provider) throw new Error('open transaction Agent inputs do not match channel offer');

  // Controllers are mutable Agent state. Settlement recipients are immutable
  // Offer snapshots and must remain the source of payout verification.
  const [buyerAgent, providerAgent] = await Promise.all([chain.agent(offer.buyer), chain.agent(offer.provider)]);
  const refund = offer.refund;
  const payee = offer.payee;
  const paid = BigInt(expected.paid);
  const refundAmount = BigInt(expected.deposit) - paid;
  const providerDelta = balanceDelta(closeTx, payee);
  if (providerDelta !== paid) throw new Error(`provider payout mismatch: expected ${paid}, observed ${providerDelta}`);

  const closeSender = closeFacts.sender;
  const currentBuyerController = canonicalAddress(buyerAgent.controller, 'buyer current controller');
  if (closeSender !== refund && closeSender !== currentBuyerController) {
    throw new Error('close gas sender is neither the snapshotted buyer refund address nor the current buyer controller');
  }
  const netGas = BigInt(closeFacts.gas.net_gas_mist);
  const refundDelta = balanceDelta(closeTx, refund);
  const expectedRefundDelta = closeSender === refund ? refundAmount - netGas : refundAmount;
  if (refundDelta !== expectedRefundDelta) {
    throw new Error(`buyer refund balance mismatch: expected ${expectedRefundDelta}, observed ${refundDelta}`);
  }
  if (closeSender !== refund && balanceDelta(closeTx, closeSender) !== -netGas) {
    throw new Error('current buyer controller did not pay close transaction gas');
  }

  return {
    version: 1,
    checked_at: new Date().toISOString(),
    network: config.network,
    chain_id: config.chain_id,
    package_id: config.package_id,
    deployment: config.deployment,
    expected: {
      channel: expected.channel,
      buyer,
      provider,
      deposit: expected.deposit,
      paid: expected.paid,
      open_digest: expected.open_digest,
      close_digest: expected.close_digest,
      source: expected.source,
    },
    channel: {
      id: fresh.id,
      status: fresh.status,
      deposit: offer.deposit,
      redeemed_amount: fresh.redeemed_amount,
      redeemed_sequence: fresh.redeemed_sequence,
      funds: fresh.funds,
      terminal_digest: fresh.terminal_digest,
    },
    offer: {
      buyer: offer.buyer,
      provider: offer.provider,
      refund,
      payee,
      deposit: offer.deposit,
    },
    current_controllers: {
      buyer: currentBuyerController,
      provider: canonicalAddress(providerAgent.controller, 'provider current controller'),
    },
    settlement: {
      provider_payee: payee,
      provider_paid_delta: String(providerDelta),
      buyer_refund: refund,
      buyer_refund_delta: String(refundDelta),
      buyer_refund_amount: String(refundAmount),
      close_gas_payer: closeSender,
      close_net_gas_mist: closeFacts.gas.net_gas_mist,
      buyer_refund_delta_formula: closeSender === refund ? 'refund - close_net_gas' : 'refund; current controller separately pays close_net_gas',
    },
    transactions: {
      open: transactionOutput(openFacts),
      close: transactionOutput(closeFacts),
    },
    checks: {
      config_validated_against_testnet_rpc: true,
      channel_terminal_closed: true,
      offer_parties_match: true,
      offer_snapshot_recipients_used: true,
      open_checkpointed_successful_channel_open: true,
      close_checkpointed_successful_channel_close: true,
      provider_paid_expected_amount: true,
      buyer_refund_and_close_gas_accounted: true,
    },
  };
}

async function main(): Promise<void> {
  const [configPath, expectedPath, outputPath] = process.argv.slice(2);
  if (!configPath || !expectedPath || !outputPath || process.argv.length !== 5) {
    throw new Error('usage: tsx scripts/verify-channel-run.ts config.json expected.json output.json');
  }
  const config = configInput(JSON.parse(await readFile(configPath, 'utf8')));
  const expected = expectedInput(JSON.parse(await readFile(expectedPath, 'utf8')));
  const output = await audit(config, expected);
  await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ audit: outputPath, passed: true, channel: expected.channel,
    open_digest: expected.open_digest, close_digest: expected.close_digest }));
}

try {
  await main();
} catch (error) {
  console.error(`channel audit failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
