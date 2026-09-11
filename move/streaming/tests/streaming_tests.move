#[test_only]
module m2m_streaming::streaming_tests;

use m2m_streaming::channel::{Self, Channel};
use m2m_streaming::identity::{Self, Agent, Domain};
use m2m_streaming::policy;
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::test_scenario::{Self as ts, Scenario};

const KEY1: vector<u8> = x"0101010101010101010101010101010101010101010101010101010101010101";
const KEY2: vector<u8> = x"0202020202020202020202020202020202020202020202020202020202020202";
const KEY3: vector<u8> = x"0303030303030303030303030303030303030303030303030303030303030303";
const ZERO: vector<u8> = x"0000000000000000000000000000000000000000000000000000000000000000";
const MAX: u64 = 18446744073709551615;
const BUYER_KEY: vector<u8> = x"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c";
const PROVIDER_KEY: vector<u8> = x"8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394";
const OFFER_SIG: vector<u8> = x"9034dba3c354eba585ce794781143f622b88c71c1c46fdde703633bc7cf421304ce1e2081b3096bdaceef1c4ad2197e6ba941a1d58eefdda422b202f343a9502";
const CREDIT_SIG: vector<u8> = x"14f23e0790fbf41036b8bcd0cca15c1807a1ce38f047ac57fd4e1f1a2f43470d499f81dde536c0d4aae9e64c4270da65fdd303b30815d537030597d5c9e51d02";
const CP_SIG: vector<u8> = x"d6c5ef69d3aa478aea9e0e555e2585f262a4dba7d949dd67fe14a1bb9c1f2cc4d87651ccf23da6642d2aad2c65d894ed921c95f7a2299bff2e57bb4ef9503509";

#[test]
fun independent_bcs_and_economic_signatures() {
    let (offer, credit, checkpoint) = channel::verify_vectors_test(b"test-vector", PROVIDER_KEY, OFFER_SIG, CREDIT_SIG, CP_SIG);
    assert!(offer == x"4d3220fcb12abce64e35907f173b9cf48c91b3c21a6f0788efd709622497ed89");
    assert!(credit == x"8bcf66c1290b2f77affc8096b65891e666555fc0bf9fb2efee192bd610a735f1");
    assert!(checkpoint == x"5dfb97829cff23e4ae23780400c045361a22a2c1b62b64ce4982f907e02d3047");
}
#[test, expected_failure(abort_code = 3, location = m2m_streaming::channel)]
fun wrong_network_signature() { channel::verify_vectors_test(b"wrong-network", PROVIDER_KEY, OFFER_SIG, CREDIT_SIG, CP_SIG); }
#[test, expected_failure(abort_code = 3, location = m2m_streaming::channel)]
fun wrong_role_signature() { channel::verify_vectors_test(b"test-vector", BUYER_KEY, OFFER_SIG, CREDIT_SIG, CP_SIG); }
#[test, expected_failure(abort_code = 3, location = m2m_streaming::channel)]
fun tampered_credit_signature() {
    let mut sig = CREDIT_SIG; *vector::borrow_mut(&mut sig, 0) = 0;
    channel::verify_vectors_test(b"test-vector", PROVIDER_KEY, OFFER_SIG, sig, CP_SIG);
}
#[test, expected_failure(abort_code = 3, location = m2m_streaming::channel)]
fun tampered_checkpoint_signature() {
    let mut sig = CP_SIG; *vector::borrow_mut(&mut sig, 0) = 0;
    channel::verify_vectors_test(b"test-vector", PROVIDER_KEY, OFFER_SIG, CREDIT_SIG, sig);
}

#[test]
fun bytes_records_and_multi_counter_round_once() {
    let bytes = policy::new(vector[b"bytes/v1"], vector[2], 3);
    assert!(policy::price(&bytes, &vector[1]) == 1);
    assert!(policy::price(&bytes, &vector[3]) == 2);
    let records = policy::new(vector[b"records/v1"], vector[17], 1);
    assert!(policy::price(&records, &vector[4]) == 68);
    let mixed = policy::new(vector[b"input/v1", b"output/v1", b"cached/v1"], vector[3, 7, 0], 10);
    assert!(policy::price(&mixed, &vector[1, 1, 999]) == 1);
    let free = policy::new(vector[b"bytes/v1"], vector[0], 1);
    assert!(policy::price(&free, &vector[MAX]) == 0);
    let boundary = policy::new(vector[b"bytes/v1"], vector[MAX], MAX);
    assert!(policy::price(&boundary, &vector[MAX]) == MAX);
}
#[test, expected_failure(abort_code = 1, location = m2m_streaming::policy)]
fun duplicate_unit_rejected() { policy::new(vector[b"x", b"x"], vector[1, 2], 1); }
#[test, expected_failure(abort_code = 0, location = m2m_streaming::policy)]
fun zero_denominator_rejected() { policy::new(vector[b"x"], vector[1], 0); }
#[test, expected_failure(abort_code = 2, location = m2m_streaming::policy)]
fun u128_sum_overflow_rejected() {
    let p = policy::new(vector[b"x", b"y"], vector[MAX, MAX], MAX);
    policy::price(&p, &vector[MAX, MAX]);
}
#[test, expected_failure(abort_code = 2, location = m2m_streaming::policy)]
fun u64_amount_overflow_rejected() {
    let p = policy::new(vector[b"x"], vector[2], 1);
    policy::price(&p, &vector[MAX]);
}

fun fixture(s: &mut Scenario): (Channel, Clock) {
    let p = policy::new(vector[b"records/v1", b"bytes/v1"], vector[7, 2], 10);
    let c = channel::test_channel(p, 1000, KEY1, KEY2, s.ctx());
    (c, clock::create_for_testing(s.ctx()))
}
fun burn(s: &mut Scenario, owner: address, amount: u64) {
    s.next_tx(owner);
    let coin = s.take_from_sender<Coin<SUI>>();
    assert!(coin::value(&coin) == amount);
    coin::burn_for_testing(coin);
}
fun state(channel: &Channel, funds: u64, redeemed: u64, status: u8) {
    let (f, r, s) = channel::state(channel);
    assert!(f == funds && r == redeemed && s == status);
}

#[test]
fun exact_close_uses_delivered_price_and_conserves_funds() {
    let mut s = ts::begin(@0xb);
    let (mut channel, clock) = fixture(&mut s);
    let credit = channel::credit(&channel, 1, 1, KEY1, ZERO, vector[10, 100], 27);
    let checkpoint = channel::checkpoint(&channel, &credit, vector[4, 25], 8, KEY2, true);
    channel::close_test(&mut channel, credit, checkpoint, &clock, s.ctx());
    state(&channel, 0, 8, 1);
    channel::destroy_test(channel); clock::destroy_for_testing(clock);
    burn(&mut s, @0xc, 8); burn(&mut s, @0xb, 992); s.end();
}
#[test]
fun free_channel_exact_close_refunds_entire_deposit() {
    let mut s = ts::begin(@0xb);
    let p = policy::new(vector[b"bytes/v1"], vector[0], 1);
    let mut channel = channel::test_channel(p, 1000, KEY1, KEY2, s.ctx());
    let clock = clock::create_for_testing(s.ctx());
    let c = channel::credit(&channel, 1, 1, KEY1, ZERO, vector[100], 0);
    let cp = channel::checkpoint(&channel, &c, vector[25], 0, KEY2, true);
    channel::close_test(&mut channel, c, cp, &clock, s.ctx());
    state(&channel, 0, 0, 1);
    channel::destroy_test(channel); clock::destroy_for_testing(clock);
    burn(&mut s, @0xb, 1000); s.end();
}
#[test, expected_failure(abort_code = 2, location = m2m_streaming::channel)]
fun public_redemption_rejects_credit_for_another_channel_before_signature() {
    let mut s = ts::begin(@0xb); let (first, clock) = fixture(&mut s);
    let (mut second, other_clock) = fixture(&mut s);
    let c = channel::credit(&first, 1, 1, KEY1, ZERO, vector[10, 100], 27);
    channel::redeem(&mut second, c, vector[], &clock, s.ctx());
    channel::destroy_test(first); channel::destroy_test(second);
    clock::destroy_for_testing(clock); clock::destroy_for_testing(other_clock); s.end();
}
#[test, expected_failure(abort_code = 1, location = m2m_streaming::channel)]
fun public_redemption_requires_signature_bytes() {
    let mut s = ts::begin(@0xb); let (mut channel, clock) = fixture(&mut s);
    let c = channel::credit(&channel, 1, 1, KEY1, ZERO, vector[10, 100], 27);
    channel::redeem(&mut channel, c, vector[], &clock, s.ctx());
    channel::destroy_test(channel); clock::destroy_for_testing(clock); s.end();
}
#[test]
fun cumulative_redemption_pays_delta_then_refunds_only_residual_at_deadline() {
    let mut s = ts::begin(@0xb);
    let (mut channel, mut clock) = fixture(&mut s);
    let c1 = channel::credit(&channel, 1, 1, KEY1, ZERO, vector[10, 100], 27);
    channel::redeem_test(&mut channel, c1, &clock, s.ctx());
    state(&channel, 973, 27, 0);
    let c2 = channel::credit(&channel, 2, 1, KEY1, KEY2, vector[20, 200], 54);
    channel::redeem_test(&mut channel, c2, &clock, s.ctx());
    state(&channel, 946, 54, 0);
    clock::set_for_testing(&mut clock, 12000);
    channel::refund(&mut channel, &clock, s.ctx());
    state(&channel, 0, 54, 2);
    channel::destroy_test(channel); clock::destroy_for_testing(clock);
    burn(&mut s, @0xc, 27); burn(&mut s, @0xc, 27); burn(&mut s, @0xb, 946); s.end();
}
#[test]
fun exact_close_after_redemption_pays_only_higher_actual_delta() {
    let mut s = ts::begin(@0xb);
    let (mut channel, clock) = fixture(&mut s);
    let c1 = channel::credit(&channel, 1, 1, KEY1, ZERO, vector[10, 100], 27);
    channel::redeem_test(&mut channel, c1, &clock, s.ctx());
    let c2 = channel::credit(&channel, 2, 1, KEY1, KEY2, vector[20, 200], 54);
    let cp = channel::checkpoint(&channel, &c2, vector[15, 160], 43, KEY2, true);
    channel::close_test(&mut channel, c2, cp, &clock, s.ctx());
    state(&channel, 0, 43, 1);
    channel::destroy_test(channel); clock::destroy_for_testing(clock);
    burn(&mut s, @0xc, 16); burn(&mut s, @0xc, 27); burn(&mut s, @0xb, 957); s.end();
}
#[test, expected_failure(abort_code = 5, location = m2m_streaming::channel)]
fun exact_close_cannot_claw_back_redeemed_advance() {
    let mut s = ts::begin(@0xb); let (mut channel, clock) = fixture(&mut s);
    let c = channel::credit(&channel, 1, 1, KEY1, ZERO, vector[10, 100], 27);
    channel::redeem_test(&mut channel, c, &clock, s.ctx());
    let cp = channel::checkpoint(&channel, &c, vector[4, 25], 8, KEY2, true);
    channel::close_test(&mut channel, c, cp, &clock, s.ctx());
    channel::destroy_test(channel); clock::destroy_for_testing(clock); s.end();
}
#[test, expected_failure(abort_code = 9, location = m2m_streaming::channel)]
fun duplicate_redemption_cannot_pay_twice() {
    let mut s = ts::begin(@0xb); let (mut channel, clock) = fixture(&mut s);
    let c = channel::credit(&channel, 1, 1, KEY1, ZERO, vector[10, 100], 27);
    channel::redeem_test(&mut channel, c, &clock, s.ctx()); channel::redeem_test(&mut channel, c, &clock, s.ctx());
    channel::destroy_test(channel); clock::destroy_for_testing(clock); s.end();
}
#[test, expected_failure(abort_code = 5, location = m2m_streaming::channel)]
fun amount_must_match_policy() {
    let mut s = ts::begin(@0xb); let (channel, clock) = fixture(&mut s);
    channel::credit(&channel, 1, 1, KEY1, ZERO, vector[10, 100], 28);
    channel::destroy_test(channel); clock::destroy_for_testing(clock); s.end();
}
#[test, expected_failure(abort_code = 5, location = m2m_streaming::channel)]
fun credit_cannot_exceed_deposit() {
    let mut s = ts::begin(@0xb); let (channel, clock) = fixture(&mut s);
    channel::credit(&channel, 1, 1, KEY1, ZERO, vector[10000, 10000], 9000);
    channel::destroy_test(channel); clock::destroy_for_testing(clock); s.end();
}
#[test, expected_failure(abort_code = 5, location = m2m_streaming::channel)]
fun checkpoint_cannot_exceed_units() {
    let mut s = ts::begin(@0xb); let (channel, clock) = fixture(&mut s);
    let c = channel::credit(&channel, 1, 1, KEY1, ZERO, vector[10, 100], 27);
    channel::checkpoint(&channel, &c, vector[11, 100], 28, KEY2, true);
    channel::destroy_test(channel); clock::destroy_for_testing(clock); s.end();
}
#[test, expected_failure(abort_code = 4, location = m2m_streaming::channel)]
fun redemption_at_claim_deadline_rejected() {
    let mut s = ts::begin(@0xb); let (mut channel, mut clock) = fixture(&mut s);
    let c = channel::credit(&channel, 1, 1, KEY1, ZERO, vector[10, 100], 27);
    clock::set_for_testing(&mut clock, 12000);channel::redeem_test(&mut channel, c, &clock, s.ctx());
    channel::destroy_test(channel); clock::destroy_for_testing(clock); s.end();
}
#[test, expected_failure(abort_code = 8, location = m2m_streaming::channel)]
fun early_refund_rejected() {
    let mut s = ts::begin(@0xb); let (mut channel, clock) = fixture(&mut s);
    channel::refund(&mut channel, &clock, s.ctx());
    channel::destroy_test(channel); clock::destroy_for_testing(clock); s.end();
}
#[test, expected_failure(abort_code = 11, location = m2m_streaming::channel)]
fun nonfinal_checkpoint_cannot_close() {
    let mut s = ts::begin(@0xb); let (mut channel, clock) = fixture(&mut s);
    let c = channel::credit(&channel, 1, 1, KEY1, ZERO, vector[10, 100], 27);
    let cp = channel::checkpoint(&channel, &c, vector[4, 25], 8, KEY2, false);
    channel::close_test(&mut channel, c, cp, &clock, s.ctx());
    channel::destroy_test(channel); clock::destroy_for_testing(clock); s.end();
}

fun setup_agents(): (Scenario, ID, ID) {
    let mut s = ts::begin(@0xb);
    identity::create_domain(b"test", s.ctx());clock::share_for_testing(clock::create_for_testing(s.ctx()));
    s.next_tx(@0xb); let d = s.take_immutable<Domain>(); let clock = s.take_shared<Clock>();
    identity::register(&d, KEY1, KEY2, 100000, &clock, s.ctx());ts::return_immutable(d);ts::return_shared(clock);
    s.next_tx(@0xc); let buyer = ts::most_recent_id_shared<Agent>().destroy_some();
    let d = s.take_immutable<Domain>(); let clock = s.take_shared<Clock>();
    identity::register(&d, KEY2, KEY3, 100000, &clock, s.ctx());ts::return_immutable(d);ts::return_shared(clock);
    s.next_tx(@0xb); let provider = ts::most_recent_id_shared<Agent>().destroy_some();
    (s, buyer, provider)
}
fun open_fixture(s: &mut Scenario, buyer: ID, provider: ID) {
    let d = s.take_immutable<Domain>();let mut b = s.take_shared_by_id<Agent>(buyer);let p = s.take_shared_by_id<Agent>(provider);
    let clock = s.take_shared<Clock>();let coins = coin::mint_for_testing<SUI>(1000, s.ctx());
    channel::open_test(&d, &mut b, &p, coins, policy::new(vector[b"bytes/v1"], vector[1], 1), ZERO, &clock, s.ctx());
    assert!(channel::opening_exists_test(&mut b, ZERO));
    ts::return_immutable(d);ts::return_shared(b);ts::return_shared(p);ts::return_shared(clock);
}
#[test, expected_failure(abort_code = 6, location = m2m_streaming::channel)]
fun duplicate_opening_nonce_rejected() {
    let (mut s, b, p) = setup_agents(); open_fixture(&mut s, b, p);s.next_tx(@0xb);open_fixture(&mut s, b, p);s.end();
}
#[test]
fun rotation_preserves_funded_keys_and_terminal_nonce() {
    let (mut s, b, p) = setup_agents();open_fixture(&mut s, b, p);s.next_tx(@0xb);
    let mut buyer = s.take_shared_by_id<Agent>(b);let mut channel = s.take_shared<Channel>();let mut clock = s.take_shared<Clock>();
    identity::replace_transport(&mut buyer, KEY3, 100000, &clock, s.ctx());
    assert!(identity::agent_economic(&buyer) == KEY2 && identity::agent_generation(&buyer) == 1);
    identity::replace_economic(&mut buyer, KEY1, 100000, &clock, s.ctx());
    assert!(identity::agent_generation(&buyer) == 2);
    let (saved_buyer_key, saved_provider_key) = channel::channel_keys_test(&channel);
    assert!(saved_buyer_key == KEY2 && saved_provider_key == KEY3);
    // Old Channel credit construction and eventual refund remain live after both rotations.
    channel::credit(&channel, 1, 1, KEY1, ZERO, vector[2], 2);
    clock::set_for_testing(&mut clock, 12000);channel::refund(&mut channel, &clock, s.ctx());
    assert!(channel::opening_exists_test(&mut buyer, ZERO));state(&channel, 0, 0, 2);
    ts::return_shared(buyer);ts::return_shared(channel);ts::return_shared(clock);
    burn(&mut s, @0xb, 1000);s.end();
}
#[test, expected_failure(abort_code = 1, location = m2m_streaming::identity)]
fun transport_and_economic_keys_must_differ() {
    let mut ctx = tx_context::dummy();let d = identity::domain_test(&mut ctx);
    let a = identity::agent_test(&d, KEY1, KEY1, &mut ctx);identity::destroy_agent(a);identity::destroy_domain(d);
}
#[test, expected_failure(abort_code = 0, location = m2m_streaming::identity)]
fun unauthorized_rotation_rejected() {
    let (mut s, b, _) = setup_agents();s.next_tx(@0xc);let mut buyer = s.take_shared_by_id<Agent>(b);let clock = s.take_shared<Clock>();
    identity::replace_transport(&mut buyer, KEY3, 100000, &clock, s.ctx());
    ts::return_shared(buyer);ts::return_shared(clock);s.end();
}
#[test]
fun controller_transfer_changes_mutation_authority() {
    let (mut s, b, _) = setup_agents();let mut buyer = s.take_shared_by_id<Agent>(b);
    identity::replace_controller(&mut buyer, @0xf, s.ctx());ts::return_shared(buyer);
    s.next_tx(@0xf);let mut buyer = s.take_shared_by_id<Agent>(b);let clock = s.take_shared<Clock>();
    identity::replace_transport(&mut buyer, KEY3, 100000, &clock, s.ctx());assert!(identity::agent_generation(&buyer) == 2);
    ts::return_shared(buyer);ts::return_shared(clock);s.end();
}
