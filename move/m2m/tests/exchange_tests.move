#[test_only]
module m2m::exchange_tests;

use m2m::exchange::{Self, Agent, Domain, Escrow};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::test_scenario::{Self as ts, Scenario};

const BUYER: address = @0xa;
const PROVIDER: address = @0xb;

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

fun fund(s: &mut Scenario, buyer: ID, provider: ID, nonce: u64, value: u64) {
    let d = s.take_immutable<Domain>();
    let mut b = s.take_shared_by_id<Agent>(buyer);
    let p = s.take_shared_by_id<Agent>(provider);
    let clock = s.take_shared<Clock>();
    let payment = coin::mint_for_testing<SUI>(value, s.ctx());
    // State-machine tests isolate the verified transition. Full signatures are
    // tested by vectors and signed live-network transactions in the harness.
    exchange::fund_test(&d, &mut b, &p, payment, nonce, 1000, 100, 200, &clock, s.ctx());
    ts::return_immutable(d); ts::return_shared(b); ts::return_shared(p); ts::return_shared(clock);
}

#[test]
fun settlement_conserves_value() {
    let (mut s, buyer, provider) = setup();
    fund(&mut s, buyer, provider, 0, 1000);
    s.next_tx(PROVIDER);
    let mut e = s.take_shared<Escrow>();
    let clock = s.take_shared<Clock>();
    assert!(exchange::funds_test(&e) == 1000);
    exchange::settle_test(&mut e, &clock, s.ctx());
    assert!(exchange::status_test(&e) == 1 && exchange::funds_test(&e) == 0);
    ts::return_shared(e); ts::return_shared(clock);
    s.next_tx(PROVIDER);
    let paid = s.take_from_sender<Coin<SUI>>();
    assert!(coin::value(&paid) == 1000);
    coin::burn_for_testing(paid);
    s.end();
}

#[test]
fun refund_at_exact_deadline_conserves_value() {
    let (mut s, buyer, provider) = setup();
    fund(&mut s, buyer, provider, 0, 1000);
    s.next_tx(@0xc);
    let mut e = s.take_shared<Escrow>();
    let mut clock = s.take_shared<Clock>();
    clock::set_for_testing(&mut clock, 200);
    // Any submitter can return funds, but never to its own arbitrary address.
    exchange::refund(&mut e, &clock, s.ctx());
    assert!(exchange::status_test(&e) == 2 && exchange::funds_test(&e) == 0);
    ts::return_shared(e); ts::return_shared(clock);
    s.next_tx(BUYER);
    let paid = s.take_from_sender<Coin<SUI>>();
    assert!(coin::value(&paid) == 1000);
    coin::burn_for_testing(paid);
    s.end();
}

#[test, expected_failure(abort_code = 6, location = m2m::exchange)]
fun funding_nonce_cannot_repeat() {
    let (mut s, buyer, provider) = setup();
    fund(&mut s, buyer, provider, 0, 1000);
    s.next_tx(BUYER);
    fund(&mut s, buyer, provider, 0, 1000);
    s.end();
}

#[test, expected_failure(abort_code = 5, location = m2m::exchange)]
fun deposit_must_equal_quote() {
    let (mut s, buyer, provider) = setup();
    fund(&mut s, buyer, provider, 0, 999);
    s.end();
}

#[test, expected_failure(abort_code = 0, location = m2m::exchange)]
fun only_controller_funds_buyer_agent() {
    let (mut s, buyer, provider) = setup();
    s.next_tx(PROVIDER);
    fund(&mut s, buyer, provider, 0, 1000);
    s.end();
}

#[test, expected_failure(abort_code = 8, location = m2m::exchange)]
fun no_early_refund() {
    let (mut s, buyer, provider) = setup();
    fund(&mut s, buyer, provider, 0, 1000);
    s.next_tx(BUYER);
    let mut e = s.take_shared<Escrow>();
    let clock = s.take_shared<Clock>();
    exchange::refund(&mut e, &clock, s.ctx());
    ts::return_shared(e); ts::return_shared(clock); s.end();
}

#[test, expected_failure(abort_code = 4, location = m2m::exchange)]
fun no_settlement_at_deadline() {
    let (mut s, buyer, provider) = setup();
    fund(&mut s, buyer, provider, 0, 1000);
    s.next_tx(PROVIDER);
    let mut e = s.take_shared<Escrow>();
    let mut clock = s.take_shared<Clock>();
    clock::set_for_testing(&mut clock, 200);
    exchange::settle_test(&mut e, &clock, s.ctx());
    ts::return_shared(e); ts::return_shared(clock); s.end();
}

#[test, expected_failure(abort_code = 7, location = m2m::exchange)]
fun settled_cannot_refund() {
    let (mut s, buyer, provider) = setup();
    fund(&mut s, buyer, provider, 0, 1000);
    s.next_tx(PROVIDER);
    let mut e = s.take_shared<Escrow>();
    let mut clock = s.take_shared<Clock>();
    exchange::settle_test(&mut e, &clock, s.ctx());
    clock::set_for_testing(&mut clock, 200);
    exchange::refund(&mut e, &clock, s.ctx());
    ts::return_shared(e); ts::return_shared(clock); s.end();
}

#[test, expected_failure(abort_code = 7, location = m2m::exchange)]
fun settled_cannot_pay_twice() {
    let (mut s, buyer, provider) = setup();
    fund(&mut s, buyer, provider, 0, 1000);
    s.next_tx(PROVIDER);
    let mut e = s.take_shared<Escrow>();
    let clock = s.take_shared<Clock>();
    exchange::settle_test(&mut e, &clock, s.ctx());
    exchange::settle_test(&mut e, &clock, s.ctx());
    ts::return_shared(e); ts::return_shared(clock); s.end();
}

#[test, expected_failure(abort_code = 0, location = m2m::exchange)]
fun only_controller_rotates_endpoint() {
    let (mut s, buyer, _) = setup();
    s.next_tx(PROVIDER);
    let mut b = s.take_shared_by_id<Agent>(buyer);
    exchange::replace_endpoint(&mut b, x"0303030303030303030303030303030303030303030303030303030303030303", s.ctx());
    ts::return_shared(b); s.end();
}
