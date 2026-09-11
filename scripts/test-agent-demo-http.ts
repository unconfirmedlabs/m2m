import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicSessionFixture } from '../tests/agent-demo/public-session.js';
import { DemoProjection } from './agent-demo-projection.js';
import { openDemoHttp } from './agent-demo-server.js';
import type { DemoControlRecord, DemoRuntimeHandle, SourceCursor } from './demo-types.js';

async function freePort(): Promise<number> {
  const probe = http.createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address(); assert(address && typeof address !== 'string'); const port = address.port; await new Promise<void>(resolve => probe.close(() => resolve())); return port;
}

async function run(): Promise<void> {
  const fixture = createPublicSessionFixture(); const root = await mkdtemp(join(tmpdir(), 'm2m-demo-http-')); const projectionDir = join(root, 'projection'); const staticDir = join(root, 'static'); await mkdir(staticDir); await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>demo</title>');
  const controls = new Map<string, DemoControlRecord>(); let closed = false;
  const runtime = {
    role: 'coordinator' as const, conversation: fixture.pins.conversation,
    publication: () => ({ version: 1 as const, state: 'ready' as const, cursor: { coordinator: '4', research: '0', host: '12' }, code: null }),
    status: () => fixture.snapshot.roles.coordinator,
    selectedChannel: () => fixture.snapshot.selected_channel,
    availableControls: () => fixture.snapshot.available_controls,
    submit: async (control: DemoRuntimeHandle['submit'] extends (value: infer T) => Promise<unknown> ? T : never) => {
      const record: DemoControlRecord = { version: 1, id: control.id, command: control.command, state: 'accepted', code: null, accepted_at_ms: '1', updated_at_ms: '1', task: control.command.op === 'task' ? control.id : null, channel: fixture.snapshot.selected_channel };
      controls.set(control.id, record); return record;
    },
    control: (id: string) => controls.get(id),
    events: (_after: SourceCursor) => ({ version: 1 as const, conversation: fixture.pins.conversation, source: 'coordinator' as const, events: fixture.events.filter(item => item.source === 'coordinator').map(item => item.event), high_water: { coordinator: '4', research: '0', host: '12' }, has_more: false }),
    subscribe: () => () => {}, economy: () => fixture.snapshot.channels, identities: () => fixture.snapshot.identities,
    evidence: async (channel: string) => ({ version: 1 as const, conversation: fixture.pins.conversation, channel, offer: fixture.snapshot.channels[0].offer, policy: fixture.snapshot.channels[0].policy, credits: [], checkpoints: [], terminal_receipts: [], economy: fixture.snapshot.channels[0] }),
    locator: () => null, shutdown: async () => { closed = true; },
  } satisfies DemoRuntimeHandle;
  const prepopulate = await DemoProjection.open({ stateDir: projectionDir, create: true, conversation: fixture.pins.conversation, pins: fixture.pins });
  for (const item of fixture.events) await prepopulate.ingest(item); await prepopulate.close();
  const port = await freePort(); const viewer = '11'.repeat(32), operator = '22'.repeat(32), observer = '33'.repeat(32); const origin = `https://127.0.0.1:${port}`;
  const app = await openDemoHttp({ runtime, config: fixture.pins.config, projectionStateDir: projectionDir, createProjection: false, publicOrigin: origin, bindHost: '127.0.0.1', port, viewerToken: viewer, operatorToken: operator, observerToken: observer, providerBaseUrl: 'http://provider.internal:8081', staticDir, network: 'localnet' });
  try {
    const session = await fetch(`http://127.0.0.1:${port}/api/v1/session`, { headers: { Authorization: `Bearer ${viewer}` } }); assert.equal(session.status, 200); const sessionBody = await session.json() as { access: string; snapshot: { projection_sequence: string } }; assert.equal(sessionBody.access, 'viewer'); assert.equal(sessionBody.snapshot.projection_sequence, String(fixture.events.length));
    const status = await fetch(`http://127.0.0.1:${port}/api/v1/status`, { headers: { Authorization: `Bearer ${operator}` } }); assert.equal(status.status, 200);
    const id = '44'.repeat(32); const control = { version: 1, id, command: { op: 'task', prompt: 'unseen question' } };
    const mutation = await fetch(`http://127.0.0.1:${port}/api/v1/controls`, { method: 'POST', headers: { Authorization: `Bearer ${operator}`, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(control) }); assert.equal(mutation.status, 202); assert.equal((await mutation.json() as { record: { id: string } }).record.id, id);
    const record = await fetch(`http://127.0.0.1:${port}/api/v1/controls/${id}`, { headers: { Authorization: `Bearer ${viewer}` } }); assert.equal(record.status, 200);
    const privateText = await fetch(`http://127.0.0.1:${port}/api/v1/session?token=${viewer}`, { headers: { Authorization: `Bearer ${viewer}` } }); assert.equal(privateText.status, 404);
    const denied = await fetch(`http://127.0.0.1:${port}/api/v1/session`, { headers: { Authorization: 'Bearer ' + 'ff'.repeat(32) } }); assert.equal(denied.status, 401); assert.doesNotMatch(await denied.text(), /ff{32}/);
    const asset = await fetch(`http://127.0.0.1:${port}/`); assert.equal(asset.status, 200); assert.match(await asset.text(), /demo/);
    const unknown = await fetch(`http://127.0.0.1:${port}/api/v1/nope`); assert.equal(unknown.status, 404); assert.match(await unknown.text(), /not_found/);
    const stream = await fetch(`http://127.0.0.1:${port}/api/v1/events`, { headers: { Authorization: `Bearer ${viewer}`, 'Last-Event-ID': `${fixture.pins.conversation}:0` } }); assert.equal(stream.status, 200); const reader = stream.body!.getReader(); const first = await reader.read(); assert(first.value); assert.match(new TextDecoder().decode(first.value), /stream_status/); await reader.cancel();
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  assert.equal(closed, false);
  process.stdout.write('agent demo HTTP tests: ok\n');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
