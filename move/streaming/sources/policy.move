/// Bounded, common-denominator cumulative pricing shared by every service adapter.
module m2m_streaming::policy;

use std::bcs;
use sui::hash;

const EPolicy: u64 = 0;
const EUnits: u64 = 1;
const EOverflow: u64 = 2;
const U128_MAX: u128 = 340282366920938463463374607431768211455;
const U64_MAX: u128 = 18446744073709551615;

public struct Policy has copy, drop, store {
    purpose: vector<u8>,
    version: u8,
    units: vector<vector<u8>>,
    rates: vector<u64>,
    denominator: u64,
}
public struct PricingPolicy has key, store { id: UID, policy: Policy }

public fun new(units: vector<vector<u8>>, rates: vector<u64>, denominator: u64): Policy {
    let value = Policy { purpose: b"m2m/streaming/policy/v1", version: 1, units, rates, denominator };
    validate(&value);
    value
}

public fun validate(value: &Policy) {
    assert!(value.purpose == b"m2m/streaming/policy/v1" && value.version == 1, EPolicy);
    assert!(value.units.length() >= 1 && value.units.length() <= 8, EPolicy);
    assert!(value.units.length() == value.rates.length() && value.denominator > 0, EPolicy);
    let mut i = 0;
    while (i < value.units.length()) {
        let name = &value.units[i];
        assert!(name.length() > 0 && name.length() <= 64, EUnits);
        let mut j = 0;
        while (j < name.length()) {
            let c = name[j];
            assert!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c == 46 || c == 95 || c == 47 || c == 45, EUnits);
            j = j + 1;
        };
        j = 0;
        while (j < i) { assert!(value.units[j] != *name, EUnits); j = j + 1 };
        i = i + 1;
    };
}

public fun publish(units: vector<vector<u8>>, rates: vector<u64>, denominator: u64, ctx: &mut TxContext) {
    transfer::freeze_object(PricingPolicy { id: object::new(ctx), policy: new(units, rates, denominator) });
}
public fun value(policy: &PricingPolicy): Policy { policy.policy }
public fun commitment(policy: &Policy): vector<u8> { hash::blake2b256(&bcs::to_bytes(policy)) }
public fun dimensions(policy: &Policy): u64 { policy.units.length() }

public fun price(policy: &Policy, quantities: &vector<u64>): u64 {
    assert!(quantities.length() == policy.rates.length(), EUnits);
    let mut total: u128 = 0;
    let mut i = 0;
    while (i < quantities.length()) {
        let term = (quantities[i] as u128) * (policy.rates[i] as u128);
        assert!(total <= U128_MAX - term, EOverflow);
        total = total + term;
        i = i + 1;
    };
    let d = policy.denominator as u128;
    let amount = total / d + if (total % d > 0) 1 else 0;
    assert!(amount <= U64_MAX, EOverflow);
    amount as u64
}

public fun within(units: &vector<u64>, ceilings: &vector<u64>): bool {
    if (units.length() != ceilings.length()) return false;
    let mut i = 0;
    while (i < units.length()) { if (units[i] > ceilings[i]) return false; i = i + 1 };
    true
}
