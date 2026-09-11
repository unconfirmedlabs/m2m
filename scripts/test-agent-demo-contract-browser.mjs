/** Explicit browser test of the neutral helper, not the production UI/backend.
 * Run with node --import tsx. Requires existing root and UI dev dependencies.
 * Does not download a browser, serve files or allow page network requests.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createPublicSessionFixture } from '../tests/agent-demo/public-session.ts';

if (process.argv.length > 2) throw Error('fixture_test_takes_no_arguments');
const root = fileURLToPath(new URL('../', import.meta.url));
const uiRequire = createRequire(new URL('../ui/agent-demo/package.json', import.meta.url));
const { chromium } = uiRequire('playwright');
const bundle = await build({
  absWorkingDir: root, entryPoints: ['scripts/agent-demo-event-contract.ts'],
  platform: 'browser', format: 'iife', globalName: 'M2MContract',
  bundle: true, write: false, metafile: true, logLevel: 'silent',
});
assert.deepEqual(Object.keys(bundle.metafile.inputs), ['scripts/agent-demo-event-contract.ts']);
const cached = '/home/bl/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const browser = await chromium.launch({ headless: true, ...(existsSync(cached) ? { executablePath: cached } : {}) });
try {
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const fixture = createPublicSessionFixture();
  const result = await page.evaluate(input => {
    const api = globalThis.M2MContract;
    const session = api.validateDemoSessionResponse({ version: 1, access: 'viewer', snapshot: input.snapshot }, input.pins);
    const events = input.events.map(event => api.validateDemoEvent(event, input.pins));
    const cursor = { coordinator: '4', research: '0', host: '12' };
    const roundtrip = api.decodeSourceCursor(api.encodeSourceCursor(cursor));
    let rejected = false;
    try {
      api.validateDemoEvent({ ...input.events[0], event: { ...input.events[0].event,
        data: { ...input.events[0].event.data, private_key: 'TEST_SENTINEL' } } }, input.pins);
    } catch (error) { rejected = error.code === 'invalid_event' && !error.message.includes('TEST_SENTINEL'); }
    const rejects = (code, work) => {
      try { work(); return false; } catch (error) { return error.code === code; }
    };
    const checks = [];
    checks.push({ name: 'session access requires a string enum', pass: rejects('invalid_snapshot', () =>
      api.validateDemoSessionResponse({ version: 1, access: ['operator'], snapshot: input.snapshot }, input.pins)) });
    const forgedOperator = structuredClone(input.events[0]);
    forgedOperator.source = 'provider'; forgedOperator.event.role = 'host';
    forgedOperator.event.type = 'tool_result'; forgedOperator.event.request = '33'.repeat(32);
    forgedOperator.event.data = { name: 'operator.task', call_id: forgedOperator.event.request,
      result: { state: 'completed', text: 'TEST FIXTURE operator result' } };
    checks.push({ name: 'provider cannot emit operator result', pass: rejects('invalid_event', () => api.validateDemoEvent(forgedOperator, input.pins)) });
    const separate = structuredClone(input);
    const returned = api.validateDemoSnapshot(separate.snapshot, separate.pins);
    try { returned.config.price.output_rate = '9'; } catch { /* Frozen detached values also cannot mutate pins. */ }
    checks.push({ name: 'returned snapshot cannot mutate trusted pins', pass: separate.pins.config.price.output_rate === '3' });
    const reserved = structuredClone(input.snapshot), economy = reserved.channels[0];
    economy.reserved_mist = '50'; economy.reserved_exposure_mist = '24';
    economy.budget.authorized_mist = '50'; economy.budget.outstanding_mist = '24'; economy.budget.remaining_mist = '23950';
    let acceptedReservation = false;
    try { const result = api.validateDemoSnapshot(reserved, input.pins); acceptedReservation = result.channels[0].outstanding_mist === '12' && result.channels[0].reserved_exposure_mist === '24'; } catch { /* report below */ }
    checks.push({ name: 'unsigned reservation stays distinct from signed exposure', pass: acceptedReservation });
    const nonfinal = structuredClone(input.events.find(event => event.event.type === 'delivery'));
    nonfinal.event.type = 'channel_final'; nonfinal.event.request = null;
    nonfinal.event.data = { checkpoint: nonfinal.event.data.checkpoint };
    checks.push({ name: 'channel_final requires final checkpoint', pass: rejects('invalid_event', () => api.validateDemoEvent(nonfinal, input.pins)) });
    const inventedRefund = structuredClone(input.snapshot); inventedRefund.channels[0].refunded_mist = '123';
    checks.push({ name: 'absent chain observation cannot carry a refund', pass: rejects('invalid_snapshot', () => api.validateDemoSnapshot(inventedRefund, input.pins)) });
    const pageContext = { ...input.pins, source: 'coordinator' };
    const completePage = { version: 1, conversation: input.snapshot.conversation,
      source: 'coordinator', events: input.events.filter(event => event.source === 'coordinator').map(event => event.event),
      high_water: input.snapshot.roles.coordinator.cursor, has_more: false };
    // First prove the baseline page is valid; malformed-envelope rejection
    // must not masquerade as coverage of the specific final-page relationship.
    api.validateDemoSourcePage(completePage, pageContext);
    const missingTail = structuredClone(completePage);
    missingTail.high_water.host = '99';
    checks.push({ name: 'final source page must reach present-role high water', pass: rejects('invalid_event', () => api.validateDemoSourcePage(missingTail, pageContext)) });
    return { events: events.length, channel: session.snapshot.selected_channel,
      exposed: session.snapshot.channels[0].outstanding_mist, roundtrip, rejected, checks,
      nodeBuffer: typeof globalThis.Buffer, nodeProcess: typeof globalThis.process };
  }, fixture);
  assert.equal(result.events, fixture.events.length);
  assert.equal(result.channel, fixture.snapshot.selected_channel);
  assert.equal(result.exposed, '12');
  assert.equal(result.rejected, true);
  assert.equal(result.nodeBuffer, 'undefined');
  assert.equal(result.nodeProcess, 'undefined');
  assert.deepEqual(result.roundtrip, { coordinator: '4', research: '0', host: '12' });
  console.log(JSON.stringify({ mode: 'explicit-browser-fixture',
    bundle_inputs: Object.keys(bundle.metafile.inputs), bundle_bytes: bundle.outputFiles[0].contents.length, ...result }));
  assert.deepEqual(result.checks.filter(check => !check.pass).map(check => check.name), [], 'browser contract regressions remain');
} finally { await browser.close(); }
