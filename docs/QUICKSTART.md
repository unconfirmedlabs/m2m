# Run the paid-file PoC

Two processes exchange `fixtures/hello.txt` over Iroh, with payment governed by a
Sui Move escrow. No GPU or LLM is required. Tested toolchain: Rust 1.97.1, Node 22,
Python 3, and Sui testnet CLI 1.79.0 on Linux x86_64.

## Install and start the chain

From the repository root:

```bash
bash scripts/install-sui.sh
npm ci
cargo build --locked
bash scripts/localnet.sh
```

The installer checks the release SHA-256 and extracts the `sui` executable into
the user's cache. The archive is approximately 1.1 GB. On other platforms, install
the same Sui version and set `SUI_BIN` to its path.

Leave the local network running in that terminal. The script creates an isolated
genesis under `.m2m/localnet` only when missing, persists chain state, and binds
RPC/faucet access to loopback. Ctrl-C stops it; rerunning preserves the chain.
This is a single-validator development network.

## Deploy and run

In another terminal:

```bash
mkdir -p .m2m
bash scripts/sui.sh move build --path move/m2m --dump-bytecode-as-base64 > .m2m/build.json
node --import tsx scripts/setup.ts --state .m2m/demo
python3 scripts/demo.py --root .m2m/demo --count 10 --failures
```

Setup creates separate controller wallets and a provider gas wallet, funds them
with test coins, publishes the package, and creates its immutable Domain object.
Rerunning reuses that deployment. An uncertain publication is recorded and stops
automatic republishing. The deployer retains the upgrade cap; this PoC assumes a
trusted package publisher.

The demo registers two Agents and starts a provider subprocess. Each buyer call
runs in a separate process. It tests ten purchases, loss of a funding reference,
buyer restart after acceptance, provider restart after result storage, a lost
settlement reply, timeout refund, and an RPC outage. Results are saved as
`.m2m/demo/demo-results-*.json`. The demo stops its provider when it exits.

Run setup and tests sequentially when sharing role wallets. Do not run two
providers/demos against the same state directory; runtime directories are locked.
Never delete chain state while retaining wallets/jobs that reference that chain.

## Individual commands

After the demo has initialized the two Agents:

```bash
target/debug/m2m --state .m2m/demo/provider identity
target/debug/m2m --state .m2m/demo/provider serve \
  --file fixtures/hello.txt --gas-signer .m2m/demo/provider-gas.json \
  --ticket .m2m/demo/provider-ticket.json
```

Copy the public provider Agent ID into this buyer command:

```bash
target/debug/m2m --state .m2m/demo/buyer buy \
  --provider <PROVIDER_AGENT_ID> --ticket .m2m/demo/provider-ticket.json \
  --expected-file fixtures/hello.txt --signer .m2m/demo/buyer-controller.json \
  --request example-1 --max-price 1000

target/debug/m2m --state .m2m/demo/buyer status --request example-1
target/debug/m2m --state .m2m/demo/buyer refund \
  --request example-1 --gas-signer .m2m/demo/provider-gas.json
```

Prices are in MIST; the fixture defaults to 1,000 MIST. Gas is additional and
usually exceeds this illustrative price. Reuse the **same request ID** after an
interruption. A fresh ID denotes a new intended purchase. Buyer flags
`--stop-after funded` and `--stop-after accepted`, and provider flags
`--drop-after-delivery` and `--drop-after-settle`, enable failure demonstrations.

The provider worker needs its endpoint key and separate gas wallet, not its
controller key. Private keys, receipts, and transaction attempts stay under the
gitignored `.m2m/` directory with restricted file permissions. Do not publish that
directory. Checked-in vector keys are public deterministic test keys with no funds.

## Tests

```bash
cargo test --locked
npm run typecheck
npm run vectors
bash scripts/sui.sh move test --path move/m2m
node --import tsx scripts/test-economics.ts .m2m/demo
```

The last command uses the local deployment and isolated test Agents. It checks
actual deposits/payouts/refunds and precise Move aborts for invalid actions. Some
invalid actions are rejected in the SDK's on-node resolution simulation before
broadcast. Move unit tests cover exact clock boundaries deterministically.

With the provider running, test a peer that claims another Agent's identity:

```bash
M2M_TEST_ROOT=.m2m/demo cargo test --locked --test peer_auth -- --ignored
```

Rust signing vectors are reconstructed independently in TypeScript, verified with
Node crypto, and checked in Move. This is not a second complete protocol
implementation. Dependency resolutions are pinned in the three lockfiles.

## Public testnet and other networks

```bash
node --import tsx scripts/setup.ts --state .m2m/testnet --network testnet
python3 scripts/demo.py --root .m2m/testnet --count 1 --failures
python3 scripts/demo.py --root .m2m/testnet --count 1 --relay-only
```

If the public faucet rate-limits the server, fund the generated deployer address
with test SUI and rerun setup. About 1 test SUI is sufficient for setup and a few
jobs. Setup distributes 0.2 test SUI to each of the three role wallets. Use only
testnet funds. Localnet and testnet state directories must be separate.

These commands passed against public testnet on 2026-09-10. See the
[validation record](VALIDATION.md#public-testnet) for deployment IDs, transaction
evidence, costs, and the distinction between same-server and two-network testing.

For different hosts, give each operator its own private role state and a public
copy of `chain.json`. Share only the provider ticket and Agent ID. Add `--relay`
to both `serve` and `buy` for Iroh's default address lookup and relay support.
Use `--relay-only` on both sides (or on `scripts/demo.py`) to disable direct IP
paths and explicitly exercise relay delivery.
Those are external dependencies. The default local demo uses direct IP transport.
Cross-network/NAT behavior requires an actual two-network run.

## Limits

The buyer can withhold acceptance after receiving the file. A provider must
submit acceptance before expiry to be paid. This assumes known counterparties,
not fair exchange or verifiable arbitrary work quality.

There is one operation, asset, and active endpoint per Agent. The provider handles
requests serially. Each Rust chain operation launches a small TypeScript adapter
using the official Sui gRPC SDK; process startup is included in timings. Publishing
an optimized SDK, implementing MCP/A2A/x402 adapters, and proving customer demand
are separate work.
