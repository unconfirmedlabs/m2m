/// Signed cumulative payment channels for the m2m experimental settlement
/// method. Bulk work remains offchain; this module enforces the deposit,
/// endpoint-key snapshots, cumulative redemption, close, and refund.
module m2m::channel;

use std::bcs;
use m2m::exchange::{Self, Agent, Domain};
use sui::balance::{Self, Balance};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::dynamic_field;
use sui::ed25519;
use sui::hash;
use sui::object::{Self, ID, UID};
use sui::sui::SUI;
use sui::transfer;

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

const OPEN: u8 = 0;
const CLOSED: u8 = 1;
const REFUNDED: u8 = 2;
const MAX_LIFETIME_MS: u64 = 3_600_000;

/// The typed dynamic-field name makes buyer+opening_nonce the uniqueness key.
/// It is retained after a channel becomes terminal.
public struct OpeningKey has copy, drop, store {
    nonce: vector<u8>,
}

/// The signed Offer has a flat prefix followed by the fields in the order
/// specified by docs/CHANNEL_SPEC.md. Do not reorder or nest these fields.
public struct Offer has copy, drop, store {
    purpose: vector<u8>,
    method: vector<u8>,
    version: u8,
    network: vector<u8>,
    package_id: address,
    deployment: address,
    buyer: address,
    provider: address,
    buyer_key: vector<u8>,
    provider_key: vector<u8>,
    refund: address,
    payee: address,
    opening_nonce: vector<u8>,
    terms_hash: vector<u8>,
    deposit: u64,
    offer_expires_ms: u64,
    work_deadline_ms: u64,
    claim_deadline_ms: u64,
}

/// A buyer authorization for a cumulative payment amount.
public struct Credit has copy, drop, store {
    purpose: vector<u8>,
    method: vector<u8>,
    version: u8,
    network: vector<u8>,
    package_id: address,
    deployment: address,
    buyer: address,
    provider: address,
    channel: address,
    offer_hash: vector<u8>,
    sequence: u64,
    cumulative_amount: u64,
    request_hash: vector<u8>,
    previous_transcript_hash: vector<u8>,
}

/// Both endpoint keys sign this exact structure for cooperative close.
public struct Close has copy, drop, store {
    purpose: vector<u8>,
    method: vector<u8>,
    version: u8,
    network: vector<u8>,
    package_id: address,
    deployment: address,
    buyer: address,
    provider: address,
    channel: address,
    offer_hash: vector<u8>,
    final_sequence: u64,
    final_amount: u64,
    transcript_hash: vector<u8>,
}

/// Terminal state is retained so recovery can distinguish a completed
/// transition from an unknown transaction outcome.
public struct Channel has key {
    id: UID,
    offer: Offer,
    funds: Balance<SUI>,
    redeemed_amount: u64,
    redeemed_sequence: u64,
    status: u8,
    terminal_tx: vector<u8>,
    close_hash: vector<u8>,
}

fun validate_parties(domain: &Domain, buyer: &Agent, provider: &Agent) {
    assert!(exchange::agent_deployment(buyer) == object::id(domain), EDomain);
    assert!(exchange::agent_deployment(provider) == object::id(domain), EDomain);
    assert!(object::id_address(buyer) != object::id_address(provider), EAuthority);
    assert!(exchange::agent_endpoint(buyer).length() == 32, ELength);
    assert!(exchange::agent_endpoint(provider).length() == 32, ELength);
}

fun validate_deadlines(
    offer_expires_ms: u64, work_deadline_ms: u64, claim_deadline_ms: u64,
) {
    assert!(offer_expires_ms < work_deadline_ms, EDeadline);
    assert!(work_deadline_ms < claim_deadline_ms, EDeadline);
    assert!(claim_deadline_ms - work_deadline_ms >= 10_000, EDeadline);
}

fun validate_signature(signature: &vector<u8>, key: &vector<u8>, bytes: &vector<u8>) {
    assert!(signature.length() == 64 && key.length() == 32, ELength);
    assert!(ed25519::ed25519_verify(signature, key, bytes), ESignature);
}

fun offer_bytes(offer: &Offer): vector<u8> { bcs::to_bytes(offer) }

fun credit_bytes(credit: &Credit): vector<u8> { bcs::to_bytes(credit) }

fun close_bytes(close: &Close): vector<u8> { bcs::to_bytes(close) }

fun offer_hash(offer: &Offer): vector<u8> { hash::blake2b256(&offer_bytes(offer)) }

fun credit_offer_hash(channel: &Channel): vector<u8> { offer_hash(&channel.offer) }

fun terminal_digest(ctx: &TxContext): vector<u8> { *ctx.digest() }

fun make_offer(
    domain: &Domain, buyer: &Agent, provider: &Agent,
    opening_nonce: vector<u8>, terms_hash: vector<u8>, deposit: u64,
    offer_expires_ms: u64, work_deadline_ms: u64, claim_deadline_ms: u64,
): Offer {
    validate_parties(domain, buyer, provider);
    assert!(opening_nonce.length() == 32 && terms_hash.length() == 32, ELength);
    assert!(deposit > 0, EAmount);
    validate_deadlines(offer_expires_ms, work_deadline_ms, claim_deadline_ms);
    Offer {
        purpose: b"m2m/channel/offer/v1",
        method: b"sui.channel.v1",
        version: 1,
        network: exchange::domain_network(domain),
        package_id: exchange::domain_package(domain),
        deployment: object::id_address(domain),
        buyer: object::id_address(buyer),
        provider: object::id_address(provider),
        buyer_key: exchange::agent_endpoint(buyer),
        provider_key: exchange::agent_endpoint(provider),
        refund: exchange::agent_controller(buyer),
        payee: exchange::agent_controller(provider),
        opening_nonce,
        terms_hash,
        deposit,
        offer_expires_ms,
        work_deadline_ms,
        claim_deadline_ms,
    }
}

/// Construct the exact Offer that `open` will verify and fund.
public fun offer(
    domain: &Domain, buyer: &Agent, provider: &Agent,
    opening_nonce: vector<u8>, terms_hash: vector<u8>, deposit: u64,
    offer_expires_ms: u64, work_deadline_ms: u64, claim_deadline_ms: u64,
): Offer {
    make_offer(
        domain, buyer, provider, opening_nonce, terms_hash, deposit,
        offer_expires_ms, work_deadline_ms, claim_deadline_ms,
    )
}

fun open_verified(
    buyer: &mut Agent, payment: Coin<SUI>, terms: Offer,
    clock: &Clock, ctx: &mut TxContext,
) {
    assert!(exchange::agent_controller(buyer) == ctx.sender(), EAuthority);
    assert!(clock::timestamp_ms(clock) < terms.offer_expires_ms, EExpired);
    assert!(terms.claim_deadline_ms - clock::timestamp_ms(clock) <= MAX_LIFETIME_MS, EDeadline);
    assert!(coin::value(&payment) == terms.deposit, EAmount);

    // Check before adding so a duplicate nonce has the channel-specific abort
    // code rather than the framework dynamic-field error.
    let key = OpeningKey { nonce: terms.opening_nonce };
    assert!(!dynamic_field::exists(exchange::agent_uid_mut(buyer), key), ENonce);

    let channel = Channel {
        id: object::new(ctx),
        offer: terms,
        funds: coin::into_balance(payment),
        redeemed_amount: 0,
        redeemed_sequence: 0,
        status: OPEN,
        terminal_tx: vector[],
        close_hash: vector[],
    };
    let channel_id = object::id(&channel);
    dynamic_field::add(exchange::agent_uid_mut(buyer), key, channel_id);
    transfer::share_object(channel);
}

/// Open a channel after verifying the provider's endpoint signature over the
/// canonical Offer. The transaction sender only supplies buyer funding/gas;
/// destinations are reconstructed from the live Agents.
public fun open(
    domain: &Domain, buyer: &mut Agent, provider: &Agent, payment: Coin<SUI>,
    opening_nonce: vector<u8>, terms_hash: vector<u8>, deposit: u64,
    offer_expires_ms: u64, work_deadline_ms: u64, claim_deadline_ms: u64,
    signature: vector<u8>, clock: &Clock, ctx: &mut TxContext,
) {
    let terms = make_offer(
        domain, buyer, provider, opening_nonce, terms_hash, deposit,
        offer_expires_ms, work_deadline_ms, claim_deadline_ms,
    );
    let bytes = offer_bytes(&terms);
    validate_signature(&signature, &terms.provider_key, &bytes);
    open_verified(buyer, payment, terms, clock, ctx);
}

fun make_credit(
    channel: &Channel, sequence: u64, cumulative_amount: u64,
    request_hash: vector<u8>, previous_transcript_hash: vector<u8>,
): Credit {
    assert!(sequence > 0, ESequence);
    assert!(cumulative_amount > 0 && cumulative_amount <= channel.offer.deposit, EAmount);
    assert!(request_hash.length() == 32 && previous_transcript_hash.length() == 32, ELength);
    Credit {
        purpose: b"m2m/channel/credit/v1",
        method: channel.offer.method,
        version: channel.offer.version,
        network: channel.offer.network,
        package_id: channel.offer.package_id,
        deployment: channel.offer.deployment,
        buyer: channel.offer.buyer,
        provider: channel.offer.provider,
        channel: object::id_address(channel),
        offer_hash: credit_offer_hash(channel),
        sequence,
        cumulative_amount,
        request_hash,
        previous_transcript_hash,
    }
}

/// Construct the exact Credit bound to this channel's immutable Offer.
public fun credit(
    channel: &Channel, sequence: u64, cumulative_amount: u64,
    request_hash: vector<u8>, previous_transcript_hash: vector<u8>,
): Credit {
    make_credit(channel, sequence, cumulative_amount, request_hash, previous_transcript_hash)
}

/// Redeem any newer buyer-signed cumulative credit. The gas payer is not an
/// authority; the payee is always the snapshotted provider controller.
public fun redeem(
    channel: &mut Channel, sequence: u64, cumulative_amount: u64,
    request_hash: vector<u8>, previous_transcript_hash: vector<u8>,
    signature: vector<u8>, clock: &Clock, ctx: &mut TxContext,
) {
    assert!(channel.status == OPEN, ETerminal);
    let statement = make_credit(
        channel, sequence, cumulative_amount, request_hash, previous_transcript_hash,
    );
    let bytes = credit_bytes(&statement);
    validate_signature(&signature, &channel.offer.buyer_key, &bytes);
    redeem_verified(channel, sequence, cumulative_amount, clock, ctx);
}

fun redeem_verified(
    channel: &mut Channel, sequence: u64, cumulative_amount: u64,
    clock: &Clock, ctx: &mut TxContext,
) {
    let now = clock::timestamp_ms(clock);
    assert!(now < channel.offer.claim_deadline_ms, EExpired);
    assert!(sequence > channel.redeemed_sequence, ESequence);
    assert!(cumulative_amount > channel.redeemed_amount, EAmount);
    assert!(cumulative_amount <= channel.offer.deposit, EAmount);
    let delta = cumulative_amount - channel.redeemed_amount;
    channel.redeemed_sequence = sequence;
    channel.redeemed_amount = cumulative_amount;
    let payment = coin::from_balance(balance::split(&mut channel.funds, delta), ctx);
    transfer::public_transfer(payment, channel.offer.payee);
}

fun make_close(
    channel: &Channel, final_sequence: u64, final_amount: u64,
    transcript_hash: vector<u8>,
): Close {
    assert!(transcript_hash.length() == 32, ELength);
    Close {
        purpose: b"m2m/channel/close/v1",
        method: channel.offer.method,
        version: channel.offer.version,
        network: channel.offer.network,
        package_id: channel.offer.package_id,
        deployment: channel.offer.deployment,
        buyer: channel.offer.buyer,
        provider: channel.offer.provider,
        channel: object::id_address(channel),
        offer_hash: credit_offer_hash(channel),
        final_sequence,
        final_amount,
        transcript_hash,
    }
}

/// Construct the exact Close statement bound to this channel.
public fun close_statement(
    channel: &Channel, final_sequence: u64, final_amount: u64,
    transcript_hash: vector<u8>,
): Close {
    make_close(channel, final_sequence, final_amount, transcript_hash)
}

fun drain_to(channel: &mut Channel, recipient: address, ctx: &mut TxContext) {
    let amount = balance::value(&channel.funds);
    if (amount > 0) {
        let payment = coin::from_balance(balance::withdraw_all(&mut channel.funds), ctx);
        transfer::public_transfer(payment, recipient);
    } else {
        balance::destroy_zero(balance::withdraw_all(&mut channel.funds));
    };
}

/// Cooperatively close with the same Close signed by both endpoint keys.
/// The final amount can pay only the incremental amount not already redeemed.
public fun close(
    channel: &mut Channel, final_sequence: u64, final_amount: u64,
    transcript_hash: vector<u8>, buyer_signature: vector<u8>,
    provider_signature: vector<u8>, clock: &Clock, ctx: &mut TxContext,
) {
    assert!(channel.status == OPEN, ETerminal);
    let statement = make_close(channel, final_sequence, final_amount, transcript_hash);
    let bytes = close_bytes(&statement);
    validate_signature(&buyer_signature, &channel.offer.buyer_key, &bytes);
    validate_signature(&provider_signature, &channel.offer.provider_key, &bytes);
    assert!(clock::timestamp_ms(clock) < channel.offer.claim_deadline_ms, EExpired);
    assert!(final_amount >= channel.redeemed_amount && final_amount <= channel.offer.deposit, EAmount);
    assert!(
        (final_sequence == channel.redeemed_sequence && final_amount == channel.redeemed_amount)
            || (final_sequence > channel.redeemed_sequence && final_amount > channel.redeemed_amount),
        ESequence,
    );
    close_verified(channel, final_sequence, final_amount, &bytes, clock, ctx);
}

fun close_verified(
    channel: &mut Channel, final_sequence: u64, final_amount: u64,
    bytes: &vector<u8>, clock: &Clock, ctx: &mut TxContext,
) {
    assert!(clock::timestamp_ms(clock) < channel.offer.claim_deadline_ms, EExpired);
    assert!(final_amount >= channel.redeemed_amount && final_amount <= channel.offer.deposit, EAmount);
    assert!(
        (final_sequence == channel.redeemed_sequence && final_amount == channel.redeemed_amount)
            || (final_sequence > channel.redeemed_sequence && final_amount > channel.redeemed_amount),
        ESequence,
    );
    let delta = final_amount - channel.redeemed_amount;
    if (delta > 0) {
        let payment = coin::from_balance(balance::split(&mut channel.funds, delta), ctx);
        transfer::public_transfer(payment, channel.offer.payee);
    };
    let refund = channel.offer.refund;
    drain_to(channel, refund, ctx);
    channel.redeemed_amount = final_amount;
    channel.redeemed_sequence = final_sequence;
    channel.status = CLOSED;
    channel.close_hash = hash::blake2b256(bytes);
    channel.terminal_tx = terminal_digest(ctx);
}

/// Refund residual funds at or after the immutable claim deadline. Already
/// redeemed counters are retained so the result is auditable and conserved.
public fun refund(channel: &mut Channel, clock: &Clock, ctx: &mut TxContext) {
    assert!(channel.status == OPEN, ETerminal);
    assert!(clock::timestamp_ms(clock) >= channel.offer.claim_deadline_ms, ETooEarly);
    let refund = channel.offer.refund;
    drain_to(channel, refund, ctx);
    channel.status = REFUNDED;
    channel.terminal_tx = terminal_digest(ctx);
}

// The test-only opener exercises all state and dynamic-field checks without
// pretending Move can generate an Ed25519 signature. Signed positive and
// negative vectors live in channel_signing_tests.move and the live harness.
#[test_only]
public fun open_test(
    domain: &Domain, buyer: &mut Agent, provider: &Agent, payment: Coin<SUI>,
    opening_nonce: vector<u8>, terms_hash: vector<u8>, deposit: u64,
    offer_expires_ms: u64, work_deadline_ms: u64, claim_deadline_ms: u64,
    clock: &Clock, ctx: &mut TxContext,
) {
    let terms = make_offer(
        domain, buyer, provider, opening_nonce, terms_hash, deposit,
        offer_expires_ms, work_deadline_ms, claim_deadline_ms,
    );
    open_verified(buyer, payment, terms, clock, ctx);
}

#[test_only]
public fun redeem_test(
    channel: &mut Channel, sequence: u64, cumulative_amount: u64,
    request_hash: vector<u8>, previous_transcript_hash: vector<u8>,
    clock: &Clock, ctx: &mut TxContext,
) {
    assert!(channel.status == OPEN, ETerminal);
    let _statement = make_credit(
        channel, sequence, cumulative_amount, request_hash, previous_transcript_hash,
    );
    redeem_verified(channel, sequence, cumulative_amount, clock, ctx);
}

#[test_only]
public fun close_test(
    channel: &mut Channel, final_sequence: u64, final_amount: u64,
    transcript_hash: vector<u8>, clock: &Clock, ctx: &mut TxContext,
) {
    assert!(channel.status == OPEN, ETerminal);
    let statement = make_close(channel, final_sequence, final_amount, transcript_hash);
    let bytes = close_bytes(&statement);
    close_verified(channel, final_sequence, final_amount, &bytes, clock, ctx);
}

#[test_only]
public fun status_test(channel: &Channel): u8 { channel.status }

#[test_only]
public fun funds_test(channel: &Channel): u64 { balance::value(&channel.funds) }

#[test_only]
public fun redeemed_amount_test(channel: &Channel): u64 { channel.redeemed_amount }

#[test_only]
public fun redeemed_sequence_test(channel: &Channel): u64 { channel.redeemed_sequence }

#[test_only]
public fun close_hash_test(channel: &Channel): vector<u8> { channel.close_hash }

#[test_only]
public fun opening_exists_test(buyer: &mut Agent, nonce: vector<u8>): bool {
    dynamic_field::exists(exchange::agent_uid_mut(buyer), OpeningKey { nonce })
}

#[test_only]
public fun verify_test(signature: vector<u8>, key: vector<u8>, bytes: vector<u8>) {
    validate_signature(&signature, &key, &bytes);
}

/// Reconstruct a public vector Offer from its individual fields and verify the
/// provider signature over Move's own BCS encoding. This is test-only so the
/// production surface stays limited to the frozen constructors and entries.
#[test_only]
public fun verify_offer_vector_test(
    network: vector<u8>, package_id: address, deployment: address,
    buyer: address, provider: address, buyer_key: vector<u8>,
    provider_key: vector<u8>, refund: address, payee: address,
    opening_nonce: vector<u8>, terms_hash: vector<u8>, deposit: u64,
    offer_expires_ms: u64, work_deadline_ms: u64, claim_deadline_ms: u64,
    signature: vector<u8>,
): vector<u8> {
    let value = Offer {
        purpose: b"m2m/channel/offer/v1", method: b"sui.channel.v1", version: 1,
        network, package_id, deployment, buyer, provider, buyer_key,
        provider_key, refund, payee, opening_nonce, terms_hash, deposit,
        offer_expires_ms, work_deadline_ms, claim_deadline_ms,
    };
    let bytes = offer_bytes(&value);
    validate_signature(&signature, &value.provider_key, &bytes);
    hash::blake2b256(&bytes)
}

/// Reconstruct and verify a public vector Credit using the same field order as
/// the production `credit` constructor.
#[test_only]
public fun verify_credit_vector_test(
    network: vector<u8>, package_id: address, deployment: address,
    buyer: address, provider: address, channel: address, offer_hash: vector<u8>,
    sequence: u64, cumulative_amount: u64, request_hash: vector<u8>,
    previous_transcript_hash: vector<u8>, buyer_key: vector<u8>, signature: vector<u8>,
): vector<u8> {
    let value = Credit {
        purpose: b"m2m/channel/credit/v1", method: b"sui.channel.v1", version: 1,
        network, package_id, deployment, buyer, provider, channel, offer_hash,
        sequence, cumulative_amount, request_hash, previous_transcript_hash,
    };
    let bytes = credit_bytes(&value);
    validate_signature(&signature, &buyer_key, &bytes);
    hash::blake2b256(&bytes)
}

/// Reconstruct a public vector Close and verify both endpoint signatures.
#[test_only]
public fun verify_close_vector_test(
    network: vector<u8>, package_id: address, deployment: address,
    buyer: address, provider: address, channel: address, offer_hash: vector<u8>,
    final_sequence: u64, final_amount: u64, transcript_hash: vector<u8>,
    buyer_key: vector<u8>, provider_key: vector<u8>, buyer_signature: vector<u8>,
    provider_signature: vector<u8>,
): vector<u8> {
    let value = Close {
        purpose: b"m2m/channel/close/v1", method: b"sui.channel.v1", version: 1,
        network, package_id, deployment, buyer, provider, channel, offer_hash,
        final_sequence, final_amount, transcript_hash,
    };
    let bytes = close_bytes(&value);
    validate_signature(&buyer_signature, &buyer_key, &bytes);
    validate_signature(&provider_signature, &provider_key, &bytes);
    hash::blake2b256(&bytes)
}
