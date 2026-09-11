import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeReducedDemoState } from './reduced-demo-init.js';
import { DemoProjection } from './agent-demo-projection.js';
import { canonicalDemoJson } from './agent-demo-event-contract.js';
import { DeterministicDemoSupervisor, deterministicSupervisorProfile } from './reduced-demo-supervisor.js';
import { assertResponsesLiveEvidence, openAgentWorker, responsesLimits } from './agent-runtime.js';
import type { DemoHostConfig } from './agent-demo-server.js';
import type { AgentProfile, ResearchPort, ResearchResult } from './agent-service-types.js';

const id = (byte: string) => byte.repeat(64);
const address = (byte: string) => `0x${byte.repeat(64)}`;
const agents = {
  buyer: { network: [1], package_id: address('1'), domain: address('2'), agent: address('3') },
  provider: { network: [1], package_id: address('1'), domain: address('2'), agent: address('4') },
};
const config = {
  version: 1 as const,
  budget: { max_total_mist: '100000', max_channel_deposit_mist: '100000', max_turn_mist: '40000', max_outstanding_mist: '1024', max_requests: 2, deadline_ms: '4102444800000', output_tranche_bytes: 256 },
  deposit_mist: '100000', price: { input_rate: '0', output_rate: '1', denominator: '1' }, allowed_hosts: ['example.com'],
};
function result(request: string): ResearchResult {
  return { text: 'answer', receipt: { version: 2, conversation: id('a'), request, request_hash: [1], sequence: '0', outcome: 'completed', reason: null, checkpoint_hash: [2], delivered_units: ['0', '6'], generated_output: 'answer', discarded_output: '', continuation: 'ready', citations: [] } };
}

const root = await mkdtemp(join(tmpdir(), 'm2m-reduced-demo-'));
try {
  const calls: string[] = [];
  let uncertain = true;
  const port: ResearchPort = {
    async execute(input) { calls.push(input.requestId); if (uncertain) { uncertain = false; throw Error('uncertain_execution'); } return result(input.requestId); },
    async cancel() { return { confirmed: false }; },
  };
  const conversation = id('b'); const configurationHash = id('c');
  const supervisor = await DeterministicDemoSupervisor.open({ stateDir: root, create: true, conversation, configurationHash, port, config });
  assert.equal(supervisor.profile().id, 'm2m.reduced.user-driven.v1');
  assert.deepEqual(deterministicSupervisorProfile().tools, []);
  await assert.rejects(supervisor.run({ id: id('d'), prompt: 'first' }), /uncertain_execution/);
  assert.equal(supervisor.status().state, 'uncertain');
  const completed = await supervisor.run({ id: id('d'), prompt: 'first' });
  assert.equal(completed.receipt.request, id('d'));
  assert.deepEqual(calls, [id('d'), id('d')]);
  await assert.rejects(supervisor.run({ id: id('d'), prompt: 'changed' }), /request_conflict/);
  await supervisor.run({ id: id('e'), prompt: 'second' });
  await assert.rejects(supervisor.run({ id: id('f'), prompt: 'third' }), /limit_exceeded/);
  const reopened = await DeterministicDemoSupervisor.open({ stateDir: root, create: false, conversation, configurationHash, port, config });
  const replay = await reopened.run({ id: id('d'), prompt: 'first' });
  assert.equal(replay.receipt.request, id('d'));
  assert.deepEqual(calls, [id('d'), id('d'), id('e')]);

  const evidencePath = join(root, 'responses-live-evidence.json');
  const summary = { state: 'completed', creates: 2, userCreateCount: 1, continuationCreateCount: 1, callbackCount: 1,
    markerObservedInOutput: true, userCreatePreviousResponseIdPresent: true, prohibitedToolsSubmitted: 0, rejectedDispatchCount: 3,
    sentinelState: { filesystem: false, process: false, network: false }, sentinelAttempts: ['filesystem_write', 'process_exec', 'network_fetch'] };
  await writeFile(evidencePath, JSON.stringify({ version: 1, runtime: 'responses-tools-v1', model: 'gpt-5.6-luna', effort: 'xhigh', initial: { ...summary, creates: 1 }, restart: summary }), { mode: 0o600 });
  assertResponsesLiveEvidence(evidencePath);
  const unreviewedProfile: AgentProfile = { id: 'unreviewed-profile', baseInstructions: 'fixture', developerInstructions: 'fixture', tools: [{ name: 'shell', description: 'unreviewed forbidden tool', inputSchema: { type: 'object', properties: { command: { type: 'string', maxLength: 64 } }, required: ['command'], additionalProperties: false } }], maxToolCalls: 1, maxToolResultBytes: 1024, recoverableTools: [], handleTool: async () => ({ success: false, text: 'fixture' }) };
  await assert.rejects(() => openAgentWorker({ descriptor: { version: 1, kind: 'responses-tools-v1', model: 'gpt-5.6-luna', reasoning: 'xhigh' }, stateDir: root, create: true, profile: unreviewedProfile, apiKey: 'fixture-only', limits: responsesLimits('provider'), evidenceFile: evidencePath }), /agent_tool_runtime_unvalidated/);
  const forgedEvidencePath = join(root, 'responses-live-evidence-forged.json'); const forgedEvidence = JSON.parse(await readFile(evidencePath, 'utf8')) as { initial: { sentinelAttempts: string[] } };
  forgedEvidence.initial.sentinelAttempts = ['a', 'b', 'c']; await writeFile(forgedEvidencePath, JSON.stringify(forgedEvidence), { mode: 0o600 });
  await assert.rejects(() => openAgentWorker({ descriptor: { version: 1, kind: 'responses-tools-v1', model: 'gpt-5.6-luna', reasoning: 'xhigh' }, stateDir: root, create: true, profile: unreviewedProfile, apiKey: 'fixture-only', limits: responsesLimits('provider'), evidenceFile: forgedEvidencePath }), /invalid_live_evidence/);
  await chmod(evidencePath, 0o644);
  assert.throws(() => assertResponsesLiveEvidence(evidencePath), /unsafe_live_evidence/);
  await chmod(evidencePath, 0o600);

  const initializedState = await mkdtemp(join(root, 'initialized-'));
  const base = { version: 1 as const, state_dir: initializedState, conversation, network: 'testnet' as const, config, runtime: { version: 1 as const, kind: 'responses-tools-v1' as const, model: 'gpt-5.6-luna' as const, reasoning: 'xhigh' as const }, agents,
    projection_state_dir: join(initializedState, 'projection'), static_dir: join(initializedState, 'ui'), bind_host: '0.0.0.0', port: 8080, provider_base_url: 'http://provider:8081', model_api_key_file: join(initializedState, 'model.key'), observer_token_file: join(initializedState, 'observer.token') };
  await initializeReducedDemoState({ ...base, role: 'coordinator', public_origin: 'https://demo.example', wallet_file: join(initializedState, 'wallet.key'), viewer_token_file: join(initializedState, 'viewer.token'), operator_token_file: join(initializedState, 'operator.token') } as DemoHostConfig);
  await initializeReducedDemoState({ ...base, role: 'provider', bind_host: 'fly-local-6pn', port: 8081, search_api_key_file: join(initializedState, 'search.key') } as DemoHostConfig);
  for (const role of ['coordinator', 'provider']) {
    const roleRoot = join(initializedState, 'agent-services', conversation, role);
    assert.equal((await stat(join(roleRoot, '.agent-services.lock'))).isFile(), true);
    assert.deepEqual(JSON.parse(await readFile(join(roleRoot, 'manifest.json'), 'utf8')).configuration_hash.length, 64);
    assert.equal(JSON.parse(await readFile(join(roleRoot, 'runtime.json'), 'utf8')).desired, 'offline');
  }
  const configuration_hash = createHash('sha256').update(canonicalDemoJson({ config, agents }), 'utf8').digest('hex');
  const projection = await DemoProjection.open({ stateDir: join(initializedState, 'projection'), create: false, conversation, pins: { conversation, configuration_hash, config, agents } });
  assert.equal(projection.highWater(), '0'); await projection.close();
  await assert.rejects(initializeReducedDemoState({ ...base, role: 'coordinator' } as DemoHostConfig), /already_initialized/);
  const orphanRoot = await mkdtemp(join(root, 'orphan-'));
  const orphanRole = join(orphanRoot, 'agent-services', conversation, 'provider');
  await mkdir(orphanRole, { recursive: true, mode: 0o700 });
  await writeFile(join(orphanRole, 'host.json'), JSON.stringify({ retained: 'channel' }), { mode: 0o600 });
  await assert.rejects(initializeReducedDemoState({ ...base, state_dir: orphanRoot, role: 'provider' } as DemoHostConfig), /already_initialized/);
  assert.equal(JSON.parse(await readFile(join(orphanRole, 'host.json'), 'utf8')).retained, 'channel');
  console.log('PASS reduced demo: deterministic supervisor exact replay/uncertainty, bounded provider evidence gate, and effect-free two-role initialization');
} finally { await rm(root, { recursive: true, force: true }); }
