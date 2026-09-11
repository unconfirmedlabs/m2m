import type {
  DemoCommand,
  DemoControl,
  DemoControlRecord,
  DemoEconomy,
  DemoEvent,
  DemoSessionResponse,
  DemoSnapshot,
  DemoTransaction,
  MachineRole,
  SourceCursor,
} from '../../../scripts/demo-types.js';

export type {
  DemoCommand,
  DemoControl,
  DemoControlRecord,
  DemoEconomy,
  DemoEvent,
  DemoSessionResponse,
  DemoSnapshot,
  DemoTransaction,
  MachineRole,
  SourceCursor,
};

export type BrowserConnectionState = 'disconnected' | 'connecting' | 'connected' | 'failed';

export interface VisibleCitation {
  title: string;
  url: string;
  source?: string;
}

export interface TranscriptEntry {
  id: string;
  side: 'coordinator' | 'research';
  kind: 'answer' | 'action' | 'delivery' | 'status';
  text: string;
  atMs: string;
  request: string | null;
  citations: VisibleCitation[];
}

export interface DeliveryStream {
  chunks: number[][];
  seen: string[];
  text: string;
  outputBytes: string;
  malformed: boolean;
  pending?: number[];
}

export interface DemoUiState {
  snapshot: DemoSnapshot | null;
  events: DemoEvent[];
  transcript: TranscriptEntry[];
  deliveries: Record<string, DeliveryStream>;
  seenEventKeys: string[];
  browser: BrowserConnectionState;
  browserError: string | null;
  sync: 'replaying' | 'live' | 'failed';
  replayCut: string | null;
  iroh: { coordinator: string; provider: string };
  newActivity: boolean;
  lastSequence: string;
  /** A durable state event asks the UI to refresh the authoritative snapshot. */
  refreshRequested: boolean;
}

export interface ApiErrorShape {
  version: 1;
  code: string;
  role?: MachineRole;
  phase?: string;
}

export interface StatusResponse {
  version: 1;
  snapshot?: DemoSnapshot;
  code?: string;
}

export interface ControlResponse {
  version: 1;
  record: DemoControlRecord;
}

export interface UiEconomyCard {
  economy: DemoEconomy;
  deliveredPrice: string;
  signedAuthorization: string;
  outstanding: string;
  reservedExposure: string;
  refund: string | null;
  redeemedAboveDelivery: boolean | null;
  priceMismatch: boolean;
  transaction: DemoTransaction;
  openingTransaction: DemoTransaction;
  terminalTransaction: DemoTransaction | null;
}
