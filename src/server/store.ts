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
}

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
