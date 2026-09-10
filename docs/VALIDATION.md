# PoC validation record

Run date: 2026-09-10. These results describe a test-file fixture on one Linux
server. They establish technical behavior, not demand for a real paid service.

## Environment

- Rust 1.97.1; Iroh 1.2.0; Node 22.23.2; Sui TypeScript SDK 2.30.0.
- Sui CLI 1.79.0, with a persistent single-validator local network and gRPC RPC.
- Separate buyer/provider processes, Agent objects, endpoint keys, controller
  wallets, and a provider gas wallet. No GPU or model server.
- Exact dependency resolutions are recorded in Cargo, npm, and Move lockfiles.

## Completed checks

| Check | Result |
|---|---|
| Move unit tests | 11 passed: value conservation, nonce replay, authority, amount, deadline boundaries, terminal state, and signature vectors |
| Signed economic checks against local Sui | 17 passed: forged quotes, changed price/request/payee, wrong network, expired quote, unauthorized funding, funding replay, forged/cross-escrow/wrong-result acceptance, early refund, buyer/provider endpoint replacement, exact payout, terminal replay, and timeout refund |
| Rust unit checks | Hash output length, signature purpose separation, unsupported messages, and state locking/durable storage passed |
| Independent encoding/signatures | Rust BCS matches TypeScript BCS; Node crypto and Move verify the same Ed25519 vectors; tampered inputs fail |
| Peer identity attack | A different Iroh endpoint claiming the buyer Agent was rejected by the running provider |
| Repeated purchases | Ten consecutive distinct fixture purchases settled; one escrow and one payout per job |
| Lost funding reference | The buyer recovered the original escrow from the onchain nonce mapping and did not purchase again |
| Buyer restart after acceptance | A new buyer process reused the persisted acceptance and settled the same agreement |
| Provider restart after result persistence | A new provider process delivered the cached bytes for the original escrow |
| Lost settlement reply | The buyer recovered successful settlement from chain state |
| No acceptance | Timeout returned the deposit; repeated refund did not pay again |
| RPC outage | An unreachable buyer RPC returned an error without modifying the job; restoring connectivity settled the original escrow |
| Forced relay transport | A same-server purchase completed with direct IP transports disabled on both Iroh endpoints |
| Static checks | Rust formatting and Clippy with warnings denied, TypeScript type checking, and script syntax checks passed |
| Fresh setup | New role wallets, package, Domain, and Agents completed one purchase and all six recovery scenarios using the documented scripts |

Invalid economic requests are rejected either during the SDK's on-node
transaction-resolution simulation or by transaction execution. Successful funding,
settlement, and refunds are actual local-chain transactions. Exact deadline
boundary assertions are deterministic Move tests, not a claim about reproducing
all real-network scheduling races.

The independent TypeScript verifier is not a second full m2m implementation.
The forced-relay run proves a relay path works for these endpoints; it is not a
test between different operators' networks or a general NAT/firewall claim.

## Measurements

Ten sequential direct-path purchases on the same server, including fresh buyer
process startup, chain reads, quote, funding, file delivery, acceptance, and
settlement:

| Measurement | Observed |
|---|---|
| Median purchase wall time | 9,517 ms |
| Range | 8,248–10,634 ms |
| Quoted price | 1,000 MIST per job |
| Median funding net gas, 10 samples | 7,531,820 MIST |
| Median settlement net gas, 16 samples including recovery runs | 2,286,300 MIST |

Gas is computation plus storage cost minus storage rebate. The fixture price is
illustrative, and gas exceeds it. These measurements are not an economically
competitive inference/data service or a throughput benchmark. Local chain
parameters, new-object storage, and per-operation Node adapter startup contribute
to the result. JSON diagnostics separate chain-operation timings and connection
timings; transaction journals retain gas costs. Optimization is deferred.

A separate fresh-deployment run (one purchase plus six recovery scenarios) recorded
the following phase samples. Chain timings include Node adapter startup and
network/deployment validation on every call; samples are individual calls, not
per-purchase totals.

| Phase | Samples | Median |
|---|---|---|
| Agent resolution | 41 | 509 ms |
| Nonce lookup | 14 | 502 ms |
| Iroh connection | 20 | 24 ms |
| Funding | 7 | 1,261 ms |
| Service result plus durable storage | 6 uncached | 1,111 µs |
| Cached result read/verification | 1 | 87 µs |
| Settlement | 6 | 1,294 ms |
| Refund | 1 | 1,256 ms |

A normal settled purchase requires two economic transactions: funding and
settlement. A timed-out purchase requires funding and refund instead. Package
publication, Domain creation, and Agent registration are separate setup costs;
quoting and file delivery require no transactions.

## Remaining evidence

- **Public testnet:** the RPC is reachable and reports testnet, but the faucet
  rejected funding with HTTP 429. No testnet deployment or paid exchange has been
  confirmed. Setup can resume with the existing generated deployer wallet once
  it has test SUI.
- **Two actual networks:** not run. A second host on a different network is needed.
- **Independent onboarding:** the 30-minute quickstart target has not been tested
  by a developer other than the implementer.
- **Customer value:** no buyer/provider interview or real workflow comparison has
  established that this composition is worth adopting.

The package retains a deployer-controlled upgrade cap and assumes a trusted
publisher and known counterparties. The buyer can withhold acceptance after
delivery; a provider must submit an acceptance before expiry. Endpoint replacement
does not revoke keys from already funded agreements. There is no production
security audit, reputation system, dispute resolution, or arbitrary-work proof.

## Reproduce

Use [QUICKSTART.md](QUICKSTART.md). Local raw receipts, transaction attempts,
measurements, and process logs are under `.m2m/local` in the implementer's workspace.
They are intentionally not committed because that tree also contains private
keys. The harness regenerates equivalent evidence against a fresh local deployment.
