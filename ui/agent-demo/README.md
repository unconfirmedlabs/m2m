# m2m live agent demo UI

This is the production browser surface for the authenticated `/api/v1` demo
service. It uses React, TypeScript, Vite, and Tailwind's official Vite plugin.
The UI has no fixture mode, sample data, query-parameter backend switch, wallet,
model, or search credential. A missing or unavailable backend stays visible as
an authentication/error/unknown state.

The browser stores the bearer token only in memory. It uses same-origin
authenticated `fetch`, `credentials: omit`, strict finite responses, streamed
SSE replay with `Last-Event-ID`, and durable command IDs. Public text is rendered
as text; source links are accepted only when they are HTTPS URLs and open with
`noopener noreferrer`.

## Local commands

```sh
npm ci
npm test
npm run build
npm run smoke   # requires the cached/local Playwright Chromium
```

The fixture wrapper under `tests/fixture-harness.tsx` is test-only and displays
`TEST FIXTURE — no live agents or payments`. The production `src/main.tsx` does
not import it. `tests/` consumes the shared `tests/agent-demo/accounting-vectors.json`
through the real accounting and event reducers, including exact BigInt pricing,
cumulative authorization replacement, confirmed settlement exposure, split
UTF-8 delivery and source identity collision cases.

The API server and provider projection are separate implementation slices. This
package does not claim live model, Iroh, Sui, Fly, or payment evidence by itself.
