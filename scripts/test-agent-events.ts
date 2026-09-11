import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEvents, type AgentPublicEvent } from './agent-events.js';

const directory = await mkdtemp(join(tmpdir(), 'm2m-agent-events-test-'));
const path = join(directory, 'events.json');
const conversation = '12'.repeat(32);
const seen: AgentPublicEvent[] = [];
let events = await AgentEvents.open(path, conversation, e => seen.push(e));
await Promise.all([
  events.append('coordinator', 'task_started', { prompt: 'A real task' }, '23'.repeat(32)),
  events.append('host', 'budget', { authorized_mist: '0' }),
  events.append('coordinator', 'model_text', { delta: 'Public answer, not reasoning.' }),
]);
assert.deepEqual(seen.map(e => [e.role, e.id]), [['coordinator', '1'], ['host', '1'], ['coordinator', '2']]);
assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).events, seen);
assert.equal((await stat(path)).mode & 0o777, 0o600);
events = await AgentEvents.open(path, conversation);
assert.deepEqual(events.replay({ coordinator: '1', host: '1' }), [seen[2]]);
const copy = events.replay(); copy[0].data.changed = true;
assert.equal(events.replay()[0].data.changed, undefined);
await assert.rejects(() => events.append('host', 'model_text', { text: 'a'.repeat(65_536) }), /limit/);
assert.equal(events.replay().length, 3);
await assert.rejects(() => AgentEvents.open(path, '34'.repeat(32)), /journal_corrupt/);
const saved = await readFile(path, 'utf8');
const corrupted = JSON.parse(saved); corrupted.events[2].id = '4';
await writeFile(path, JSON.stringify(corrupted));
await assert.rejects(() => AgentEvents.open(path, conversation), /journal_corrupt/);
await writeFile(path, saved);
await rename(path, join(directory, 'events.saved.json'));
await assert.rejects(() => AgentEvents.open(path, conversation), /journal_missing/);
await assert.rejects(() => AgentEvents.open(join(directory, 'missing.json'), conversation, undefined, true), /journal_missing/);
console.log('PASS public agent events: durable publication, per-role IDs, replay, private mode, limits, missing/corrupt journal rejection');
