import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FixtureHarness } from './fixture-harness.js';
import App from '../src/App.js';
import { applyDemoEvent, initialUiState } from '../src/reducer.js';
import { createPublicSessionFixture } from '../../../tests/agent-demo/public-session.js';

describe('production shell and fixture boundary', () => {
  it('starts unauthenticated and never renders a fixture banner in production App', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: /Research that can show its receipts/i })).toBeInTheDocument();
    expect(screen.queryByText(/TEST FIXTURE/)).not.toBeInTheDocument();
  });

  it('fixture harness makes its non-live status unmistakable', () => {
    render(<FixtureHarness><p>fixture panel</p></FixtureHarness>);
    expect(screen.getByRole('note')).toHaveTextContent('TEST FIXTURE — no live agents or payments');
  });

  it('renders public untrusted text as text rather than executable markup', () => {
    const fixture = createPublicSessionFixture();
    const state = applyDemoEvent(initialUiState(fixture.snapshot), { version: 1, source: 'coordinator', sequence: '1', event: {
      version: 1, id: '1', role: 'coordinator', conversation: fixture.pins.conversation, request: null, at_ms: '1', type: 'model_text', data: { text: '<script>window.stolen="token"</script>' },
    } });
    const view = render(<p>{state.transcript[0].text}</p>);
    expect(view.container.querySelector('script')).toBeNull();
    expect(view.container.textContent).toContain('<script>window.stolen="token"</script>');
  });
});
