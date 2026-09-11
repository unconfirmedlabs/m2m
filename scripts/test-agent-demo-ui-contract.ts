/** Root-owned UI boundary regressions. Explicit fixtures only: no HTTP,
 * credentials, model, Iroh, chain, or browser integration is exercised here.
 */
import assert from 'node:assert/strict';
import { DemoApi } from '../ui/agent-demo/src/api.js';
import { applyDemoEvent, initialUiState, replaceSnapshot } from '../ui/agent-demo/src/reducer.js';
import { deriveEconomy } from '../ui/agent-demo/src/accounting.js';
import type { DemoEconomy, DemoEvent } from './demo-types.js';
import { createPublicSessionFixture } from '../tests/agent-demo/public-session.js';

if (process.argv.length > 2) throw Error('fixture_test_takes_no_arguments');

const publicFixture = createPublicSessionFixture();
const conversation = publicFixture.pins.conversation;
const initial = () => initialUiState(publicFixture.snapshot);
const cursor = { coordinator: '0', research: '0', host: '0' };
function event(sequence: string, source: DemoEvent['source'] = 'coordinator', id = sequence): DemoEvent {
  return { version: 1, sequence, source, event: {
    version: 1, id, conversation, role: source === 'coordinator' ? 'coordinator' : 'research', request: null,
    at_ms: '1', type: 'model_text', data: { text: 'TEST FIXTURE public text' },
  } };
}
function frame(value: DemoEvent, id = `${conversation}:${value.sequence}`): string {
  return `event: agent_event\r\nid: ${id}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
}
async function consume(payload: string, bytewise: boolean) {
  const encoded = new TextEncoder().encode(payload);
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    if (bytewise) for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(encoded);
    controller.close();
  } });
  const api = new DemoApi('', async input => String(input).endsWith('/session')
    ? new Response(JSON.stringify({ version: 1, access: 'viewer', snapshot: publicFixture.snapshot })) : new Response(body, {
    status: 200, headers: { 'Content-Type': 'text/event-stream' },
  }));
  api.authenticate('fixture-only-token');
  await api.session();
  const received: DemoEvent[] = [], states: string[] = [];
  await api.subscribe(cursor, value => received.push(value), state => states.push(state),
    undefined, `${conversation}:0`).done;
  api.logout();
  return { received, states };
}

const checks: Array<[string, () => void | Promise<void>]> = [
  ['FD-17 projection gaps cannot advance browser high water', () => {
    const first = applyDemoEvent(initial(), event('1'));
    const next = applyDemoEvent(first, event('3', 'coordinator', '2'));
    assert.equal(next.browser, 'failed');
    assert.equal(next.lastSequence, '1');
  }],
  ['FD-17 same projection sequence cannot name a different source record', () => {
    const first = applyDemoEvent(initial(), event('1'));
    const next = applyDemoEvent(first, event('1', 'provider'));
    assert.equal(next.browser, 'failed');
    assert.equal(next.events.length, 1);
  }],
  ['FD-15 provider output is not buyer-verified delivery', () => {
    const input = event('1', 'provider');
    input.event.type = 'delivery'; input.event.role = 'research';
    input.event.request = 'd'.repeat(64);
    input.event.data = { output: [...new TextEncoder().encode('unverified provider bytes')] };
    const next = applyDemoEvent(initial(), input);
    assert.equal(next.transcript.filter(item => item.kind === 'delivery').length, 0);
    assert.equal(Object.keys(next.deliveries).length, 0);
  }],
  ['FD-19 nonempty or unknown funds retain exposure despite a terminal label', () => {
    // Only fields read by this pure accounting helper are fixture inputs.
    const input = {
      status: 'closed', terminal: { state: 'confirmed', digest: '1'.repeat(43), gas: null },
      policy: { rates: ['1', '0'], denominator: '1' }, delivered_units: ['850', '0'],
      delivered_mist: '850', signed_authorized_mist: '900', reserved_mist: '900',
      redeemed_mist: '850', locked_mist: '1', offer: { payload: { deposit: '12000' } },
    } as DemoEconomy;
    for (const locked_mist of ['1', null]) {
      const actual = deriveEconomy({ ...input, locked_mist });
      assert.equal(actual.outstanding, '50');
      assert.equal(actual.reservedExposure, '50');
      assert.equal(actual.refund, null);
    }
  }],
  ['FD-17 CRLF split across network chunks preserves the complete SSE frame', async () => {
    const result = await consume(frame(event('1')), true);
    assert.deepEqual(result.received.map(value => value.sequence), ['1']);
  }],
  ['FD-17 SSE frame ID and payload sequence must agree', async () => {
    const result = await consume(frame(event('1'), `${conversation}:2`), false);
    assert.equal(result.received.length, 0);
    assert.ok(result.states.includes('failed'));
  }],
  ['FD-17 malformed durable event stops replay instead of skipping ahead', async () => {
    const result = await consume(`event: agent_event\nid: ${conversation}:1\ndata: {bad json}\n\n${frame(event('2'))}`, false);
    assert.equal(result.received.length, 0);
    assert.ok(result.states.includes('failed'));
  }],
  ['FD-15 forbidden provider delivery fails without advancing the cursor', () => {
    const fixture = createPublicSessionFixture();
    const input = structuredClone(fixture.events.find(e => e.event.type === 'delivery')!);
    input.source = 'provider'; input.sequence = '1'; input.event.id = '1';
    const next = applyDemoEvent(initialUiState(fixture.snapshot), input);
    assert.equal(next.browser, 'failed');
    assert.equal(next.lastSequence, '0');
    assert.equal(next.events.length, 0);
  }],
  ['FD-17 projection failure stays latched until explicit recovery', () => {
    const first = applyDemoEvent(initial(), event('1'));
    const failed = applyDemoEvent(first, event('3', 'coordinator', '2'));
    assert.equal(failed.browser, 'failed');
    const later = applyDemoEvent(failed, event('2'));
    assert.equal(later.lastSequence, '1');
    assert.deepEqual(later.events, first.events);
  }],
  ['FD-17 snapshot history does not animate old activity', () => {
    const fixture = createPublicSessionFixture();
    const next = applyDemoEvent(initialUiState(fixture.snapshot), fixture.events[0]);
    assert.equal(next.lastSequence, '1', 'history still advances its replay cursor');
    assert.equal(next.newActivity, false, 'already included historical work is not new activity');
    assert.equal(next.refreshRequested, false);
  }],
  ['FD-17 refreshed snapshot cannot replace pinned conversation or configuration', () => {
    const fixture = createPublicSessionFixture();
    const first = initialUiState(fixture.snapshot);
    for (const key of ['conversation', 'configuration_hash'] as const) {
      const wrong = structuredClone(fixture.snapshot); wrong[key] = 'fe'.repeat(32);
      let rejected = false;
      try {
        const next = replaceSnapshot(first, wrong);
        rejected = next.browser === 'failed' && next.snapshot?.[key] === fixture.snapshot[key];
      } catch { rejected = true; }
      assert.equal(rejected, true, `wrong ${key} cannot become a valid snapshot`);
    }
  }],
  ['FD-19 empty funds without known paid/digest/observation retain exposure', () => {
    const fixture = createPublicSessionFixture();
    const input: DemoEconomy = { ...fixture.snapshot.channels[0], status: 'closed', locked_mist: '0',
      terminal: { state: 'confirmed', digest: null, gas: null } };
    const actual = deriveEconomy(input);
    assert.equal(actual.outstanding, '12');
    assert.equal(actual.reservedExposure, '12');
    assert.equal(actual.refund, null);
  }],
  ['FD-15 valid split UTF-8 delivery is not malformed before terminal receipt', () => {
    const fixture = createPublicSessionFixture();
    let state = initialUiState(fixture.snapshot);
    for (const input of fixture.events) {
      state = applyDemoEvent(state, input);
      if (input.event.type !== 'delivery') continue;
      const stream = state.deliveries[input.event.request!];
      assert.ok(stream);
      assert.equal(stream.malformed, false, 'an incomplete scalar is retained between valid chunks');
    }
    assert.equal(state.deliveries[fixture.receipt.request].text, fixture.expected.research_text);
  }],
];

let failed = 0;
for (const [name, check] of checks) {
  try { await check(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : 'assertion_failed'}`); }
}
assert.equal(failed, 0, `${failed} UI boundary regressions remain (fixtures only)`);
