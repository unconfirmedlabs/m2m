import { Transaction } from '@mysten/sui/transactions';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { bcs } from '@mysten/sui/bcs';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { NativeChain, ObjectError } from './native-chain.js';
import { Channel, OpeningKey, policyHash, offerHash, creditHash, equal, validateSigned, validatePolicy,
  type PolicyData, type OfferData, type CreditData, type CheckpointData, type SignedData } from './streaming-codec.js';

export class StreamingChain extends NativeChain {
  async channel(id:string){
    await this.validate();
    const data=Channel.parse((await this.object(id,'channel','Channel')).content);
    const o=data.offer;
    if(data.id!==normalizeSuiAddress(id)||o.package_id!==this.config.package_id||o.deployment!==this.config.domain||
      Buffer.from(o.network).toString('utf8')!==this.config.chain_id||!equal(policyHash(data.policy),o.policy_hash))throw Error('Channel binding mismatch');
    return data;
  }
  async opening(buyer:string,nonce:number[]){
    await this.validate();
    try{
      const {dynamicField}=await this.client.getDynamicField({parentId:buyer,
        name:{type:`${this.config.package_id}::channel::OpeningKey`,bcs:OpeningKey.serialize({nonce}).toBytes()}});
      return bcs.Address.parse(dynamicField.value.bcs);
    }catch(error){if(error instanceof ObjectError&&error.code==='notExists')return null;throw error;}
  }
  policyArgument(tx:Transaction,policy:PolicyData){
    validatePolicy(policy);
    return this.call(tx,'policy','new',[tx.pure(bcs.vector(bcs.vector(bcs.u8())).serialize(policy.units)),
      tx.pure.vector('u64',policy.rates),tx.pure.u64(policy.denominator)]);
  }
  creditArgument(tx:Transaction,credit:CreditData){
    return this.call(tx,'channel','credit',[tx.object(credit.channel),tx.pure.u64(credit.sequence),tx.pure.u64(credit.request_sequence),
      tx.pure.vector('u8',credit.request_hash),tx.pure.vector('u8',credit.previous_checkpoint),tx.pure.vector('u64',credit.units),tx.pure.u64(credit.cumulative_amount)]);
  }
  async fund(offer:SignedData<OfferData>,policy:PolicyData,signer:Ed25519Keypair,journal:string){
    await this.validate();const o=validateSigned<OfferData>('offer',offer,offer.payload.provider_key).payload;
    if(o.package_id!==this.config.package_id||o.deployment!==this.config.domain||Buffer.from(o.network).toString('utf8')!==this.config.chain_id||!equal(o.policy_hash,policyHash(policy)))throw Error('Offer Domain/policy mismatch');
    const existing=await this.opening(o.buyer,o.opening_nonce);
    if(existing){const channel=await this.channel(existing);if(!equal(offerHash(channel.offer),offerHash(o)))throw Error('Opening nonce belongs to different terms');return existing;}
    const [buyer,provider]=await Promise.all([this.resolve(this.reference(o.buyer)),this.resolve(this.reference(o.provider))]);
    if(buyer.controller!==signer.toSuiAddress()||o.refund!==buyer.controller||o.payee!==provider.controller||
      !equal(o.buyer_key,buyer.economic_key)||!equal(o.provider_key,provider.economic_key))throw Error('Live offer authority mismatch');
    const tx=new Transaction();const [coin]=tx.splitCoins(tx.gas,[tx.pure.u64(o.deposit)]);
    this.call(tx,'channel','open',[tx.object(this.config.domain),tx.object(o.buyer),tx.object(o.provider),coin,this.policyArgument(tx,policy),
      tx.pure.vector('u8',o.opening_nonce),tx.pure.u64(o.deposit),tx.pure.u64(o.offer_expires_ms),tx.pure.u64(o.work_deadline_ms),
      tx.pure.u64(o.claim_deadline_ms),tx.pure.vector('u8',offer.signature),tx.object('0x6')]);
    await this.execute(tx,signer,journal,`fund:${Buffer.from(offerHash(o)).toString('hex')}`);
    const id=await this.opening(o.buyer,o.opening_nonce);if(!id)throw Error('Funded opening mapping not visible');
    const confirmed=await this.channel(id);if(!equal(offerHash(confirmed.offer),offerHash(o)))throw Error('Funded terms mismatch');return id;
  }
  async redeem(credit:SignedData<CreditData>,signer:Ed25519Keypair,journal:string){
    const ch=await this.channel(credit.payload.channel);validateSigned('credit',credit,ch.offer.buyer_key);
    const tx=new Transaction();this.call(tx,'channel','redeem',[tx.object(ch.id),this.creditArgument(tx,credit.payload),tx.pure.vector('u8',credit.signature),tx.object('0x6')]);
    return this.execute(tx,signer,journal,`redeem:${ch.id}:${Buffer.from(creditHash(credit.payload)).toString('hex')}`);
  }
  async closeExact(credit:SignedData<CreditData>,checkpoint:SignedData<CheckpointData>,signer:Ed25519Keypair,journal:string){
    const ch=await this.channel(credit.payload.channel);validateSigned('credit',credit,ch.offer.buyer_key);validateSigned('checkpoint',checkpoint,ch.offer.provider_key);
    if(!checkpoint.payload.final)throw Error('Exact close requires provider final consent');
    const tx=new Transaction(),c=this.creditArgument(tx,credit.payload),p=checkpoint.payload;
    const cp=this.call(tx,'channel','checkpoint',[tx.object(ch.id),c,tx.pure.vector('u64',p.units),tx.pure.u64(p.cumulative_amount),
      tx.pure.vector('u8',p.output_hash),tx.pure.bool(p.final)]);
    this.call(tx,'channel','close_exact',[tx.object(ch.id),c,tx.pure.vector('u8',credit.signature),cp,tx.pure.vector('u8',checkpoint.signature),tx.object('0x6')]);
    return this.execute(tx,signer,journal,`close:${ch.id}:${Buffer.from(checkpoint.signature).toString('hex')}`);
  }
  async refund(id:string,signer:Ed25519Keypair,journal:string){
    const ch=await this.channel(id);const tx=new Transaction();this.call(tx,'channel','refund',[tx.object(ch.id),tx.object('0x6')]);
    return this.execute(tx,signer,journal,`refund:${ch.id}`);
  }
}
