#[test_only]
module m2m::channel_tests;

use m2m::channel::{Self, Channel};
use m2m::exchange::{Self, Agent, Domain};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::test_scenario::{Self as ts, Scenario};

const BUYER: address = @0xa;
const PROVIDER: address = @0xb;
const THIRD_PARTY: address = @0xc;
const NONCE: vector<u8> = x"0909090909090909090909090909090909090909090909090909090909090909";
const TERMS: vector<u8> = x"0101010101010101010101010101010101010101010101010101010101010101";
const REQUEST: vector<u8> = x"0202020202020202020202020202020202020202020202020202020202020202";
const ROOT: vector<u8> = x"0303030303030303030303030303030303030303030303030303030303030303";

fun setup(): (Scenario, ID, ID) {
    let mut s = ts::begin(BUYER);
    exchange::create_domain(b"local-test", s.ctx());
    let clock = clock::create_for_testing(s.ctx());
    clock::share_for_testing(clock);
    s.next_tx(BUYER);
    let d = s.take_immutable<Domain>();
    exchange::register(&d, x"0101010101010101010101010101010101010101010101010101010101010101", s.ctx());
    ts::return_immutable(d);
    s.next_tx(PROVIDER);
    let buyer = ts::most_recent_id_shared<Agent>().destroy_some();
    let d = s.take_immutable<Domain>();
    exchange::register(&d, x"0202020202020202020202020202020202020202020202020202020202020202", s.ctx());
    ts::return_immutable(d);
    s.next_tx(BUYER);
    let provider = ts::most_recent_id_shared<Agent>().destroy_some();
    (s, buyer, provider)
}

fun open_channel(s: &mut Scenario, buyer: ID, provider: ID, deposit: u64) {
    let d = s.take_immutable<Domain>();
    let mut b = s.take_shared_by_id<Agent>(buyer);
    let p = s.take_shared_by_id<Agent>(provider);
    let clock = s.take_shared<Clock>();
    let payment = coin::mint_for_testing<SUI>(deposit, s.ctx());
    channel::open_test(
        &d, &mut b, &p, payment, NONCE, TERMS, deposit,
        100, 200, 10_200, &clock, s.ctx(),
    );
    ts::return_immutable(d);
    ts::return_shared(b);
    ts::return_shared(p);
    ts::return_shared(clock);
}

fun take_channel(s: &mut Scenario): Channel {
    s.next_tx(THIRD_PARTY);
    s.take_shared<Channel>()
}

fun return_channel(channel: Channel, clock: Clock) {
    ts::return_shared(channel);
    ts::return_shared(clock);
}

fun burn_sender_coin(s: &mut Scenario, owner: address, expected: u64) {
    s.next_tx(owner);
    let paid = s.take_from_sender<Coin<SUI>>();
    assert!(coin::value(&paid) == expected);
    coin::burn_for_testing(paid);
}

#[test]
fun opening_reserves_typed_nonce_and_close_retains_terminal_record() {
    let (mut s, buyer, provider) = setup();
    open_channel(&mut s, buyer, provider, 12_000);
    let mut channel = take_channel(&mut s);
    assert!(channel::status_test(&channel) == 0);
    assert!(channel::funds_test(&channel) == 12_000);
    assert!(channel::redeemed_amount_test(&channel) == 0);
    let mut b = s.take_shared_by_id<Agent>(buyer);
    assert!(channel::opening_exists_test(&mut b, NONCE));
    ts::return_shared(b);
    let clock = s.take_shared<Clock>();
    channel::close_test(&mut channel, 0, 0, ROOT, &clock, s.ctx());
    assert!(channel::status_test(&channel) == 1);
    assert!(channel::funds_test(&channel) == 0);
    assert!(channel::redeemed_sequence_test(&channel) == 0);
    assert!(channel::close_hash_test(&channel).length() == 32);
    return_channel(channel, clock);
    burn_sender_coin(&mut s, BUYER, 12_000);
    s.end();
}

#[test, expected_failure(abort_code = 6, location = m2m::channel)]
fun same_buyer_nonce_cannot_open_twice() {
    let (mut s, buyer, provider) = setup();
    open_channel(&mut s, buyer, provider, 12_000);
    s.next_tx(BUYER);
    let d = s.take_immutable<Domain>();
    let mut b = s.take_shared_by_id<Agent>(buyer);
    let p = s.take_shared_by_id<Agent>(provider);
    let clock = s.take_shared<Clock>();
    let payment = coin::mint_for_testing<SUI>(12_000, s.ctx());
    channel::open_test(
        &d, &mut b, &p, payment, NONCE, TERMS, 12_000,
        100, 200, 10_200, &clock, s.ctx(),
    );
    ts::return_immutable(d);
    ts::return_shared(b);
    ts::return_shared(p);
    ts::return_shared(clock);
    s.end();
}

#[test]
fun cumulative_redemption_pays_only_deltas_to_fixed_payee() {
    let (mut s, buyer, provider) = setup();
    open_channel(&mut s, buyer, provider, 12_000);
    let mut channel = take_channel(&mut s);
    let clock = s.take_shared<Clock>();
    channel::redeem_test(&mut channel, 2, 2_000, REQUEST, ROOT, &clock, s.ctx());
    ts::return_shared(channel);
    ts::return_shared(clock);
    burn_sender_coin(&mut s, PROVIDER, 2_000);

    let mut channel = take_channel(&mut s);
    let clock = s.take_shared<Clock>();
    channel::redeem_test(&mut channel, 3, 5_000, REQUEST, ROOT, &clock, s.ctx());
    assert!(channel::redeemed_sequence_test(&channel) == 3);
    assert!(channel::redeemed_amount_test(&channel) == 5_000);
    assert!(channel::funds_test(&channel) == 7_000);
    ts::return_shared(channel);
    ts::return_shared(clock);
    burn_sender_coin(&mut s, PROVIDER, 3_000);
    s.end();
}

#[test, expected_failure(abort_code = 9, location = m2m::channel)]
fun stale_credit_cannot_redeem_again() {
    let (mut s, buyer, provider) = setup();
    open_channel(&mut s, buyer, provider, 12_000);
    let mut channel = take_channel(&mut s);
    let clock = s.take_shared<Clock>();
    channel::redeem_test(&mut channel, 2, 2_000, REQUEST, ROOT, &clock, s.ctx());
    channel::redeem_test(&mut channel, 2, 2_000, REQUEST, ROOT, &clock, s.ctx());
    ts::return_shared(channel);
    ts::return_shared(clock);
    s.end();
}

#[test]
fun higher_close_after_redemption_pays_increment_and_refunds_residual() {
    let (mut s, buyer, provider) = setup();
    open_channel(&mut s, buyer, provider, 12_000);
    let mut channel = take_channel(&mut s);
    let clock = s.take_shared<Clock>();
    channel::redeem_test(&mut channel, 1, 1_000, REQUEST, ROOT, &clock, s.ctx());
    ts::return_shared(channel);
    ts::return_shared(clock);
    burn_sender_coin(&mut s, PROVIDER, 1_000);

    let mut channel = take_channel(&mut s);
    let clock = s.take_shared<Clock>();
    channel::close_test(&mut channel, 2, 2_000, ROOT, &clock, s.ctx());
    assert!(channel::status_test(&channel) == 1);
    assert!(channel::funds_test(&channel) == 0);
    ts::return_shared(channel);
    ts::return_shared(clock);
    burn_sender_coin(&mut s, PROVIDER, 1_000);
    burn_sender_coin(&mut s, BUYER, 10_000);
    s.end();
}

#[test, expected_failure(abort_code = 5, location = m2m::channel)]
fun lower_close_after_higher_redemption_aborts() {
    let (mut s, buyer, provider) = setup();
    open_channel(&mut s, buyer, provider, 12_000);
    let mut channel = take_channel(&mut s);
    let clock = s.take_shared<Clock>();
    channel::redeem_test(&mut channel, 2, 2_000, REQUEST, ROOT, &clock, s.ctx());
    channel::close_test(&mut channel, 1, 1_000, ROOT, &clock, s.ctx());
    ts::return_shared(channel);
    ts::return_shared(clock);
    s.end();
}

#[test, expected_failure(abort_code = 7, location = m2m::channel)]
fun terminal_channel_rejects_later_redemption() {
    let (mut s, buyer, provider) = setup();
    open_channel(&mut s, buyer, provider, 12_000);
    let mut channel = take_channel(&mut s);
    let clock = s.take_shared<Clock>();
    channel::close_test(&mut channel, 0, 0, ROOT, &clock, s.ctx());
    channel::redeem_test(&mut channel, 1, 1_000, REQUEST, ROOT, &clock, s.ctx());
    ts::return_shared(channel);
    ts::return_shared(clock);
    s.end();
}

#[test]
fun refund_at_exact_claim_deadline_conserves_residual() {
    let (mut s, buyer, provider) = setup();
    open_channel(&mut s, buyer, provider, 12_000);
    let mut channel = take_channel(&mut s);
    let mut clock = s.take_shared<Clock>();
    clock::set_for_testing(&mut clock, 10_200);
    channel::refund(&mut channel, &clock, s.ctx());
    assert!(channel::status_test(&channel) == 2);
    assert!(channel::funds_test(&channel) == 0);
    assert!(channel::close_hash_test(&channel).length() == 0);
    ts::return_shared(channel);
    ts::return_shared(clock);
    burn_sender_coin(&mut s, BUYER, 12_000);
    s.end();
}

#[test, expected_failure(abort_code = 8, location = m2m::channel)]
fun refund_before_claim_deadline_aborts() {
    let (mut s, buyer, provider) = setup();
    open_channel(&mut s, buyer, provider, 12_000);
    let mut channel = take_channel(&mut s);
    let clock = s.take_shared<Clock>();
    channel::refund(&mut channel, &clock, s.ctx());
    ts::return_shared(channel);
    ts::return_shared(clock);
    s.end();
}

#[test, expected_failure(abort_code = 4, location = m2m::channel)]
fun redeem_at_exact_claim_deadline_aborts() {
    let (mut s, buyer, provider) = setup();
    open_channel(&mut s, buyer, provider, 12_000);
    let mut channel = take_channel(&mut s);
    let mut clock = s.take_shared<Clock>();
    clock::set_for_testing(&mut clock, 10_200);
    channel::redeem_test(&mut channel, 1, 1_000, REQUEST, ROOT, &clock, s.ctx());
    return_channel(channel, clock);
    s.end();
}

#[test, expected_failure(abort_code = 4, location = m2m::channel)]
fun close_at_exact_claim_deadline_aborts() {
    let (mut s, buyer, provider) = setup();
    open_channel(&mut s, buyer, provider, 12_000);
    let mut channel = take_channel(&mut s);
    let mut clock = s.take_shared<Clock>();
    clock::set_for_testing(&mut clock, 10_200);
    channel::close_test(&mut channel, 0, 0, ROOT, &clock, s.ctx());
    return_channel(channel, clock);
    s.end();
}
