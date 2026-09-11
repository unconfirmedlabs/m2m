# Native core and research streaming quickstart

Experimental Linux reference runner, checked 2026-09-11. This is separate from
the [legacy channel runner](CHANNEL_QUICKSTART.md). Read the [validation limits](NATIVE_VALIDATION.md)
and [economic contract](STREAMING_V1_SPEC.md) before funding anything. Testnet and
localnet only; no mainnet deployment or name purchase.

## Build and test

Requirements: Node with the repository's pinned npm dependencies, Rust, the Sui
CLI selected by `scripts/sui.sh`, and Linux `flock` (util-linux). The live worker
requires exactly Codex CLI 0.154.0 and operator-provisioned authentication. Run:

```sh
npm ci
cargo build --locked --bins
npm run typecheck
npm run native-tests
cargo test --locked
bash scripts/sui.sh move test --path move/streaming
```

`native-tests` uses test doubles for the worker and RPC. Real Rust/TypeScript Iroh
interoperability is exercised by `cargo test`, using the independent TypeScript
core and the Rust raw-byte Iroh bridge. See the validation record for live runs.

## Localnet setup

Start or reuse the existing localnet in a separate terminal. Do not erase genesis
or state to work around a recovery error:

```sh
bash scripts/localnet.sh .m2m/localnet
npx tsx scripts/native-setup.ts --network localnet --wallet /private/localnet-wallet.json --state .m2m/native-localnet
```

The wallet file contains an Ed25519 32-byte seed as a JSON `secret_key` (or
`secretKey`) byte array or a Sui `suiprivkey` string in that field. Pass a private
file path, never a secret on the command
line. The wallet must be funded on the selected network. Setup publishes a
separate Move package and Domain, creates two Agents with distinct transport and
economic keys, and persists exact signed transaction attempts before submission.
The demo uses one controller wallet for both Agents; that is an operator choice,
not shared signing authority between transport and economics.

Localnet skips SuiNS. Keys and private journals live in the ignored state directory.
Agent authorization expires after 24 hours in this setup; renewal/rotation is an
explicit identity operation, not permission to discard identity or agreement state.

## Live protocol validation client

```sh
M2M_CODEX_AUTH_FILE=/private/codex-auth.json npx tsx scripts/native-demo.ts --state .m2m/native-localnet --session live-001 --wallet /private/localnet-wallet.json
```

Use `--request-file /private/question.txt` for a custom UTF-8 prompt, at most
16 KiB. A new session ID creates a new experiment; rerunning the **same session**
recovers its saved agreement and operations. Never delete its state and then
pretend a replacement agreement is recovery. Do not reuse a session with another
prompt, wallet, deployment, or fixture/live mode.

The CLI launches separate coordinator and provider Node processes with actual
Iroh endpoints. The coordinator is a programmed protocol test client; the
provider is a real Luna `xhigh` text worker. This is **not** the two-live-LLM
investor demo. The current worker has no browsing or host tools. Responses and
timing are not deterministic. The [demo proposal](LIVE_DEMO_PROPOSAL.md) describes
the additional live coordinator, research tools, and Tailwind UI.

Output is delivered in credit-gated byte slices. The live policy prices original
input UTF-8 bytes at rate 1 and delivered output bytes at rate 2, with common
denominator 8 and one cumulative ceiling operation. These intentionally small
test prices are not model API cost, revenue projections, or production pricing.
The 100,000-MIST deposit bounds the agreement; signed rolling ceilings expose only
their authorized amount to unilateral claim. See [the adapter contract](NATIVE_RESEARCH_SPEC.md)
for generation overshoot and cancellation semantics.

The worker uses an isolated private runtime directory outside the repository;
its location is saved in the provider journal. Keep that directory for recovery.
Neither credentials nor private Codex state belongs in a public evidence bundle.
The buyer's `runs/SESSION/buyer/result.json` records terminal accounting and the
confirmed Sui digest. An authorization is not an onchain transfer.

## Test-only fixtures and recovery faults

`--fixture` replaces the worker with fixed text for protocol assertions. It is
not permitted as the live investor-demo backend. To exercise the two persisted
restart boundaries on an already initialized localnet:

```sh
npx tsx scripts/test-native-demo.ts --state .m2m/native-localnet --wallet /private/localnet-wallet.json
```

This uses real Iroh, funded localnet Channels, and real settlement transactions;
only model output is synthetic. It restarts after durable delivery and after
confirmed chain close, checking that neither creates another channel or payment.
These are controlled process restarts, not a claim of tested hardware power-loss
durability. Never unlink lock files while a process is running: advisory locks are
automatically released on process death and lock filenames intentionally remain.

## Named testnet deployment

The testnet `nozomi.sui` parent already exists. Only its controlling wallet may
create the intended direct leaves. Once its private wallet-file path is available:

```sh
npx tsx scripts/native-setup.ts --network testnet --wallet /private/nozomi-testnet-wallet.json --state .m2m/native-testnet --create-names
M2M_CODEX_AUTH_FILE=/private/codex-auth.json npx tsx scripts/native-demo.ts --state .m2m/native-testnet --session live-001 --wallet /private/nozomi-testnet-wallet.json
```

Setup validates the expected parent registration/owner and reuses matching leaves;
it refuses to overwrite a different target. The client independently resolves
`local.nozomi.sui` and `research.nozomi.sui` to the configured qualified Agents
before opening the experiment. Chain identity and RPC scope are pinned; mainnet
is rejected. These commands are implemented but the named testnet run has **not**
yet been executed. See [naming verification](NATIVE_NAMING_SPEC.md).
