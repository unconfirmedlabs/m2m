/** Rendered layout regression against the compiled production UI.
 * Explicit coherent test HTTP session only; no live model, identity or money.
 * A visible fixture banner is injected by the test, never by production code.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPublicSessionFixture } from '../tests/agent-demo/public-session.ts';

if (process.argv.length > 2) throw Error('fixture_test_takes_no_arguments');
const uiRoot = fileURLToPath(new URL('../ui/agent-demo/', import.meta.url));
const uiRequire = createRequire(new URL('../ui/agent-demo/package.json', import.meta.url));
const { build } = await import(pathToFileURL(uiRequire.resolve('vite')));
const { chromium } = uiRequire('playwright');
const result = await build({ root: uiRoot, mode: 'production', logLevel: 'silent', build: { write: false } });
const outputs = (Array.isArray(result) ? result : [result]).flatMap(value => value.output);
const assets = new Map(outputs.map(output => [output.fileName, Buffer.from(output.type === 'chunk' ? output.code : output.source)]));
const fixture = createPublicSessionFixture();
const token = 'TEST_ONLY_LAYOUT_TOKEN';
let apiRequests = 0;
let mutationRequests = 0;
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) {
    apiRequests += 1;
    if (request.method !== 'GET') { mutationRequests += 1; response.writeHead(405); response.end(); return; }
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401); response.end(); return; }
    if (url.pathname === '/api/v1/session' || url.pathname === '/api/v1/status') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(url.pathname.endsWith('/session')
        ? { version: 1, access: 'viewer', snapshot: fixture.snapshot }
        : { version: 1, conversation: fixture.snapshot.conversation, high_water: fixture.snapshot.projection_sequence, snapshot: fixture.snapshot })); return;
    }
    if (url.pathname === '/api/v1/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      response.end(fixture.events.map(event => `event: agent_event\nid: ${fixture.snapshot.conversation}:${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      return;
    }
    response.writeHead(404); response.end(); return;
  }
  const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const bytes = assets.get(name);
  if (!bytes || request.method !== 'GET') { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
  response.end(bytes);
});
let browser;
try {
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const address = server.address(); assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const cached = '/home/bl/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
  browser = await chromium.launch({ headless: true, ...(existsSync(cached) ? { executablePath: cached } : {}) });
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  const external = [];
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    external.push(true); return route.abort();
  });
  await page.goto(origin);
  await page.getByLabel('Viewer or operator token').fill(token);
  await page.getByRole('button', { name: 'Open live session' }).click();
  await page.getByText(fixture.expected.research_text, { exact: true }).waitFor();
  await page.evaluate(notice => {
    const banner = document.createElement('div'); banner.textContent = notice;
    banner.dataset.testFixtureBanner = 'true';
    Object.assign(banner.style, { position: 'fixed', bottom: '0', left: '0', right: '0', zIndex: '9999', background: '#17202a', color: 'white', padding: '8px', textAlign: 'center' });
    document.body.appendChild(banner);
  }, 'TEST FIXTURE — no live agents or payments');
  const measured = [];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    measured.push(await page.evaluate(() => {
      const panels = [...document.querySelectorAll('.panel')];
      return { width: window.innerWidth, document_width: document.documentElement.scrollWidth,
        fixture_banner: document.querySelector('[data-test-fixture-banner]')?.textContent,
        panels: panels.map(panel => {
          const panelRect = panel.getBoundingClientRect();
          const pill = panel.querySelector('.connection-pill');
          if (!pill) return { missing_pill: true };
          const pillRect = pill.getBoundingClientRect();
          const heading = panel.querySelector('h2');
          const headingRect = heading?.getBoundingClientRect();
          const inside = rect => rect.left >= Math.max(panelRect.left, 0) - 1 && rect.right <= Math.min(panelRect.right, innerWidth) + 1;
          const overlap = headingRect && Math.min(headingRect.right, pillRect.right) - Math.max(headingRect.left, pillRect.left) > 1
            && Math.min(headingRect.bottom, pillRect.bottom) - Math.max(headingRect.top, pillRect.top) > 1;
          return { name: heading?.textContent, panel_right: panelRect.right, pill_right: pillRect.right,
            pill_inside: inside(pillRect), heading_inside: Boolean(headingRect && inside(headingRect)),
            heading_overlaps_pill: Boolean(overlap) };
        }) };
    }));
  }
  console.log(JSON.stringify({ mode: 'explicit-browser-layout-fixture', measured, api_requests: apiRequests,
    mutation_requests: mutationRequests, live_backend: false, live_inference: false, payments: false }));
  assert.equal(mutationRequests, 0); assert.equal(external.length, 0);
  for (const view of measured) {
    assert.equal(view.fixture_banner, 'TEST FIXTURE — no live agents or payments');
    assert.equal(view.panels.length, 2);
    assert(view.document_width <= view.width, 'document overflows viewport');
    for (const panel of view.panels) {
      assert(panel.pill_inside, `${view.width}px Iroh status is clipped beyond its panel or viewport`);
      assert(panel.heading_inside, `${view.width}px Agent name is clipped`);
      assert(!panel.heading_overlaps_pill, `${view.width}px Agent name overlaps Iroh status`);
    }
  }
} finally {
  await browser?.close();
  server.closeAllConnections();
  if (server.listening) await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
}
