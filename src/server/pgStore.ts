import type pg from "pg";
import type { CareEvent } from "@/domain/events";
import { getPool } from "./db";
import type { AgentExecution, Analytics, EventStore, GapSnapshot } from "./store";

/** Rows loaded by scripts/seed-history.ts. They feed analytics but never appear in patient or clinician screens. */
export const SYNTHETIC_SOURCE = "synthetic-history";

const COLS = "event_id, occurred_at, recorded_at, patient_id, workflow_id, event_type, actor_type, actor_id, source_system, payload, verification_status, is_simulated, correlation_id, idempotency_key";

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

function toEvent(r: Row): CareEvent {
  return {
    eventId: r.event_id as string,
    workflowId: r.workflow_id as string,
    patientId: r.patient_id as string,
    type: r.event_type as CareEvent["type"],
    actorId: r.actor_id as string,
    actorRole: r.actor_type as CareEvent["actorRole"],
    sourceSystem: r.source_system as string,
    occurredAt: iso(r.occurred_at),
    recordedAt: iso(r.recorded_at),
    payload: (r.payload ?? {}) as Record<string, unknown>,
    verification: r.verification_status as CareEvent["verification"],
    simulated: r.is_simulated as boolean,
    correlationId: r.correlation_id as string,
    idempotencyKey: r.idempotency_key as string,
  };
}

/** Metrics worth measuring, computed when the closing event arrives so aggregates can summarise them. */
const METRICS: Partial<Record<CareEvent["type"], { metric: string; since: CareEvent["type"] }>> = {
  "prescription.acknowledged": { metric: "ack_latency", since: "prescription.transmitted" },
  "prescription.ready": { metric: "fulfilment_time", since: "prescription.acknowledged" },
  "prescription.clarification_resolved": { metric: "clarification_resolution", since: "prescription.clarification_requested" },
};

export class PgEventStore implements EventStore {
  constructor(private pool: pg.Pool = getPool()) {}

  async hasIdempotencyKey(key: string): Promise<boolean> {
    const r = await this.pool.query("select 1 from event_idempotency where idempotency_key = $1", [key]);
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * Claims the idempotency key and inserts the event in one transaction. A repeated key stores nothing and
   * returns false, even under concurrent writers (the primary key arbitrates).
   */
  async append(e: CareEvent): Promise<boolean> {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      const claim = await c.query("insert into event_idempotency (idempotency_key, event_id) values ($1, $2) on conflict do nothing returning 1", [e.idempotencyKey, e.eventId]);
      if (!claim.rowCount) {
        await c.query("rollback");
        return false;
      }
      await c.query(`insert into care_events (${COLS}) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14)`, [
        e.eventId, e.occurredAt, e.recordedAt, e.patientId, e.workflowId, e.type, e.actorRole, e.actorId, e.sourceSystem,
        JSON.stringify(e.payload), e.verification, e.simulated, e.correlationId, e.idempotencyKey,
      ]);
      const m = METRICS[e.type];
      if (m) {
        await c.query(
          `insert into workflow_metrics (occurred_at, workflow_id, patient_id, metric, value_seconds, simulated)
           select $1::timestamptz, $2, $3, $4, greatest(extract(epoch from ($5::timestamptz - recorded_at)), 0), $6
           from care_events where workflow_id = $2 and event_type = $7
           order by recorded_at desc, seq desc limit 1`,
          [e.occurredAt, e.workflowId, e.patientId, m.metric, e.recordedAt, e.simulated, m.since],
        );
      }
      await c.query("commit");
      return true;
    } catch (err) {
      await c.query("rollback").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  async listByWorkflow(workflowId: string): Promise<CareEvent[]> {
    const r = await this.pool.query(`select ${COLS} from care_events where workflow_id = $1 order by recorded_at, seq`, [workflowId]);
    return r.rows.map(toEvent);
  }

  async listByPatient(patientId: string): Promise<CareEvent[]> {
    const r = await this.pool.query(`select ${COLS} from care_events where patient_id = $1 and source_system <> $2 order by recorded_at, seq`, [patientId, SYNTHETIC_SOURCE]);
    return r.rows.map(toEvent);
  }

  async listAll(): Promise<CareEvent[]> {
    const r = await this.pool.query(`select ${COLS} from care_events where source_system <> $1 order by recorded_at, seq`, [SYNTHETIC_SOURCE]);
    return r.rows.map(toEvent);
  }

  async logAgentExecution(e: AgentExecution): Promise<void> {
    await this.pool.query(
      "insert into agent_executions (started_at, agent, patient_id, tool, model, ok, error, duration_ms, input_tokens, output_tokens) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [e.startedAt, e.agent, e.patientId, e.tool ?? null, e.model ?? null, e.ok, e.error ?? null, Math.round(e.durationMs), e.inputTokens ?? null, e.outputTokens ?? null],
    );
  }

  async listAgentExecutions(): Promise<AgentExecution[]> {
    const r = await this.pool.query("select * from (select * from agent_executions order by started_at desc, seq desc limit 500) t order by started_at, seq");
    return r.rows.map((x) => ({
      agent: x.agent, patientId: x.patient_id, startedAt: iso(x.started_at), durationMs: x.duration_ms, ok: x.ok,
      error: x.error ?? undefined, tool: x.tool ?? undefined, model: x.model ?? undefined,
      inputTokens: x.input_tokens ?? undefined, outputTokens: x.output_tokens ?? undefined,
    }));
  }

  /**
   * Persists care-gap transitions. `care_gaps_open` is the current state; `care_gap_events` (a hypertable)
   * is the history that the daily aggregate counts. Each transition is written once even if several clients
   * poll at the same moment, because the insert or delete itself decides who wins.
   */
  async recordGaps(gaps: GapSnapshot[]): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      const now = new Date().toISOString();
      const current = new Set(gaps.map((g) => g.key));
      for (const g of gaps) {
        const ins = await c.query("insert into care_gaps_open (gap_key, rule, patient_id, workflow_id, responsible, detected_at) values ($1,$2,$3,$4,$5,$6) on conflict do nothing returning 1", [g.key, g.rule, g.patientId, g.workflowId, g.responsible, now]);
        if (ins.rowCount) await c.query("insert into care_gap_events (occurred_at, gap_key, rule, patient_id, workflow_id, responsible, transition) values ($1,$2,$3,$4,$5,$6,'detected')", [now, g.key, g.rule, g.patientId, g.workflowId, g.responsible]);
      }
      const open = await c.query("select gap_key from care_gaps_open");
      for (const { gap_key } of open.rows as { gap_key: string }[]) {
        if (current.has(gap_key)) continue;
        const del = await c.query("delete from care_gaps_open where gap_key = $1 returning rule, patient_id, workflow_id, responsible", [gap_key]);
        const d = del.rows[0];
        if (d) await c.query("insert into care_gap_events (occurred_at, gap_key, rule, patient_id, workflow_id, responsible, transition) values ($1,$2,$3,$4,$5,$6,'resolved')", [now, gap_key, d.rule, d.patient_id, d.workflow_id, d.responsible]);
      }
      await c.query("commit");
    } catch (err) {
      await c.query("rollback").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  async analytics(): Promise<Analytics> {
    const q = async (sql: string, params: unknown[] = []) => (await this.pool.query(sql, params)).rows as Row[];
    const windowHours = 48; // the hourly chart
    const benchHours = 24 * 30; // the timing comparison uses a 30-day window so the volume is meaningful

    const [totals] = await q(
      `select (select count(*) from care_events) as events,
              (select count(distinct workflow_id) from care_events where event_type = 'prescription.authorized') as prescriptions,
              (select count(*) from care_gaps_open) as open_gaps,
              (select count(*) from care_gap_events where transition = 'resolved') as resolved_gaps,
              (select count(*) from care_events where source_system = $1) as synthetic`,
      [SYNTHETIC_SOURCE],
    );
    const [ack] = await q(
      `select count(*) as samples,
              percentile_cont(0.5) within group (order by value_seconds) as median,
              percentile_cont(0.9) within group (order by value_seconds) as p90
       from workflow_metrics where metric = 'ack_latency' and occurred_at > now() - interval '30 days'`,
    );

    const eventsHourly = await q(`select bucket, event_type, events from care_events_hourly where bucket >= now() - interval '${windowHours} hours' order by bucket, event_type`);
    const metricsDaily = await q("select bucket, metric, samples, avg_seconds, min_seconds, max_seconds from workflow_metrics_daily where bucket >= now() - interval '14 days' order by bucket, metric");
    const gapsDaily = await q("select bucket, rule, detected, resolved from care_gaps_daily where bucket >= now() - interval '14 days' order by bucket, rule");
    const agentHourly = await q("select bucket, agent, calls, failures, avg_ms, max_ms, input_tokens, output_tokens from agent_latency_hourly where bucket >= now() - interval '48 hours' order by bucket, agent");
    const notificationsDaily = await q("select bucket, event_type, events from notifications_daily where bucket >= now() - interval '14 days' order by bucket, event_type");

    const [size] = await q("select hypertable_size('care_events') as bytes");
    const [chunkInfo] = await q("select count(*)::int as chunks, count(*) filter (where is_compressed)::int as compressed from timescaledb_information.chunks where hypertable_schema = current_schema() and hypertable_name = 'care_events'");
    const [comp] = await q("select before_compression_total_bytes as b, after_compression_total_bytes as a from hypertable_compression_stats('care_events')");

    // Honest measurement: the same question answered two ways, timed on this request.
    const t0 = performance.now();
    const viaAggregate = await q(`select event_type, sum(events)::bigint as n from care_events_hourly where bucket >= date_trunc('hour', now()) - interval '${benchHours} hours' group by 1 order by 1`);
    const aggregateMs = performance.now() - t0;
    const t1 = performance.now();
    const viaRaw = await q(`select event_type, count(*)::bigint as n from care_events where event_type like 'prescription.%' and occurred_at >= date_trunc('hour', now()) - interval '${benchHours} hours' group by 1 order by 1`);
    const rawMs = performance.now() - t1;
    const [scanned] = await q(`select count(*) as n from care_events where event_type like 'prescription.%' and occurred_at >= date_trunc('hour', now()) - interval '${benchHours} hours'`);
    const same = JSON.stringify(viaAggregate.map((r) => [r.event_type, num(r.n)])) === JSON.stringify(viaRaw.map((r) => [r.event_type, num(r.n)]));

    return {
      available: true,
      source: "Tiger Data (TimescaleDB continuous aggregates)",
      generatedAt: new Date().toISOString(),
      totals: { events: num(totals.events), prescriptions: num(totals.prescriptions), openGaps: num(totals.open_gaps), resolvedGaps: num(totals.resolved_gaps), syntheticEvents: num(totals.synthetic) },
      ackLatency: { samples: num(ack.samples), medianSeconds: ack.median === null ? null : num(ack.median), p90Seconds: ack.p90 === null ? null : num(ack.p90) },
      eventsHourly: eventsHourly.map((r) => ({ bucket: iso(r.bucket), key: r.event_type as string, value: num(r.events) })),
      metricsDaily: metricsDaily.map((r) => ({ bucket: iso(r.bucket), metric: r.metric as string, samples: num(r.samples), avgSeconds: num(r.avg_seconds), minSeconds: num(r.min_seconds), maxSeconds: num(r.max_seconds) })),
      gapsDaily: gapsDaily.map((r) => ({ bucket: iso(r.bucket), rule: r.rule as string, detected: num(r.detected), resolved: num(r.resolved) })),
      agentHourly: agentHourly.map((r) => ({ bucket: iso(r.bucket), agent: r.agent as string, calls: num(r.calls), failures: num(r.failures), avgMs: num(r.avg_ms), maxMs: num(r.max_ms), inputTokens: num(r.input_tokens), outputTokens: num(r.output_tokens) })),
      notificationsDaily: notificationsDaily.map((r) => ({ bucket: iso(r.bucket), event: r.event_type as string, events: num(r.events) })),
      storage: { hypertableBytes: num(size.bytes), chunks: num(chunkInfo.chunks), compressedChunks: num(chunkInfo.compressed), compressedFromBytes: comp?.b == null ? null : num(comp.b), compressedToBytes: comp?.a == null ? null : num(comp.a) },
      timings: { aggregateMs: Math.round(aggregateMs * 10) / 10, rawMs: Math.round(rawMs * 10) / 10, rawRowsScanned: num(scanned.n), resultsMatch: same, windowHours: benchHours },
    };
  }
}
