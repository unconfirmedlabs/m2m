/** Real coordinator/worker seam, with explicit injected model/ResearchPort fixtures.
 * No Iroh, Sui transactions, API credentials, search or live inference.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentCoordinator, BudgetLedger } from './agent-coordinator.js';
import { ResponsesWorker } from './responses-worker.js';
import { responsesLimits, type AgentRuntimeDescriptor } from './agent-runtime.js';
import type { AgentRef } from './native-chain.js';
import type { AgentProfile, AgentToolCall, ResearchPort, ResearchResult } from './agent-service-types.js';
import type {
  ResponsesCreateBody, ResponsesEvent, ResponsesHttpOptions,
  ResponsesSnapshot, ResponsesTransport,
} from './responses-transport.js';
import { makePolicy } from './streaming-codec.js';

if (process.argv.length > 2) throw Error('fixture_test_takes_no_arguments');

const address = (byte: string) => `0x${byte.repeat(32)}`;
const conversation = '31'.repeat(32), task = '32'.repeat(32);
const buyer: AgentRef = { network: [116, 101, 115, 116], package_id: address('01'), domain: address('02'), agent: address('03') };
const provider: AgentRef = { ...buyer, agent: address('04') };
const descriptor: AgentRuntimeDescriptor = { version: 1, kind: 'responses-tools-v1', model: 'gpt-5.6-luna', reasoning: 'xhigh' };

class SeamTransport implements ResponsesTransport {
  readonly bodies: ResponsesCreateBody[] = [];
  readonly snapshots = new Map<string, ResponsesSnapshot>();
  readonly requests: string[] = [];
  readonly retrievals: string[] = [];
  close(): void {}
  async create(body: ResponsesCreateBody, options: ResponsesHttpOptions & { clientRequestId: string }): Promise<AsyncIterable<ResponsesEvent>> {
    assert.equal(options.signal.aborted, false);
    this.bodies.push(structuredClone(body)); this.requests.push(options.clientRequestId);
    const first = this.bodies.length === 1;
    const id = `resp_seam_${this.bodies.length}`;
    const item = first
      ? { type: 'function_call', id: 'fc_seam', call_id: 'call_seam', name: 'research', arguments: '{"question":"Compare the fixture evidence."}', status: 'completed' }
      : { type: 'message', id: 'msg_seam', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Fixture evidence received.', annotations: [] }] };
    // Include the effective execution metadata the host must validate. These
    // values come from its actual submitted body, not a second fixture policy.
    const metadata = {
      id, model: body.model, reasoning: body.reasoning, instructions: body.instructions,
      tools: body.tools, tool_choice: body.tool_choice, parallel_tool_calls: body.parallel_tool_calls,
      background: body.background, store: body.store, truncation: body.truncation,
      max_output_tokens: body.max_output_tokens, previous_response_id: body.previous_response_id ?? null,
    };
    const snapshot: ResponsesSnapshot = { ...metadata, status: 'completed', output: [item], usage: null };
    this.snapshots.set(id, snapshot);
    // Fields checked against the official streaming event schema, 2026-09-11:
    // https://developers.openai.com/api/reference/resources/responses/streaming-events
    // Item events carry item identity; only response payloads carry response ID.
    const events: ResponsesEvent[] = [
      { type: 'response.created', sequence_number: 0, response: { ...metadata, status: 'in_progress', output: [], usage: null } },
      { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: first ? { ...item, status: 'in_progress', arguments: '' } : { ...item, status: 'in_progress', content: [] } },
      first
        ? { type: 'response.function_call_arguments.done', sequence_number: 2, item_id: item.id, output_index: 0, arguments: item.arguments }
        : { type: 'response.output_text.delta', sequence_number: 2, item_id: item.id, output_index: 0, content_index: 0, delta: 'Fixture evidence received.', logprobs: [] },
      { type: 'response.output_item.done', sequence_number: 3, output_index: 0, item },
      { type: 'response.completed', sequence_number: 4, response: snapshot },
    ];
    return (async function* () {
      for (const event of events) {
        if (options.signal.aborted) throw Error('fixture_aborted');
        await options.chargeReceivedBytes(Buffer.byteLength(JSON.stringify(event)));
        yield structuredClone(event);
      }
    })();
  }
  async retrieve(id: string, options: ResponsesHttpOptions): Promise<ResponsesSnapshot> {
    this.retrievals.push(id);
    const result = this.snapshots.get(id); assert.ok(result, 'retrieve must address a known response');
    await options.chargeReceivedBytes(Buffer.byteLength(JSON.stringify(result)));
    return structuredClone(result);
  }
  async resume(id: string, after: number, options: ResponsesHttpOptions): Promise<AsyncIterable<ResponsesEvent>> {
    const snapshot = await this.retrieve(id, options);
    return (async function* () {
      if (after < 4) yield { type: 'response.completed', sequence_number: 4, response: snapshot };
    })();
  }
  async cancel(id: string, options: ResponsesHttpOptions): Promise<ResponsesSnapshot> {
    // Already completed backend responses remain completed on cancellation.
    return this.retrieve(id, options);
  }
}

function delivered(request: string): ResearchResult {
  const text = 'Fixture research result.';
  const outputBytes = String(Buffer.byteLength(text));
  return {
    text,
    receipt: {
      version: 2, conversation, request, request_hash: Array(32).fill(7), sequence: '1',
      outcome: 'completed', reason: null, checkpoint_hash: Array(32).fill(8),
      // This port is injected (hashes are synthetic), but counts still follow
      // the real receipt schema: UTF-8 byte counts, never the generated text.
      delivered_units: [String(Buffer.byteLength('Compare the fixture evidence.')), outputBytes],
      generated_output: outputBytes, discarded_output: '0', continuation: 'ready', citations: [],
    },
  };
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'm2m-runtime-seam-'));
  let coordinator: AgentCoordinator | undefined, budget: BudgetLedger | undefined, worker: ResponsesWorker | undefined;
  const transport = new SeamTransport();
  const portCalls: string[] = [], hostCalls: Array<Pick<AgentToolCall, 'threadId' | 'callId' | 'turnId' | 'request'>> = [];
  try {
    budget = await BudgetLedger.open({
      stateDir: join(root, 'budget'), create: true, buyer, provider,
      limits: { max_total_mist: '1000', max_channel_deposit_mist: '500', max_turn_mist: '500',
        max_outstanding_mist: '500', max_requests: 4, deadline_ms: String(Date.now() + 60_000), output_tranche_bytes: 1024 },
    });
    await budget.reserveFunding('11'.repeat(32), '500');
    await budget.bindChannel({ channel: address('05'), opening_nonce: '11'.repeat(32), deposit: '500',
      policy: makePolicy(['input_utf8_bytes', 'output_utf8_bytes'], ['1', '1'], '1') });
    const port: ResearchPort = {
      async execute({ requestId }) {
        portCalls.push(requestId);
        await budget!.beginRequest(requestId, budget!.currentUnits());
        if (portCalls.length === 1) throw Error('fixture_lost_reply');
        return delivered(requestId);
      },
      async cancel() { return { confirmed: false }; },
    };
    coordinator = await AgentCoordinator.open({
      stateDir: join(root, 'coordinator'), create: true, conversation, buyer, provider, budget, port,
      async workerFactory(profile: AgentProfile) {
        const handle = profile.handleTool;
        const observedProfile = { ...profile, async handleTool(call: AgentToolCall) {
          hostCalls.push({ threadId: call.threadId, callId: call.callId, turnId: call.turnId, request: structuredClone(call.request) });
          return handle(call);
        } };
        worker = await ResponsesWorker.open({ stateDir: join(root, 'worker'), create: true,
          descriptor, profile: observedProfile, limits: responsesLimits('coordinator', { maxDurationMs: 10_000, cancelGraceMs: 100 }), transport });
        return worker;
      },
    });
    const first = await coordinator.run({ id: task, prompt: 'Use the fixture research service.' });
    assert.equal(first.state, 'uncertain', 'lost paid result is not terminal task success');
    assert.equal(transport.bodies.length, 1, 'uncertain callback forbids model continuation');
    assert.equal(portCalls.length, 1);
    assert.equal(hostCalls.length, 1);
    assert.equal(transport.retrievals.length, 0, 'a valid completed stream must not need recovery to process its documented events');
    assert.equal(worker!.status({ agent: buyer.agent, conversationId: conversation, requestId: task })?.state, 'uncertain');
    // AR-10 makes recovery explicit. The future lifecycle owner must invoke
    // this known-request reconciliation; run() alone is not a retry permit.
    const workerRecovered = await worker!.reconcile({ agent: buyer.agent, conversationId: conversation, requestId: task });
    assert.equal(workerRecovered?.state, 'completed', 'explicit worker reconciliation completes only the retained operation');
    const recovered = await coordinator.run({ id: task, prompt: 'Use the fixture research service.' });
    assert.equal(recovered.state, 'completed', 'explicit reconciliation can complete the original operation');
    assert.equal(portCalls.length, 2);
    assert.equal(hostCalls.length, 2);
    assert.equal(portCalls[0], portCalls[1], 'recovery keeps the paid request identity');
    assert.deepEqual(hostCalls[1], hostCalls[0], 'recovery keeps the qualified model callback identity');
    assert.equal(transport.bodies.length, 2, 'only one continuation after durable terminal tool result');
    assert.equal(transport.bodies[1].previous_response_id, 'resp_seam_1');
    assert.deepEqual(transport.bodies[1].input, [{ type: 'function_call_output', call_id: 'call_seam',
      output: JSON.stringify({ success: true, text: JSON.stringify(delivered(portCalls[0])) }) }]);
    const replay = await coordinator.run({ id: task, prompt: 'Use the fixture research service.' });
    assert.deepEqual(replay, recovered);
    assert.equal(transport.bodies.length, 2, 'completed replay does not create another model response');
    assert.equal(portCalls.length, 2, 'completed replay does not execute research again');
    assert.equal(hostCalls.length, 2, 'completed replay does not invoke the host callback again');
    assert.equal(transport.retrievals.length, 0, 'tool-result reconciliation does not need to retrieve already completed model responses');
    assert.equal(budget.snapshot().requests_remaining, 3, 'same-operation recovery consumes one research allocation');
    await coordinator.shutdown(); coordinator = undefined;
    await budget.close(); budget = undefined;
    console.log('Coordinator/Responses seam: uncertainty halts continuation; recovery and replay retain identities (fixtures only).');
  } finally {
    await coordinator?.shutdown().catch(() => {});
    await worker?.shutdown().catch(() => {});
    await budget?.close();
    await rm(root, { recursive: true, force: true });
  }
}
await main();
