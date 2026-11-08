import type { CareEvent } from "@/domain/events";

export interface AgentExecution {
  agent: "patient" | "doctor" | "pharmacy";
  patientId: string;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  error?: string;
  /** Set for tool executions and model calls so there is real evidence of what each agent did. */
  tool?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Persistence boundary. The Postgres/TimescaleDB implementation lives beside this
 * and satisfies the same interface; tests use the in-memory version.
 */
export interface EventStore {
  hasIdempotencyKey(key: string): Promise<boolean>;
  /** Returns false (and stores nothing) if the idempotency key already exists. */
  append(event: CareEvent): Promise<boolean>;
  listByWorkflow(workflowId: string): Promise<CareEvent[]>;
  listByPatient(patientId: string): Promise<CareEvent[]>;
  listAll(): Promise<CareEvent[]>;
  logAgentExecution(e: AgentExecution): Promise<void>;
  listAgentExecutions(): Promise<AgentExecution[]>;
  /** Optional: stores that persist care-gap transitions (Tiger Data) implement these. */
  recordGaps?(gaps: GapSnapshot[]): Promise<void>;
  analytics?(): Promise<Analytics>;
}

export interface GapSnapshot {
  key: string;
  rule: string;
  patientId: string;
  workflowId: string;
  responsible: string;
}

export interface SeriesPoint {
  bucket: string;
  key: string;
  value: number;
}

/** Everything on the analytics page comes from these database queries. Nothing is hardcoded. */
export type Analytics =
  | { available: false; reason: string }
  | {
      available: true;
      source: string;
      generatedAt: string;
      totals: { events: number; prescriptions: number; openGaps: number; resolvedGaps: number; syntheticEvents: number };
      ackLatency: { samples: number; medianSeconds: number | null; p90Seconds: number | null };
      eventsHourly: SeriesPoint[];
      metricsDaily: { bucket: string; metric: string; samples: number; avgSeconds: number; minSeconds: number; maxSeconds: number }[];
      gapsDaily: { bucket: string; rule: string; detected: number; resolved: number }[];
      agentHourly: { bucket: string; agent: string; calls: number; failures: number; avgMs: number; maxMs: number; inputTokens: number; outputTokens: number }[];
      notificationsDaily: { bucket: string; event: string; events: number }[];
      storage: { hypertableBytes: number; chunks: number; compressedChunks: number; compressedFromBytes: number | null; compressedToBytes: number | null };
      /** Measured on this request: the same question answered from the continuous aggregate and from raw rows. */
      timings: { aggregateMs: number; rawMs: number; rawRowsScanned: number; resultsMatch: boolean; windowHours: number };
    };

export class InMemoryEventStore implements EventStore {
  private events: CareEvent[] = [];
  private keys = new Set<string>();
  private agentLog: AgentExecution[] = [];

  async hasIdempotencyKey(key: string) {
    return this.keys.has(key);
  }
  async append(event: CareEvent) {
    if (this.keys.has(event.idempotencyKey)) return false;
    this.keys.add(event.idempotencyKey);
    this.events.push(event);
    return true;
  }
  async listByWorkflow(workflowId: string) {
    return this.events.filter((e) => e.workflowId === workflowId);
  }
  async listByPatient(patientId: string) {
    return this.events.filter((e) => e.patientId === patientId);
  }
  async listAll() {
    return [...this.events];
  }
  async logAgentExecution(e: AgentExecution) {
    this.agentLog.push(e);
  }
  async listAgentExecutions() {
    return [...this.agentLog];
  }
}
