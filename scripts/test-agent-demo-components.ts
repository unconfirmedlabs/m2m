/** Crash-boundary snapshots around actual BudgetLedger construction. No RPC,
 * model, signing or funding. An interrupted intent is never an empty reset.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoComponents } from './agent-demo-components.js';
import { BudgetLedger } from './agent-coordinator.js';
import { save, type AgentRef } from './native-chain.js';

const address = (byte: string) => '0x' + byte.repeat(32);
const ref = (byte: string): AgentRef => ({ network: [1], package_id: address('01'), domain: address('02'), agent: address(byte) });
const limits = { max_total_mist: '100000', max_channel_deposit_mist: '10000', max_turn_mist: '10000', max_outstanding_mist: '10000', max_requests: 4, deadline_ms: '4102444800000', output_tranche_bytes: 1024 };
const pins = { role: 'coordinator' as const, conversation: '03'.repeat(32), configuration_hash: '04'.repeat(32), test_dependencies_used: true };
const root = await mkdtemp(join(tmpdir(), 'm2m-component-recovery-'));
let budget: BudgetLedger | undefined;
const construct = (directory: string, create: boolean) => BudgetLedger.open({ stateDir: join(directory, 'budget'), create, limits, buyer: ref('05'), provider: ref('06') });
try {
  // Crash before the intent: a retained empty registry permits first creation.
  const unused = join(root, 'unused');
  await DemoComponents.open(unused, true, pins);
  let components = await DemoComponents.open(unused, false, pins);
  budget = await components.openComponent('budget', create => { assert.equal(create, true); return construct(unused, create); });
  await budget.reserveFunding('07'.repeat(32), '1000');
  const snapshot = budget.snapshot(); await budget.close(); budget = undefined;
  components = await DemoComponents.open(unused, false, pins);
  budget = await components.openComponent('budget', create => { assert.equal(create, false); return construct(unused, create); });
  assert.deepEqual(budget.snapshot(), snapshot); await budget.close(); budget = undefined;

  // Crash after the intent but before the constructor result: refuse missing
  // state, because it is indistinguishable from subsequent journal loss.
  const beforeResult = join(root, 'before-result');
  components = await DemoComponents.open(beforeResult, true, pins);
  await assert.rejects(components.openComponent('budget', async () => { throw Error('injected_crash_before_result'); }), /injected_crash/);
  await assert.rejects(DemoComponents.open(beforeResult, false, pins), /journal_missing/);
  let invoked = false;
  await assert.rejects(components.openComponent('budget', async () => { invoked = true; }), /journal_missing/);
  assert.equal(invoked, false);

  // Crash after the durable constructor result but before the ready marker:
  // validate/reopen the original journal rather than constructing a new one.
  const afterResult = join(root, 'after-result');
  components = await DemoComponents.open(afterResult, true, pins);
  await assert.rejects(components.openComponent('budget', async create => {
    budget = await construct(afterResult, create);
    await budget.reserveFunding('08'.repeat(32), '900');
    await budget.close(); budget = undefined;
    throw Error('injected_crash_after_result');
  }), /injected_crash/);
  const retained = await readFile(join(afterResult, 'budget/budget.json'), 'utf8');
  components = await DemoComponents.open(afterResult, false, pins);
  budget = await components.openComponent('budget', create => { assert.equal(create, false); return construct(afterResult, create); });
  await budget.close(); budget = undefined;
  assert.equal(await readFile(join(afterResult, 'budget/budget.json'), 'utf8'), retained);
  assert.equal(JSON.parse(await readFile(join(afterResult, 'components.json'), 'utf8')).entries.budget.state, 'ready');

  for (const state of ['initializing', 'ready']) {
    const loss = join(root, `loss-${state}`);
    components = await DemoComponents.open(loss, true, pins);
    budget = await components.openComponent('budget', create => construct(loss, create));
    await budget.close(); budget = undefined;
    const path = join(loss, 'components.json');
    const registry = JSON.parse(await readFile(path, 'utf8')); registry.entries.budget.state = state;
    await save(path, registry); await rm(join(loss, 'budget/budget.json'));
    await assert.rejects(DemoComponents.open(loss, false, pins), /journal_missing/);
  }
  await assert.rejects(DemoComponents.open(unused, false, { ...pins, test_dependencies_used: false }), /journal_corrupt/);
  await assert.rejects(DemoComponents.open(unused, false, { ...pins, configuration_hash: '09'.repeat(32) }), /journal_corrupt/);
  // Missing credentials / the live gate do not strand a never-created worker.
  // The same error after a partial result must retain the pending intent.
  for (const code of ['openai_credential_unavailable', 'agent_tool_runtime_unvalidated']) {
    const directory = join(root, code);
    components = await DemoComponents.open(directory, true, pins);
    await assert.rejects(components.openComponent('worker', async () => { throw Error(code); }), new RegExp(code));
    components = await DemoComponents.open(directory, false, pins);
    await assert.rejects(components.openComponent('worker', async create => {
      assert.equal(create, true);
      await save(join(directory, 'worker/responses-worker.json'), { fixture_only: true });
      throw Error(code);
    }), new RegExp(code));
    await assert.rejects(DemoComponents.open(directory, false, pins), /journal_missing/);
  }
  const registryPath = join(unused, 'components.json');
  const altered = JSON.parse(await readFile(registryPath, 'utf8')); altered.entries.budget.files = ['../budget.json'];
  await save(registryPath, altered);
  await assert.rejects(DemoComponents.open(unused, false, pins), /journal_corrupt/);
  console.log('PASS component initialization: unused/reopen, interrupted intent/result, retained reservation, initialized loss, immutable paths/provenance');
} finally {
  await budget?.close(); await rm(root, { recursive: true, force: true });
}
