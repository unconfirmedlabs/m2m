# Run signed cumulative channels

This optional method uses Iroh payment messages and a Sui deposit to buy several
fixed-file jobs before settling the total. It uses raw Ed25519 signatures and
commitments; it does not generate zero-knowledge proofs. Read the normative
[channel specification](CHANNEL_SPEC.md) for its economic and recovery rules.

## Build and deploy

Use the toolchain and local network in [QUICKSTART.md](QUICKSTART.md), then run
from the repository root:

```bash
npm ci
cargo build --locked
mkdir -p .m2m
bash scripts/sui.sh move build --path move/m2m --dump-bytecode-as-base64 > .m2m/channel-build.json
node --import tsx scripts/setup.ts --state .m2m/channels-local --build .m2m/channel-build.json
python3 scripts/channel-demo.py --root .m2m/channels-local
```

The harness registers separate buyer/provider Agents, starts a provider process,
and runs ten jobs through one channel. Its default deposit is 12,000 MIST: 10,000
MIST pays for the jobs and 2,000 MIST returns at cooperative close. Gas is separate.
The successful economic path is one open transaction and one close transaction;
publication, Domain creation, and Agent registration are setup costs. Repeating
the same session must recover its original outcome without another deposit.

Use a new deployment directory for this package. The old escrow package and
existing deployment evidence remain valid; an old package lacks the channel
module. The new package also supports the existing escrow commands.

## Use the CLI

After the harness initializes the Agents, start the provider:

```bash
target/debug/m2m --state .m2m/channels-local/provider channel-serve \
  --file fixtures/hello.txt --gas-signer .m2m/channels-local/provider-gas.json \
  --ticket .m2m/channels-local/channel-ticket.json
```

Read its public Agent ID with `identity`, then run:

```bash
target/debug/m2m --state .m2m/channels-local/buyer channel-buy \
  --provider <PROVIDER_AGENT_ID> --ticket .m2m/channels-local/channel-ticket.json \
  --expected-file fixtures/hello.txt --signer .m2m/channels-local/buyer-controller.json \
  --session example-1 --jobs 10 --deposit 12000 --max-unit-price 1000

target/debug/m2m --state .m2m/channels-local/buyer channel-status --session example-1
```

Reuse the same session ID and parameters after interruption. A new session ID
means a new intended deposit. Add `--no-close` to leave a funded session for a
separate `channel-close --session example-1 --gas-signer PATH` command. The close
signatures freeze further activity on that channel. `--relay-only` on both sides
disables direct IP paths; the harness exposes the same flag.

The buyer signs and persists a cumulative credit before each job. It verifies
and stores that job's exact file before issuing the next credit. The provider
can claim the last advance without proving delivery, so the honest buyer's
unfulfilled prepayment exposure is one job's price. A compromised buyer endpoint
can authorize the remaining deposit. It cannot spend the controller's other funds.

The running provider stops new work before expiry and schedules redemption of
its saved credit if cooperative close has not completed. Keep it running through
the recovery window. Default work time is 300 seconds, followed by 60 seconds for
claims. `--work-ms` and `--grace-ms` configure these horizons; short windows are
useful for tests and provide less time for recovery.

Manual recovery commands are also available:

```bash
target/debug/m2m --state .m2m/channels-local/provider channel-redeem \
  --channel <CHANNEL_ID> --gas-signer .m2m/channels-local/provider-gas.json
target/debug/m2m --state .m2m/channels-local/buyer channel-refund \
  --session example-1 --gas-signer .m2m/channels-local/buyer-controller.json
```

Refund is available at the claim deadline and returns only residual funds.
Payments already redeemed remain paid. A missing RPC response is an unknown
outcome; terminal state is retained on Sui for reconciliation. Losing all copies
of an authorization, stopping the provider throughout the grace window, or an
outage past the deadline can prevent a timely claim.

Retain the original endpoint keys and journals until their channels are terminal.
Changing an Agent's registered endpoint affects new channels. Existing channels
continue to authenticate their original endpoint keys; a replacement key cannot
sign or communicate on behalf of that earlier snapshot. The PoC serves one
endpoint key per process.

## Verify

```bash
cargo test --locked
npm run typecheck
npm run vectors
npm run channel-vectors
npm run channel-journals
bash scripts/sui.sh move test --path move/m2m
node --import tsx scripts/test-channel-economics.ts .m2m/channels-local
python3 scripts/channel-recovery.py --root .m2m/channels-local
python3 scripts/channel-demo.py --root .m2m/channels-local --block-rpc-in-jobs
```

The signed economic harness is restricted to localnet. Golden signing keys are
public test fixtures without assets. Operational keys, signed transaction
attempts, channel journals, and raw traces remain private under `.m2m/`.

## Public testnet

For a fresh set of testnet wallets:

```bash
node --import tsx scripts/setup.ts --state .m2m/channels-testnet \
  --network testnet --build .m2m/channel-build.json
python3 scripts/channel-demo.py --root .m2m/channels-testnet
```

If `.m2m/testnet` already contains funded wallets on the same chain, add
`--wallets-from .m2m/testnet` to setup. This copies the same role keys into the new
private deployment directory and verifies the source network/genesis. The two
directories then share wallets: run funded operations sequentially. This option
does not move the old package or its Agent/channel state.

Use testnet funds only. [Validation](CHANNEL_VALIDATION.md) separates localnet,
public testnet, and the [Ashburn–Sydney Fly run](FLY_POC.md). Cross-region relay
connectivity is demonstrated; residential NAT diversity and customer demand remain
untested.
