/** Frozen integration boundary from AGENT_SERVICES_IMPLEMENTATION.md §1. */
import type { RequestRef, CodexWorker } from './codex-worker.js';
import type { AgentRef } from './native-chain.js';
import type { PolicyData } from './streaming-codec.js';
import type { AgentEventType } from './agent-events.js';

export type Units = [string, string];
export type AgentWorker = Pick<CodexWorker, 'run' | 'status' | 'reconcile' | 'cancel' | 'close'> & {
  /** New runtimes must quiesce local writers before their owners release locks. */
  shutdown?(): Promise<void>;
};
export interface AgentToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }
export interface AgentToolCall {
  request: RequestRef; threadId: string; turnId: string; callId: string; name: string;
  arguments: unknown; signal: AbortSignal;
}
export interface AgentToolResult {
  success: boolean;
  text: string;
  /** Valid only with success:false; unresolved effects prohibit continuation. */
  uncertain?: true;
}
export interface AgentProfile {
  id: string; baseInstructions: string; developerInstructions: string; tools: AgentToolSpec[];
  maxToolCalls: number; maxToolResultBytes: number;
  /** Only explicitly idempotent handlers may reconcile the same pending call. */
  recoverableTools: string[];
  handleTool(call: AgentToolCall): Promise<AgentToolResult>;
}
export interface ResearchRequestV2 { version: 2; conversation: string; request: string; sequence: string; prompt: string }
export interface Citation { id: string; url: string; title: string; retrieved_at_ms: string; content_hash: number[] }
export interface TurnReceipt {
  version: 2; conversation: string; request: string; request_hash: number[]; sequence: string;
  outcome: 'completed' | 'failed' | 'cancelled'; reason: string | null; checkpoint_hash: number[];
  delivered_units: Units; generated_output: string; discarded_output: string;
  continuation: 'ready' | 'requires_channel_close'; citations: Citation[];
}
export interface ResearchStatus {
  request_hash: number[];
  phase: 'credited' | 'launching' | 'running' | 'draining' | 'cancelling' | 'terminal' | 'uncertain';
  worker_state: 'prepared' | 'launching' | 'running' | 'completed' | 'failed' | 'cancelled' | 'uncertain' | null;
  checkpoint_hash: number[]; delivered_units: Units; authorized_units: Units;
  generated_output: string; available_output: string; input_dispatched: boolean; cancel_requested: boolean;
}
export interface BudgetLimits {
  max_total_mist: string; max_channel_deposit_mist: string; max_turn_mist: string;
  max_outstanding_mist: string; max_requests: number; deadline_ms: string; output_tranche_bytes: number;
}
export interface BudgetSnapshot {
  limits: BudgetLimits; channel: string | null; authorized_mist: string; delivered_mist: string;
  redeemed_mist: string; settled_prior_mist: string; remaining_mist: string; outstanding_mist: string;
  requests_remaining: number; uncertain: boolean;
}
export interface CreditReservation {
  channel: string; request: string; ceilings: Units; delivered_units: Units; request_start_units: Units;
}
export interface ChannelBudgetBinding { channel: string; opening_nonce: string; deposit: string; policy: PolicyData }
export interface ChannelBudgetObservation {
  channel: string; status: 'open' | 'closed' | 'refunded'; redeemed_mist: string;
  delivered_units: Units; authorized_units: Units;
}
export interface ResearchResult { text: string; receipt: TurnReceipt }
export type ResearchNotDispatchedCode = 'cancelled_before_dispatch' | 'budget_rejected' | 'deadline_exceeded' | 'request_limit_exceeded';
/** Host-only proof category. Never instantiate from a peer's error string. */
export class ResearchNotDispatchedError extends Error {
  constructor(readonly code: ResearchNotDispatchedCode) { super(code); this.name = 'ResearchNotDispatchedError'; }
}
export interface ResearchPort {
  execute(input: { requestId: string; prompt: string }): Promise<ResearchResult>;
  cancel(requestId: string): Promise<{ confirmed: boolean }>;
}
export interface PublicEventInput {
  role: 'coordinator' | 'research' | 'host'; conversation: string; request: string | null;
  type: AgentEventType;
  data: Record<string, unknown>;
}
export type EventSink = (event: PublicEventInput) => Promise<void>;
export type PinnedAgents = { buyer: AgentRef; provider: AgentRef };
