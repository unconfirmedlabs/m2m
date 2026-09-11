import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { type OfferData,makePolicy,policyHash,purpose,utf8,METHOD,makeCredit,makeAck,makeCheckpoint,signStatement,ZERO_HASH,hash } from './streaming-codec.js';

/** Public deterministic test-only seeds. Never use these accounts for funds. */
export async function streamingFixture() {
  const buyer=Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(1));
  const provider=Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(2));
  const addr=(n:number)=>`0x${n.toString(16).padStart(2,'0').repeat(32)}`;
  const policy=makePolicy(['records/v1','bytes/v1'],['7','2'],'10');
  const offer:OfferData={purpose:purpose('offer'),method:utf8(METHOD),version:1,network:utf8('test-vector'),package_id:addr(3),deployment:addr(4),
    buyer:addr(5),provider:addr(6),buyer_key:Array.from(buyer.getPublicKey().toRawBytes()),provider_key:Array.from(provider.getPublicKey().toRawBytes()),
    refund:addr(7),payee:addr(8),opening_nonce:Array<number>(32).fill(9),policy_hash:policyHash(policy),deposit:'12000',offer_expires_ms:'1000',work_deadline_ms:'2000',claim_deadline_ms:'12000'};
  const channel=addr(10), requestHash=hash(utf8('public deterministic request'));
  const credit=makeCredit(offer,channel,'1','1',requestHash,ZERO_HASH,['10','100'],policy);
  const output=Uint8Array.from(utf8('public deterministic output'));
  const checkpoint=makeCheckpoint(offer,credit,policy,['4','25'],hash(output),true);
  return {buyer,provider,policy,offer:await signStatement('offer',offer,provider),channel,requestHash,output,
    credit:await signStatement('credit',credit,buyer),ack:await signStatement('ack',makeAck(offer,credit),provider),
    checkpoint:await signStatement('checkpoint',checkpoint,provider)};
}
