/// New durable identity binding; legacy exchange Agents retain their original authority.
module m2m_streaming::identity;

use sui::clock::{Self, Clock};

const EAuthority: u64 = 0;
const EKey: u64 = 1;
const EExpiry: u64 = 2;
const EDomain: u64 = 3;

public struct Domain has key, store {
    id: UID,
    network: vector<u8>,
    package_id: address,
}

public struct Agent has key {
    id: UID,
    deployment: ID,
    controller: address,
    transport_key: vector<u8>,
    economic_key: vector<u8>,
    generation: u64,
    expires_ms: u64,
}

public fun create_domain(network: vector<u8>, ctx: &mut TxContext) {
    assert!(network.length() > 0 && network.length() <= 64, EDomain);
    transfer::freeze_object(Domain {
        id: object::new(ctx), network, package_id: std::type_name::original_id<Domain>(),
    });
}

fun validate_keys(transport_key: &vector<u8>, economic_key: &vector<u8>) {
    assert!(transport_key.length() == 32 && economic_key.length() == 32, EKey);
    assert!(transport_key != economic_key, EKey);
}

public fun register(
    domain: &Domain, transport_key: vector<u8>, economic_key: vector<u8>,
    expires_ms: u64, clock: &Clock, ctx: &mut TxContext,
) {
    validate_keys(&transport_key, &economic_key);
    assert!(expires_ms > clock::timestamp_ms(clock), EExpiry);
    transfer::share_object(Agent {
        id: object::new(ctx), deployment: object::id(domain), controller: ctx.sender(),
        transport_key, economic_key, generation: 0, expires_ms,
    });
}

public fun replace_transport(
    agent: &mut Agent, key: vector<u8>, expires_ms: u64, clock: &Clock, ctx: &TxContext,
) {
    assert!(agent.controller == ctx.sender(), EAuthority);
    validate_keys(&key, &agent.economic_key);
    assert!(expires_ms > clock::timestamp_ms(clock), EExpiry);
    agent.transport_key = key;
    agent.expires_ms = expires_ms;
    agent.generation = agent.generation + 1;
}

public fun replace_economic(
    agent: &mut Agent, key: vector<u8>, expires_ms: u64, clock: &Clock, ctx: &TxContext,
) {
    assert!(agent.controller == ctx.sender(), EAuthority);
    validate_keys(&agent.transport_key, &key);
    assert!(expires_ms > clock::timestamp_ms(clock), EExpiry);
    agent.economic_key = key;
    agent.expires_ms = expires_ms;
    agent.generation = agent.generation + 1;
}

public fun replace_controller(agent: &mut Agent, controller: address, ctx: &TxContext) {
    assert!(agent.controller == ctx.sender(), EAuthority);
    assert!(controller != @0x0, EAuthority);
    agent.controller = controller;
    agent.generation = agent.generation + 1;
}

public fun domain_network(domain: &Domain): vector<u8> { domain.network }
public fun domain_package(domain: &Domain): address { domain.package_id }
public fun agent_deployment(agent: &Agent): ID { agent.deployment }
public fun agent_controller(agent: &Agent): address { agent.controller }
public fun agent_transport(agent: &Agent): vector<u8> { agent.transport_key }
public fun agent_economic(agent: &Agent): vector<u8> { agent.economic_key }
public fun agent_generation(agent: &Agent): u64 { agent.generation }
public fun assert_live(agent: &Agent, clock: &Clock) {
    assert!(clock::timestamp_ms(clock) < agent.expires_ms, EExpiry);
}
public(package) fun agent_uid_mut(agent: &mut Agent): &mut UID { &mut agent.id }

#[test_only]
public fun domain_test(ctx: &mut TxContext): Domain {
    Domain { id: object::new(ctx), network: b"test", package_id: @m2m_streaming }
}
#[test_only]
public fun agent_test(domain: &Domain, transport_key: vector<u8>, economic_key: vector<u8>, ctx: &mut TxContext): Agent {
    validate_keys(&transport_key, &economic_key);
    Agent { id: object::new(ctx), deployment: object::id(domain), controller: ctx.sender(),
        transport_key, economic_key, generation: 0, expires_ms: 100_000 }
}
#[test_only]
public fun destroy_domain(domain: Domain) { let Domain { id, network: _, package_id: _ } = domain; id.delete() }
#[test_only]
public fun destroy_agent(agent: Agent) {
    let Agent { id, deployment: _, controller: _, transport_key: _, economic_key: _, generation: _, expires_ms: _ } = agent;
    id.delete()
}
