# L0 provisioning correction: independent Astra re-review

Checked 2026-09-11, completed at approximately 09:13 UTC. **Return S3 for bounded
correction.** S1's unused-orchestration defect is corrected and the original S2
fresh-authority ordering variants pass. This does not establish complete L0/F14a
acceptance. S4 actual per-role export remains explicitly pending L1.

Implementation and owner tests were read-only. All wallet material used by probes
was newly generated test material in private temporary directories. SDK/name
reads and submissions were intercepted; there was no public RPC, transaction,
name write, real wallet read, Fly action, inference, or deployment. The separate
runtime and UI implementations were not reviewed in this tranche.

## Frozen inputs

Hashes matched before and after review:

| File | SHA-256 |
| --- | --- |
| `scripts/native-setup.ts` | `468563edc4c89c15d8691ed0726a5ece980f648a6dc1066a6c75706874f8c514` |
| `scripts/native-setup-helper.ts` | `dcb5f5757993f324ddae3536b155697d03b5585b156f02612145f42c7e8abeb9` |
| `scripts/test-agent-demo-setup.ts` | `e1e98682760463e0079f8f4971255d9fd733aaf34f1eeacbdb1502edf07248db` |

Read the prior `agent-demo-coordinator-setup-review-2026-09-11.md` S1–S4,
FD-04/05, the frozen Fly implementation L0/F14a contract, all three files above,
and the actual `NativeChain`/`NativeNames` adapters. No Move or signed-wire change
is requested by these findings.

## Accepted narrow evidence

- The CLI really calls `provisionNativeDemo` (`native-setup.ts:127–131`). Its
  adapters construct the unchanged `create_domain`/`register` ABI calls, use the
  controller for publication/domain/registration, and pass the explicit name
  wallet only to existing `NativeNames.createLeaves`. This closes the original
  parallel-unused-orchestration finding, not every adapter crash boundary.
- `preflightExisting` resolves all preexisting Agents before any transaction or
  leaf effect, and compares the fresh controller plus both operational keys.
  Independent exact old-S2 probes left local uncreated and research existing,
  with its local controller record still matching. Each of fresh research
  controller, transport-key, and economic-key mismatch failed with
  `Existing research Agent authority mismatch` and **zero effects**.
- With a complete, intact manifest, independent no-op probes changing mode,
  controller, name wallet, network, chain identifier, package, domain, or operation
  identity all failed with zero new effects. A changed name-wallet probe changed
  the mock parent owner too, so the rejection genuinely reached immutable pin
  admission rather than accidentally failing parent ownership first.
- `tsx scripts/test-agent-demo-setup.ts` and `npm run typecheck` passed. The
  checked-in suite exercises an interrupted domain effect using recording ports,
  intact-manifest replay, completed no-op recovery, completed-state manifest
  loss, several pin changes, separate/legacy authority selection, and actual
  `NativeChain.execute` with mocked SDK submission/wait/reopen. The latter checks
  signer rejection and identical retained bytes/signature; it is not a complete
  CLI boundary matrix or chain-settlement proof.
- An independent nearest-valid registration retry retained the submitted journal
  after a lost submission acknowledgment. Two observed submissions used identical
  bytes. The contrasting missing-journal variant below used different bytes.
- Actual CLI invocations with a sentinel nonexistent wallet path rejected
  `--network mainnet`, `--network localnet --create-names`, and `--name-wallet`
  without `--create-names` before wallet access, with the expected fixed messages.
- Existing `NativeNames` parent checks and rejection of an existing leaf's wrong
  target remain in use. No implicit controller transfer, retargeting, or Move ABI
  change was introduced. Historical one-wallet mode is still a fresh legacy
  invocation, not permission to migrate initialized separate-mode state silently.

## SR01 — P1: lost initialized manifest is treated as fresh before final outputs

`native-setup-helper.ts:296–305` detects a missing manifest only if `chain.json`
was supplied as `initialConfig` or a role was supplied as `existing`. The CLI
writes `chain.json`, role `identity.json`, and `authorization.json` only after
the entire helper returns (`native-setup.ts:132–135`). Its earlier key files and
transaction journals do not prevent fresh initialization when the manifest is
missing. There is no independent initialized-component admission marker.

Actual CLI reproduction, with production orchestration/adapters and only SDK
boundaries intercepted:

1. Generate two distinct fixture wallets, save them to temporary files, and
   create a fixture `build.json` containing `modules: ['AA=='], dependencies: []`
   so the test does not invoke a Move build.
2. Intercept the SDK core `getChainIdentifier` and ledger `getServiceInfo`
   prototypes with `fixture-chain` and testnet; intercept `NativeNames.parent`
   with the fixture name-wallet owner. Make unexpected `fetch` fail.
3. Intercept `NativeChain.execute` to count invocation and throw
   `FIXTURE_STOP_BEFORE_SUBMIT`. Call actual `runNativeSetup` with explicit
   separate wallets and `--create-names`.
4. Assert the saved manifest is initialized/separate while `chain.json` and role
   identity outputs do not exist. Move only `setup-manifest.json` aside; retain
   all other setup files.
5. Invoke the same CLI/state/controller without `--name-wallet` or
   `--create-names`.

Observed:

```json
{"firstError":"FIXTURE_STOP_BEFORE_SUBMIT","secondError":"FIXTURE_STOP_BEFORE_SUBMIT","effectAdapterCalls":2,"chainOutputExists":false,"identityOutputExists":false,"oldMode":"separate","newMode":"legacy","nameWalletChanged":true}
```

Thus the second invocation rewrites authority pins and admits another effect
adapter. This is not merely a hypothetical helper-only bypass.

Separately, a helper fault matrix interrupted **after** each of publication,
domain, local registration, research registration, and names, before the CLI's
final outputs. Removing only the manifest and retrying without separate-wallet
mode completed in all five cases and wrote a legacy manifest. The recording
transaction port retained prior operation results, so this matrix proves
admission/authority loss, not real transaction idempotence.

Required correction/tests: distinguish explicitly fresh setup from initialized
reopen before creating/replacing components or admitting effects. Loss of the
authoritative initialized pins must fail closed even when final public output
files never existed. Cover before first effect and before/after every effect and
result save. Keep a valid exact-input resume positive case at each boundary.
Do not infer fresh authority from the absence of `chain.json`/identity outputs,
or silently migrate legacy state. Public output reconstruction from intact,
authoritative retained evidence may be safe; minting replacement authority is not.

## SR02 — P1: lost submitted operation journal permits a newly signed retry

The initialized manifest pins operation **names**, but not which operation
components have been initialized/dispatched and are required for recovery.
Registration starts at `native-setup-helper.ts:345–353`, then records its result
only after it returns and fresh resolution succeeds (`355–367`). A submitted
registration journal can therefore be lost while the manifest still has an
empty Agent pin. The next retry calls `NativeChain.execute` with an absent
journal; its normal fresh-operation path builds/signs new bytes.

Independent fixture reproduction used actual `provisionNativeDemo` and actual
`NativeChain.execute`, generated signing keys, a real temporary transaction
journal, and an injected SDK client—no remote effects:

1. Supply the helper with durable manifest callbacks. Let fixture publication and
   domain finish; leave both Agents uncreated.
2. Route registration through real `NativeChain.execute`. Its fake transaction
   builder returns a distinguishable byte sequence on each fresh build; the
   mocked SDK captures submitted bytes/signature and then throws
   `FIXTURE_LOST_SUBMIT_ACK` on the first local registration.
3. Confirm `local/register.tx.json` is `submitted`, the setup manifest remains
   initialized, and the local Agent result is not yet pinned.
4. Move only that submitted journal aside. Retain the setup manifest, original
   wallets/keys, config pins and other component files.
5. Retry the helper with the same inputs. Subsequent mock SDK calls return
   successful created-Agent results and successful waits.

Observed:

```json
{"firstError":"FIXTURE_LOST_SUBMIT_ACK","pendingState":"submitted","initializedManifest":true,"completed":true,"localSubmissions":2,"identicalLocalBytes":false}
```

The nearest-valid case that retained the journal completed with
`identicalLocalBytes: true`. The mock does not establish whether Sui would create
an extra Agent in a particular transaction; the proven violation is admission
of differently signed bytes after loss of an uncertain operation's evidence.

Required correction/tests: retain enough authoritative per-operation lifecycle
evidence to reject a missing required transaction component instead of treating
it as never launched. A pending/uncertain operation must recover from its exact
signed journal, or report recovery required; it must not rebuild/re-sign.
Exercise missing/corrupt pending components for publication, domain, both
registrations and names, with intact-journal same-byte/same-signature positives.
This can be enforced by the L0 orchestrator/admission contract; do not weaken or
reinterpret `NativeChain.execute`'s signed-byte replay behavior.

## SR03 — P1: operational inputs are not pinned, and the Iroh copy is unchecked

The manifest schema (`native-setup-helper.ts:91–106`) contains no role public-key
pins. On reopen, the CLI reads whichever key is currently in each purpose file.
It checks presence and transport/economic inequality, but an existing
`iroh-key.json` is only tested for existence (`native-setup.ts:61–78`), not parsed
and compared to the transport key it is supposed to encode.

Actual CLI fixture reproduction:

1. Use the SDK interceptions from SR01. Mock publication/domain results through
   the actual transaction adapter, mock domain validation/clock, and stop the
   first registration adapter with `FIXTURE_STOP_BEFORE_REGISTER_SUBMIT`.
2. Retain the initialized manifest with its completed package/domain pins.
   Replace only local `transport.json` with a different generated fixture key;
   retain its original `iroh-key.json` and every other file.
3. Rerun identical CLI arguments.

Observed: the second registration adapter is admitted; publication/domain are
not repeated. Counts were `registerCalls: 2`, `publishCalls: 1`, `domainCalls: 1`.
The transport public key changed, the Iroh copy remained the old 32-byte secret,
and there was no pin-mismatch error. A helper-only nearer-to-initialization probe
also changed a transport public key after initial manifest save but before
publication, then completed and registered that changed key.

Required correction/tests: pin the original per-role public operational inputs
for an initialized provisioning attempt, and verify the actual Iroh key file
derives the pinned transport public key. Reject changed, missing, malformed or
mismatched purpose/transport components before effects; never generate a
replacement for an initialized component. Test both roles/purposes and an
unchanged valid derivative. This does not forbid a separately authorized future
key-rotation workflow; setup recovery must not invent one implicitly. The final
L1 identity preflight remains independently necessary and is not a reason for L0
to register an unintended key first.

## SR04 — P2: CLI error output is not a fixed safe surface

`safeSetupFailure` (`native-setup.ts:145–154`) rejects selected path/secret-looking
text but returns arbitrary other short exception messages. Its comment that the
CLI is fixed and never prints SDK response data is not true.

An actual CLI-entrypoint probe used generated fixture wallets and replaced the
SDK chain-identifier read with an exception whose entire message was
`fixture_token=NOT_A_REAL_CREDENTIAL`. Capturing `console.error` observed exactly
that text, with exit code 1. This sentinel was not a real credential.

Required correction/test: use finite, trusted CLI failure construction or map
unknown errors to a fixed fallback. Do not treat a message as public-safe merely
because it avoids a few keywords/path patterns. Preserve the useful known
argument/authority failures, but add arbitrary SDK/request/child-process error
sentinels and assert none are printed. Import-safe callers may retain private
structured diagnostics under the existing private handling boundary.

## Acceptance limits and bounded handoff

The checked-in manifest-loss regression removes the manifest only **after**
complete setup and supplies both `initialConfig` and existing identities
(`test-agent-demo-setup.ts:204–206`). It cannot expose SR01. Its replay fixtures
retain every operation journal; they cannot expose SR02. Its manifests have no
key pins and do not exercise a changed purpose key versus retained Iroh copy.
There is no permanent actual CLI fixed-error sentinel regression for SR04.

Return SR01–SR04 to the L0 owner for failing-regression-first correction. At least
one regression must use actual `runNativeSetup` with intercepted SDK boundaries,
and SR02 must retain the real `NativeChain.execute` boundary. Do not add alternate
production setup paths merely to make fixtures pass. The complete before/after
effect/result-persistence matrix, missing component checks and exact-input
positive recovery remain required acceptance evidence; the existing green suite
does not cover them all.

S4/F14a actual role export remains pending the real L1 composition/export path.
The existing sentinel field-projection test is not evidence that a real export
excludes the parent wallet and counterpart keys. No public provisioning, named
testnet deployment, funding, Fly hosting or investor-demo acceptance is claimed.
