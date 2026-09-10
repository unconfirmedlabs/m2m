/// Experimental SUI escrow for a single endpoint-authenticated exchange.
module m2m::exchange;

use std::bcs;
use sui::balance::{Self, Balance};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::ed25519;
use sui::hash;
use sui::sui::SUI;
use sui::table::{Self, Table};

const EAuthority: u64 = 0;
const ELength: u64 = 1;
const EDomain: u64 = 2;
const ESignature: u64 = 3;
const EExpired: u64 = 4;
const EAmount: u64 = 5;
const ENonce: u64 = 6;
const ETerminal: u64 = 7;
const ETooEarly: u64 = 8;
const EResult: u64 = 9;
const EDeadline: u64 = 10;

const FUNDED: u8 = 0;
const SETTLED: u8 = 1;
const REFUNDED: u8 = 2;
// Bound both signature lifetime and arithmetic. This is a PoC policy, not a market rule.
const MAX_LIFETIME_MS: u64 = 3_600_000;

public struct Domain has key, store {
    id: UID,
    network: vector<u8>,
    package_id: address,
}

public struct Agent has key {
    id: UID,
    deployment: ID,
    controller: address,
    endpoint_key: vector<u8>,
    next_nonce: u64,
    jobs: Table<u64, ID>,
}

/// Field order must match docs/PROTOCOL.md, Rust, and the independent TS codec.
public struct Quote has copy, drop, store {
    purpose: vector<u8>,
    network: vector<u8>,
    package_id: address,
    deployment: address,
    buyer: address,
    provider: address,
    buyer_key: vector<u8>,
    provider_key: vector<u8>,
    refund: address,
    payee: address,
    nonce: u64,
    request_hash: vector<u8>,
    result_hash: vector<u8>,
    amount: u64,
    quote_expires_ms: u64,
    deadline_ms: u64,
}

public struct Acceptance has copy, drop, store {
    purpose: vector<u8>,
    network: vector<u8>,
    package_id: address,
    deployment: address,
    escrow: address,
    quote_hash: vector<u8>,
    result_hash: vector<u8>,
}

public struct Escrow has key {
    id: UID,
    quote: Quote,
    funds: Balance<SUI>,
    status: u8,
    terminal_tx: vector<u8>,
}

public fun create_domain(network: vector<u8>, ctx: &mut TxContext) {
    assert!(network.length() > 0 && network.length() <= 64, ELength);
    transfer::freeze_object(Domain {
        id: object::new(ctx), network, package_id: std::type_name::original_id<Domain>(),
    });
}

public fun register(domain: &Domain, endpoint_key: vector<u8>, ctx: &mut TxContext) {
    assert!(endpoint_key.length() == 32, ELength);
    transfer::share_object(Agent {
        id: object::new(ctx), deployment: object::id(domain),
        controller: ctx.sender(), endpoint_key, next_nonce: 0, jobs: table::new(ctx),
    });
}

public fun replace_endpoint(agent: &mut Agent, endpoint_key: vector<u8>, ctx: &TxContext) {
    assert!(agent.controller == ctx.sender(), EAuthority);
    assert!(endpoint_key.length() == 32, ELength);
    agent.endpoint_key = endpoint_key;
}

public fun quote(
    domain: &Domain, buyer: &Agent, provider: &Agent, nonce: u64,
    request_hash: vector<u8>, result_hash: vector<u8>, amount: u64,
    quote_expires_ms: u64, deadline_ms: u64,
): Quote {
    assert!(buyer.deployment == object::id(domain), EDomain);
    assert!(provider.deployment == object::id(domain), EDomain);
    assert!(request_hash.length() == 32 && result_hash.length() == 32, ELength);
    Quote {
        purpose: b"m2m/quote/v1", network: domain.network,
        package_id: domain.package_id, deployment: object::id_address(domain),
        buyer: object::id_address(buyer), provider: object::id_address(provider),
        buyer_key: buyer.endpoint_key, provider_key: provider.endpoint_key,
        refund: buyer.controller, payee: provider.controller,
        nonce, request_hash, result_hash, amount, quote_expires_ms, deadline_ms,
    }
}

public fun fund(
    domain: &Domain, buyer: &mut Agent, provider: &Agent,
    payment: Coin<SUI>, nonce: u64, request_hash: vector<u8>,
    result_hash: vector<u8>, amount: u64, quote_expires_ms: u64,
    deadline_ms: u64, signature: vector<u8>, clock: &Clock, ctx: &mut TxContext,
) {
    let terms = quote(domain, buyer, provider, nonce, request_hash, result_hash,
        amount, quote_expires_ms, deadline_ms);
    assert!(ed25519::ed25519_verify(&signature, &terms.provider_key,
        &bcs::to_bytes(&terms)), ESignature);
    fund_verified(buyer, payment, terms, clock, ctx);
}

fun fund_verified(
    buyer: &mut Agent, payment: Coin<SUI>, terms: Quote,
    clock: &Clock, ctx: &mut TxContext,
) {
    assert!(buyer.controller == ctx.sender(), EAuthority);
    assert!(terms.nonce == buyer.next_nonce, ENonce);
    assert!(terms.amount > 0 && coin::value(&payment) == terms.amount, EAmount);
    let now = clock::timestamp_ms(clock);
    assert!(now < terms.quote_expires_ms, EExpired);
    assert!(terms.quote_expires_ms < terms.deadline_ms, EDeadline);
    assert!(terms.deadline_ms - now <= MAX_LIFETIME_MS, EDeadline);
    let escrow = Escrow {
        id: object::new(ctx), quote: terms, funds: coin::into_balance(payment),
        status: FUNDED, terminal_tx: vector[],
    };
    table::add(&mut buyer.jobs, terms.nonce, object::id(&escrow));
    buyer.next_nonce = buyer.next_nonce + 1;
    transfer::share_object(escrow);
}

public fun acceptance(escrow: &Escrow, result_hash: vector<u8>): Acceptance {
    let q = &escrow.quote;
    Acceptance {
        purpose: b"m2m/accept/v1", network: q.network,
        package_id: q.package_id, deployment: q.deployment,
        escrow: object::id_address(escrow),
        quote_hash: hash::blake2b256(&bcs::to_bytes(q)), result_hash,
    }
}

public fun settle(
    escrow: &mut Escrow, result_hash: vector<u8>, signature: vector<u8>,
    clock: &Clock, ctx: &mut TxContext,
) {
    let receipt = acceptance(escrow, result_hash);
    assert!(ed25519::ed25519_verify(&signature, &escrow.quote.buyer_key,
        &bcs::to_bytes(&receipt)), ESignature);
    settle_verified(escrow, result_hash, clock, ctx);
}

fun settle_verified(
    escrow: &mut Escrow, result_hash: vector<u8>, clock: &Clock, ctx: &mut TxContext,
) {
    assert!(escrow.status == FUNDED, ETerminal);
    assert!(clock::timestamp_ms(clock) < escrow.quote.deadline_ms, EExpired);
    assert!(result_hash == escrow.quote.result_hash, EResult);
    escrow.status = SETTLED;
    escrow.terminal_tx = *ctx.digest();
    let payment = coin::from_balance(balance::withdraw_all(&mut escrow.funds), ctx);
    transfer::public_transfer(payment, escrow.quote.payee);
}

public fun refund(escrow: &mut Escrow, clock: &Clock, ctx: &mut TxContext) {
    assert!(escrow.status == FUNDED, ETerminal);
    assert!(clock::timestamp_ms(clock) >= escrow.quote.deadline_ms, ETooEarly);
    escrow.status = REFUNDED;
    escrow.terminal_tx = *ctx.digest();
    let payment = coin::from_balance(balance::withdraw_all(&mut escrow.funds), ctx);
    transfer::public_transfer(payment, escrow.quote.refund);
}

#[test_only]
public fun fund_test(
    domain: &Domain, buyer: &mut Agent, provider: &Agent, payment: Coin<SUI>,
    nonce: u64, amount: u64, expires: u64, deadline: u64,
    clock: &Clock, ctx: &mut TxContext,
) {
    let h = x"0101010101010101010101010101010101010101010101010101010101010101";
    let q = quote(domain, buyer, provider, nonce, h, h, amount, expires, deadline);
    fund_verified(buyer, payment, q, clock, ctx);
}

#[test_only]
public fun settle_test(escrow: &mut Escrow, clock: &Clock, ctx: &mut TxContext) {
    let result_hash = escrow.quote.result_hash;
    settle_verified(escrow, result_hash, clock, ctx);
}

#[test_only]
public fun status_test(escrow: &Escrow): u8 { escrow.status }

#[test_only]
public fun funds_test(escrow: &Escrow): u64 { balance::value(&escrow.funds) }
