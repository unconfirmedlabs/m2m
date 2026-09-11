import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { DemoApi } from '../src/api.js';
import type { DemoControl, DemoEvent } from '../src/types.js';
import { createPublicSessionFixture } from '../../../tests/agent-demo/public-session.js';

const FIXTURE_NOTICE = 'TEST FIXTURE — no live agents or payments';
const { snapshot, pins } = createPublicSessionFixture();
const id = pins.conversation;
const event: DemoEvent = { version: 1, source: 'coordinator', sequence: '1', event: {
  version: 1, id: '1', role: 'coordinator', conversation: id, request: null, at_ms: '1', type: 'model_text', data: { text: 'fixture status' },
} };

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture_listen');
  return `http://127.0.0.1:${address.port}`;
}

describe('explicit labeled fixture HTTP boundary', () => {
  it('uses real same-origin fetch and SSE replay without production fallback', async () => {
    expect(FIXTURE_NOTICE).toContain('no live agents or payments');
    let retained: DemoControl | null = null;
    const server = createServer((request, response) => {
      if (request.url === '/api/v1/session') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ version: 1, access: 'operator', snapshot })); return; }
      if (request.url === '/api/v1/controls' && request.method === 'POST') {
        let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => { retained = JSON.parse(body) as DemoControl; response.writeHead(202, { 'content-type': 'application/json' }); response.end(JSON.stringify({ version: 1, record: { version: 1, id: retained!.id, command: retained!.command, state: 'accepted', code: null, accepted_at_ms: '1', updated_at_ms: '1', task: null, channel: null } })); }); return;
      }
      if (request.url === '/api/v1/events') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(`event: agent_event\nid: ${id}:1\ndata: ${JSON.stringify(event)}\n\n`); response.end(); return; }
      response.writeHead(404); response.end(JSON.stringify({ version: 1, code: 'not_found' }));
    });
    const origin = await listen(server);
    try {
      const api = new DemoApi(origin); api.authenticate('fixture-token');
      expect((await api.session()).snapshot.conversation).toBe(id);
      const command: DemoControl = { version: 1, id: 'b'.repeat(64), command: { op: 'disconnect' } };
      expect((await api.control(command)).id).toBe(command.id);
      const received: DemoEvent[] = []; const subscription = api.subscribe({ coordinator: '0', research: '0', host: '0' }, value => received.push(value), () => {}, undefined, `${id}:0`);
      await subscription.done;
      expect((retained as DemoControl | null)?.id).toBe(command.id); expect(received).toHaveLength(1);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
