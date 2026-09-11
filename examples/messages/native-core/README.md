# Experimental native core wire examples

These are signed `m2m/core/1` envelope fixtures for the experimental
[native core contract](../../../docs/NATIVE_CORE_SPEC.md), independent of the
legacy escrow/channel examples. Every fixture uses deterministic public **test**
keys, synthetic qualified Agent references, and time `1000` ms; it is not live
chain authority or a currently valid request.

`vectors.json` records each full wire envelope, exact signing bytes in hexadecimal,
and public key. `cargo run --quiet --bin native-core -- vectors` reproduces it.
`cargo test --test native_core` verifies signatures, payload types, handshake hashes,
and receipt commitment. `python3 tests/native_core_schema.py` checks the envelope
and decoded body schemas (requires the same `jsonschema` package as legacy
message-example checks). The schema is
[native-core-v1.schema.json](../../../schemas/native-core-v1.schema.json); decode
`message.payload` bytes as UTF-8 JSON and apply the matching `$defs` body schema.

Hello/welcome/confirm/ready establish one transcript. Describe/description advertises
two unpaid services. Send/receipt returns echo output with a separately recorded
`completed` dispatch status; that status is not quality acceptance or payment.
The error is an alternative conflicting retry branch for the same send ID.
`extension.example.echo.v1` demonstrates exact negotiated extension dispatch,
not a streaming-payment statement.

The runtime also exercises service calls in both directions, saved-outbox retry
after receiver restart, changed-content rejection, retained uncertain dispatch,
freshness/key separation, mandatory-feature rejection, and independent TypeScript
peer admission and calls over a raw Iroh framing bridge. A separate test restarts
both the Rust host and TypeScript client processes, opens a new session, and
recovers the saved logical request from durable sender/receiver state. Test success must be
reported from the actual run; schema/fixture presence does not demonstrate a
runtime sender or handler by itself.
