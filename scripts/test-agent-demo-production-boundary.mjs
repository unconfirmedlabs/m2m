/** Production UI build + real Chromium/loopback HTTP negative-boundary test.
 * No dashboard fixture, model, wallet, payment, external request or live claim.
 * Uses the installed UI lockfile dependencies; never downloads a browser.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.argv.length > 2) throw Error('boundary_test_takes_no_arguments');
const root = fileURLToPath(new URL('../', import.meta.url));
const uiRoot = resolve(root, 'ui/agent-demo');
const uiRequire = createRequire(new URL('../ui/agent-demo/package.json', import.meta.url));
const { build, version: viteVersion } = await import(pathToFileURL(uiRequire.resolve('vite')));
const { chromium } = uiRequire('playwright');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const allowedApplication = new Set([
  'ui/agent-demo/index.html', 'ui/agent-demo/src/main.tsx',
  'ui/agent-demo/src/App.tsx', 'ui/agent-demo/src/api.ts',
  'ui/agent-demo/src/reducer.ts', 'ui/agent-demo/src/accounting.ts',
  'ui/agent-demo/src/contract.ts',
  'ui/agent-demo/src/styles.css', 'scripts/agent-demo-event-contract.ts',
]);
const allowedVirtual = new Set(['\0rolldown/runtime.js', '\0vite/modulepreload-polyfill.js']);
const allowedDependency = /^ui\/agent-demo\/node_modules\/(react|react-dom|scheduler)\//;
const forbiddenText = [
  'createPublicSessionFixture', 'economic-session.json', 'dashboard-fixture',
  'fixture-token', 'TEST FIXTURE', 'TEST_SENTINEL', 'fixture-harness',
  'suiprivkey', 'OPENAI_API_KEY', 'BRAVE_API_KEY', 'native-testnet-state',
];

function checkedModule(id) {
  if (allowedVirtual.has(id)) return id;
  assert(!id.includes('\0') && isAbsolute(id), 'unexpected virtual or external runtime module');
  const path = realpathSync(id);
  const name = relative(root, path);
  assert(allowedApplication.has(name) || allowedDependency.test(name), 'unapproved production runtime module');
  return name;
}

// Fail closed on a fixture/private runtime dependency, including symlink targets.
assert.throws(() => checkedModule(resolve(root, 'tests/agent-demo/public-session.ts')));
assert.throws(() => checkedModule(resolve(root, 'scripts/native-chain.ts')));
assert.throws(() => checkedModule('node:fs'));
assert.throws(() => checkedModule('\0unreviewed-virtual-module'));

const observedInputs = new Map([...allowedApplication]
  .filter(name => existsSync(resolve(root, name)))
  .map(name => [name, digest(readFileSync(resolve(root, name)))]));
const buildInputs = new Map(['vite.config.ts', 'package.json', 'package-lock.json']
  .map(name => [name, digest(readFileSync(resolve(uiRoot, name)))]));
let publicDir;
const result = await build({
  root: uiRoot, mode: 'production', logLevel: 'silent',
  // Keep actual production config, plugins and output options. Only suppress
  // artifact writes; do not silently disable an enabled source-map/fixture option.
  build: { write: false },
  plugins: [{ name: 'm2m-observe-production-config', configResolved(config) { publicDir = config.publicDir; } }],
});
// Vite copies publicDir verbatim on disk builds; those files are not necessarily
// present in the returned in-memory chunks. This demo currently needs none.
function checkPublicAssets(path) {
  if (!path || !existsSync(path)) return;
  assert(!lstatSync(path).isSymbolicLink(), 'public asset symlink is not allowed');
  assert(lstatSync(path).isDirectory(), 'unreviewed copied public asset');
  for (const entry of readdirSync(path)) checkPublicAssets(resolve(path, entry));
}
checkPublicAssets(publicDir);
const outputs = (Array.isArray(result) ? result : [result]).flatMap(value => value.output);
assert(outputs.length > 0, 'production build emitted no assets');
const artifacts = new Map();
const modules = new Set();
for (const output of outputs) {
  const name = output.fileName;
  assert(name === 'index.html' || /^assets\/[A-Za-z0-9_-]+\.(js|css)$/.test(name), 'unexpected production asset');
  assert(!artifacts.has(name), 'duplicate production asset');
  const bytes = Buffer.from(output.type === 'chunk' ? output.code : output.source);
  const body = bytes.toString('utf8');
  assert(!body.includes('sourceMappingURL'), 'production source map reference');
  for (const sentinel of forbiddenText) assert(!body.includes(sentinel), 'fixture/private sentinel in production output');
  artifacts.set(name, bytes);
  if (output.type === 'chunk') {
    assert.equal(output.map, null, 'production source map');
    assert.equal(output.sourcemapFileName, null, 'production source map filename');
    for (const id of output.moduleIds) modules.add(checkedModule(id));
    for (const id of Object.keys(output.modules)) modules.add(checkedModule(id));
  }
}
assert(artifacts.has('index.html'));
for (const output of outputs.filter(item => item.type === 'chunk')) {
  for (const imported of [...output.imports, ...output.dynamicImports]) {
    // Output import filenames are bundle-relative in the installed Rolldown API.
    assert(artifacts.has(imported) || artifacts.has(resolve('/', dirname(output.fileName), imported).slice(1)),
      'external production chunk import');
  }
}
for (const required of ['ui/agent-demo/src/main.tsx', 'ui/agent-demo/src/App.tsx', 'ui/agent-demo/src/api.ts']) {
  assert(modules.has(required), 'actual production entrypoint/API missing');
}
for (const name of observedInputs.keys()) if (!modules.has(name)) observedInputs.delete(name);

// Record exact input bytes when stable; never claim evidence for a source that
// another owner edited during this build. No source contents are printed.
for (const [name, sha] of observedInputs) {
  assert.equal(digest(readFileSync(resolve(root, name))), sha, 'production input changed during build');
}
for (const [name, sha] of buildInputs) assert.equal(digest(readFileSync(resolve(uiRoot, name))), sha, 'production build configuration changed');

const token = 'TEST_ONLY_PRODUCTION_BOUNDARY_TOKEN';
const cases = [
  { name: 'unavailable-json', status: 503, type: 'application/json', body: '{"version":1,"code":"backend_unavailable"}' },
  { name: 'missing-html', status: 404, type: 'text/html', body: '<h1>TEST_ONLY_BACKEND_ABSENT</h1>' },
  { name: 'unavailable-malformed', status: 503, type: 'application/json', body: '{invalid' },
  { name: 'unauthorized-html', status: 401, type: 'text/html', body: '<h1>TEST_ONLY_BACKEND_UNAUTHORIZED</h1>' },
  { name: 'connection-lost', drop: true },
  { name: 'untrusted-backend-code', status: 503, type: 'application/json',
    body: '{"version":1,"code":"TEST_ONLY_BACKEND_PRIVATE_DETAILS"}' },
];
let activeCase = cases[0];
const requests = [];
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/internal/')) {
    requests.push({ method: request.method, path: url.pathname,
      no_query: url.search === '', no_cookie: request.headers.cookie === undefined,
      expected_bearer: request.headers.authorization === `Bearer ${token}` });
    if (activeCase.drop) { request.socket.destroy(); return; }
    response.writeHead(activeCase.status, { 'Content-Type': activeCase.type, 'Cache-Control': 'no-store' });
    response.end(activeCase.body); return;
  }
  const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const bytes = artifacts.get(name);
  if (request.method !== 'GET' || !bytes || url.search) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
  response.end(bytes);
});
let browser;
const checks = [];
try {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const cached = '/home/bl/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
  browser = await chromium.launch({ headless: true, ...(existsSync(cached) ? { executablePath: cached } : {}) });
  for (const item of cases) {
    activeCase = item;
    requests.length = 0;
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      const external = [];
      await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        external.push(true); return route.abort();
      });
      await context.addCookies([{ name: 'test_only_cookie', value: 'must_not_reach_api', url: origin }]);
      const page = await context.newPage();
      await page.addInitScript(() => {
        globalThis.__m2mBoundaryCspFailures = 0;
        document.addEventListener('securitypolicyviolation', () => { globalThis.__m2mBoundaryCspFailures += 1; });
      });
      page.setDefaultTimeout(5000);
      const pageErrors = [];
      page.on('pageerror', () => pageErrors.push(true));
      await page.goto(origin, { waitUntil: 'networkidle' });
      assert.equal(requests.length, 0, 'login gate made a backend request before authentication');
      await page.getByLabel('Viewer or operator token').fill(token);
      await page.getByRole('button', { name: 'Open live session' }).click();
      await page.getByRole('alert').waitFor({ state: 'visible' });
      await page.waitForLoadState('networkidle');
      const error = await page.getByRole('alert').textContent();
      assert(typeof error === 'string' && error.length > 0 && error.length <= 128);
      assert(!error.includes(token) && !error.includes('TEST_ONLY_BACKEND'), 'raw backend/token text escaped into error');
      if (item.name === 'unavailable-json') assert.equal(error, 'backend_unavailable');
      assert.equal(await page.getByRole('heading', { name: 'Nozomi research desk' }).count(), 0, 'backend failure fabricated dashboard');
      assert.equal(await page.getByRole('button', { name: 'Fund displayed terms' }).count(), 0);
      assert.equal(await page.getByLabel('Viewer or operator token').count(), 1);
      assert.equal(await page.evaluate(() => globalThis.__m2mBoundaryCspFailures), 0, 'production asset violated the required CSP');
      assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 });
      assert.equal(requests.length, 1, 'failed login triggered replay, control, automatic retry or fallback');
      assert.deepEqual(requests[0], { method: 'GET', path: '/api/v1/session', no_query: true, no_cookie: true, expected_bearer: true });
      await page.reload({ waitUntil: 'networkidle' });
      assert.equal(await page.getByLabel('Viewer or operator token').inputValue(), '');
      assert.equal(requests.length, 1, 'reload reused failed authentication');
      assert.equal(external.length, 0, 'production UI tried external networking');
      assert.equal(pageErrors.length, 0, 'production UI threw an uncaught exception');
      checks.push({ name: item.name, pass: true, api_requests: requests.length, error_code: error });
    } finally { await context.close(); }
  }
  for (const [name, sha] of observedInputs) {
    assert.equal(digest(readFileSync(resolve(root, name))), sha, 'production input changed during browser checks');
  }
  for (const [name, sha] of buildInputs) assert.equal(digest(readFileSync(resolve(uiRoot, name))), sha, 'production build configuration changed');
  checkPublicAssets(publicDir);
  console.log(JSON.stringify({ mode: 'production-build-negative-backend-test', vite: viteVersion,
    playwright: uiRequire('playwright/package.json').version,
    build_inputs: Object.fromEntries(buildInputs),
    modules: [...modules].sort(), inputs: Object.fromEntries([...observedInputs].sort()),
    artifacts: [...artifacts].map(([file, bytes]) => ({ file, bytes: bytes.length, sha256: digest(bytes) })), checks,
    live_backend: false, live_inference: false, payments: false }));
} finally {
  await browser?.close();
  server.closeAllConnections();
  if (server.listening) await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
}
