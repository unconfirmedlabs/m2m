/** Browser-neutral contract from FLY_AGENT_DEMO_IMPLEMENTATION.md.
 * All imports are type-only: no wallet, filesystem or network code enters the UI.
 */
import type { AgentRef, NativeConfig } from './native-chain.js';
import type { AgentServiceConfig } from './agent-services.js';
import type { AgentProfile, AgentWorker, BudgetSnapshot } from './agent-service-types.js';
import type { AgentPublicEvent } from './agent-events.js';
import type { AgentRuntimeDescriptor, ResponsesLimits } from './agent-runtime.js';
import type { RawTransport, SignedEnvelope } from './native-peer.js';
import type { StreamingChain } from './native-streaming-chain.js';
import type { BoundedWebTools } from './agent-web.js';
import type {
  SignedData, OfferData, CreditData, CheckpointData, PolicyData,
} from './streaming-codec.js';

export type MachineRole = 'coordinator' | 'provider';
/** Exactly 64 lowercase hex characters, without 0x. */
export type ID = string;
/** Exactly 0x followed by 64 lowercase hex characters. */
export type Address = string;
/** Canonical decimal-string u64; never a JSON number or bigint. */
export type U64 = string;
export type SourceCursor = Record<'coordinator' | 'research' | 'host', U64>;

/** Trusted deployment pins for pure structural validation, not chain proof. */
export interface DemoValidationPins {
  conversation: ID;
  configuration_hash: ID;
  config: AgentServiceConfig;
  agents: { buyer: AgentRef; provider: AgentRef };
}
/** Ephemeral SSE status: never a durable event ID or financial update. */
export interface DemoStreamStatus {
  version: 1;
  conversation: ID;
  state: 'replaying' | 'live';
  high_water: U64;
}

export type DemoCommand =
  | { op: 'start' }
  | { op: 'fund'; configuration_hash: ID; previous_channel: Address | null }
  | { op: 'task'; prompt: string }
  | { op: 'cancel'; task: ID }
  | { op: 'spending'; paused: boolean }
  | { op: 'disconnect' }
  | { op: 'reconnect' }
  | { op: 'close'; channel: Address }
  | { op: 'refund'; channel: Address };

export interface DemoControl {
  version: 1;
  id: ID;
  command: DemoCommand;
}
export interface DemoControlRecord {
  version: 1;
  id: ID;
  command: DemoCommand;
  state: 'accepted' | 'running' | 'completed' | 'failed' | 'uncertain';
  /** Fixed allowlisted code, not an exception message. */
  code: string | null;
  accepted_at_ms: U64;
  updated_at_ms: U64;
  task: ID | null;
  channel: Address | null;
}
export interface DemoConnection {
  desired: 'online' | 'offline';
  state: 'disconnected' | 'connecting' | 'connected' | 'recovering' | 'failed';
  generation: U64;
  path: 'direct' | 'relay' | 'unknown';
  changed_at_ms: U64;
  code: string | null;
}
export interface DemoIdentity {
  name: 'local.nozomi.sui' | 'research.nozomi.sui';
  agent: AgentRef;
  controller: Address;
  transport_key: number[];
  economic_key: number[];
  generation: U64;
  authority_checked_at_ms: U64;
  alias_state: 'verified' | 'stale' | 'changed';
}
export interface DemoRoleStatus {
  version: 1;
  role: MachineRole;
  conversation: ID;
  phase: 'initializing' | 'ready' | 'active' | 'recovering' |
    'degraded' | 'blocked' | 'stopping';
  code: string | null;
  runtime: AgentRuntimeDescriptor;
  profile_fingerprint: ID;
  configuration_hash: ID;
  active_task: ID | null;
  active_request: ID | null;
  spending_paused: boolean;
  waiting_for_credit: boolean;
  connection: DemoConnection;
  cursor: SourceCursor;
}
export interface DemoEconomy {
  channel: Address;
  status: 'open' | 'closed' | 'refunded' | 'unknown';
  offer: SignedData<OfferData>;
  policy: PolicyData;
  signed_credit: SignedData<CreditData> | null;
  checkpoint: SignedData<CheckpointData> | null;
  budget: BudgetSnapshot;
  delivered_units: [U64, U64];
  delivered_mist: U64;
  signed_authorized_mist: U64;
  reserved_mist: U64;
  outstanding_mist: U64;
  reserved_exposure_mist: U64;
  redeemed_mist: U64 | null;
  locked_mist: U64 | null;
  refunded_mist: U64 | null;
  observed_at_ms: U64 | null;
  opening: DemoTransaction;
  terminal: DemoTransaction | null;
}
export interface DemoTransaction {
  state: 'pending' | 'confirmed' | 'failed' | 'unknown';
  digest: string | null;
  gas: {
    computation_cost: U64;
    storage_cost: U64;
    storage_rebate: U64;
    non_refundable_storage_fee: U64;
  } | null;
}
export interface DemoSnapshot {
  version: 1;
  conversation: ID;
  mode: 'live';
  network: 'testnet' | 'localnet';
  configuration_hash: ID;
  config: AgentServiceConfig;
  identities: { coordinator: DemoIdentity; provider: DemoIdentity };
  roles: { coordinator: DemoRoleStatus; provider: DemoRoleStatus | null };
  provider_observed_at_ms: U64 | null;
  selected_channel: Address | null;
  channels: DemoEconomy[];
  projection_sequence: U64;
  available_controls: DemoCommand['op'][];
}
export interface DemoSessionResponse {
  version: 1;
  access: 'viewer' | 'operator';
  snapshot: DemoSnapshot;
}
export interface SourcedEvent { source: MachineRole; event: AgentPublicEvent }
export interface DemoEvent extends SourcedEvent {
  version: 1;
  sequence: U64;
}
export interface SourceEventPage {
  version: 1;
  conversation: ID;
  source: MachineRole;
  events: AgentPublicEvent[];
  high_water: SourceCursor;
  has_more: boolean;
}
/** Internal synchronous publication fence, not a browser endpoint. */
export type DemoPublication =
  | { version: 1; state: 'ready'; cursor: SourceCursor; code: null }
  | { version: 1; state: 'pending'; cursor: SourceCursor; code: 'publication_pending' }
  | { version: 1; state: 'failed'; cursor: SourceCursor; code: 'publication_failed' };
export interface DemoRuntimeHandle {
  readonly role: MachineRole;
  readonly conversation: ID;
  /** Getters below expose only the committed public view at this source cut. */
  publication(): DemoPublication;
  status(): DemoRoleStatus;
  /** Coordinator-selected history entry, not a guess from array order. */
  selectedChannel(): Address | null;
  /** Host predicate only; HTTP viewer/operator authorization remains separate. */
  availableControls(): DemoCommand['op'][];
  /** Coordinator only; never exposed by the private provider HTTP routes. */
  submit(control: DemoControl): Promise<DemoControlRecord>;
  control(id: ID): DemoControlRecord | undefined;
  events(after: SourceCursor, limit?: number): SourceEventPage;
  subscribe(listener: (event: AgentPublicEvent) => void): () => void;
  economy(): DemoEconomy[];
  identities(): { coordinator: DemoIdentity; provider: DemoIdentity };
  evidence(channel: Address): Promise<DemoEvidence>;
  locator(): DemoLocator | null;
  shutdown(): Promise<void>;
}
export interface DemoLocator {
  version: 1;
  conversation: ID;
  provider: AgentRef;
  configuration_hash: ID;
  endpoint: {
    id: ID;
    addrs: Array<{ Relay: string } | { Ip: string }>;
  };
}
export interface DemoEvidence {
  version: 1;
  conversation: ID;
  channel: Address;
  offer: SignedData<OfferData>;
  policy: PolicyData;
  credits: SignedData<CreditData>[];
  checkpoints: SignedData<CheckpointData>[];
  terminal_receipts: SignedEnvelope[];
  economy: DemoEconomy;
}

/** Constructor-only localnet test seam, never parsed from production config. */
export type DemoBridgeEvent =
  | { event: 'listening'; endpoint: DemoLocator['endpoint'] }
  | { event: 'connected'; remote_key: number[] }
  | { event: 'frame'; bytes: number[] }
  | { event: 'error'; message: 'transport closed' };
export interface DemoBridge extends RawTransport {
  event(): Promise<DemoBridgeEvent>;
  connected(): Promise<void>;
}
export interface DemoHostClock {
  nowMs(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}
export interface DemoRuntimeTestDependencies {
  workerFactory(options: {
    role: MachineRole;
    descriptor: AgentRuntimeDescriptor;
    stateDir: string;
    create: boolean;
    profile: AgentProfile;
    limits: ResponsesLimits;
  }): Promise<AgentWorker>;
  webToolsFactory(options: {
    stateDir: string;
    create: boolean;
    allowedHosts: string[];
  }): Promise<Pick<BoundedWebTools, 'profile' | 'sources' | 'close'>>;
  chainFactory?(config: NativeConfig): StreamingChain;
  bridgeFactory?(options: {
    mode: 'listen' | 'connect';
    keyFile: string;
    ticketFile: string;
    relay: boolean;
  }): DemoBridge;
  clock?: DemoHostClock;
  pollMs?: number;
}
