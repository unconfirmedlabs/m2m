import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { ChannelChain, type MutationView } from './channel-chain.js';
import { key, save, type ChainConfig } from './chain.js';
import {
  Close,
  Credit,
  Offer,
  RequestDescriptor,
  hash,
  offerHash,
  termsHash,
  transcriptStart,
  utf8,
  type CreditData,
  type OfferData,
  validateCredit,
  validateOffer,
} from './channel-codec.js';

/**
 * Signed channel economic checks. This intentionally targets localnet only:
 * each invocation registers fresh agents and submits failed transactions.
 * The parent owns live execution and must opt into this script explicitly.
 */
const root = resolve(process.argv[2] ?? '.m2m/channels-local');
const runState = resolve(root, 'channel-economics', randomUUID());
const config: ChainConfig = JSON.parse(await readFile(`${root}/chain.json`, 'utf8'));
assert.equal(config.network, 'localnet', 'channel economic checks are restricted to localnet');

const chain = new ChannelChain(config);
await chain.validate();
const buyerController = await key(`${root}/buyer-controller.json`);
const providerController = await key(`${root}/provider-controller.json`);
const providerGas = await key(`${root}/provider-gas.json`);
const fixture = await readFile('fixtures/hello.txt');
const resultHash = Array.from(hash(fixture));
const terms = {
  purpose: utf8('m2m/channel/fixture-terms/v1'), result_hash: resultHash,
  unit_price: '1000', max_jobs: '10', max_unfulfilled_jobs: 1,
};
const termsDigest = Array.from(termsHash(terms));
const results: { test: string; passed: boolean; abort_code?: number }[] = [];

function abortCode(value: unknown): string | null {
  const error = value as any;
  let structured = error?.executionError ?? error?.FailedTransaction?.status?.error ?? error?.status?.error ?? error;
  if (structured instanceof Error) {
    try { structured = JSON.parse(structured.message); }
    catch { return null; }
  }
  if (structured?.$kind !== 'MoveAbort') return null;
  const abort = structured.MoveAbort;
  assert.equal(abort?.location?.package, config.package_id, 'Abort came from another package');
  assert.equal(abort?.location?.module, 'channel', 'Abort came from another module');
  return abort?.abortCode === undefined ? null : String(abort.abortCode);
}

async function expectAbort(name: string, expected: number, work: () => Promise<unknown>): Promise<void> {
  await assert.rejects(work, error => {
    const actual = abortCode(error);
    assert.equal(actual, String(expected), `${name}: expected MoveAbort ${expected}, got ${actual ?? String(error)}`);
    return true;
  });
  results.push({ test: name, passed: true, abort_code: expected });
  console.log(`PASS ${name} (MoveAbort ${expected})`);
}

async function registerPair(): Promise<{
  buyer: string; provider: string; buyerKey: Ed25519Keypair; providerKey: Ed25519Keypair;
}> {
  const buyerKey = Ed25519Keypair.generate();
  const providerKey = Ed25519Keypair.generate();
  const buyer = (await chain.register(Array.from(buyerKey.getPublicKey().toRawBytes()), buyerController)).agent;
  const provider = (await chain.register(Array.from(providerKey.getPublicKey().toRawBytes()), providerController)).agent;
  return { buyer, provider, buyerKey, providerKey };
}

async function buildOffer(
  buyer: string, provider: string, buyerKey: Ed25519Keypair, providerKey: Ed25519Keypair,
  nonce: number[], options: { deposit?: string; lifetime?: bigint; grace?: bigint } = {},
): Promise<{ offer: OfferData; signature: number[] }> {
  const now = BigInt(await chain.clock());
  const lifetime = options.lifetime ?? 180_000n;
  const grace = options.grace ?? 60_000n;
  const workDuration = lifetime - grace;
  if (workDuration < 10_000n) throw new Error('test offer work duration must be at least 10000ms');
  const offer: OfferData = {
    purpose: utf8('m2m/channel/offer/v1'), method: utf8('sui.channel.v1'), version: 1,
    network: utf8(config.chain_id), package_id: config.package_id, deployment: config.deployment,
    buyer, provider,
    buyer_key: Array.from(buyerKey.getPublicKey().toRawBytes()),
    provider_key: Array.from(providerKey.getPublicKey().toRawBytes()),
    refund: buyerController.toSuiAddress(), payee: providerController.toSuiAddress(),
    opening_nonce: nonce, terms_hash: termsDigest, deposit: options.deposit ?? '12000',
    offer_expires_ms: String(now + workDuration / 2n),
    work_deadline_ms: String(now + workDuration), claim_deadline_ms: String(now + lifetime),
  };
  validateOffer(offer);
  const signature = Array.from(await providerKey.sign(Offer.serialize(offer).toBytes()));
  return { offer, signature };
}

async function openChannel(
  label: string, pair: Awaited<ReturnType<typeof registerPair>>, nonce: number[], options: { deposit?: string; lifetime?: bigint; grace?: bigint } = {},
): Promise<{ offer: OfferData; signature: number[]; state: MutationView }> {
  const prepared = await buildOffer(pair.buyer, pair.provider, pair.buyerKey, pair.providerKey, nonce, options);
  const state = await chain.openChannel(prepared.offer, prepared.signature, buyerController, `${runState}/${label}.open.tx.json`);
  // A lost indexing response may legitimately reconcile the newly executed
  // opening. Verify its own digest and exact funded intent instead.
  assert.equal(state.resolution, 'own');
  assert.ok(state.digest);
  assert.deepEqual(state.state.offer, prepared.offer);
  assert.equal(await chain.lookupChannel(prepared.offer.buyer, prepared.offer.opening_nonce), state.channel);
  return { ...prepared, state };
}

function txOpen(
  offer: OfferData, signature: number[], signer: Ed25519Keypair, paymentAmount = offer.deposit,
): () => Promise<unknown> {
  return async () => {
    const tx = new Transaction();
    const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(paymentAmount)]);
    tx.moveCall({ target: `${config.package_id}::channel::open`, arguments: [
      tx.object(config.deployment), tx.object(offer.buyer), tx.object(offer.provider), payment,
      tx.pure.vector('u8', offer.opening_nonce), tx.pure.vector('u8', offer.terms_hash),
      tx.pure.u64(offer.deposit), tx.pure.u64(offer.offer_expires_ms), tx.pure.u64(offer.work_deadline_ms),
      tx.pure.u64(offer.claim_deadline_ms), tx.pure.vector('u8', signature), tx.object('0x6'),
    ] });
    tx.setSender(signer.toSuiAddress()); tx.setGasBudget(50_000_000);
    const bytes = await tx.build({ client: chain.client });
    const signed = await signer.signTransaction(bytes);
    const result = await chain.client.executeTransaction({ transaction: Buffer.from(signed.bytes, 'base64'), signatures: [signed.signature], include: { effects: true } });
    if (result.$kind === 'FailedTransaction') throw result.FailedTransaction.status.error;
    return result;
  };
}

function txRedeem(channel: string, credit: CreditData, signature: number[], signer: Ed25519Keypair): () => Promise<unknown> {
  return async () => {
    const tx = new Transaction();
    tx.moveCall({ target: `${config.package_id}::channel::redeem`, arguments: [
      tx.object(channel), tx.pure.u64(credit.sequence), tx.pure.u64(credit.cumulative_amount),
      tx.pure.vector('u8', credit.request_hash), tx.pure.vector('u8', credit.previous_transcript_hash),
      tx.pure.vector('u8', signature), tx.object('0x6'),
    ] });
    tx.setSender(signer.toSuiAddress()); tx.setGasBudget(50_000_000);
    const bytes = await tx.build({ client: chain.client }); const signed = await signer.signTransaction(bytes);
    const result = await chain.client.executeTransaction({ transaction: Buffer.from(signed.bytes, 'base64'), signatures: [signed.signature], include: { effects: true } });
    if (result.$kind === 'FailedTransaction') throw result.FailedTransaction.status.error;
    return result;
  };
}

function txClose(channel: string, close: { final_sequence: string; final_amount: string; transcript_hash: number[] }, buyerSignature: number[], providerSignature: number[], signer: Ed25519Keypair): () => Promise<unknown> {
  return async () => {
    const tx = new Transaction();
    tx.moveCall({ target: `${config.package_id}::channel::close`, arguments: [
      tx.object(channel), tx.pure.u64(close.final_sequence), tx.pure.u64(close.final_amount),
      tx.pure.vector('u8', close.transcript_hash), tx.pure.vector('u8', buyerSignature),
      tx.pure.vector('u8', providerSignature), tx.object('0x6'),
    ] });
    tx.setSender(signer.toSuiAddress()); tx.setGasBudget(50_000_000);
    const bytes = await tx.build({ client: chain.client }); const signed = await signer.signTransaction(bytes);
    const result = await chain.client.executeTransaction({ transaction: Buffer.from(signed.bytes, 'base64'), signatures: [signed.signature], include: { effects: true } });
    if (result.$kind === 'FailedTransaction') throw result.FailedTransaction.status.error;
    return result;
  };
}

function txRefund(channel: string, signer: Ed25519Keypair): () => Promise<unknown> {
  return async () => {
    const tx = new Transaction(); tx.moveCall({ target: `${config.package_id}::channel::refund`, arguments: [tx.object(channel), tx.object('0x6')] });
    tx.setSender(signer.toSuiAddress()); tx.setGasBudget(50_000_000);
    const bytes = await tx.build({ client: chain.client }); const signed = await signer.signTransaction(bytes);
    const result = await chain.client.executeTransaction({ transaction: Buffer.from(signed.bytes, 'base64'), signatures: [signed.signature], include: { effects: true } });
    if (result.$kind === 'FailedTransaction') throw result.FailedTransaction.status.error;
    return result;
  };
}

async function creditFor(
  pair: Awaited<ReturnType<typeof registerPair>>, channel: string, offer: OfferData, sequence: string, amount: string,
): Promise<{ credit: CreditData; signature: number[] }> {
  const request = {
    purpose: utf8('m2m/channel/request/v1'), channel, terms_hash: termsDigest,
    request_id: utf8(`job-${sequence.padStart(4, '0')}`), request_sequence: sequence,
  };
  const requestDigest = Array.from(hash(RequestDescriptor.serialize(request).toBytes()));
  const previous = Array.from(hash(new TextEncoder().encode(`previous-${sequence}`)));
  const credit: CreditData = {
    purpose: utf8('m2m/channel/credit/v1'), method: utf8('sui.channel.v1'), version: 1,
    network: offer.network, package_id: offer.package_id, deployment: offer.deployment,
    buyer: offer.buyer, provider: offer.provider, channel,
    offer_hash: Array.from(offerHash(offer)), sequence, cumulative_amount: amount,
    request_hash: requestDigest, previous_transcript_hash: previous,
  };
  validateCredit(credit);
  return { credit, signature: Array.from(await pair.buyerKey.sign(Credit.serialize(credit).toBytes())) };
}

async function closeCertificate(
  pair: Awaited<ReturnType<typeof registerPair>>, offer: OfferData, channel: string,
  sequence: string, amount: string, transcriptHash: number[],
) {
  const close = {
    purpose: utf8('m2m/channel/close/v1'), method: utf8('sui.channel.v1'), version: 1,
    network: offer.network, package_id: offer.package_id, deployment: offer.deployment,
    buyer: offer.buyer, provider: offer.provider, channel,
    offer_hash: Array.from(offerHash(offer)), final_sequence: sequence, final_amount: amount,
    transcript_hash: transcriptHash,
  };
  const bytes = Close.serialize(close).toBytes();
  return {
    close,
    buyer_signature: Array.from(await pair.buyerKey.sign(bytes)),
    provider_signature: Array.from(await pair.providerKey.sign(bytes)),
  };
}

async function balance(owner: string): Promise<bigint> {
  return BigInt((await chain.client.getBalance({ owner })).balance.balance);
}

// Channel one covers signed opening, exact authority/nonce/amount checks,
// a cross-channel statement, fixed destinations, key rotation snapshots, and
// terminal close behavior.
const pairOne = await registerPair();
const first = await buildOffer(pairOne.buyer, pairOne.provider, pairOne.buyerKey, pairOne.providerKey, Array(32).fill(1));
const tamperedPayeeOffer = { ...first.offer, payee: buyerController.toSuiAddress() };
const tamperedPayeeSignature = Array.from(await pairOne.providerKey.sign(Offer.serialize(tamperedPayeeOffer).toBytes()));
await expectAbort('tampered offer cannot redirect fixed payee', 3, txOpen(tamperedPayeeOffer, tamperedPayeeSignature, buyerController));
const wrongNetworkOffer = { ...first.offer, network: utf8('wrong-network') };
const wrongNetworkSignature = Array.from(await pairOne.providerKey.sign(Offer.serialize(wrongNetworkOffer).toBytes()));
await expectAbort('offer network is cryptographically bound', 3, txOpen(wrongNetworkOffer, wrongNetworkSignature, buyerController));
await expectAbort('funding requires exact deposit', 5, txOpen(first.offer, first.signature, buyerController, '11999'));
await expectAbort('wrong provider signature', 3, txOpen(first.offer, new Array(64).fill(0), buyerController));
await expectAbort('short provider signature', 1, txOpen(first.offer, new Array(63).fill(0), buyerController));
await expectAbort('wrong controller cannot open', 0, txOpen(first.offer, first.signature, providerController));
const opened = await chain.openChannel(first.offer, first.signature, buyerController, `${runState}/channel-one.open.tx.json`);
results.push({ test: 'valid open', passed: true }); console.log('PASS valid open');
const channelOne = opened.channel;
await expectAbort('duplicate opening nonce', 6, txOpen(first.offer, first.signature, buyerController));

// Open a second channel under the same endpoint keys so a valid signed credit
// for one channel cannot be replayed against its sibling.
const zero = await openChannel('channel-zero', pairOne, Array(32).fill(3));
const creditOne = await creditFor(pairOne, channelOne, first.offer, '1', '1000');
await expectAbort('credit cannot cross channels', 3, txRedeem(zero.state.channel, creditOne.credit, creditOne.signature, providerGas));
const zeroCredit = await creditFor(pairOne, zero.state.channel, zero.offer, '1', '1000');
const wrongMethodCredit = { ...zeroCredit.credit, method: utf8('m2m/other/v1') };
const wrongMethodSignature = Array.from(await pairOne.buyerKey.sign(Credit.serialize(wrongMethodCredit).toBytes()));
await expectAbort('credit method is cryptographically bound', 3, txRedeem(zero.state.channel, wrongMethodCredit, wrongMethodSignature, providerGas));
const wrongCreditNetwork = { ...zeroCredit.credit, network: utf8('wrong-network') };
const wrongCreditNetworkSignature = Array.from(await pairOne.buyerKey.sign(Credit.serialize(wrongCreditNetwork).toBytes()));
await expectAbort('credit network is cryptographically bound', 3, txRedeem(zero.state.channel, wrongCreditNetwork, wrongCreditNetworkSignature, providerGas));
const zeroCertificate = await closeCertificate(pairOne, zero.offer, zero.state.channel, '0', '0', Array.from(transcriptStart(zero.state.channel, zero.offer)));
const zeroClosed = await chain.closeChannel(zeroCertificate, providerGas, `${runState}/channel-zero.close.tx.json`);
assert.equal(zeroClosed.state.status, 1); assert.equal(zeroClosed.state.redeemed_amount, '0');
results.push({ test: 'zero-job cooperative close', passed: true }); console.log('PASS zero-job cooperative close');

await expectAbort('wrong credit signature', 3, txRedeem(channelOne, creditOne.credit, new Array(64).fill(0), providerGas));
await expectAbort('short credit signature', 1, txRedeem(channelOne, creditOne.credit, new Array(63).fill(0), providerGas));
const providerBeforeCredit = await balance(providerController.toSuiAddress());
const redeemed = await chain.redeemChannel(creditOne.credit, creditOne.signature, providerGas, `${runState}/channel-one.redeem.tx.json`);
const providerAfterCredit = await balance(providerController.toSuiAddress());
assert.equal(providerAfterCredit - providerBeforeCredit, 1000n, 'redeem must pay fixed provider controller');
assert.equal(redeemed.state.redeemed_amount, '1000'); results.push({ test: 'valid cumulative redemption', passed: true }); console.log('PASS valid cumulative redemption');
await expectAbort('duplicate redemption sequence', 9, txRedeem(channelOne, creditOne.credit, creditOne.signature, providerGas));
const staleAmount = { ...creditOne.credit, sequence: '2', cumulative_amount: '999' };
const staleAmountSignature = Array.from(await pairOne.buyerKey.sign(Credit.serialize(staleAmount).toBytes()));
await expectAbort('redemption amount cannot move backwards', 5, txRedeem(channelOne, staleAmount, staleAmountSignature, providerGas));
const tooMuch = { ...creditOne.credit, sequence: '2', cumulative_amount: String(BigInt(first.offer.deposit) + 1n) };
const tooMuchSignature = Array.from(await pairOne.buyerKey.sign(Credit.serialize(tooMuch).toBytes()));
await expectAbort('cumulative amount cannot exceed deposit', 5, txRedeem(channelOne, tooMuch, tooMuchSignature, providerGas));

// Existing funded authority is the endpoint-key snapshot. Rotate both live
// agents, then prove that an old funded close still works and a new offer
// signed with old/current mismatched terms cannot be adopted.
const oldBuyerKey = pairOne.buyerKey;
const oldProviderKey = pairOne.providerKey;
const currentBuyerKey = Ed25519Keypair.generate();
const currentProviderKey = Ed25519Keypair.generate();
await chain.rotate(pairOne.buyer, Array.from(currentBuyerKey.getPublicKey().toRawBytes()), buyerController);
await chain.rotate(pairOne.provider, Array.from(currentProviderKey.getPublicKey().toRawBytes()), providerController);
const oldKeyOffer = await buildOffer(pairOne.buyer, pairOne.provider, oldBuyerKey, oldProviderKey, Array(32).fill(4));
await expectAbort('rotated endpoint cannot sign a new offer with old key', 3, txOpen(oldKeyOffer.offer, oldKeyOffer.signature, buyerController));
const currentOffer = await buildOffer(pairOne.buyer, pairOne.provider, currentBuyerKey, currentProviderKey, Array(32).fill(5));
const currentTamperedPayee = { ...currentOffer.offer, payee: buyerController.toSuiAddress() };
const currentTamperedPayeeSignature = Array.from(await currentProviderKey.sign(Offer.serialize(currentTamperedPayee).toBytes()));
await expectAbort('new offer payee remains fixed by agent', 3, txOpen(currentTamperedPayee, currentTamperedPayeeSignature, buyerController));

const closeOne = await closeCertificate(pairOne, first.offer, channelOne, '1', '1000', Array(32).fill(7));
await expectAbort('close with invalid buyer signature', 3, txClose(channelOne, closeOne.close, new Array(64).fill(0), closeOne.provider_signature, providerGas));
const closed = await chain.closeChannel(closeOne, providerGas, `${runState}/channel-one.close.tx.json`);
assert.equal(closed.state.status, 1); assert.equal(closed.state.redeemed_amount, '1000');
results.push({ test: 'funded authority survives endpoint rotation', passed: true }); console.log('PASS funded authority survives endpoint rotation');
await expectAbort('redeem after close', 7, txRedeem(channelOne, creditOne.credit, creditOne.signature, providerGas));
await expectAbort('refund after close', 7, txRefund(channelOne, providerGas));

// Channel two checks direct cumulative redemption (sequence 2 then 3), a
// lower close racing the already redeemed state, and residual deadline refund.
const pairTwo = await registerPair();
const second = await openChannel('channel-two', pairTwo, Array(32).fill(2), { lifetime: 20_000n, grace: 10_000n, deposit: '12000' });
await expectAbort('refund before claim deadline', 8, txRefund(second.state.channel, providerGas));
const validSecondCredit = await creditFor(pairTwo, second.state.channel, second.offer, '1', '1000');
const malformed = { ...validSecondCredit.credit, sequence: '0', cumulative_amount: '0' };
const malformedSignature = Array.from(await pairTwo.buyerKey.sign(Credit.serialize(malformed).toBytes()));
await expectAbort('zero credit sequence', 9, txRedeem(second.state.channel, malformed, malformedSignature, providerGas));
const malformedLength = { ...validSecondCredit.credit, sequence: '1', request_hash: [1] };
const malformedLengthSignature = Array.from(await pairTwo.buyerKey.sign(Credit.serialize(malformedLength as any).toBytes()));
await expectAbort('credit hash length', 1, txRedeem(second.state.channel, malformedLength as any, malformedLengthSignature, providerGas));
const secondCredit = await creditFor(pairTwo, second.state.channel, second.offer, '2', '2000');
const secondBefore = await balance(providerController.toSuiAddress());
await chain.redeemChannel(secondCredit.credit, secondCredit.signature, providerGas, `${runState}/channel-two.redeem-2.tx.json`);
const secondAfter = await balance(providerController.toSuiAddress());
assert.equal(secondAfter - secondBefore, 2000n);
const thirdCredit = await creditFor(pairTwo, second.state.channel, second.offer, '3', '3000');
const thirdBefore = await balance(providerController.toSuiAddress());
await chain.redeemChannel(thirdCredit.credit, thirdCredit.signature, providerGas, `${runState}/channel-two.redeem-3.tx.json`);
const thirdAfter = await balance(providerController.toSuiAddress());
assert.equal(thirdAfter - thirdBefore, 1000n);
results.push({ test: 'direct sequence 2 then sequence 3 cumulative deltas', passed: true }); console.log('PASS direct sequence 2 then sequence 3 cumulative deltas');
const lowerClose = await closeCertificate(pairTwo, second.offer, second.state.channel, '2', '2000', Array(32).fill(8));
await expectAbort('close lower than redeemed state', 5, txClose(second.state.channel, lowerClose.close, lowerClose.buyer_signature, lowerClose.provider_signature, providerGas));

while (BigInt(await chain.clock()) < BigInt(second.offer.claim_deadline_ms)) await new Promise(resolveTimer => setTimeout(resolveTimer, 250));
await expectAbort('redeem fails at claim deadline', 4, txRedeem(second.state.channel, thirdCredit.credit, thirdCredit.signature, providerGas));
await expectAbort('close fails at claim deadline', 4, txClose(second.state.channel, lowerClose.close, lowerClose.buyer_signature, lowerClose.provider_signature, providerGas));
const refundBefore = await balance(buyerController.toSuiAddress());
const refunded = await chain.refundChannel(second.state.channel, providerGas, `${runState}/channel-two.refund.tx.json`);
const refundAfter = await balance(buyerController.toSuiAddress());
assert.equal(refundAfter - refundBefore, 9000n, 'refund must pay only residual funds to fixed buyer controller');
assert.equal(refunded.state.status, 2); assert.equal(refunded.state.funds, '0');
results.push({ test: 'valid deadline residual refund', passed: true }); console.log('PASS valid deadline residual refund');
await expectAbort('refund replay after terminal state', 7, txRefund(second.state.channel, providerGas));

// A separate channel proves that a valid higher close after a lower
// redemption transfers only the incremental delta.
const pairThree = await registerPair();
const third = await openChannel('channel-three', pairThree, Array(32).fill(6));
const lowerCredit = await creditFor(pairThree, third.state.channel, third.offer, '2', '2000');
await chain.redeemChannel(lowerCredit.credit, lowerCredit.signature, providerGas, `${runState}/channel-three.redeem.tx.json`);
const higherClose = await closeCertificate(pairThree, third.offer, third.state.channel, '3', '3000', Array(32).fill(9));
const higherBefore = await balance(providerController.toSuiAddress());
const higherClosed = await chain.closeChannel(higherClose, providerGas, `${runState}/channel-three.close.tx.json`);
const higherAfter = await balance(providerController.toSuiAddress());
assert.equal(higherAfter - higherBefore, 1000n, 'higher close must pay only the remaining delta');
assert.equal(higherClosed.state.status, 1); assert.equal(higherClosed.state.redeemed_amount, '3000');
results.push({ test: 'higher close after lower redemption delta', passed: true }); console.log('PASS higher close after lower redemption delta');

await save(`${root}/channel-economics-results.json`, {
  network: config.network, package_id: config.package_id, results,
  channel_one: channelOne, channel_two: second.state.channel,
});
console.log(`${results.length} channel economic checks passed.`);
