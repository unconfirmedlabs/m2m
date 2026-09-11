import vectors from '../../../tests/agent-demo/accounting-vectors.json';
import { describe, expect, it } from 'vitest';
import { deriveEconomy, policyPrice } from '../src/accounting.js';
import { applyDemoEvent, initialUiState, replaceSnapshot } from '../src/reducer.js';
import type { DemoEconomy, DemoEvent } from '../src/types.js';
import { createPublicSessionFixture } from '../../../tests/agent-demo/public-session.js';

const fixture = createPublicSessionFixture();
const initial = () => initialUiState(fixture.snapshot);
const conversation = fixture.pins.conversation;

function economy(vector: typeof vectors.accounting[number]): DemoEconomy {
  const terminal = vector.terminal_confirmed ? { state: 'confirmed' as const, digest: 'a'.repeat(43), gas: null } : null;
  return {
    channel: `0x${'1'.repeat(64)}`, status: vector.status as DemoEconomy['status'], offer: { payload: { deposit: vector.deposit_mist } } as DemoEconomy['offer'],
    policy: { rates: ['1', '0'], denominator: '1' } as DemoEconomy['policy'], signed_credit: null, checkpoint: null,
    budget: {} as DemoEconomy['budget'], delivered_units: [vector.delivered_mist, '0'], delivered_mist: vector.delivered_mist,
    signed_authorized_mist: vector.signed_cumulative_observations.at(-1) ?? '0', reserved_mist: vector.reserved_mist,
    outstanding_mist: '0', reserved_exposure_mist: '0', redeemed_mist: vector.redeemed_mist, locked_mist: vector.locked_mist,
    refunded_mist: null, observed_at_ms: '1', opening: { state: 'confirmed', digest: null, gas: null }, terminal,
  };
}

describe('browser accounting reducer', () => {
  it('uses exact policy arithmetic and active exposure settlement semantics from shared vectors', () => {
    for (const vector of vectors.prices) expect(policyPrice({ rates: vector.rates, denominator: vector.denominator }, vector.units)).toBe(vector.expected_mist);
    for (const vector of vectors.accounting) {
      const result = deriveEconomy(economy(vector));
      expect({ signed_authorized_mist: result.signedAuthorization, outstanding_mist: result.outstanding, reserved_exposure_mist: result.reservedExposure,
        refunded_mist: result.refund, redeemed_above_delivery: result.redeemedAboveDelivery }).toEqual(vector.expected);
    }
  });

  it('requires complete terminal evidence before clearing exposure or showing refund', () => {
    const base = economy(vectors.accounting.find(item => item.terminal_confirmed)!);
    base.status = 'closed'; base.locked_mist = '0'; base.redeemed_mist = '850'; base.observed_at_ms = '10';
    base.terminal = { state: 'confirmed', digest: 'valid-terminal', gas: { computation_cost: '1', storage_cost: '2', storage_rebate: '0', non_refundable_storage_fee: '0' } };
    expect(deriveEconomy(base).outstanding).toBe('0');
    expect(deriveEconomy(base).openingTransaction.digest).toBe(base.opening.digest);
    expect(deriveEconomy(base).terminalTransaction?.digest).toBe('valid-terminal');
    for (const missing of ['redeemed_mist', 'observed_at_ms'] as const) {
      const uncertain = { ...base, [missing]: null };
      expect(deriveEconomy(uncertain).outstanding).toBe('50');
      expect(deriveEconomy(uncertain).refund).toBeNull();
    }
    const noDigest = { ...base, terminal: { ...base.terminal, digest: null } };
    expect(deriveEconomy(noDigest).outstanding).toBe('50');
    expect(deriveEconomy(noDigest).refund).toBeNull();
  });

  it('deduplicates split UTF-8 delivery frames without replacement characters or duplicate answers', () => {
    let state = initial();
    for (const event of fixture.events) {
      state = applyDemoEvent(state, event);
      const replay = applyDemoEvent(state, event);
      expect(replay).toBe(state);
    }
    expect(state.deliveries[fixture.receipt.request].text).toBe(fixture.expected.research_text);
    expect(state.deliveries[fixture.receipt.request].outputBytes).toBe('8');
    expect(state.transcript.filter(entry => entry.kind === 'delivery')).toHaveLength(1);
    expect(state.transcript.find(entry => entry.kind === 'delivery')!.text).not.toContain('\ufffd');
  });

  it('keeps source identity separate when roles reuse host event ids', () => {
    let state = initial();
    for (const source of ['coordinator', 'provider'] as const) {
      state = applyDemoEvent(state, { version: 1, source, sequence: String(state.events.length + 1), event: {
        version: 1, id: '1', role: 'host', conversation, request: null, at_ms: '1', type: 'connection', data: { connection: fixture.snapshot.roles.coordinator.connection, actor: 'host' },
      } });
    }
    expect(state.events).toHaveLength(2);
    expect(new Set(state.seenEventKeys).size).toBe(2);
  });

  it('keeps untrusted HTML and secret-shaped text inert', () => {
    const state = applyDemoEvent(initial(), { version: 1, source: 'coordinator', sequence: '1', event: {
      version: 1, id: '1', role: 'coordinator', conversation, request: null, at_ms: '1', type: 'model_text',
      data: { text: '<img src=x onerror="fetch(\'/steal?token=secret\')">' },
    } });
    expect(state.transcript[0].text).toContain('<img');
    expect(state.transcript[0].text).toContain('token=secret');
  });

  it('marks changed duplicate source identity as a stream conflict', () => {
    const event = { version: 1 as const, source: 'coordinator' as const, sequence: '1', event: {
      version: 1 as const, id: '1', role: 'coordinator' as const, conversation, request: null, at_ms: '1', type: 'model_text' as const, data: { text: 'one' },
    } };
    const changed = { ...event, event: { ...event.event, data: { text: 'changed' } } };
    const state = applyDemoEvent(applyDemoEvent(initial(), event), changed);
    expect(state.browser).toBe('failed');
    expect(state.browserError).toBe('event_conflict');
  });

  it('keeps replay history out of live activity and latches failures', () => {
    const snapshot = structuredClone(fixture.snapshot); snapshot.projection_sequence = '1';
    const base = replaceSnapshot(initialUiState(), snapshot);
    const historical: DemoEvent = { version: 1, source: 'coordinator', sequence: '1', event: { version: 1, id: '1', role: 'host', conversation, request: null, at_ms: '1', type: 'connection', data: { connection: { ...snapshot.roles.coordinator.connection, desired: 'online', state: 'connected' }, actor: 'host' } } };
    const replayed = applyDemoEvent(base, historical);
    expect(replayed.newActivity).toBe(false);
    expect(replayed.iroh.coordinator).toBe(snapshot.roles.coordinator.connection.state);
    expect(replayed.refreshRequested).toBe(false);
    const live = applyDemoEvent(replayed, { ...historical, sequence: '2', event: { ...historical.event, id: '2' } });
    expect(live.newActivity).toBe(true);
    const failed = applyDemoEvent(live, { ...historical, sequence: '4', event: { ...historical.event, id: '4' } });
    expect(failed.sync).toBe('failed');
    expect(applyDemoEvent(failed, { ...historical, sequence: '3', event: { ...historical.event, id: '3' } })).toBe(failed);
  });

  it('keeps incomplete UTF-8 pending until terminal and renders receipt citations', () => {
    const request = fixture.receipt.request; let state = initial(); let sawPending = false;
    const citation = { id: 's1', url: 'https://example.com/source', title: 'TEST FIXTURE source', retrieved_at_ms: '500', content_hash: Array(32).fill(1) };
    const events = structuredClone(fixture.events);
    for (const event of events) {
      if (event.event.type === 'turn_terminal') (event.event.data.receipt as typeof fixture.receipt).citations = [citation];
      state = applyDemoEvent(state, event);
      if (event.event.type === 'delivery') {
        expect(state.deliveries[request].malformed).toBe(false);
        sawPending ||= Boolean(state.deliveries[request].pending?.length);
      }
    }
    expect(sawPending).toBe(true);
    expect(state.deliveries[request].text).toBe(fixture.expected.research_text);
    expect(state.transcript.find(entry => entry.kind === 'delivery')!.citations[0].url).toBe(citation.url);
  });
});
