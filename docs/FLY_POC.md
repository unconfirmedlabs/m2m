# Cross-region Fly Machines PoC

Status: cross-region relay exchange verified, 2026-09-10. App
`m2m-iroh-poc-20260910` hosts the experiment. The buyer and provider completed ten
paid jobs in Sydney and Ashburn; their temporary machines and volumes were
archived and removed after settlement. See [validation](CHANNEL_VALIDATION.md)
and its public transaction evidence. The final ten-job offchain loop took
4,591 ms; opening and closing used two Sui transactions. Fly lists zero remaining
machines and volumes for this app after cleanup.

This test places the buyer and provider on separate Fly Machines in different
regions and runs the existing signed cumulative channel over Iroh. Both roles
use the same public Sui testnet deployment, so this measures cross-region host
connectivity and process separation. It does not by itself demonstrate two
independent networks, residential NAT diversity, or customer demand.

## What the image contains

[`Dockerfile`](../Dockerfile) is a multi-stage build pinned to the Rust and Node
toolchain versions used by this PoC. It builds the Rust executable with
`Cargo.lock`, installs the Node adapter with `package-lock.json`, and copies the
channel adapter and deterministic fixtures. It contains no `.m2m` directory,
wallet, endpoint key, transaction journal, Git data, or controller key.

The image starts with `sleep infinity`. The runner initializes each fresh
volume with an already registered `identity.json` and its `endpoint-key.json`,
then starts the provider and buyer with `fly machine exec`. This keeps the
provider controller and deployer keys off the provider Machine. The provider
Machine receives only its endpoint key and provider gas signer; the buyer
Machine receives its endpoint key and buyer controller signer. The state
volume is the durable role boundary.

Fly's `--file-local` mechanism transfers these small files into each Machine's
configuration and writes them at boot. They are not part of the image, but the
Machine configuration is sensitive while the test is running. Use a temporary
app and destroy the Machines and volumes after terminal settlement. Fly
documents this file injection behavior in [Run a new Machine](https://fly.io/docs/machines/flyctl/fly-machine-run/).

## Prerequisites

Build and deploy a fresh channel package on Sui testnet first. The supplied
`chain.json` must describe that package and Domain, and both role state
directories must contain identities registered in that same deployment:

```text
chain-config:   .m2m/channels-testnet/chain.json
provider-state: .m2m/channels-testnet/provider
buyer-state:    .m2m/channels-testnet/buyer
provider-gas:   .m2m/channels-testnet/provider-gas.json
buyer-signer:   .m2m/channels-testnet/buyer-controller.json
```

The runner reads identity and chain metadata to check that they match. It does
not read or print the private key contents. The provider controller may be used
on the control host when registering the provider, but it is not an input to the
Fly run.

Check access without printing a Fly token:

```bash
~/.fly/bin/flyctl version
~/.fly/bin/flyctl orgs list
~/.fly/bin/flyctl platform regions
```

The current preparation host has `flyctl v0.4.101` at that path and lists
`iad` (Ashburn) and `syd` (Sydney). Region availability and capacity can change;
Fly's [region reference](https://fly.io/docs/reference/regions/) is the current
source of truth.

## Run a forced-relay exchange

The retained app is `m2m-iroh-poc-20260910`. The final tested
image is:

```text
registry.fly.io/m2m-iroh-poc-20260910:deployment-01M25XFPQCHM2FPQE4YMKWG8RG
```

Build manifest digest: `sha256:5c545b1fdfced31e112dd58b681753176e04fb0eda9093092d5039a6b99f9131`.
The installed Fly CLI rejected a digest-form reference at machine creation, so
the command uses this build-specific deployment tag. That rejected attempt
created no machine or channel; its two empty volumes were removed.

The runner uses
the `--reuse-app --image` path below, so it does not create or delete the app
and does not rebuild the image per Machine:

```bash
export M2M_IMAGE='registry.fly.io/m2m-iroh-poc-20260910:deployment-01M25XFPQCHM2FPQE4YMKWG8RG'

python3 scripts/fly-poc.py \
  --app m2m-iroh-poc-20260910 \
  --org personal \
  --reuse-app \
  --image "$M2M_IMAGE" \
  --chain-config .m2m/channels-testnet/chain.json \
  --provider-state .m2m/channels-testnet/provider \
  --buyer-state .m2m/channels-testnet/buyer \
  --provider-gas .m2m/channels-testnet/provider-gas.json \
  --buyer-signer .m2m/channels-testnet/buyer-controller.json \
  --provider-region iad \
  --buyer-region syd \
  --path relay
```

`--path relay` passes `--relay-only` to both channel processes. The runner
filters the provider ticket to `Relay` routes and refuses to continue without a
relay route. It exposes no HTTP port and disables Fly DNS registration. The
default run uses ten jobs, a 12,000 MIST deposit, and a 2,000 MIST residual
refund.

The command creates two one-gigabyte volumes and two unmanaged Machines using
the build-specific image. It waits for the provider ticket, starts the buyer,
reconciles `channel-status`, and reads the open and close transaction journals
through a narrow projection that omits transaction bytes and signatures. Before
any volume deletion it downloads a second, complete `/state` tar archive for
each live Machine. The archives include journals and result files and are
stored locally with mode 600 under `.m2m/fly-prep/<run-id>/`; they are never
printed. Fly's [machine run reference](https://fly.io/docs/machines/flyctl/fly-machine-run/)
and [volume documentation](https://fly.io/docs/volumes/overview/) describe the
Machine and volume lifecycle used here.

The report is written under `.m2m/fly-prep/<run-id>/report.json` with mode 600.
It includes Machine IDs and observed regions, channel ID, open/close digests,
gas records, balance/status fields, timing, archive SHA-256/size metadata, and
the two runtime logs. The `connection.runtime_events` field preserves the
structured `channel_connected` and `channel_jobs_end` events, including the
Iroh `PathList` debug snapshots emitted by the runtime. Those events are the
evidence for the path actually selected; the requested mode alone is not a
latency or connectivity result.

The runner also invokes `scripts/verify-channel-run.ts` from the control host.
This independent audit reads the checkpointed open/close transactions and Channel
from Sui, verifies the expected package, Domain, parties, changed object, paid
amount, and buyer refund net of gas. It must pass before success or cleanup.

The runner declares success only when all of these checks pass:

- exactly two confirmed transaction journals exist in the fresh buyer volume,
  named `<session>.open.tx.json` and `<session>.close.tx.json`, with distinct
  digests;
- the status is terminal `closed`, with ten completed jobs, authorization and
  redeemed amount equal to `jobs * unit-price`, and status residual/funds equal
  to zero;
- the retained channel state reports `deposit`, `redeemed_amount`, and
  `funds`, and the derived refund `deposit - redeemed_amount` is consistent
  with the expected paid amount.

The derived refund is checked against actual balance changes by the independent
audit. Terminal channel state establishes the final paid amount and zero residual.

## Run the direct-path variant

Reuse the same parent-created app for the direct-path experiment. The runner
generates new underscored volume names for this invocation, and each report
has its own run ID:

```bash
python3 scripts/fly-poc.py \
  --app m2m-iroh-poc-20260910 \
  --org personal \
  --reuse-app \
  --image "$M2M_IMAGE" \
  --chain-config .m2m/channels-testnet/chain.json \
  --provider-state .m2m/channels-testnet/provider \
  --buyer-state .m2m/channels-testnet/buyer \
  --provider-gas .m2m/channels-testnet/provider-gas.json \
  --buyer-signer .m2m/channels-testnet/buyer-controller.json \
  --provider-region iad \
  --buyer-region syd \
  --path direct
```

The 2026-09-10 direct probe found no globally routable provider route and stopped
before funding a channel. Its provider state was archived and its resources
removed. A future direct test needs an appropriate public UDP configuration.

Direct mode uses the channel runtime's normal Iroh transport without a relay
and filters the ticket to globally routable IP routes. It drops private,
loopback, link-local, CGNAT, and Fly 6PN routes before the buyer sees the
ticket. If the provider exposes no global IP route, the runner fails rather
than silently testing Fly private networking. A successful run still needs the
runtime path snapshots in the report to establish the selected path.

Fly's [private networking documentation](https://fly.io/docs/networking/private-networking/)
describes `.internal` and 6PN addresses. The runner intentionally does not use
those names or addresses for the direct-path claim. The relay variant is a
real cross-region exchange through Iroh relay infrastructure; it is not a
direct public-IP result.

## Cleanup and recovery

After the hard success checks and complete state archives succeed, the runner
stops and destroys only the Machines and volumes recorded in its current run.
The retained app is retained. `--keep` retains created resources after a
successful run. `--delete-app` is ineffective with `--reuse-app` and is not
needed for the parent-owned app.

If opening, close, status reconciliation, hard accounting checks, or archive
download fails, the runner preserves the created resources by default because
the Sui outcome or recovery records may be unknown. It still attempts a full
archive for every Machine that exists before considering cleanup. If an archive
fails, volume deletion is skipped. The report contains the error, resource IDs,
and any successfully downloaded archive metadata. Inspect the channel from the
buyer state, recover the terminal state, and then clean up explicitly.
`--cleanup-on-error` is available for a deliberate teardown after an error, but
the runner still refuses volume deletion when a state archive is incomplete.

The app name is checked first. An existing app is refused unless
`--reuse-app` is explicitly supplied; even then the runner never deletes the
app. Generated volume names use bounded lowercase letters, digits, and underscores.
The runner saves creation intents before API calls and checkpoints returned IDs.
Uncertain resource creation blocks automatic deletion; cleanup uses only known
IDs from this run. Stop or destruction errors prevent volume deletion. This follows Fly's volume name/API shape and
protects unrelated Fly applications.

The installed CLI accepts `fly machine exec [machine-id] <command> [flags]`.
The runner passes flags to `flyctl`, then executes a single remote `sh -lc`
script as the command, quoting the actual command with `shlex.join`; channel
arguments therefore cannot be consumed as Fly flags. The archive transfer uses
that same boundary: `tar` and base64 run remotely, and only the decoded private
archive is written locally. It does not put an archive in a command-line
argument or print it.

## Evidence limits

The report should preserve the direct and forced-relay results separately. For
each path record the two regions, Machine IDs, observed Iroh events, setup and
job timings, completed job count, actual Sui transaction count, gas, channel
ID, and terminal digests. Do not combine the relay and direct runs into one
latency number.

Both Machines call the same public Sui testnet RPC. The test does not prove that
the agents operate on different Sui networks, and it does not turn a fixed
file fixture into evidence of demand. The channel remains the signed
cumulative-credit PoC described in [CHANNEL_SPEC.md](CHANNEL_SPEC.md); it has no
GPU, inference provider, or zero-knowledge prover.
