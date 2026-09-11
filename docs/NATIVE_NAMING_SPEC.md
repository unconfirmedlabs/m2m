# Native testnet identity and naming binding

Status: implementation contract for issue #1, 2026-09-11; experimental, not a
released standard. The native package is separate from `m2m::exchange`; legacy
Agent IDs are never silently converted. See [the implementation plan](NATIVE_IMPLEMENTATION_PLAN.md).

The resolver accepts a qualified `(network, package_id, domain, agent)` reference
or one of the direct leaf names under `nozomi.sui`. Resolution is independent of
payment. A name is an optional forward alias, not an Agent-adopted organizational
claim and not a payment destination.

## Trust and freshness

The PoC trusts the configured Sui fullnode's state, its chain identity, and a local
clock within five seconds of the onchain Clock. It does not implement a light
client proof verifier. Every resolution checks the network before fetching Agent
authority. Testnet uses the fixed public testnet endpoint; localnet requires a
loopback endpoint and a pinned chain identifier. A mainnet-labelled or unexpected
chain response fails closed. No mainnet transactions are in scope.

Validate the exact object type, object ID, Domain ID, and Domain's network and
package fields using BCS. Agent keys must be distinct 32-byte values; expiry must
be in the future. Cache validity is at most 30 seconds from the start of the RPC
read and never exceeds Agent expiry. Delayed RPC cannot renew a stale snapshot.
An expired snapshot cannot admit or dispatch new messages. The core rechecks
freshness for existing sessions. Generation changes terminate the old admission;
reconnect uses fresh authorization and the durable message journal. RPC errors
are unknown state, not revocation, absence, or successful settlement.

## SuiNS scope

Pinned client releases: `@mysten/sui` 2.30.0 and `@mysten/suins` 2.0.5.
This PoC supports the SLD `nozomi.sui` and its direct leaves only; deeper node
delegations require another explicit binding. Normalize using the SDK's dot form
and reject names outside that scope.

Read raw NameRecord BCS to preserve exact u64 values. Leaf records use expiration
`0` and store their parent's registration ID. Validate the SLD's record and
registration object: expected registration ID, exact type, matching domain labels,
matching unexpired expiration, and current address owner. Validate a leaf's
parent registration reference, marker, and nonempty target. This follows the
[leaf record](https://github.com/MystenLabs/suins-contracts/blob/692a12c02260fd4abecf1630d33db819e4bcadef/packages/suins/sources/name_record.move)
and [leaf constant](https://github.com/MystenLabs/suins-contracts/blob/692a12c02260fd4abecf1630d33db819e4bcadef/packages/suins/sources/constants.move)
definitions, checked 2026-09-11 against the installed SDK's generated BCS layout.
The SDK's convenient `getNameRecord` returns raw records without these lifecycle
checks; [the query API](https://docs.sui.io/sui-stack/suins/developer/sdk/querying)
does not establish a complete m2m authorization.

Pin the resulting qualified Agent reference in conversation and agreement state.
If a later lookup differs, return `identity_changed`; do not move existing trust,
credit, work, or settlement destinations to the new target. Existing conversations
may resolve their pinned Agent directly if the alias expires or SuiNS is unavailable.

## Provisioning and recovery

Expected parent registration:
`0x3f7a86bb5acaf9781399ba2cc710ae5e9dfd9855faaf413bc7179796f19a0bac`.
Only its current owner can create the two leaves, using the SDK's
[createLeafSubName transaction](https://docs.sui.io/sui-stack/suins/developer/sdk/subnames#create-a-leaf-subname).
No registration purchase, renewal, parent retarget, or mainnet operation is needed.
If a leaf already exists and targets the intended Agent, reuse it; a different
target is an error, never an automatic destructive replacement.

Persist the exact signed transaction before submission, bound to network,
deployment, signer and operation identity. An uncertain transaction is retried
with the same signed bytes and reconciled by its digest. A journal cannot be
reused for a different operation. Transaction records and keys are private local
state; public evidence contains only addresses, digests and measured outcomes.

Transport rotation preserves the Agent ID, name, and journal. Economic rights in
an existing channel retain the opening snapshots until that channel's deadline.
Controller changes do not make a cached name or old transport key current.
