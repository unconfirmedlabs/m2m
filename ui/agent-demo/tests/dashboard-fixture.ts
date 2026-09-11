import type { DemoEvent, DemoSnapshot } from '../src/types.js';
import { createPublicSessionFixture } from '../../../tests/agent-demo/public-session.js';

export const conversation = 'c'.repeat(64);
export const address = `0x${'1'.repeat(64)}`;
export const task = 't'.repeat(64);

export function snapshot(input?: unknown): DemoSnapshot {
  if (input === undefined) return createPublicSessionFixture().snapshot;
  const evidence = input as { binding?: { channel: string; offer: unknown; policy: { rates: string[]; denominator: string } }; steps?: Array<{ kind: string; checkpoint?: { payload: { units: string[]; cumulative_amount: string } }; credit?: { payload: { cumulative_amount: string } } }> } | undefined;
  const defaultBinding = { channel: address, offer: { version: 1, payload: { deposit: '12000' } }, policy: { rates: ['1', '1'], denominator: '1' } };
  const binding = evidence?.binding ?? defaultBinding;
  const steps = evidence?.steps ?? [];
  const finalCheckpoint = steps.find(step => step.kind === 'channel_final')?.checkpoint;
  const finalUnits = finalCheckpoint?.payload.units ?? ['1', '8'];
  const finalAuthorization = [...steps].reverse().find(step => step.kind === 'authorization');
  const finalAuthorized = finalAuthorization?.credit?.payload.cumulative_amount ?? finalAuthorization?.checkpoint?.payload.cumulative_amount ?? '38';
  const identity = (name: 'local.nozomi.sui' | 'research.nozomi.sui', agent: string) => ({
    name, agent: { network: [108, 111, 99, 97, 108], package_id: address, domain: address, agent }, controller: address,
    transport_key: [1, 2, 3], economic_key: [4, 5, 6], generation: '1', authority_checked_at_ms: '1', alias_state: 'verified',
  });
  const connection = { desired: 'online' as const, state: 'connected' as const, generation: '1', path: 'direct' as const, changed_at_ms: '1', code: null };
  const role = (value: 'coordinator' | 'provider') => ({ version: 1 as const, role: value, conversation, phase: 'active' as const, code: null,
    runtime: { version: 1 as const, kind: 'responses-tools-v1' as const, model: 'gpt-5.6-luna' as const, reasoning: 'xhigh' as const }, profile_fingerprint: address.slice(2), configuration_hash: address.slice(2), active_task: task,
    active_request: null, spending_paused: false, waiting_for_credit: false, connection, cursor: { coordinator: '0', research: '0', host: '0' } });
  const limits = { max_total_mist: '10000', max_channel_deposit_mist: '12000', max_turn_mist: '5000', max_outstanding_mist: '12000', max_requests: 4, deadline_ms: '9999999999999', output_tranche_bytes: 1024 };
  const economy = {
    channel: binding.channel, status: 'open' as const, offer: binding.offer, policy: binding.policy, signed_credit: null, checkpoint: finalCheckpoint ?? null,
    budget: { limits, channel: binding.channel, authorized_mist: finalAuthorized, delivered_mist: '26', redeemed_mist: '0', settled_prior_mist: '0', remaining_mist: '9962', outstanding_mist: '12', requests_remaining: 3, uncertain: false },
    delivered_units: finalUnits as [string, string], delivered_mist: '26', signed_authorized_mist: finalAuthorized, reserved_mist: finalAuthorized, outstanding_mist: '12', reserved_exposure_mist: '12', redeemed_mist: '0', locked_mist: '12000', refunded_mist: null, observed_at_ms: '1',
    opening: { state: 'confirmed' as const, digest: 'opening-digest', gas: { computation_cost: '2', storage_cost: '1', storage_rebate: '0', non_refundable_storage_fee: '0' } }, terminal: null,
  };
  return { version: 1, conversation, mode: 'live', network: 'localnet', configuration_hash: address.slice(2), config: { version: 1, budget: economy.budget.limits, deposit_mist: '12000', price: { input_rate: binding.policy.rates[0], output_rate: binding.policy.rates[1], denominator: binding.policy.denominator }, allowed_hosts: ['example.com'] },
    identities: { coordinator: identity('local.nozomi.sui', address.slice(2)), provider: identity('research.nozomi.sui', '2'.repeat(64)) }, roles: { coordinator: role('coordinator'), provider: role('provider') }, provider_observed_at_ms: '1', selected_channel: address, channels: [economy], projection_sequence: '0', available_controls: ['task', 'start', 'fund', 'cancel', 'spending', 'disconnect', 'reconnect', 'close', 'refund'] } as unknown as DemoSnapshot;
}

export function event(sequence: string, type: DemoEvent['event']['type'], source: DemoEvent['source'] = 'coordinator', data: Record<string, unknown> = {}): DemoEvent {
  return { version: 1, source, sequence, event: { version: 1, id: sequence, role: source === 'provider' ? 'research' : 'coordinator', conversation, request: null, at_ms: sequence, type, data } };
}

export function sse(events: DemoEvent[]): string {
  const streamConversation = events[0]?.event.conversation ?? conversation;
  return events.map(value => `event: agent_event\r\nid: ${streamConversation}:${value.sequence}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`).join('');
}
