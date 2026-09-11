# Fly investor demo deployment

Status: packaging/integration in progress, checked 2026-09-11. No investor URL,
new Fly app, Machine, volume, public Sui transaction or live-agent acceptance is
claimed. These files implement the already specified
[two-role envelope](../../docs/FLY_AGENT_DEMO_SPEC.md#6-fly-envelope-and-evidence),
not a separate deployment or a fixture demo.

## Build and inspect locally

Run from the repository root. Use Buildx/BuildKit: the legacy Docker builder does
not provide the Dockerfile-specific context exclusion used here. No build needs
a wallet, model/search key, Fly token or operator state.

```sh
npm ci --no-audit --no-fund
node deploy/agent-demo/build.mjs
docker buildx build --load --platform linux/amd64 \
  --file deploy/agent-demo/Dockerfile --tag m2m-agent-demo:local .
docker image inspect m2m-agent-demo:local
docker run --rm --network none --entrypoint /usr/local/bin/native-bridge \
  m2m-agent-demo:local --help
```

The server build rejects missing actual host/lifecycle modules or unapproved
dependencies. It checks the real import graph and transpiles it as separate ESM modules;
merging their `import.meta.url` values would incorrectly execute imported CLI main
guards. Tests, setup commands and fixtures are not runtime entrypoints. The final
image contains only the release bridge, production lockfile dependencies, the
checked server graph and compiled React/Tailwind assets. Inspect the actual image
and test import-safe boot before calling the build accepted.

The explicit local image test below uses an empty ephemeral mount and no network.
Its test-only configuration has no initialized Agents or economic/model keys:
it expects the real static login and authenticated `backend_unavailable`, never a
snapshot, funding or fake-ready runtime. Do not substitute a real state mount.

```sh
docker run --rm --network none \
  --tmpfs /data:rw,mode=0700,uid=1000,gid=1000 \
  --mount type=bind,src=/absolute/path/to/m2m/deploy/agent-demo/image-smoke.mjs,dst=/probe.mjs,readonly \
  --entrypoint node m2m-agent-demo:local /probe.mjs
```

Rust 1.97.1 and Node 22.23.2 base images are pinned by official image-index digest,
checked against Docker Hub on 2026-09-11. The local build tool probe used Docker
29.8.0 and Buildx 0.37.0; it does not install a system service. Dependencies use
Cargo.lock and both npm lockfiles. Native compilation occurs in the builder, never
on the 1-vCPU demo Machines.

## Read-only plan and preflight

Copy `deployment.example.json` into a protected operator directory outside the
repository. Select two **new** app names and an explicit organization. Retain null
resource fields until the real IDs exist; never invent IDs or reuse an unrelated
app. Resolve the two exact SuiNS leaves and native Agent/controller/key pins,
verify testnet and the fixed budget, and retain the public evidence. The parent
name wallet stays local and is never exported to either role.

Render the two TOML templates with those app names. Both template configurations
pass `flyctl 0.4.101 config validate --strict`; validation does not create apps or
prove authorization, correct volume attachment or runtime readiness.

```sh
fly auth whoami
fly apps list
fly config validate --strict --config deploy/agent-demo/coordinator.fly.toml
fly config validate --strict --config deploy/agent-demo/provider.fly.toml
```

Recheck the current price for exactly one shared vCPU / 1024 MiB Machine and one
1-GiB volume in each of `iad` and `ams` before creation. Model/search usage, egress
and retained storage are separate costs. No remote builder, spare Machine, GPU,
dedicated IPv4, autoscaler, automatic volume extension or extra writer is included.

## Role initialization and deployment boundary

Executable creation/export steps remain pending the tested production `host.json`
entrypoint and role-export implementation. **Do not deploy these templates yet.**
This is the remaining integration, not permission to bypass a missing runtime or
substitute a sample backend. Creation must be recorded one exact resource at a
time, with one volume ID bound to one Machine ID per app. Future updates target
that recorded Machine and volume; do not use an application-wide scale command.

The image command is `node /app/scripts/agent-demo-server.js --config
/data/m2m/host.json`. The protected `/data/m2m` directory must already exist on the
actual mounted volume, be owned by UID/GID 1000, and use directory/file modes
0700/0600. Boot must reject missing initialized records, mismatched deployment
pins and placeholder configuration. It must not publish, generate replacement
keys, register names, open a deposit or start an LLM task.

Role-specific transfer must include only the following authority:

| Input | Coordinator | Provider |
| --- | --- | --- |
| Public chain/config and both Agent identities | Yes | Yes |
| Own transport/economic private keys | Local Agent only | Research Agent only |
| Funded demo-controller wallet | Yes | No |
| Parent SuiNS wallet | **Never** | **Never** |
| Explicit model API credential | Yes | Yes |
| Search API credential | No | Yes |
| Viewer/operator bearer tokens | Yes | No |
| Independent observer bearer token | Yes | Yes |

Transfer through protected files/stdin without echoing secret values or putting
them in shell arguments, URLs, reports or repository files. The provider binds
`fly-local-6pn:8081`; its HTTP Host check uses its configured `.internal:8081`
address, not that listener alias. The coordinator binds port 8080 behind Fly HTTPS;
browser Host/Origin remain the public HTTPS origin. All agent/work/payment traffic
still uses actual Iroh with relay support. No provider public service is declared.

## First connected run and recovery

After the real runtime gates, image boot and protected initialization pass:

1. Open the authenticated UI; provide the viewer/operator token in its password
   input only. Check actual identities and runtime readiness.
2. Start and verify an unpaid Iroh exchange before funding. Inspect the displayed
   immutable terms, then explicitly fund once.
3. Submit an unseen research question. Observe genuine model-selected actions,
   delivered research/citations and signed cumulative credit, with chain amounts
   kept separate from offchain authorization and delivered-byte price.
4. Test browser replay separately from the real Iroh disconnect/reconnect and
   spending pause. No reconnect or restart may create fresh work or money.
5. Explicitly close after reconciled terminal work, or use the real eligible
   expiry-refund path. Independently verify Sui amounts and digest; report gas
   separately. Unknown execution or settlement stays unknown.
6. Test each recorded Machine's restart with its same volume. At the end, review
   retained liabilities, stop only those two exact Machines and retain both apps,
   volumes and journals. There is no automatic destructive cleanup.

Final evidence follows [F14–F21](../../docs/FLY_AGENT_DEMO_IMPLEMENTATION.md#6-acceptance-matrix).
A successful image or HTTP endpoint alone is not a live-demo pass.

## Checked upstream

Checked 2026-09-11: [Fly app configuration](https://fly.io/docs/reference/configuration/)
for HTTPS, resources, mounts and shutdown; [private networking](https://fly.io/docs/networking/private-networking/)
for the 6PN listener; [Fly secrets](https://fly.io/docs/apps/secrets/) for app-scoped
credentials. The [Docker context documentation](https://docs.docker.com/build/concepts/context/#dockerignore-files)
specifies Dockerfile-specific ignore files. These are living docs, not runtime
acceptance evidence.
