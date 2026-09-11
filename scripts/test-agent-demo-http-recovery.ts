/** Focused H01-H06 regressions at the actual openDemoHttp seam.
 * All inputs are local fixture records; this does not claim live L1/model/Iroh/Sui/Fly behavior.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicSessionFixture } from '../tests/agent-demo/public-session.js';
import { encodeSourceCursor } from './agent-demo-event-contract.js';
import { openDemoHttp } from './agent-demo-server.js';
import type { AgentPublicEvent } from './agent-events.js';
import type { DemoControl, DemoControlRecord, DemoRuntimeHandle, SourceCursor, SourceEventPage } from './demo-types.js';

const fixture = createPublicSessionFixture();
const VIEWER = '11'.repeat(32);
const OPERATOR = '22'.repeat(32);
const OBSERVER = '33'.repeat(32);

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string'); const port = address.port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}

function sourceCursor(events: AgentPublicEvent[]): SourceCursor {
  const cursor: SourceCursor = { coordinator: '0', research: '0', host: '0' };
  for (const event of events) cursor[event.role] = event.id;
  return cursor;
}

type RuntimeOptions = {
  role?: 'coordinator' | 'provider';
  events?: AgentPublicEvent[];
  evidence?: () => Promise<any>;
  beforePage?: (calls: number, emit: (event: AgentPublicEvent) => void) => void;
};

function makeRuntime(options: RuntimeOptions = {}): DemoRuntimeHandle & { emit(event: AgentPublicEvent): void; submissions: DemoControl[] } {
  const role = options.role ?? 'coordinator';
  const sourceEvents = options.events ? [...options.events] : [];
  const listeners = new Set<(event: AgentPublicEvent) => void>();
  const records = new Map<string, DemoControlRecord>();
  const submissions: DemoControl[] = [];
  let pageCalls = 0;
  const baseStatus = role === 'coordinator' ? fixture.snapshot.roles.coordinator : fixture.snapshot.roles.provider!;
  const currentCursor = () => sourceCursor(sourceEvents);
  const emit = (event: AgentPublicEvent): void => { sourceEvents.push(structuredClone(event)); for (const listener of listeners) listener(structuredClone(event)); };
  const events = (after: SourceCursor, limit = 256): SourceEventPage => {
    pageCalls += 1; options.beforePage?.(pageCalls, emit);
    const remaining = sourceEvents.filter(event => BigInt(event.id) > BigInt(after[event.role]));
    return { version: 1, conversation: fixture.pins.conversation, source: role, events: structuredClone(remaining.slice(0, limit)), high_water: currentCursor(), has_more: remaining.length > limit };
  };
  const runtime: DemoRuntimeHandle & { emit(event: AgentPublicEvent): void; submissions: DemoControl[] } = {
    role, conversation: fixture.pins.conversation,
    publication: () => ({ version: 1, state: 'ready', cursor: currentCursor(), code: null }),
    status: () => { const value = structuredClone(baseStatus); value.cursor = currentCursor(); return value; },
    selectedChannel: () => role === 'coordinator' ? fixture.snapshot.selected_channel : null,
    availableControls: () => role === 'coordinator' ? [...fixture.snapshot.available_controls] : [],
    submit: async control => {
      if (role !== 'coordinator') throw new Error('control_not_allowed');
      submissions.push(structuredClone(control));
      const record: DemoControlRecord = { version: 1, id: control.id, command: structuredClone(control.command), state: 'accepted', code: null, accepted_at_ms: '1', updated_at_ms: '1', task: control.command.op === 'task' ? control.id : control.command.op === 'cancel' ? control.command.task : null, channel: control.command.op === 'fund' ? control.command.previous_channel : control.command.op === 'close' || control.command.op === 'refund' ? control.command.channel : null };
      records.set(control.id, record); return structuredClone(record);
    },
    control: id => structuredClone(records.get(id)),
    events, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    economy: () => role === 'coordinator' ? structuredClone(fixture.snapshot.channels) : [],
    identities: () => structuredClone(fixture.snapshot.identities),
    evidence: options.evidence ?? (async () => { throw new Error('channel_mismatch'); }),
    locator: () => role === 'provider' ? structuredClone({ version: 1, conversation: fixture.pins.conversation, provider: fixture.pins.agents.provider, configuration_hash: fixture.pins.configuration_hash, endpoint: { id: '55'.repeat(32), addrs: [] } }) : null,
    shutdown: async () => {},
    emit, submissions,
  };
  return runtime;
}

async function start(runtime: DemoRuntimeHandle, root: string, provider = false): Promise<{ app: Awaited<ReturnType<typeof openDemoHttp>>; port: number; origin: string }> {
  const port = await freePort(); const origin = `https://127.0.0.1:${port}`;
  const app = await openDemoHttp({ runtime, config: fixture.pins.config, projectionStateDir: root, createProjection: true,
    bindHost: '127.0.0.1', port, ...(provider ? { observerToken: OBSERVER } : { publicOrigin: origin, viewerToken: VIEWER, operatorToken: OPERATOR, observerToken: OBSERVER }), network: 'localnet' });
  return { app, port, origin };
}

async function json(url: string, init?: RequestInit): Promise<{ response: Response; body: any }> {
  const response = await fetch(url, init); let body: any = null; try { body = await response.json(); } catch { /* fixed non-JSON is a test failure at the caller */ }
  return { response, body };
}

async function readSse(url: string, headers: Record<string, string>): Promise<{ text: string; cancel(): Promise<void> }> {
  const response = await fetch(url, { headers }); assert.equal(response.status, 200); assert(response.body);
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = '';
  for (;;) { const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value, { stream: true }); if (text.includes('state":"live')) break; }
  return { text, cancel: async () => { await reader.cancel(); } };
}

function event(id: number, text = `fixture-${id}`): AgentPublicEvent {
  return { version: 1, id: String(id), role: 'coordinator', conversation: fixture.pins.conversation, request: null, at_ms: String(id), type: 'model_text', data: { text } };
}

async function h01ProviderBoot(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'm2m-h01-')); const runtime = makeRuntime({ role: 'provider', events: fixture.events.filter(item => item.source === 'provider').map(item => item.event) });
  let app: Awaited<ReturnType<typeof openDemoHttp>> | undefined;
  try {
    const started = await start(runtime, root, true); app = started.app; const base = `http://127.0.0.1:${started.port}`; const headers = { Authorization: `Bearer ${OBSERVER}` };
    const status = await json(`${base}/internal/v1/status`, { headers }); assert.equal(status.response.status, 200); assert.equal(status.body.source, 'provider');
    const encoded = encodeSourceCursor({ coordinator: '0', research: '0', host: '0' }); const events = await json(`${base}/internal/v1/events?after=${encoded}`, { headers }); assert.equal(events.response.status, 200); assert.equal(events.body.source, 'provider'); assert.equal(events.body.page.events.length, 3);
    const locator = await json(`${base}/internal/v1/locator`, { headers }); assert.equal(locator.response.status, 200); assert.equal(locator.body.locator.provider.agent, fixture.pins.agents.provider.agent);
    const publicRoute = await json(`${base}/api/v1/session`, { headers }); assert.equal(publicRoute.response.status, 403);
    const control = await json(`${base}/api/v1/controls`, { method: 'POST', headers: { ...headers, Origin: started.origin, 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(control.response.status, 403);
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
}

async function h02EvidenceBoundary(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'm2m-h02-')); let mode: 'valid' | 'nested' = 'valid';
  const valid = { version: 1 as const, conversation: fixture.pins.conversation, channel: fixture.snapshot.channels[0].channel, offer: fixture.snapshot.channels[0].offer, policy: fixture.snapshot.channels[0].policy, credits: [], checkpoints: [], terminal_receipts: [], economy: fixture.snapshot.channels[0] };
  const runtime = makeRuntime({ events: fixture.events.filter(item => item.source === 'coordinator').map(item => item.event), evidence: async () => mode === 'valid' ? structuredClone(valid) : { ...structuredClone(valid), economy: { ...structuredClone(valid.economy), raw_model: { reasoning: 'TEST_FIXTURE_REASONING' } }, private_key: 'TEST_FIXTURE_PRIVATE_DO_NOT_PUBLISH' } });
  let app: Awaited<ReturnType<typeof openDemoHttp>> | undefined;
  try {
    const started = await start(runtime, root); app = started.app; const base = `http://127.0.0.1:${started.port}/api/v1/evidence/${valid.channel}`; const headers = { Authorization: `Bearer ${VIEWER}` };
    const positive = await json(base, { headers }); assert.equal(positive.response.status, 200); assert.equal(positive.body.channel, valid.channel); assert.doesNotMatch(JSON.stringify(positive.body), /TEST_FIXTURE_/);
    mode = 'nested'; const negative = await json(base, { headers }); assert.equal(negative.response.status, 503); assert.doesNotMatch(JSON.stringify(negative.body), /TEST_FIXTURE_/);
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
}

async function h03ReplayReconnectAndAppend(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'm2m-h03-')); const runtime = makeRuntime({ events: Array.from({ length: 300 }, (_, index) => event(index + 1)) }); let app: Awaited<ReturnType<typeof openDemoHttp>> | undefined;
  try {
    const started = await start(runtime, root); app = started.app; const base = `http://127.0.0.1:${started.port}/api/v1/events`; const auth = { Authorization: `Bearer ${VIEWER}` };
    const first = await readSse(base, { ...auth, 'Last-Event-ID': `${fixture.pins.conversation}:0` }); const firstIds = [...first.text.matchAll(/id: [^:]+:([0-9]+)/g)].map(match => Number(match[1])); assert.deepEqual(firstIds, Array.from({ length: 300 }, (_, index) => index + 1)); await first.cancel();
    const resumed = await readSse(base, { ...auth, 'Last-Event-ID': `${fixture.pins.conversation}:256` }); const resumedIds = [...resumed.text.matchAll(/id: [^:]+:([0-9]+)/g)].map(match => Number(match[1])); assert.deepEqual(resumedIds, Array.from({ length: 44 }, (_, index) => index + 257)); await resumed.cancel();
    runtime.emit(event(301)); await new Promise(resolve => setTimeout(resolve, 10)); const appended = await readSse(base, { ...auth, 'Last-Event-ID': `${fixture.pins.conversation}:300` }); const appendIds = [...appended.text.matchAll(/id: [^:]+:([0-9]+)/g)].map(match => Number(match[1])); assert.deepEqual(appendIds, [301]); await appended.cancel();
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
}

async function h04PoisonAdmission(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'm2m-h04-')); const runtime = makeRuntime(); let app: Awaited<ReturnType<typeof openDemoHttp>> | undefined;
  try {
    const started = await start(runtime, root); app = started.app; runtime.emit({ ...structuredClone(fixture.events.find(item => item.source === 'coordinator')!.event), id: '99' }); await new Promise(resolve => setTimeout(resolve, 15));
    const base = `http://127.0.0.1:${started.port}`; const status = await json(`${base}/api/v1/status`, { headers: { Authorization: `Bearer ${VIEWER}` } }); assert.equal(status.response.status, 409); assert.equal(status.body.code, 'projection_gap');
    const task = { version: 1, id: '44'.repeat(32), command: { op: 'task', prompt: 'new work' } }; const taskResult = await json(`${base}/api/v1/controls`, { method: 'POST', headers: { Authorization: `Bearer ${OPERATOR}`, Origin: started.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(task) }); assert.equal(taskResult.response.status, 409); assert.equal(runtime.submissions.length, 0);
    const pause = { version: 1, id: '45'.repeat(32), command: { op: 'spending', paused: true } }; const pauseResult = await json(`${base}/api/v1/controls`, { method: 'POST', headers: { Authorization: `Bearer ${OPERATOR}`, Origin: started.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(pause) }); assert.equal(pauseResult.response.status, 202); assert.equal(runtime.submissions.length, 1);
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
}

async function h05StartupCutoverAndReopen(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'm2m-h05-')); let emitted = false; const first = event(1, 'one'); const second = event(2, 'two');
  const runtime = makeRuntime({ events: [first], beforePage: (calls, emit) => { if (!emitted && calls === 1) { emitted = true; queueMicrotask(() => emit(second)); } } }); let app: Awaited<ReturnType<typeof openDemoHttp>> | undefined;
  try {
    const started = await start(runtime, root); app = started.app; const base = `http://127.0.0.1:${started.port}`; const response = await json(`${base}/api/v1/status`, { headers: { Authorization: `Bearer ${VIEWER}` } }); assert.equal(response.response.status, 200); assert.equal(response.body.snapshot.projection_sequence, '2'); await app.close(); app = undefined;
    const reopened = await start(runtime, root); app = reopened.app; const after = await json(`http://127.0.0.1:${reopened.port}/api/v1/status`, { headers: { Authorization: `Bearer ${VIEWER}` } }); assert.equal(after.response.status, 200); assert.equal(after.body.snapshot.projection_sequence, '2');
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
}

async function h06CloseActiveSse(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'm2m-h06-')); const runtime = makeRuntime(); let app: Awaited<ReturnType<typeof openDemoHttp>> | undefined;
  try {
    const started = await start(runtime, root); app = started.app; const response = await fetch(`http://127.0.0.1:${started.port}/api/v1/events`, { headers: { Authorization: `Bearer ${VIEWER}` } }); assert.equal(response.status, 200); assert(response.body); const reader = response.body.getReader(); const first = await reader.read(); assert(first.value);
    const closed = await Promise.race([app.close().then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1_000))]); assert.equal(closed, true); app = undefined; const done = await Promise.race([reader.read().then(result => result.done), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1_000))]); assert.equal(done, true); await reader.cancel();
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
}

await h01ProviderBoot();
await h02EvidenceBoundary();
await h03ReplayReconnectAndAppend();
await h04PoisonAdmission();
await h05StartupCutoverAndReopen();
await h06CloseActiveSse();
process.stdout.write('agent demo H01-H06 HTTP regressions: ok\n');
