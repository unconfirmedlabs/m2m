import { readFile, mkdir, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { requestSuiFromFaucetV2 } from '@mysten/sui/faucet';
import { Chain, save, key, type ChainConfig } from './chain.js';
import { utf8 } from './codec.js';

const { values } = parseArgs({ options: {
  state: { type: 'string', default: '.m2m/demo' },
  network: { type: 'string', default: 'localnet' },
  rpc: { type: 'string' }, faucet: { type: 'string' },
  build: { type: 'string', default: '.m2m/build.json' },
  'wallets-from': { type: 'string' },
} });
const state = resolve(values.state!);
if (values.network !== 'localnet' && values.network !== 'testnet') throw new Error('Only localnet/testnet are supported');
const network = values.network;
const rpc = values.rpc ?? (network === 'localnet' ? 'http://127.0.0.1:9000' : 'https://fullnode.testnet.sui.io:443');
const faucet = values.faucet ?? (network === 'localnet' ? 'http://127.0.0.1:9123' : 'https://faucet.testnet.sui.io');
await mkdir(state, { recursive: true, mode: 0o700 });
const exists = (path: string) => access(path).then(() => true, () => false);
if (await exists(`${state}/chain.json`)) {
  const config: ChainConfig = JSON.parse(await readFile(`${state}/chain.json`, 'utf8'));
  if (config.rpc_url !== rpc || config.network !== network) throw new Error('Existing setup uses different network; use a new state directory');
  await new Chain(config).validate();
  console.log(JSON.stringify({ reused: true, config: `${state}/chain.json` }));
  process.exit(0);
}
const client = new SuiGrpcClient({ baseUrl: rpc, network });
const { chainIdentifier } = await client.core.getChainIdentifier();
const { response: info } = await client.ledgerService.getServiceInfo({});
if (info.chain === 'mainnet' || (network === 'testnet' && info.chain !== 'testnet')) throw new Error('Unexpected network; refusing deployment');
const config: ChainConfig = { rpc_url:rpc, network, chain_id:chainIdentifier, package_id:'0x0', deployment:'0x0' };
const chain = new Chain(config);
const walletsFrom = values['wallets-from'] ? resolve(values['wallets-from']) : undefined;
if (walletsFrom) {
  const source: ChainConfig = JSON.parse(await readFile(`${walletsFrom}/chain.json`, 'utf8'));
  if (source.network !== network || source.chain_id !== chainIdentifier) {
    throw new Error('Source wallets belong to a different network; refusing reuse');
  }
}
for (const name of ['deployer', 'buyer-controller', 'provider-controller', 'provider-gas']) {
  const path = `${state}/${name}.json`;
  if (!await exists(path)) {
    const generated = walletsFrom ? await key(`${walletsFrom}/${name}.json`) : Ed25519Keypair.generate();
    await save(path, { secret_key: generated.getSecretKey(), address: generated.toSuiAddress() });
  }
  const signer = await key(path);
  const owner = signer.toSuiAddress();
  const balance = await client.getBalance({ owner });
  if (BigInt(balance.balance.balance) < 100_000_000n) {
    if (network === 'testnet' && name !== 'deployer') {
      // One funded testnet wallet supplies the three isolated role wallets.
      const deployer = await key(`${state}/deployer.json`);
      const tx = new Transaction();
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(200_000_000)]);
      tx.transferObjects([coin], owner);
      await chain.execute(tx, deployer, `${state}/${name}.fund.tx.json`);
    } else {
      console.error(`Requesting ${network} faucet funds for ${name} (${owner})`);
      await requestSuiFromFaucetV2({ host: faucet, recipient: owner });
    }
    let funded = false;
    for (let attempt=0; attempt<30; attempt++) {
      if (BigInt((await client.getBalance({ owner })).balance.balance) >= 100_000_000n) { funded = true; break; }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!funded) throw new Error(`Faucet funding not visible for ${owner}; rerun setup later`);
  }
}
const signer = await key(`${state}/deployer.json`);
let publish;
if (await exists(`${state}/publish.tx.json`)) {
  publish = JSON.parse(await readFile(`${state}/publish.tx.json`, 'utf8'));
  if (publish.state !== 'confirmed') throw new Error('Publication outcome uncertain; reconcile publish.tx.json instead of publishing again');
} else {
  const build = JSON.parse(await readFile(values.build!, 'utf8'));
  const tx = new Transaction();
  // Publishing both settlement modules needs a larger storage budget than a job.
  tx.setGasBudget(100_000_000);
  const [cap] = tx.publish({ modules:build.modules, dependencies:build.dependencies });
  tx.transferObjects([cap], signer.toSuiAddress());
  publish = await chain.execute(tx, signer, `${state}/publish.tx.json`);
}
const pkg = publish.created.find((o: {type:string}) => o.type === 'package');
if (!pkg) throw new Error('Missing published package ID');
config.package_id = pkg.id;
let domain;
if (await exists(`${state}/domain.tx.json`)) {
  domain = JSON.parse(await readFile(`${state}/domain.tx.json`, 'utf8'));
  if (domain.state !== 'confirmed') throw new Error('Domain creation uncertain; reconcile domain.tx.json');
} else {
  const tx = new Transaction();
  chain.call(tx, 'create_domain', [tx.pure.vector('u8', utf8(chainIdentifier))]);
  domain = await chain.execute(tx, signer, `${state}/domain.tx.json`);
}
const id = domain.created.find((o: {type:string}) => o.type?.endsWith('::exchange::Domain'))?.id;
if (!id) throw new Error('Missing Domain ID');
config.deployment = id;
await chain.validate();
await save(`${state}/chain.json`, config);
console.log(JSON.stringify({ config:`${state}/chain.json`, ...config }, null, 2));
