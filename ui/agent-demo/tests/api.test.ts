import { describe, expect, it, vi } from 'vitest';
import { DemoApi, DemoApiError } from '../src/api.js';
import type { DemoControl, DemoEvent } from '../src/types.js';
import { createPublicSessionFixture } from '../../../tests/agent-demo/public-session.js';

const fixture = createPublicSessionFixture();
const conversation = fixture.pins.conversation;
function withSession(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => String(input).endsWith('/session')
    ? new Response(JSON.stringify({ version: 1, access: 'operator', snapshot: fixture.snapshot })) : fetcher(input, init);
}

const token = 'viewer-token';
const control: DemoControl = { version: 1, id: 'a'.repeat(64), command: { op: 'disconnect' } };

describe('authenticated browser API', () => {
  it('uses bearer fetch without credentials and retains only the exact command id', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({ version: 1, record: { version: 1, id: control.id, command: control.command, state: 'accepted', code: null, accepted_at_ms: '1', updated_at_ms: '1', task: null, channel: null } }), { status: 202, headers: { 'content-type': 'application/json' } }));
    const api = new DemoApi('', withSession(fetcher)); api.authenticate(token); await api.session();
    const record = await api.control(control);
    expect(record.id).toBe(control.id);
    expect(fetcher).toHaveBeenCalledWith('/api/v1/controls', expect.objectContaining({ credentials: 'omit', redirect: 'error', method: 'POST', body: JSON.stringify(control), headers: expect.objectContaining({ Authorization: `Bearer ${token}` }) }));
  });

  it('clears the in-memory token on 401 and never turns an HTTP failure into fixture data', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ version: 1, code: 'unauthorized' }), { status: 401 }));
    const api = new DemoApi('', fetcher); api.authenticate(token);
    await expect(api.status()).rejects.toEqual(new DemoApiError(401, 'unauthorized'));
    expect(api.hasSession()).toBe(false);
  });

  it('rejects extra private fields and changed payment terms before accepting a snapshot', async () => {
    const poisoned = structuredClone(fixture.snapshot) as unknown as Record<string, unknown>;
    poisoned.private_key = 'TEST_ONLY_PRIVATE';
    const api = new DemoApi('', async () => new Response(JSON.stringify({ version: 1, access: 'operator', snapshot: poisoned })));
    api.authenticate(token);
    await expect(api.session()).rejects.toEqual(new DemoApiError(502, 'invalid_session'));

    const changed = structuredClone(fixture.snapshot); changed.identities.coordinator.agent.agent = '0x' + '09'.repeat(32);
    const pinned = new DemoApi('', withSession(async () => new Response(JSON.stringify({ version: 1, conversation, snapshot: changed, high_water: changed.projection_sequence }))));
    pinned.authenticate(token); await pinned.session();
    await expect(pinned.status()).rejects.toEqual(new DemoApiError(502, 'invalid_snapshot'));
  });

  it('rejects duplicate JSON keys and never sends a control before a validated session', async () => {
    const fetcher = vi.fn(async () => new Response('{"version":1,"version":1,"access":"viewer","snapshot":{}}'));
    const api = new DemoApi('', fetcher); api.authenticate(token);
    await expect(api.control(control)).rejects.toEqual(new DemoApiError(409, 'session_unavailable'));
    expect(fetcher).not.toHaveBeenCalled();
    await expect(api.session()).rejects.toEqual(new DemoApiError(200, 'invalid_json'));
  });

  it('rejects private nested SSE data before it reaches a transcript callback', async () => {
    const value = structuredClone(fixture.events[0]); value.event.data.private_key = 'TEST_ONLY_PRIVATE';
    const body = `event: agent_event\nid: ${conversation}:1\ndata: ${JSON.stringify(value)}\n\n`;
    const api = new DemoApi('', withSession(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })));
    api.authenticate(token); await api.session();
    const received = vi.fn(), status = vi.fn();
    await api.subscribe({ coordinator: '0', research: '0', host: '0' }, received, status, undefined, `${conversation}:0`).done;
    expect(received).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith('failed', 'invalid_event_payload');
  });

  it('parses partial UTF-8 SSE frames, comments and multiple events', async () => {
    const event = (sequence: string): DemoEvent => ({ version: 1, source: 'coordinator', sequence, event: { version: 1, id: sequence, role: 'coordinator', conversation, request: null, at_ms: sequence, type: 'model_text', data: { text: `<safe-${sequence}>` } } });
    const encoded = new TextEncoder().encode(`: heartbeat\n\nevent: agent_event\nid: ${conversation}:1\ndata: ${JSON.stringify(event('1'))}\n\nevent: agent_event\nid: ${conversation}:2\ndata: ${JSON.stringify(event('2'))}\n\n`);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoded.slice(0, 41)); controller.enqueue(encoded.slice(41)); controller.close(); } });
    const fetcher = vi.fn(async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const api = new DemoApi('', withSession(fetcher)); api.authenticate(token); await api.session(); const received: DemoEvent[] = [];
    const subscription = api.subscribe({ coordinator: '0', research: '0', host: '0' }, eventValue => received.push(eventValue), vi.fn(), undefined, `${conversation}:0`);
    await subscription.done;
    expect(received.map(item => item.sequence)).toEqual(['1', '2']);
    expect(fetcher).toHaveBeenCalledWith('/api/v1/events', expect.objectContaining({ headers: expect.objectContaining({ 'Last-Event-ID': `${conversation}:0`, Accept: 'text/event-stream' }) }));
  });

  it('revokes on 401 before reading an invalid body', async () => {
    let consumed = false; const unauthorized = vi.fn();
    const response = { status: 401, ok: false, headers: new Headers(), get body() { consumed = true; throw new Error('body must not be read'); } } as unknown as Response;
    const api = new DemoApi('', vi.fn(async () => response));
    api.authenticate(token); api.setUnauthorizedHandler(unauthorized);
    await expect(api.status()).rejects.toEqual(new DemoApiError(401, 'unauthorized'));
    expect(api.hasSession()).toBe(false); expect(unauthorized).toHaveBeenCalledTimes(1); expect(consumed).toBe(false);
  });

  it('rejects control replies with mismatched command or incomplete records', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ version: 1, record: { version: 1, id: control.id, command: { op: 'reconnect' }, state: 'completed', code: null, accepted_at_ms: '1', updated_at_ms: '1', task: null, channel: null } }), { status: 202 }));
    const api = new DemoApi('', withSession(fetcher)); api.authenticate(token); await api.session();
    await expect(api.control(control)).rejects.toEqual(new DemoApiError(502, 'control_reply_mismatch'));
  });

  it('does not install a finite response after logout starts a new session generation', async () => {
    let release!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    const api = new DemoApi('', fetcher); api.authenticate(token);
    const pending = api.status(); api.logout(); release(new Response(JSON.stringify({ version: 1, snapshot: {} }), { status: 200 }));
    await expect(pending).rejects.toEqual(new DemoApiError(0, 'stale_session'));
  });

  it('fails closed on unknown SSE event kinds', async () => {
    const body = `event: made_up\nid: ${conversation}:1\ndata: {}\n\n`;
    const fetcher = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const api = new DemoApi('', withSession(fetcher)); api.authenticate(token); await api.session(); const status = vi.fn(); const received: DemoEvent[] = [];
    const subscription = api.subscribe({ coordinator: '0', research: '0', host: '0' }, event => received.push(event), status, undefined, `${conversation}:0`);
    await subscription.done; expect(received).toHaveLength(0); expect(status).toHaveBeenLastCalledWith('failed', 'invalid_event_frame');
  });
});
