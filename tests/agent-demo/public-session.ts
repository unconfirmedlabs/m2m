/** TEST FIXTURE ONLY. No live model, web tool, chain, identity or transport.
 * Wrap the separately engine-verified economic input in coherent public shapes.
 * Never import this module from shipped UI/server/runtime code.
 */
import economicSession from './economic-session.json' with { type: 'json' };
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { AgentPublicEvent } from '../../scripts/agent-events.js';
import type { AgentRef } from '../../scripts/native-chain.js';
import type { BudgetSnapshot, ResearchRequestV2, TurnReceipt } from '../../scripts/agent-service-types.js';
import type {
  DemoEvent, DemoIdentity, DemoRoleStatus, DemoSnapshot, DemoValidationPins,
  MachineRole, SourceCursor,
} from '../../scripts/demo-types.js';
import {
  checkpointHash, type AckData, type CheckpointData, type CreditData,
  type OfferData, type PolicyData, type SignedData,
} from '../../scripts/streaming-codec.js';

interface EconomicInput {
  binding: { channel: string; offer: SignedData<OfferData>; policy: PolicyData };
  request: ResearchRequestV2;
  request_hash: number[];
  steps: Array<
    { kind: 'authorization'; credit: SignedData<CreditData>; ack: SignedData<AckData> } |
    { kind: 'delivery'; checkpoint: SignedData<CheckpointData>; output: number[] } |
    { kind: 'channel_final'; checkpoint: SignedData<CheckpointData> }
  >;
}

export function createPublicSessionFixture() {
  const fixture = structuredClone(economicSession) as EconomicInput;
  const { binding, request, request_hash } = fixture;
  const offer = binding.offer.payload;
  const task = '33'.repeat(32), tool = '34'.repeat(32), configurationHash = '35'.repeat(32);
  const reference = (agent: string): AgentRef => ({
    network: [...offer.network], package_id: offer.package_id, domain: offer.deployment, agent,
  });
  const agents = { buyer: reference(offer.buyer), provider: reference(offer.provider) };
  const config: DemoValidationPins['config'] = {
    version: 1,
    budget: {
      max_total_mist: '24000', max_channel_deposit_mist: offer.deposit,
      max_turn_mist: '1000', max_outstanding_mist: '1000', max_requests: 4,
      deadline_ms: '9000000000000', output_tranche_bytes: 1024,
    },
    deposit_mist: offer.deposit,
    price: { input_rate: '2', output_rate: '3', denominator: '1' },
    allowed_hosts: ['example.com'],
  };
  const pins: DemoValidationPins = { conversation: request.conversation, configuration_hash: configurationHash, config, agents };
  const identity = (role: MachineRole): DemoIdentity => ({
    name: role === 'coordinator' ? 'local.nozomi.sui' : 'research.nozomi.sui',
    agent: role === 'coordinator' ? agents.buyer : agents.provider,
    controller: role === 'coordinator' ? offer.refund : offer.payee,
    // Other PUBLIC TEST seeds, distinct from both economic test keys.
    transport_key: [...Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(role === 'coordinator' ? 3 : 4)).getPublicKey().toRawBytes()],
    economic_key: [...(role === 'coordinator' ? offer.buyer_key : offer.provider_key)],
    generation: '1', authority_checked_at_ms: '500', alias_state: 'verified',
  });
  const identities = { coordinator: identity('coordinator'), provider: identity('provider') };
  const cursors: Record<MachineRole, SourceCursor> = {
    coordinator: { coordinator: '0', research: '0', host: '0' },
    provider: { coordinator: '0', research: '0', host: '0' },
  };
  const roleStatus = (role: MachineRole): DemoRoleStatus => ({
    version: 1, role, conversation: request.conversation, phase: 'ready', code: null,
    runtime: { version: 1, kind: 'responses-tools-v1', model: 'gpt-5.6-luna', reasoning: 'xhigh' },
    profile_fingerprint: (role === 'coordinator' ? '36' : '37').repeat(32),
    configuration_hash: configurationHash, active_task: null, active_request: null,
    spending_paused: true, waiting_for_credit: false,
    connection: { desired: 'offline', state: 'disconnected', generation: '0', path: 'unknown', changed_at_ms: '500', code: null },
    cursor: structuredClone(cursors[role]),
  });
  const events: DemoEvent[] = [];
  const emit = (source: MachineRole, role: AgentPublicEvent['role'], type: AgentPublicEvent['type'],
    outerRequest: string | null, data: Record<string, unknown>) => {
    const sequence = String(events.length + 1);
    cursors[source][role] = String(BigInt(cursors[source][role]) + 1n);
    events.push({ version: 1, sequence, source, event: {
      version: 1, id: cursors[source][role], role, conversation: request.conversation,
      request: outerRequest, at_ms: String(500 + events.length), type, data: structuredClone(data),
    } });
  };
  let reserved = '0', delivered = '0';
  const budget = (): BudgetSnapshot => ({
    limits: structuredClone(config.budget), channel: binding.channel,
    authorized_mist: reserved, delivered_mist: delivered, redeemed_mist: '0',
    settled_prior_mist: '0', remaining_mist: String(24000n - BigInt(reserved)),
    outstanding_mist: String(BigInt(reserved) - BigInt(delivered)), requests_remaining: 3, uncertain: false,
  });
  emit('coordinator', 'coordinator', 'task_started', null, { task_id: task });
  emit('coordinator', 'coordinator', 'tool_started', request.request, { name: 'research', call_id: tool });
  emit('coordinator', 'host', 'request_started', request.request, { request, request_hash });
  // Deliberately synthetic summaries: not evidence of a dispatched web search.
  emit('provider', 'research', 'tool_started', request.request,
    { name: 'web_search', call_id: '38'.repeat(32), arguments: { query: 'test fixture evidence' } });
  emit('provider', 'research', 'tool_result', request.request,
    { name: 'web_search', call_id: '38'.repeat(32), success: true, result_bytes: 2 });

  const decoder = new TextDecoder('utf-8', { fatal: true });
  let output = '';
  let lastDelivery: SignedData<CheckpointData> | undefined;
  let lastCredit: SignedData<CreditData> | undefined;
  let final: SignedData<CheckpointData> | undefined;
  for (const step of fixture.steps) {
    if (step.kind === 'authorization') {
      lastCredit = step.credit;
      reserved = step.credit.payload.cumulative_amount;
      emit('coordinator', 'host', 'budget', request.request, { ...budget(), action: 'mechanical_credit' });
      emit('coordinator', 'host', 'authorization', request.request, { channel: binding.channel, credit: step.credit, actor: 'host' });
    } else if (step.kind === 'delivery') {
      lastDelivery = step.checkpoint;
      delivered = step.checkpoint.payload.cumulative_amount;
      output += decoder.decode(Uint8Array.from(step.output), { stream: true });
      emit('coordinator', 'host', 'delivery', request.request, { checkpoint: step.checkpoint, output: step.output });
    } else final = step.checkpoint;
  }
  output += decoder.decode();
  if (!lastDelivery || !lastCredit || !final) throw Error('incomplete_test_fixture');
  const receipt: TurnReceipt = {
    version: 2, conversation: request.conversation, request: request.request, request_hash,
    sequence: request.sequence, outcome: 'completed', reason: null,
    checkpoint_hash: checkpointHash(lastDelivery.payload), delivered_units: ['1', '8'],
    generated_output: '8', discarded_output: '0', continuation: 'ready', citations: [],
  };
  emit('coordinator', 'host', 'turn_terminal', request.request, { receipt });
  emit('coordinator', 'coordinator', 'tool_result', request.request,
    { name: 'research', call_id: tool, result: { text: output, receipt } });
  const coordinatorText = 'TEST FIXTURE: the research response was received.';
  emit('coordinator', 'coordinator', 'model_text', null, { text: coordinatorText });
  emit('coordinator', 'host', 'budget', null, budget() as unknown as Record<string, unknown>);
  emit('coordinator', 'host', 'channel_final', null, { checkpoint: final });
  // Runtime event cursor is pre-append, while the final snapshot captures the
  // completed projection cut. Both roles are disconnected in this test input.
  emit('provider', 'host', 'runtime', null, { status: roleStatus('provider') });
  emit('coordinator', 'host', 'runtime', null, { status: roleStatus('coordinator') });

  const snapshot: DemoSnapshot = {
    version: 1, conversation: request.conversation, mode: 'live', network: 'localnet',
    configuration_hash: configurationHash, config, identities,
    roles: { coordinator: roleStatus('coordinator'), provider: roleStatus('provider') },
    provider_observed_at_ms: String(499 + events.length), selected_channel: binding.channel,
    channels: [{
      channel: binding.channel, status: 'unknown', offer: binding.offer, policy: binding.policy,
      signed_credit: lastCredit, checkpoint: final, budget: budget(), delivered_units: ['1', '8'],
      delivered_mist: delivered, signed_authorized_mist: reserved, reserved_mist: reserved,
      outstanding_mist: '12', reserved_exposure_mist: '12',
      // There is NO injected chain observation in the baseline fixture.
      redeemed_mist: null, locked_mist: null, refunded_mist: null, observed_at_ms: null,
      opening: { state: 'unknown', digest: null, gas: null }, terminal: null,
    }],
    projection_sequence: String(events.length), available_controls: ['disconnect', 'reconnect', 'spending'],
  };
  return structuredClone({
    notice: 'TEST FIXTURE — no live agents or payments',
    provenance: 'Synthetic public host/model/tool/identity metadata around engine-verified fixture signatures. No chain observations, real tool dispatch or real runtime execution.',
    pins, snapshot, events, receipt,
    expected: { research_text: output, coordinator_text: coordinatorText, signed_mist: '38', delivered_mist: '26', exposure_mist: '12' },
  });
}
