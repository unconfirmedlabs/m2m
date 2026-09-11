/** Real HTTP server + browser API/reducer, explicitly injected fixture runtime.
 * No live inference, Iroh exchange, chain operation or hosted-demo claim.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createPublicSessionFixture } from '../tests/agent-demo/public-session.js';
import { DemoApi } from '../ui/agent-demo/src/api.js';
import { applyDemoEvent, initialUiState } from '../ui/agent-demo/src/reducer.js';
import { openDemoHttp } from './agent-demo-server.js';
import { DemoProjection } from './agent-demo-projection.js';
import type { DemoControlRecord, DemoRuntimeHandle, SourceCursor } from './demo-types.js';

if (process.argv.length > 2) throw Error('fixture_test_takes_no_arguments');
const fixture = createPublicSessionFixture();
const root = await mkdtemp(join(tmpdir(), 'm2m-ui-http-fixture-'));
const cursor: SourceCursor = { coordinator: '0', research: '0', host: '0' };
const source = fixture.events.filter(value => value.source === 'coordinator').map(value => value.event);
for (const event of source) cursor[event.role] = event.id;
const records = new Map<string, DemoControlRecord>();
const runtime: DemoRuntimeHandle = {
  role: 'coordinator', conversation: fixture.pins.conversation,
  publication: () => ({ version: 1, state: 'ready', cursor: structuredClone(cursor), code: null }),
  status: () => structuredClone(fixture.snapshot.roles.coordinator),
  identities: () => structuredClone(fixture.snapshot.identities),
  selectedChannel: () => fixture.snapshot.selected_channel,
  availableControls: () => [...fixture.snapshot.available_controls],
  economy: () => structuredClone(fixture.snapshot.channels),
  events: (after, limit = 256) => {
    const remaining = source.filter(event => BigInt(event.id) > BigInt(after[event.role]));
    return { version: 1, conversation: fixture.pins.conversation, source: 'coordinator', events: structuredClone(remaining.slice(0, limit)), high_water: structuredClone(cursor), has_more: remaining.length > limit };
  },
  subscribe: () => () => {}, locator: () => null, shutdown: async () => {},
  evidence: async () => { throw Error('fixture_evidence_not_used'); },
  submit: async control => {
    const record: DemoControlRecord = { ...structuredClone(control), state: 'accepted', code: null, accepted_at_ms: '1', updated_at_ms: '1', task: null, channel: null };
    records.set(control.id, record); return structuredClone(record);
  },
  control: id => records.has(id) ? structuredClone(records.get(id)!) : undefined,
};
let app: Awaited<ReturnType<typeof openDemoHttp>> | undefined;
let api: DemoApi | undefined;
try {
  const projection = await DemoProjection.open({ stateDir: root, create: true, conversation: fixture.pins.conversation, pins: fixture.pins });
  try { for (const event of fixture.events) await projection.ingest(event); } finally { await projection.close(); }
  const reservation = http.createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address(); assert(address && typeof address !== 'string');
  const port = address.port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const publicOrigin = `https://127.0.0.1:${port}`;
  app = await openDemoHttp({ runtime, config: fixture.pins.config, projectionStateDir: root, createProjection: false, bindHost: '127.0.0.1', port,
    publicOrigin, viewerToken: '11'.repeat(32), operatorToken: '22'.repeat(32), observerToken: '33'.repeat(32), network: 'localnet' });
  // Node fetch does not automatically add the browser's same-origin POST header.
  api = new DemoApi(`http://127.0.0.1:${port}`, (input, init) => fetch(input, { ...init, headers: { ...init?.headers, ...(init?.method === 'POST' ? { Origin: publicOrigin } : {}) } }));
  api.authenticate('22'.repeat(32));
  const session = await api.session(); assert.equal(session.access, 'operator');
  assert.equal((await api.status()).projection_sequence, String(fixture.events.length));
  let state = initialUiState(session.snapshot); const failures: string[] = [];
  const abort = new AbortController();
  const timer = setTimeout(() => { failures.push('test_timeout'); abort.abort(); }, 5_000);
  try {
    await api.subscribe({ coordinator: '0', research: '0', host: '0' }, event => {
      state = applyDemoEvent(state, event);
      if (event.sequence === session.snapshot.projection_sequence) abort.abort();
    }, (status, code) => { if (status === 'failed') failures.push(code ?? 'stream_failed'); }, abort.signal, `${fixture.pins.conversation}:0`).done;
  } finally { clearTimeout(timer); }
  assert.deepEqual(failures, []); assert.notEqual(state.sync, 'failed');
  assert.equal(state.events.length, fixture.events.length);
  assert.equal(state.deliveries[fixture.receipt.request].text, fixture.expected.research_text);
  const control = { version: 1 as const, id: '44'.repeat(32), command: { op: 'disconnect' as const } };
  assert.equal((await api.control(control)).id, control.id);
  assert.deepEqual(await api.controlStatus(control.id, control.command), records.get(control.id));
  assert.equal(records.size, 1);
  console.log(JSON.stringify({ mode: 'explicit-runtime-fixture-real-ui-http', events: state.events.length, controls: records.size, live_inference: false, payments: false }));
} finally { api?.logout(); await app?.close(); await rm(root, { recursive: true, force: true }); }
