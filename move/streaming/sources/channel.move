/// Funded generic streaming credit. Signatures use economic keys, never transport authority.
module m2m_streaming::channel;

use std::bcs;
use m2m_streaming::identity::{Self, Agent, Domain};
use m2m_streaming::policy::{Self, Policy};
use sui::balance::{Self, Balance};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::dynamic_field;
use sui::ed25519;
use sui::hash;
use sui::sui::SUI;

const EAuthority: u64 = 0;
const ELength: u64 = 1;
const EDomain: u64 = 2;
const ESignature: u64 = 3;
const EExpired: u64 = 4;
const EAmount: u64 = 5;
const ENonce: u64 = 6;
const ETerminal: u64 = 7;
const ETooEarly: u64 = 8;
const ESequence: u64 = 9;
const EDeadline: u64 = 10;
const ECheckpoint: u64 = 11;

public struct OpeningKey has copy, drop, store { nonce: vector<u8> }

public struct Offer has copy, drop, store {
    purpose: vector<u8>, method: vector<u8>, version: u8, network: vector<u8>,
    package_id: address, deployment: address, buyer: address, provider: address,
    buyer_key: vector<u8>, provider_key: vector<u8>, refund: address, payee: address,
    opening_nonce: vector<u8>, policy_hash: vector<u8>, deposit: u64,
    offer_expires_ms: u64, work_deadline_ms: u64, claim_deadline_ms: u64,
}
public struct Credit has copy, drop, store {
    purpose: vector<u8>, method: vector<u8>, version: u8, network: vector<u8>,
    package_id: address, deployment: address, buyer: address, provider: address,
    channel: address, offer_hash: vector<u8>, sequence: u64, request_sequence: u64,
    request_hash: vector<u8>, previous_checkpoint: vector<u8>, units: vector<u64>,
    cumulative_amount: u64,
}
public struct Checkpoint has copy, drop, store {
    purpose: vector<u8>, method: vector<u8>, version: u8, network: vector<u8>,
    package_id: address, deployment: address, buyer: address, provider: address,
    channel: address, offer_hash: vector<u8>, credit_hash: vector<u8>, sequence: u64,
    request_sequence: u64, request_hash: vector<u8>, previous_checkpoint: vector<u8>,
    units: vector<u64>, cumulative_amount: u64, output_hash: vector<u8>, final: bool,
}
public struct Channel has key {
    id: UID, offer: Offer, policy: Policy, funds: Balance<SUI>,
    redeemed_amount: u64, redeemed_sequence: u64, redeemed_units: vector<u64>,
    status: u8, terminal_tx: vector<u8>, close_hash: vector<u8>,
}

fun signature(signature: &vector<u8>, key: &vector<u8>, bytes: &vector<u8>) {
    assert!(signature.length() == 64 && key.length() == 32, ELength);
    assert!(ed25519::ed25519_verify(signature, key, bytes), ESignature);
}

public fun offer(
    domain: &Domain, buyer: &Agent, provider: &Agent, policy: &Policy,
    opening_nonce: vector<u8>, deposit: u64, offer_expires_ms: u64,
    work_deadline_ms: u64, claim_deadline_ms: u64,
): Offer {
    assert!(identity::agent_deployment(buyer) == object::id(domain), EDomain);
    assert!(identity::agent_deployment(provider) == object::id(domain), EDomain);
    assert!(object::id(buyer) != object::id(provider), EAuthority);
    assert!(opening_nonce.length() == 32, ELength);
    assert!(deposit > 0, EAmount);
    assert!(offer_expires_ms < work_deadline_ms && work_deadline_ms < claim_deadline_ms, EDeadline);
    assert!(claim_deadline_ms - work_deadline_ms >= 10_000, EDeadline);
    policy::validate(policy);
    Offer {
        purpose: b"m2m/streaming/offer/v1", method: b"sui.streaming.v1", version: 1,
        network: identity::domain_network(domain), package_id: identity::domain_package(domain),
        deployment: object::id_address(domain), buyer: object::id_address(buyer), provider: object::id_address(provider),
        buyer_key: identity::agent_economic(buyer), provider_key: identity::agent_economic(provider),
        refund: identity::agent_controller(buyer), payee: identity::agent_controller(provider),
        opening_nonce, policy_hash: policy::commitment(policy), deposit,
        offer_expires_ms, work_deadline_ms, claim_deadline_ms,
    }
}

fun open_verified(
    buyer: &mut Agent, payment: Coin<SUI>, terms: Offer, policy: Policy,
    clock: &Clock, ctx: &mut TxContext,
) {
    assert!(identity::agent_controller(buyer) == ctx.sender(), EAuthority);
    let now = clock::timestamp_ms(clock);
    assert!(now < terms.offer_expires_ms, EExpired);
    assert!(terms.claim_deadline_ms - now <= 3_600_000, EDeadline);
    assert!(coin::value(&payment) == terms.deposit, EAmount);
    let key = OpeningKey { nonce: terms.opening_nonce };
    assert!(!dynamic_field::exists(identity::agent_uid_mut(buyer), key), ENonce);
    let mut redeemed_units = vector[];
    let mut i = 0;
    while (i < policy::dimensions(&policy)) { redeemed_units.push_back(0); i = i + 1 };
    let channel = Channel {
        id: object::new(ctx), offer: terms, policy, funds: coin::into_balance(payment),
        redeemed_amount: 0, redeemed_sequence: 0, redeemed_units,
        status: 0, terminal_tx: vector[], close_hash: vector[],
    };
    dynamic_field::add(identity::agent_uid_mut(buyer), key, object::id(&channel));
    transfer::share_object(channel);
}

public fun open(
    domain: &Domain, buyer: &mut Agent, provider: &Agent, payment: Coin<SUI>, policy: Policy,
    opening_nonce: vector<u8>, deposit: u64, offer_expires_ms: u64, work_deadline_ms: u64,
    claim_deadline_ms: u64, provider_signature: vector<u8>, clock: &Clock, ctx: &mut TxContext,
) {
    identity::assert_live(buyer, clock);
    identity::assert_live(provider, clock);
    let terms = offer(domain, buyer, provider, &policy, opening_nonce, deposit,
        offer_expires_ms, work_deadline_ms, claim_deadline_ms);
    signature(&provider_signature, &terms.provider_key, &bcs::to_bytes(&terms));
    open_verified(buyer, payment, terms, policy, clock, ctx);
}

public fun credit(
    channel: &Channel, sequence: u64, request_sequence: u64, request_hash: vector<u8>,
    previous_checkpoint: vector<u8>, units: vector<u64>, cumulative_amount: u64,
): Credit {
    assert!(sequence > 0 && request_sequence > 0, ESequence);
    assert!(request_hash.length() == 32 && previous_checkpoint.length() == 32, ELength);
    assert!(cumulative_amount == policy::price(&channel.policy, &units), EAmount);
    assert!(cumulative_amount <= channel.offer.deposit, EAmount);
    let o = &channel.offer;
    Credit {
        purpose: b"m2m/streaming/credit/v1", method: b"sui.streaming.v1", version: 1,
        network: o.network, package_id: o.package_id, deployment: o.deployment,
        buyer: o.buyer, provider: o.provider, channel: object::id_address(channel),
        offer_hash: hash::blake2b256(&bcs::to_bytes(o)), sequence, request_sequence,
        request_hash, previous_checkpoint, units, cumulative_amount,
    }
}

fun validate_credit(channel: &Channel, credit: &Credit, buyer_signature: &vector<u8>) {
    let expected = credit(channel, credit.sequence, credit.request_sequence, credit.request_hash,
        credit.previous_checkpoint, credit.units, credit.cumulative_amount);
    assert!(*credit == expected, EDomain);
    signature(buyer_signature, &channel.offer.buyer_key, &bcs::to_bytes(credit));
}

public fun checkpoint(
    channel: &Channel, credit: &Credit, units: vector<u64>, cumulative_amount: u64,
    output_hash: vector<u8>, final: bool,
): Checkpoint {
    assert!(policy::within(&units, &credit.units), EAmount);
    assert!(policy::price(&channel.policy, &units) == cumulative_amount, EAmount);
    assert!(output_hash.length() == 32, ELength);
    let o = &channel.offer;
    Checkpoint {
        purpose: b"m2m/streaming/checkpoint/v1", method: b"sui.streaming.v1", version: 1,
        network: o.network, package_id: o.package_id, deployment: o.deployment,
        buyer: o.buyer, provider: o.provider, channel: object::id_address(channel),
        offer_hash: hash::blake2b256(&bcs::to_bytes(o)), credit_hash: hash::blake2b256(&bcs::to_bytes(credit)),
        sequence: credit.sequence, request_sequence: credit.request_sequence,
        request_hash: credit.request_hash, previous_checkpoint: credit.previous_checkpoint,
        units, cumulative_amount, output_hash, final,
    }
}

fun assert_open(channel: &Channel, clock: &Clock) {
    assert!(channel.status == 0, ETerminal);
    assert!(clock::timestamp_ms(clock) < channel.offer.claim_deadline_ms, EExpired);
}

fun pay(channel: &mut Channel, amount: u64, ctx: &mut TxContext) {
    if (amount > 0) transfer::public_transfer(coin::from_balance(balance::split(&mut channel.funds, amount), ctx), channel.offer.payee);
}
fun return_residual(channel: &mut Channel, ctx: &mut TxContext) {
    let residual = balance::withdraw_all(&mut channel.funds);
    if (balance::value(&residual) > 0) transfer::public_transfer(coin::from_balance(residual, ctx), channel.offer.refund)
    else balance::destroy_zero(residual);
}

fun redeem_verified(channel: &mut Channel, credit: Credit, clock: &Clock, ctx: &mut TxContext) {
    assert_open(channel, clock);
    assert!(credit.sequence > channel.redeemed_sequence, ESequence);
    assert!(credit.cumulative_amount > channel.redeemed_amount, EAmount);
    assert!(policy::within(&channel.redeemed_units, &credit.units), EAmount);
    let delta = credit.cumulative_amount - channel.redeemed_amount;
    pay(channel, delta, ctx);
    channel.redeemed_amount = credit.cumulative_amount;
    channel.redeemed_sequence = credit.sequence;
    channel.redeemed_units = credit.units;
}

public fun redeem(channel: &mut Channel, credit: Credit, buyer_signature: vector<u8>, clock: &Clock, ctx: &mut TxContext) {
    validate_credit(channel, &credit, &buyer_signature);
    redeem_verified(channel, credit, clock, ctx);
}

fun close_verified(channel: &mut Channel, credit: Credit, checkpoint: Checkpoint, clock: &Clock, ctx: &mut TxContext) {
    assert_open(channel, clock);
    assert!(checkpoint.final, ECheckpoint);
    assert!(credit.sequence >= channel.redeemed_sequence, ESequence);
    assert!(checkpoint.cumulative_amount >= channel.redeemed_amount, EAmount);
    let delta = checkpoint.cumulative_amount - channel.redeemed_amount;
    pay(channel, delta, ctx);
    channel.redeemed_amount = checkpoint.cumulative_amount;
    channel.redeemed_sequence = credit.sequence;
    channel.redeemed_units = checkpoint.units;
    channel.status = 1;
    channel.terminal_tx = *ctx.digest();
    channel.close_hash = hash::blake2b256(&bcs::to_bytes(&checkpoint));
    return_residual(channel, ctx);
}

public fun close_exact(
    channel: &mut Channel, credit: Credit, buyer_signature: vector<u8>,
    checkpoint: Checkpoint, provider_signature: vector<u8>, clock: &Clock, ctx: &mut TxContext,
) {
    validate_credit(channel, &credit, &buyer_signature);
    let expected = checkpoint(channel, &credit, checkpoint.units, checkpoint.cumulative_amount,
        checkpoint.output_hash, checkpoint.final);
    assert!(checkpoint == expected, ECheckpoint);
    signature(&provider_signature, &channel.offer.provider_key, &bcs::to_bytes(&checkpoint));
    close_verified(channel, credit, checkpoint, clock, ctx);
}

public fun refund(channel: &mut Channel, clock: &Clock, ctx: &mut TxContext) {
    assert!(channel.status == 0, ETerminal);
    assert!(clock::timestamp_ms(clock) >= channel.offer.claim_deadline_ms, ETooEarly);
    channel.status = 2;
    channel.terminal_tx = *ctx.digest();
    return_residual(channel, ctx);
}

#[test_only]
public fun open_test(domain: &Domain, buyer: &mut Agent, provider: &Agent, payment: Coin<SUI>, policy: Policy, nonce: vector<u8>, clock: &Clock, ctx: &mut TxContext) {
    let terms = offer(domain, buyer, provider, &policy, nonce, coin::value(&payment), 1000, 2000, 12_000);
    open_verified(buyer, payment, terms, policy, clock, ctx);
}
#[test_only]
public fun test_channel(policy: Policy, deposit: u64, buyer_key: vector<u8>, provider_key: vector<u8>, ctx: &mut TxContext): Channel {
    let mut redeemed_units = vector[];
    let mut i = 0;
    while (i < policy::dimensions(&policy)) { redeemed_units.push_back(0); i = i + 1 };
    Channel { id: object::new(ctx), offer: Offer {
        purpose: b"m2m/streaming/offer/v1", method: b"sui.streaming.v1", version: 1,
        network: b"test", package_id: @m2m_streaming, deployment: @0xd, buyer: @0xb, provider: @0xc,
        buyer_key, provider_key, refund: @0xb, payee: @0xc, opening_nonce: x"0000000000000000000000000000000000000000000000000000000000000000",
        policy_hash: policy::commitment(&policy), deposit, offer_expires_ms: 1000, work_deadline_ms: 2000, claim_deadline_ms: 12000,
    }, policy, funds: coin::into_balance(coin::mint_for_testing<SUI>(deposit, ctx)),
        redeemed_amount: 0, redeemed_sequence: 0, redeemed_units, status: 0, terminal_tx: vector[], close_hash: vector[] }
}
#[test_only]
public fun redeem_test(channel: &mut Channel, credit: Credit, clock: &Clock, ctx: &mut TxContext) { redeem_verified(channel, credit, clock, ctx) }
#[test_only]
public fun close_test(channel: &mut Channel, credit: Credit, checkpoint: Checkpoint, clock: &Clock, ctx: &mut TxContext) { close_verified(channel, credit, checkpoint, clock, ctx) }
#[test_only]
public fun state(channel: &Channel): (u64, u64, u8) { (balance::value(&channel.funds), channel.redeemed_amount, channel.status) }
#[test_only]
public fun destroy_test(channel: Channel) {
    let Channel { id, offer: _, policy: _, funds, redeemed_amount: _, redeemed_sequence: _, redeemed_units: _, status: _, terminal_tx: _, close_hash: _ } = channel;
    id.delete(); balance::destroy_for_testing(funds);
}

/// Independent Move reconstruction of the public TypeScript test vectors.
#[test_only]
public fun verify_vectors_test(
    network: vector<u8>, provider_key: vector<u8>, offer_signature: vector<u8>,
    credit_signature: vector<u8>, checkpoint_signature: vector<u8>,
): (vector<u8>, vector<u8>, vector<u8>) {
    let p = policy::new(vector[b"records/v1", b"bytes/v1"], vector[7, 2], 10);
    let o = Offer {
        purpose: b"m2m/streaming/offer/v1", method: b"sui.streaming.v1", version: 1, network,
        package_id: @0x0303030303030303030303030303030303030303030303030303030303030303,
        deployment: @0x0404040404040404040404040404040404040404040404040404040404040404,
        buyer: @0x0505050505050505050505050505050505050505050505050505050505050505,
        provider: @0x0606060606060606060606060606060606060606060606060606060606060606,
        buyer_key: x"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c", provider_key,
        refund: @0x0707070707070707070707070707070707070707070707070707070707070707,
        payee: @0x0808080808080808080808080808080808080808080808080808080808080808,
        opening_nonce: x"0909090909090909090909090909090909090909090909090909090909090909",
        policy_hash: policy::commitment(&p), deposit: 12000, offer_expires_ms: 1000, work_deadline_ms: 2000, claim_deadline_ms: 12000,
    };
    let ob = bcs::to_bytes(&o);
    signature(&offer_signature, &o.provider_key, &ob);
    let oh = hash::blake2b256(&ob);
    let c = Credit {
        purpose: b"m2m/streaming/credit/v1", method: o.method, version: o.version,
        network: o.network, package_id: o.package_id, deployment: o.deployment, buyer: o.buyer, provider: o.provider,
        channel: @0x0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a,
        offer_hash: oh, sequence: 1, request_sequence: 1,
        request_hash: x"9460da30cd61c0105f064ea5ee1cb7ecd36e26f1b224916dc1ab3adbd1bc9f2d",
        previous_checkpoint: x"0000000000000000000000000000000000000000000000000000000000000000",
        units: vector[10, 100], cumulative_amount: policy::price(&p, &vector[10, 100]),
    };
    let cb = bcs::to_bytes(&c);
    signature(&credit_signature, &o.buyer_key, &cb);
    let ch = hash::blake2b256(&cb);
    let cp = Checkpoint {
        purpose: b"m2m/streaming/checkpoint/v1", method: o.method, version: o.version,
        network: o.network, package_id: o.package_id, deployment: o.deployment, buyer: o.buyer, provider: o.provider,
        channel: c.channel, offer_hash: oh, credit_hash: ch, sequence: c.sequence,
        request_sequence: c.request_sequence, request_hash: c.request_hash, previous_checkpoint: c.previous_checkpoint,
        units: vector[4, 25], cumulative_amount: policy::price(&p, &vector[4, 25]),
        output_hash: x"8c17305ffafec3b7bd9e4657ad8ec614c15de0b3146dffea52a24e8e8d46a9d2", final: true,
    };
    let cpb = bcs::to_bytes(&cp);
    signature(&checkpoint_signature, &o.provider_key, &cpb);
    (oh, ch, hash::blake2b256(&cpb))
}

#[test_only]
public fun opening_exists_test(buyer: &mut Agent, nonce: vector<u8>): bool {
    dynamic_field::exists(identity::agent_uid_mut(buyer), OpeningKey { nonce })
}
#[test_only]
public fun channel_keys_test(channel: &Channel): (vector<u8>, vector<u8>) { (channel.offer.buyer_key, channel.offer.provider_key) }
