import { test, expect } from 'playwright/test';
import { sse, conversation } from '../dashboard-fixture.js';
import { createPublicSessionFixture } from '../../../../tests/agent-demo/public-session.js';

test('production entrypoint presents authenticated gate without fixture fallback', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Research that can show its receipts/i })).toBeVisible();
  await expect(page.getByLabel('Viewer or operator token')).toBeVisible();
  await expect(page.getByText(/TEST FIXTURE/)).toHaveCount(0);
});

test('authenticated dashboard replays delivery and accounting at desktop and mobile widths', async ({ page }) => {
  const session = createPublicSessionFixture(); const view = session.snapshot;
  await page.route('**/api/v1/**', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.pathname.endsWith('/session')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 1, access: 'operator', snapshot: view }) });
    if (url.pathname.endsWith('/status')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 1, conversation: view.conversation, high_water: view.projection_sequence, snapshot: view }) });
    if (url.pathname.endsWith('/events')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(session.events) });
    if (url.pathname.endsWith('/controls') && request.method() === 'POST') return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ version: 1, record: { version: 1, id: JSON.parse(request.postData() ?? '{}').id, command: JSON.parse(request.postData() ?? '{}').command, state: 'completed', code: null, accepted_at_ms: '1', updated_at_ms: '2', task: null, channel: null } }) });
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ version: 1, code: 'not_found' }) });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByLabel('Viewer or operator token').fill('fixture-token');
  await page.getByRole('button', { name: 'Open live session' }).click();
  await expect(page.getByText(session.expected.coordinator_text)).toBeVisible();
  await expect(page.getByText(session.expected.research_text)).toBeVisible();
  await expect(page.getByText('Funding terms')).toBeVisible();
  await page.evaluate(() => { const banner = document.createElement('div'); banner.textContent = 'TEST FIXTURE — no live agents or payments'; banner.setAttribute('data-test-fixture-banner', 'true'); Object.assign(banner.style, { position: 'fixed', bottom: '0', left: '0', right: '0', zIndex: '9999', padding: '8px', textAlign: 'center', background: '#17202a', color: 'white', fontSize: '12px' }); document.body.appendChild(banner); });
  await expect(page.getByText('TEST FIXTURE — no live agents or payments')).toBeVisible();
  await page.screenshot({ path: '/tmp/m2m-agent-demo-dashboard-1440.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Nozomi research desk' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: '/tmp/m2m-agent-demo-dashboard-390.png', fullPage: true });
  void conversation;
});

test('failed control POST is retried with the exact pending intent', async ({ page }) => {
  const session = createPublicSessionFixture(); const view = structuredClone(session.snapshot); view.available_controls = ['task']; let postCount = 0; const ids: string[] = [];
  await page.route('**/api/v1/**', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.pathname.endsWith('/session')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 1, access: 'operator', snapshot: view }) });
    if (url.pathname.endsWith('/status')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 1, conversation: view.conversation, high_water: view.projection_sequence, snapshot: view }) });
    if (url.pathname.endsWith('/events')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(session.events) });
    if (url.pathname.endsWith('/controls') && request.method() === 'POST') {
      const body = JSON.parse(request.postData() ?? '{}') as { id: string; command: unknown }; ids.push(body.id); postCount += 1;
      if (postCount === 1) return route.abort('failed');
      return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ version: 1, record: { version: 1, id: body.id, command: body.command, state: 'completed', code: null, accepted_at_ms: '1', updated_at_ms: '2', task: null, channel: null } }) });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ version: 1, code: 'not_found' }) });
  });
  await page.goto('/'); await page.getByLabel('Viewer or operator token').fill('fixture-token'); await page.getByRole('button', { name: 'Open live session' }).click();
  await expect(page.getByRole('heading', { name: 'Submit one research turn' })).toBeVisible();
  await page.getByLabel('Research prompt (forwarded exactly)').fill('retry this exact user prompt');
  await page.getByRole('button', { name: 'Submit turn' }).click();
  await expect(page.getByRole('alert')).toContainText('network_unavailable');
  await page.getByRole('button', { name: 'Submit turn' }).click();
  await expect(page.getByText(/Operation/)).toBeVisible();
  expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]);
});
