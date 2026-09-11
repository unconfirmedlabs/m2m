import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicSessionFixture } from '../tests/agent-demo/public-session.js';
import { DemoProjection } from './agent-demo-projection.js';

function expectMessage(message: string, action: () => unknown): void { assert.throws(action, (error: unknown) => error instanceof Error && error.message === message); }

async function run(): Promise<void> {
  const fixture = createPublicSessionFixture();
  const stateDir = await mkdtemp(join(tmpdir(), 'm2m-demo-projection-'));
  await assert.rejects(DemoProjection.open({ stateDir: join(stateDir, 'missing'), create: false, conversation: fixture.pins.conversation, pins: fixture.pins }), /journal_missing/);
  let projection: DemoProjection | undefined;
  let reopened: DemoProjection | undefined;
  try {
    projection = await DemoProjection.open({ stateDir, create: true, conversation: fixture.pins.conversation, pins: fixture.pins });
    const active = projection;
    const observed: string[] = []; const unsubscribe = active.subscribe(event => observed.push(event.sequence));
    for (const input of fixture.events) assert(await active.ingest(input));
    assert.equal(active.highWater(), String(fixture.events.length));
    assert.deepEqual(active.cursor('coordinator'), { coordinator: '4', research: '0', host: '12' });
    assert.deepEqual(active.cursor('provider'), { coordinator: '0', research: '2', host: '1' });
    assert.deepEqual(observed, fixture.events.map((_, index) => String(index + 1)));
    assert.equal(await active.ingest(fixture.events[0]), null);
    const altered = structuredClone(fixture.events[0]); altered.event.at_ms = '999';
    await assert.rejects(active.ingest(altered), /projection_conflict/);
    const gap = structuredClone(fixture.events[1]); gap.event.id = '99';
    await assert.rejects(active.ingest(gap), /projection_gap/);
    assert.equal(active.replay('0', 2).length, 2);
    assert.equal(active.replay('1')[0].sequence, '2');
    expectMessage('future_cursor', () => active.replay('999'));
    unsubscribe(); await active.close(); await active.close(); projection = undefined;

    reopened = await DemoProjection.open({ stateDir, create: false, conversation: fixture.pins.conversation, pins: fixture.pins });
    assert.equal(reopened.highWater(), String(fixture.events.length));
    assert.equal(reopened.replay('0', 1)[0].event.id, fixture.events[0].event.id);
    await reopened.close(); reopened = undefined;
  } finally {
    await projection?.close(); await reopened?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
  process.stdout.write('agent demo projection tests: ok\n');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
