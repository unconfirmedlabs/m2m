import assert from 'node:assert/strict';
import { createPublicSessionFixture } from '../tests/agent-demo/public-session.js';
import type { DemoEvent, DemoValidationPins } from './demo-types.js';
import {
  DemoContractError, canonicalDemoJson, decodeSourceCursor, encodeSourceCursor,
  parseDemoJson, validateDemoControl, validateDemoControlRecord, validateDemoEvent, validateDemoRoleStatus, validateDemoSessionResponse,
  validateDemoSnapshot, validateDemoSourceEvent, validateDemoSourcePage, validateDemoStreamStatus,
} from './agent-demo-event-contract.js';

const fixture = createPublicSessionFixture();
const { pins, snapshot, events } = fixture;
const expectCode = (code: string, work: () => unknown) => {
  assert.throws(work, error => error instanceof DemoContractError && error.code === code);
};

function run(): void {
  const originalSnapshot = structuredClone(snapshot);
  assert.equal(parseDemoJson('{"b":2,"a":[true,null]}') instanceof Object, true);
  assert.equal(canonicalDemoJson({ b: 2, a: [true, null] }), '{"a":[true,null],"b":2}');
  expectCode('invalid_json', () => parseDemoJson('{"a":1,"a":2}'));
  expectCode('invalid_json', () => parseDemoJson('{"__proto__":1}'));
  expectCode('invalid_json', () => parseDemoJson('"\\ud800"'));
  expectCode('invalid_json', () => parseDemoJson('1 trailing'));
  expectCode('invalid_json', () => parseDemoJson('x'.repeat(2_000), 1_024));
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  expectCode('invalid_json', () => canonicalDemoJson(cyclic));
  const accessor = {}; Object.defineProperty(accessor, 'a', { get: () => 1, enumerable: true });
  expectCode('invalid_json', () => canonicalDemoJson(accessor));

  const cursor = { coordinator: '0', research: '12', host: '18446744073709551615' };
  const encoded = encodeSourceCursor(cursor); assert.deepEqual(decodeSourceCursor(encoded), cursor);
  expectCode('invalid_event_cursor', () => decodeSourceCursor(`${encoded}=`));
  expectCode('invalid_event', () => encodeSourceCursor({ ...cursor, research: '01' }));

  const checkedSnapshot = validateDemoSnapshot(snapshot, pins); assert.deepEqual(checkedSnapshot.conversation, pins.conversation);
  assert.deepEqual(snapshot, originalSnapshot);
  const checkedSession = validateDemoSessionResponse({ version: 1, access: 'viewer', snapshot }, pins);
  assert.equal(checkedSession.snapshot.channels[0]?.outstanding_mist, '12');
  expectCode('invalid_snapshot', () => validateDemoSnapshot({ ...snapshot, configuration_hash: '00'.repeat(32) }, pins));
  expectCode('invalid_snapshot', () => validateDemoSnapshot({ ...snapshot, channels: [{ ...snapshot.channels[0], outstanding_mist: '0' }] }, pins));
  const closedBudget = { ...snapshot.channels[0].budget, channel: null, authorized_mist: '0', delivered_mist: '0', redeemed_mist: '0', settled_prior_mist: '26', remaining_mist: '23974', outstanding_mist: '0' };
  const confirmedChannel = { ...snapshot.channels[0], status: 'closed' as const, budget: closedBudget, outstanding_mist: '0', reserved_exposure_mist: '0', redeemed_mist: '26', locked_mist: '0', observed_at_ms: '700', terminal: { state: 'confirmed' as const, digest: '1'.repeat(32), gas: null } };
  validateDemoSnapshot({ ...snapshot, channels: [confirmedChannel] }, pins);
  const pendingTerminal = { ...confirmedChannel, terminal: { state: 'pending' as const, digest: null, gas: null } };
  expectCode('invalid_snapshot', () => validateDemoSnapshot({ ...snapshot, channels: [pendingTerminal] }, pins));

  const checked = events.map(event => validateDemoEvent(event, pins)); assert.equal(checked.length, events.length);
  const sourceEvents = events.filter(event => event.source === 'coordinator').map(event => event.event);
  for (const event of sourceEvents) validateDemoSourceEvent(event, { ...pins, source: 'coordinator' });
  const sourcePage = validateDemoSourcePage({ version: 1, conversation: pins.conversation, source: 'coordinator', events: sourceEvents, high_water: { coordinator: '4', research: '0', host: '12' }, has_more: false }, { ...pins, source: 'coordinator' });
  assert.equal(sourcePage.events.length, sourceEvents.length);
  const status = validateDemoStreamStatus({ version: 1, conversation: pins.conversation, state: 'live', high_water: '21' }, pins.conversation);
  assert.equal(status.high_water, '21');

  const request = events.find(event => event.event.type === 'request_started')?.event.request as string;
  const budgetData = events.find(event => event.event.type === 'budget' && event.event.request === request)?.event.data;
  const budgetNullData = events.find(event => event.event.type === 'budget' && event.event.request === null)?.event.data;
  const checkpointData = events.find(event => event.event.type === 'delivery')?.event.data as Record<string, unknown>;
  const receiptData = events.find(event => event.event.type === 'turn_terminal')?.event.data as Record<string, unknown>;
  const event = (source: 'coordinator' | 'provider', role: 'coordinator' | 'research' | 'host', type: string, outerRequest: string | null, data: Record<string, unknown>, n: number) => validateDemoSourceEvent({ version: 1, id: String(n), role, conversation: pins.conversation, request: outerRequest, at_ms: '600', type, data }, { ...pins, source });
  event('coordinator', 'coordinator', 'tool_result', null, { name: 'budget', call_id: '40'.repeat(32), result: { snapshot: budgetNullData } }, 41);
  event('coordinator', 'coordinator', 'tool_result', null, { name: 'stop', call_id: '41'.repeat(32), result: { stopped: true } }, 42);
  event('coordinator', 'coordinator', 'tool_result', request, { name: 'research', call_id: '42'.repeat(32), success: false, code: 'budget_rejected' }, 43);
  event('coordinator', 'host', 'tool_result', '43'.repeat(32), { name: 'operator.task', call_id: '43'.repeat(32), result: { state: 'uncertain', text: 'pending' } }, 44);
  event('coordinator', 'host', 'tool_result', null, { name: 'operator.status', call_id: '44'.repeat(32), result: { activeTask: null, activeRequest: null, state: 'idle' } }, 45);
  event('coordinator', 'host', 'request_started', request, { request: (events.find(item => item.event.type === 'request_started')?.event.data as Record<string, unknown>).request, request_hash: (events.find(item => item.event.type === 'request_started')?.event.data as Record<string, unknown>).request_hash }, 46);
  event('coordinator', 'host', 'delivery', request, checkpointData, 47);
  event('coordinator', 'host', 'turn_terminal', request, receiptData, 48);
  event('coordinator', 'host', 'budget', null, budgetNullData as Record<string, unknown>, 49);
  event('coordinator', 'host', 'settlement', null, { channel: snapshot.channels[0].channel, status: 'closed', digest: '1'.repeat(32), paid_mist: '1', refund_mist: '0' }, 50);
  event('provider', 'research', 'tool_started', request, { name: 'web_fetch', call_id: '45'.repeat(32), arguments: { url: 'https://example.com/path' } }, 51);
  event('provider', 'research', 'tool_result', request, { name: 'web_fetch', call_id: '45'.repeat(32), success: false, result_bytes: 0 }, 52);
  event('coordinator', 'host', 'connection', null, { connection: { desired: 'online', state: 'connected', generation: '1', path: 'direct', changed_at_ms: '600', code: null }, actor: 'operator' }, 53);
  event('coordinator', 'host', 'control', null, { control: { version: 1, id: '46'.repeat(32), command: { op: 'disconnect' }, state: 'completed', code: null, accepted_at_ms: '1', updated_at_ms: '2', task: null, channel: null } }, 54);
  event('coordinator', 'host', 'funding', null, { channel: snapshot.channels[0].channel, opening_nonce: '47'.repeat(32), deposit_mist: pins.config.deposit_mist, transaction: { state: 'unknown', digest: null, gas: null } }, 55);
  event('coordinator', 'host', 'authorization', request, { channel: snapshot.channels[0].channel, credit: (events.find(item => item.event.type === 'authorization')?.event.data as Record<string, unknown>).credit, actor: 'host' }, 56);
  event('coordinator', 'host', 'chain_observation', null, { channel: snapshot.channels[0].channel, status: 'open', redeemed_mist: '0', locked_mist: '10', refunded_mist: null, observed_at_ms: '601', terminal: null }, 57);

  const controlId = '39'.repeat(32);
  validateDemoControl({ version: 1, id: controlId, command: { op: 'spending', paused: true } });
  expectCode('invalid_event', () => validateDemoControl({ version: 1, id: controlId, command: { op: 'task', prompt: 'x', secret: 'bad' } }));
  const hostEvent = events.find(event => event.event.type === 'runtime');
  assert(hostEvent);
  expectCode('invalid_event', () => validateDemoEvent({ ...hostEvent, source: 'provider', event: { ...hostEvent.event, role: 'coordinator' } }, pins));
  const delivery = events.find(event => event.event.type === 'delivery');
  assert(delivery);
  expectCode('invalid_event', () => validateDemoEvent({ ...delivery, event: { ...delivery.event, role: 'research' } }, pins));
  const malformed = structuredClone(events[0]) as DemoEvent;
  malformed.event.data = { ...(malformed.event.data as object), unexpected_secret: true };
  expectCode('invalid_event', () => validateDemoEvent(malformed, pins));
  expectCode('invalid_stream_status', () => validateDemoStreamStatus({ version: 1, conversation: pins.conversation, state: 'live', high_water: '01' }, pins.conversation));

  // E1: provenance and scalar-enum boundaries are fixed, not String-coerced.
  const operatorTask = { version: 1, id: '60', role: 'host' as const, conversation: pins.conversation, request,
    at_ms: '600', type: 'tool_result' as const, data: { name: 'operator.task', call_id: request, result: { state: 'completed', text: 'ok' } } };
  expectCode('invalid_event', () => validateDemoSourceEvent(operatorTask, { ...pins, source: 'provider' }));
  const operatorStatus = { ...operatorTask, id: '61', request: null, data: { name: 'operator.status', call_id: '61'.repeat(32), result: { activeTask: null, activeRequest: null, state: { hidden: true } } } };
  expectCode('invalid_event', () => validateDemoSourceEvent(operatorStatus, { ...pins, source: 'coordinator' }));
  const badReceipt = structuredClone(receiptData) as Record<string, unknown>;
  badReceipt.receipt = { ...(badReceipt.receipt as Record<string, unknown>), outcome: ['completed'] };
  expectCode('invalid_event', () => event('coordinator', 'host', 'turn_terminal', request, badReceipt, 62));
  const badConnection = { connection: { desired: ['online'], state: 'connected', generation: '1', path: 'direct', changed_at_ms: '600', code: null }, actor: 'operator' };
  expectCode('invalid_event', () => event('coordinator', 'host', 'connection', null, badConnection, 63));

  // E2/E3: unsigned reserved ceilings are distinct from signed exposure, while
  // present checkpoint/refund/payment fields remain mutually consistent.
  const reservedSnapshot = structuredClone(snapshot);
  const reservedChannel = reservedSnapshot.channels[0];
  reservedChannel.budget.authorized_mist = '50'; reservedChannel.budget.outstanding_mist = '24'; reservedChannel.budget.remaining_mist = '23950';
  reservedChannel.reserved_mist = '50'; reservedChannel.reserved_exposure_mist = '24';
  reservedChannel.signed_authorized_mist = '38'; reservedChannel.outstanding_mist = '12';
  validateDemoSnapshot(reservedSnapshot, pins);
  const zeroSnapshot = structuredClone(snapshot);
  const zeroChannel = zeroSnapshot.channels[0];
  zeroChannel.signed_credit = null; zeroChannel.checkpoint = null; zeroChannel.delivered_units = ['0', '0']; zeroChannel.delivered_mist = '0'; zeroChannel.signed_authorized_mist = '0'; zeroChannel.reserved_mist = '0'; zeroChannel.outstanding_mist = '0'; zeroChannel.reserved_exposure_mist = '0';
  zeroChannel.budget.authorized_mist = '0'; zeroChannel.budget.delivered_mist = '0'; zeroChannel.budget.outstanding_mist = '0'; zeroChannel.budget.remaining_mist = '24000';
  validateDemoSnapshot(zeroSnapshot, pins);
  expectCode('invalid_snapshot', () => validateDemoSnapshot({ ...snapshot, channels: [{ ...snapshot.channels[0], checkpoint: null }] }, pins));
  const oldCheckpoint = structuredClone(snapshot.channels[0].checkpoint);
  assert(oldCheckpoint);
  oldCheckpoint.payload.cumulative_amount = '2';
  expectCode('invalid_snapshot', () => validateDemoSnapshot({ ...snapshot, channels: [{ ...snapshot.channels[0], checkpoint: oldCheckpoint }] }, pins));
  expectCode('invalid_snapshot', () => validateDemoSnapshot({ ...snapshot, channels: [{ ...snapshot.channels[0], refunded_mist: '123' }] }, pins));
  expectCode('invalid_snapshot', () => validateDemoSnapshot({ ...snapshot, channels: [{ ...snapshot.channels[0], redeemed_mist: '12001' }] }, pins));
  expectCode('invalid_snapshot', () => validateDemoSnapshot({ ...snapshot, channels: [snapshot.channels[0], snapshot.channels[0]] }, pins));

  // E4: statement/lifecycle relationships and fixed economic terms.
  const deliveryCheckpoint = structuredClone(checkpointData.checkpoint) as Record<string, unknown>;
  expectCode('invalid_event', () => event('coordinator', 'host', 'channel_final', null, { checkpoint: deliveryCheckpoint }, 64));
  const badCredit = structuredClone((events.find(item => item.event.type === 'authorization')?.event.data as Record<string, unknown>).credit) as Record<string, unknown>;
  (badCredit.payload as Record<string, unknown>).cumulative_amount = '1';
  expectCode('invalid_event', () => event('coordinator', 'host', 'authorization', request, { channel: snapshot.channels[0].channel, credit: badCredit, actor: 'host' }, 65));
  const badReceiptBounds = structuredClone(receiptData.receipt) as Record<string, unknown>;
  badReceiptBounds.generated_output = '1'; badReceiptBounds.discarded_output = '2';
  expectCode('invalid_event', () => event('coordinator', 'host', 'turn_terminal', request, { receipt: badReceiptBounds }, 66));
  expectCode('invalid_event', () => validateDemoSourcePage({ version: 1, conversation: pins.conversation, source: 'coordinator', events: sourceEvents, high_water: { coordinator: '4', research: '0', host: '99' }, has_more: false }, { ...pins, source: 'coordinator' }));
  assert.equal(validateDemoSourcePage({ version: 1, conversation: pins.conversation, source: 'coordinator', events: sourceEvents, high_water: { coordinator: '4', research: '0', host: '99' }, has_more: true }, { ...pins, source: 'coordinator' }).high_water.host, '99');

  // E5/E6: outputs detach trusted pins and reject key/prototype/accessor traps.
  const detachedSnapshot = validateDemoSnapshot(snapshot, pins);
  detachedSnapshot.config.price.input_rate = '99';
  assert.equal(pins.config.price.input_rate, '2');
  assert.equal(snapshot.config.price.input_rate, '2');
  const sameKeys = structuredClone(snapshot);
  sameKeys.identities.coordinator.transport_key = [...sameKeys.identities.coordinator.economic_key];
  expectCode('invalid_snapshot', () => validateDemoSnapshot(sameKeys, pins));
  const mismatchedNetwork = structuredClone(snapshot);
  mismatchedNetwork.identities.provider.agent.network = [9];
  expectCode('invalid_snapshot', () => validateDemoSnapshot(mismatchedNetwork, pins));
  const zeroTurn = structuredClone(snapshot);
  zeroTurn.config.budget.max_turn_mist = '0';
  expectCode('invalid_snapshot', () => validateDemoSnapshot(zeroTurn, pins));
  const commandGetter: Record<string, unknown> = { op: 'task', prompt: 'ok' };
  Object.defineProperty(commandGetter, 'prompt', { enumerable: true, get: () => { throw Error('TEST_FIXTURE_PRIVATE_ERROR'); } });
  expectCode('invalid_event', () => validateDemoControl({ version: 1, id: '67'.repeat(32), command: commandGetter }));
  const arrayGetter: unknown[] = [];
  Object.defineProperty(arrayGetter, '0', { enumerable: true, get: () => { throw Error('TEST_FIXTURE_PRIVATE_ERROR'); } });
  Object.defineProperty(arrayGetter, 'length', { value: 1, writable: true, enumerable: false, configurable: false });
  expectCode('invalid_json', () => canonicalDemoJson(arrayGetter));
  expectCode('invalid_json', () => canonicalDemoJson({ '\ud800': 1 }));
  assert.equal(canonicalDemoJson('x'.repeat(32_769)).length, 32_771);

  // E5 exported role/control entrypoints and E7 legal fixed cases.
  validateDemoRoleStatus(snapshot.roles.coordinator, { ...pins, source: 'coordinator' });
  validateDemoControlRecord({ version: 1, id: '68'.repeat(32), command: { op: 'spending', paused: true }, state: 'completed', code: null, accepted_at_ms: '1', updated_at_ms: '2', task: null, channel: null }, pins);
  expectCode('invalid_event', () => validateDemoControlRecord({ version: 1, id: '68'.repeat(32), command: { op: 'fund', configuration_hash: '69'.repeat(32), previous_channel: null }, state: 'accepted', code: null, accepted_at_ms: '1', updated_at_ms: '1', task: null, channel: null }, pins));
  event('coordinator', 'coordinator', 'error', null, { code: 'backend_unavailable' }, 69);
  const sameRecipientSnapshot = structuredClone(snapshot);
  sameRecipientSnapshot.channels[0].offer.payload.refund = sameRecipientSnapshot.channels[0].offer.payload.payee;
  validateDemoSnapshot(sameRecipientSnapshot, pins);

  // ER-02: nested unknown values must be inspected before any getter read or
  // byte-array sanitization.
  const getterSnapshot = structuredClone(snapshot);
  let agentReads = 0;
  Object.defineProperty(getterSnapshot.identities.coordinator.agent, 'agent', { enumerable: true, get: () => { agentReads += 1; return snapshot.identities.coordinator.agent.agent; } });
  expectCode('invalid_snapshot', () => validateDemoSnapshot(getterSnapshot, pins));
  assert.equal(agentReads, 0);
  const authorizationEvent = events.find(item => item.event.type === 'authorization');
  assert(authorizationEvent);
  const getterAuthorization = structuredClone(authorizationEvent);
  const purpose = ((getterAuthorization.event.data as Record<string, unknown>).credit as Record<string, unknown>).payload as Record<string, unknown>;
  const purposeBytes = purpose.purpose as number[]; let purposeReads = 0;
  Object.defineProperty(purposeBytes, '0', { enumerable: true, get: () => { purposeReads += 1; return 109; } });
  expectCode('invalid_event', () => validateDemoEvent(getterAuthorization, pins));
  assert.equal(purposeReads, 0);
  const extraMethod = structuredClone(authorizationEvent);
  const method = (((extraMethod.event.data as Record<string, unknown>).credit as Record<string, unknown>).payload as Record<string, unknown>).method as number[];
  (method as number[] & { extra?: string }).extra = 'TEST_FIXTURE_PRIVATE';
  expectCode('invalid_event', () => validateDemoEvent(extraMethod, pins));

  // ER-03: chain observations cannot combine open status with refunds or a
  // terminal transaction, while a complete present-field refund is accepted.
  const chain = (data: Record<string, unknown>, n: number) => event('coordinator', 'host', 'chain_observation', null, data, n);
  const chainBase = { channel: snapshot.channels[0].channel, status: 'open', redeemed_mist: '0', locked_mist: '12000', refunded_mist: null, observed_at_ms: '600', terminal: null };
  chain(chainBase, 70);
  expectCode('invalid_event', () => chain({ ...chainBase, refunded_mist: '100' }, 71));
  expectCode('invalid_event', () => chain({ ...chainBase, terminal: { state: 'unknown', digest: null, gas: null } }, 72));
  expectCode('invalid_event', () => chain({ ...chainBase, terminal: { state: 'confirmed', digest: '1'.repeat(32), gas: null } }, 73));
  chain({ channel: snapshot.channels[0].channel, status: 'refunded', redeemed_mist: '0', locked_mist: '0', refunded_mist: pins.config.deposit_mist, observed_at_ms: '600', terminal: { state: 'confirmed', digest: '1'.repeat(32), gas: null } }, 74);

  // ER-04: both participants remain in the same qualified package/domain
  // namespace as the pinned native agreement.
  const providerPackage = structuredClone(snapshot);
  providerPackage.identities.provider.agent.package_id = '0x09'.repeat(32);
  expectCode('invalid_snapshot', () => validateDemoSnapshot(providerPackage));
  const changedPackagePins = structuredClone(pins);
  changedPackagePins.agents.provider.package_id = '0x09'.repeat(32);
  expectCode('invalid_snapshot', () => validateDemoSnapshot(providerPackage, changedPackagePins));
  const providerDomain = structuredClone(snapshot);
  providerDomain.identities.provider.agent.domain = '0x0a'.repeat(32);
  expectCode('invalid_snapshot', () => validateDemoSnapshot(providerDomain));
  const changedDomainPins = structuredClone(pins);
  changedDomainPins.agents.provider.domain = '0x0a'.repeat(32);
  expectCode('invalid_snapshot', () => validateDemoSnapshot(providerDomain, changedDomainPins));

  // ER-05: delivered coordinator summaries use the tool-result/source-event
  // envelope ceiling, while coordinator answer text keeps its 32 KiB cap.
  const coordinatorResult = events.find(item => item.event.type === 'tool_result' && item.event.role === 'coordinator' && item.event.request !== null);
  assert(coordinatorResult);
  const longSummary = structuredClone(coordinatorResult);
  (((longSummary.event.data as Record<string, unknown>).result as Record<string, unknown>).text as string) = 'x'.repeat(32_769);
  validateDemoEvent(longSummary, pins);
  const envelopeLimitSummary = structuredClone(coordinatorResult);
  (((envelopeLimitSummary.event.data as Record<string, unknown>).result as Record<string, unknown>).text as string) = 'x'.repeat(65_536);
  expectCode('invalid_event', () => validateDemoEvent(envelopeLimitSummary, pins));
  const oversizedSummary = structuredClone(coordinatorResult);
  (((oversizedSummary.event.data as Record<string, unknown>).result as Record<string, unknown>).text as string) = 'x'.repeat(65_537);
  expectCode('invalid_event', () => validateDemoEvent(oversizedSummary, pins));
  const longAnswer = structuredClone(events.find(item => item.event.type === 'model_text'));
  assert(longAnswer);
  (longAnswer.event.data as Record<string, unknown>).text = 'x'.repeat(32_769);
  expectCode('invalid_event', () => validateDemoEvent(longAnswer, pins));

  process.stdout.write('agent demo event contract tests: ok\n');
}

run();
