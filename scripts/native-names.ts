import { bcs } from '@mysten/sui/bcs';
import { suins, SuinsTransaction } from '@mysten/suins';
import { normalizeSuiAddress, isValidSuiNSName, normalizeSuiNSName } from '@mysten/sui/utils';
import { Transaction } from '@mysten/sui/transactions';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { NativeChain, ObjectError, type AgentRef } from './native-chain.js';

export const PARENT = 'nozomi.sui';
export const PARENT_NFT = '0x3f7a86bb5acaf9781399ba2cc710ae5e9dfd9855faaf413bc7179796f19a0bac';
const NameRecord = bcs.struct('NameRecord', {
  nft_id: bcs.Address, expiration_timestamp_ms: bcs.u64(), target_address: bcs.option(bcs.Address),
  data: bcs.vector(bcs.struct('Entry', {key:bcs.string(),value:bcs.string()})),
});
export type NameRecordData = typeof NameRecord.$inferType;
export interface ParentSnapshot {
  name: string; registration: string; owner: string; expires_ms: string;
}

export function leafName(input: string): string {
  if (!isValidSuiNSName(input)) throw new Error('invalid_name');
  const name = normalizeSuiNSName(input, 'dot');
  if (!['local.nozomi.sui', 'research.nozomi.sui'].includes(name)) throw new Error('unsupported_name');
  return name;
}

/** The zero leaf timestamp is a type marker; parent validity supplies its lease. */
export function validateLeaf(name: string, record: NameRecordData | null, parent: ParentSnapshot, now: bigint): string {
  leafName(name);
  if (parent.name !== PARENT || parent.registration !== PARENT_NFT || BigInt(parent.expires_ms) <= now) throw new Error('invalid_parent');
  if (!record) throw new Error('name_not_found');
  if (record.expiration_timestamp_ms !== '0' || record.nft_id !== parent.registration) throw new Error('invalid_leaf_parent');
  if (!record.target_address) throw new Error('missing_name_target');
  return normalizeSuiAddress(record.target_address);
}

export function assertPinned(actual: AgentRef, pinned?: AgentRef) {
  if (pinned && (actual.agent !== pinned.agent || actual.domain !== pinned.domain || actual.package_id !== pinned.package_id ||
    !Buffer.from(actual.network).equals(Buffer.from(pinned.network)))) throw new Error('identity_changed');
}

export class NativeNames {
  readonly client;
  constructor(readonly chain: NativeChain) {
    if (chain.config.network !== 'testnet') throw new Error('SuiNS binding is testnet only');
    this.client = chain.client.$extend(suins());
  }
  async record(name: string): Promise<NameRecordData | null> {
    await this.chain.checkNetwork();
    const config = this.client.suins.config;
    if (!config.registryTableId) throw new Error('Missing pinned SuiNS registry');
    try {
      const {dynamicField} = await this.client.getDynamicField({parentId:config.registryTableId,
        name:{type:`${config.packageIdV1}::domain::Domain`,
          bcs:bcs.vector(bcs.string()).serialize(name.split('.').reverse()).toBytes()}});
      if (!dynamicField?.value?.bcs) throw new Error('Invalid SuiNS record response');
      return NameRecord.parse(dynamicField.value.bcs);
    } catch (error) {
      if (error instanceof ObjectError && error.code === 'notExists') return null;
      throw error;
    }
  }
  async parent(): Promise<ParentSnapshot> {
    await this.chain.checkNetwork();
    const [record, {object}, now] = await Promise.all([this.record(PARENT),
      this.client.getObject({objectId:PARENT_NFT,include:{json:true}}),this.chain.clock()]);
    if (!record || record.nft_id !== PARENT_NFT || BigInt(record.expiration_timestamp_ms) <= now) throw new Error('invalid_parent');
    const expectedType = `${this.client.suins.config.packageIdV1}::suins_registration::SuinsRegistration`;
    const fields = object.json as {id?:string;domain_name?:string;domain?:{labels?:string[]};expiration_timestamp_ms?:string};
    if (object.type !== expectedType || object.objectId !== PARENT_NFT || fields.id !== PARENT_NFT ||
      fields.domain_name !== PARENT || JSON.stringify(fields.domain?.labels) !== JSON.stringify(['sui','nozomi']) ||
      fields.expiration_timestamp_ms !== record.expiration_timestamp_ms || object.owner.$kind !== 'AddressOwner') throw new Error('invalid_parent_registration');
    return {name:PARENT,registration:PARENT_NFT,owner:object.owner.AddressOwner,expires_ms:record.expiration_timestamp_ms};
  }
  async resolve(input: string, pinned?: AgentRef) {
    const name = leafName(input);
    const [parent, record, now] = await Promise.all([this.parent(), this.record(name),this.chain.clock()]);
    const ref = this.chain.reference(validateLeaf(name, record, parent, now));
    assertPinned(ref, pinned);
    const authorization = await this.chain.resolve(ref);
    // Re-read the parent to detect expiry/registration changes across Agent fetch.
    const finalParent = await this.parent();
    if (finalParent.registration !== parent.registration || finalParent.expires_ms !== parent.expires_ms) throw new Error('name_changed_during_resolution');
    return {name, parent, authorization};
  }
  async createLeaves(targets: {local: string; research: string}, signer: Ed25519Keypair, journal: string) {
    const parent = await this.parent();
    if (parent.owner !== signer.toSuiAddress()) throw new Error('Wallet does not control the parent registration');
    const tx = new Transaction();
    const namesTx = new SuinsTransaction(this.client.suins, tx);
    let pending = 0;
    for (const role of ['local', 'research'] as const) {
      const name = `${role}.${PARENT}`;
      const target = normalizeSuiAddress(targets[role]);
      await this.chain.resolve(this.chain.reference(target));
      const record = await this.record(name);
      if (record) {
        if (validateLeaf(name,record,parent,await this.chain.clock()) !== target) throw new Error('Existing leaf has a different target');
      } else {
        namesTx.createLeafSubName({parentNft:PARENT_NFT,name,targetAddress:target}); pending++;
      }
    }
    if (pending) await this.chain.execute(tx,signer,journal,`create-leaves:${targets.local}:${targets.research}`);
    return {local:await this.resolve(`local.${PARENT}`),research:await this.resolve(`research.${PARENT}`)};
  }
}
