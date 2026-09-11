# Native v1 compatibility boundary

Decision and implementation status, 2026-09-11: the native identity and streaming
package is additive. No legacy economic signed bytes, Move entrypoint, ALPN,
funded agreement authority, or acceptance meaning is migrated implicitly.

| Binding | Authority and economic meaning | Compatibility rule |
|---|---|---|
| `m2m/fixture/1`, existing `m2m::exchange` | Existing Agent/key binding; per-job acceptance after delivery | Continue using the original Agent objects, quote/acceptance signatures and escrow ABI |
| `m2m/payment/1`, `sui.channel.v1` | Existing opening snapshots; one-job rolling prepayment exposure | Existing channels continue their original credit, close, redemption and expiry contract |
| `m2m/core/1`, new `m2m_streaming::identity::Agent` | Durable qualified Agent with distinct controller, transport key and economic key; admission can be unpaid | Explicitly register a new Agent in the new package/Domain; no automatic legacy identity equivalence |
| Core extension `payment.sui.streaming.v1` | New channel snapshots, generic unit/rate policy, cumulative credit and provider exact-close consent | New funding and explicit feature/terms selection; never reinterpret a legacy agreement as this method |

Both old protocols remain available alongside the new native binaries. There is
no automatic ALPN fallback and no cross-protocol signature reuse. A legacy key
does not gain new spending authority because it authenticated an Iroh endpoint.
The new setup creates four separate keys for its two Agents; its controller
wallet is provisioned independently.

Migration by an operator means explicitly registering/pinning new qualified
identities, authorizing new transport and economic keys, updating service routing,
and opening new agreements under the new terms. Existing agreements must still
be closed, redeemed or expired under their original code and snapshots. Old
private recovery journals must be retained. A name may point to the new Agent,
but that does not retarget a funded agreement or transfer its rights.

Transport/controller/economic rotation in the new identity package changes
future admission and agreements. Already opened channels retain their economic
key and destination snapshots. Neither a name change nor a new endpoint is an
agreement migration. Cross-version adapters are future explicit specifications,
not implemented compatibility magic.

The legacy channel `payment.settlement` message remains specified-only. Adding
native settlement does not implement its missing sender/handler. Legacy signing
vectors, journal tests, message fixtures, Rust tests, and all 25 legacy Move tests
were rerun; see [validation](NATIVE_VALIDATION.md).
