# L2 auth: bounded integration review

2026-09-11. **Review pending corrected freeze; no auth or whole-host acceptance
yet.** Read FD-13/14, the provider replay route in FD-16, and L2/F08. No
implementation or owner-test edits, credentials, public RPC, transaction, resource
changes, or deployment were performed.

## Provenance and interruption

Initially supplied and read:

| File | SHA-256 |
| --- | --- |
| `scripts/agent-demo-auth.ts` | `168b1210dc0c924fb5a19851f25aadcb212bde1a13e770005a6aa0b740491b7d` |
| `scripts/test-agent-demo-auth.ts` | `608ef803d815e3cb9e728604e4787435103fb3f89d52aa0ef5676d0456f84e2f` |

After the two interface findings were sent immediately to root/owner, source
changed during the first independent fault probe to
`ae7d0d9723707d8e0df662bce57a17900712bcb7b77a6948188ea6787e21ca0e`
while the test retained its original hash. The new constructor discriminator made
the old-interface probe stop before its substantive assertions. Do not count
that interrupted run as confirmation of either old failures or corrected
behavior. The owner suite printed success, but a stable before/after test hash
pair was not established for a final acceptance run.

## Exact narrow return/checklist

### A01 — provider requires forbidden browser credentials

The initially frozen `DemoAuthOptions` required publicOrigin, viewerToken,
operatorToken and observerToken for every instance. That conflicts with frozen
`openDemoHttp` coordinator-only optional viewer/operator inputs and FD-22's role
secret isolation: the provider must receive only its private observer token for
HTTP authentication, not browser credentials.

Use an explicit finite coordinator/provider constructor shape. Test provider
construction with only its permitted token/host inputs, provider read success,
public/work/control route denial, and rejection of role-inappropriate credential
inputs. Do not invent dummy viewer/operator tokens as a second provider startup
flow. Coordinate the discriminator with the real host owner.

### A02 — required provider replay cursor is rejected

Initially `requestUrl` rejected every query string. Frozen FD-16 requires
`GET /internal/v1/events?after=<base64url canonical source-role cursor>` for
bounded JSON source pages. Public SSE uses Last-Event-ID, but this private route
does not. Rejecting its valid cursor prevents provider history/replay integration.

Test a canonical encoded zero cursor and a nonzero cursor with the observer token
and exact private Host; both must reach the provider page handler. Reject extra,
duplicate, malformed and token query parameters. Keep public routes' no-query
rule, provider mutation denial, and exact endpoint/method/role policy. Semantic
future/cross-conversation cursor checks remain the real source/page host's duty.

### A03 — returned principal exposes auth owner and is mutable

Static code in both inspected versions defines `Principal` with public enumerable
constructor properties `owner`, `role`, and `clientAddress`. `owner` points to
`DemoAuth`, whose TypeScript-private `secrets` field is ordinary runtime object
state containing every configured bearer buffer. This contradicts authenticate's
comment that it returns no secret material. TypeScript `readonly` also does not
freeze the returned role; `assertPrincipal` checks only class and owner identity.

Required exact probes at the next freeze:

1. Authenticate a generated-fixture viewer token. JSON serialization/object
   traversal of the returned principal must expose only intended public principal
   fields, never an auth-owner object or credential buffers. Assert secrets are
   not recoverable without printing them.
2. Attempt to change that principal's role to operator; control admission must
   still fail. Assert a forged/copied principal and another auth instance's
   principal are denied.
3. A genuine operator still admits a control; genuine viewer/operator SSE leases
   remain bounded and idempotently releasable.

Use a secret-free immutable returned principal with private provenance, such as
an instance-owned WeakMap. Do not merely make the owner nonenumerable while
leaving it reachable through the public result. This is an internal auth API
privacy/authority requirement, not a claim that a network caller has already
executed arbitrary JavaScript inside the host.

## Positive code boundaries and pending integration

The inspected implementation uses fixed-length timing-safe comparison, finite
public error codes, exact Host/Origin/role checks, mutation JSON framing, duplicate
sensitive-header rejection, no cookie auth, socket-address rather than arbitrary
forwarded-header identity, and separate control/SSE/auth-failure bounds. Existing
tests cover many of those ordinary cases. A finite-body Content-Length check is
not a streaming body limit: actual HTTP tests must still exercise chunked/idle
bodies and the five-second deadline. Every route must call authorization before
stateful handling, use the expected listener scope, and serialize only approved
response shapes. The full host is independently in progress and was not reviewed.

## Small packaging side check

Read only the newly supplied Dockerfile, two ignore files, build.mjs, role TOMLs
and deployment example. No new integration-critical blocker was found in that
static set: deny-by-default build contexts exclude operator state/tests; the
image copies the release bridge, locked runtime dependencies, graph-checked
per-module ESM and built UI; provider has no public service; nonroot/SIGTERM,
explicit placeholders and fixed VM/volume envelope follow FD-22/23. Per-module
compilation correctly preserves imported CLI main guards.

No container build or resource command was run. Real L1/L2 modules were still
absent, so a usable host image was not claimed. Image build/import-safe boot,
UID/GID 1000 volume preparation, exact host config/role-secret wiring and the
one-recorded-Machine deployment procedure remain pending. The private auth Host
must match the observer client's configured internal host:8081, not merely the
listener alias; public configured Host/Origin remains the coordinator HTTPS
origin across Fly TLS termination.

## New-hash A01–A03 re-review: accepted narrow correction

On 2026-09-11, auth source
`7ab7eae75af1efed7cc22fe562a4220c6549fb1ec3134dca3d95b43efb038c73`
and test
`ebd9de868dd3d048a2f01549c37d66bc12335e24c8823a9f54921981d7c6b587`
remained unchanged through independent exact A01–A03 re-probes. All pass:
observer-only provider configuration and canonical private replay cursors;
secret-free immutable principal fields with private instance provenance;
viewer/forged/foreign principal denial, genuine operator admission and bounded
idempotently released SSE leases. The owner auth test also passes.

This supersedes the three original auth correction requests only. Actual HTTP
integration was then inspected separately and has concrete startup, sanitation,
replay/admission and cleanup failures recorded in
[the frozen L2 review](agent-demo-l2-review-2026-09-11.md). The auth correction
does not establish whole-host or deployment acceptance.
