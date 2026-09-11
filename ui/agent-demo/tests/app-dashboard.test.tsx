import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.js';
import { FixtureHarness } from './fixture-harness.js';
import { sse } from './dashboard-fixture.js';
import { createPublicSessionFixture } from '../../../tests/agent-demo/public-session.js';

describe('authenticated dashboard fixture boundary', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('restores durable history and renders both agents, verified delivery and accounting', async () => {
    const fixture = createPublicSessionFixture();
    const view = fixture.snapshot, conversation = view.conversation;
    const citation = { id: 's1', url: 'https://example.com/source', title: 'Primary source', retrieved_at_ms: '500', content_hash: Array(32).fill(1) };
    for (const item of fixture.events) {
      if (item.event.type === 'turn_terminal') (item.event.data.receipt as typeof fixture.receipt).citations = [citation];
    }
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(sse(fixture.events)));
      controller.close();
    } });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/api/v1/session')) return new Response(JSON.stringify({ version: 1, access: 'operator', snapshot: view }), { status: 200 });
      if (path.endsWith('/api/v1/status')) return new Response(JSON.stringify({ version: 1, conversation, high_water: view.projection_sequence, snapshot: view }), { status: 200 });
      if (path.endsWith('/api/v1/events')) return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      return new Response(JSON.stringify({ version: 1, code: 'not_found' }), { status: 404 });
    });
    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();
    render(<FixtureHarness><App /></FixtureHarness>);
    await user.type(screen.getByLabelText('Viewer or operator token'), 'fixture-token');
    await user.click(screen.getByRole('button', { name: 'Open live session' }));
    expect(await screen.findByText(fixture.expected.coordinator_text)).toBeInTheDocument();
    expect(await screen.findByText(fixture.expected.research_text)).toBeInTheDocument();
    for (const link of screen.getAllByRole('link', { name: 'Primary source' })) expect(link).toHaveAttribute('href', 'https://example.com/source');
    expect(screen.getAllByText('38 MIST').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('TEST FIXTURE — no live agents or payments')).toBeInTheDocument();
    expect(screen.getAllByText(/Nozomi research desk/)).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith('/api/v1/events', expect.objectContaining({ headers: expect.objectContaining({ 'Last-Event-ID': `${conversation}:0` }) }));
    await waitFor(() => expect(screen.getByText('Research agent')).toBeInTheDocument());
  });
});
