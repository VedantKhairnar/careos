import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor, CareEvent, EventType } from "@/domain/events";
import { foldPrescriptionState } from "@/domain/prescription";
import { poolConfig } from "@/server/db";
import { Orchestrator } from "@/server/orchestrator";
import { PgEventStore, SYNTHETIC_SOURCE } from "@/server/pgStore";
import { migrate } from "../scripts/migrate";

/**
 * Integration tests against a REAL TimescaleDB (Tiger Cloud), inside a throwaway schema that is dropped
 * afterwards. Skipped unless explicitly enabled, so a normal `pnpm test` can never touch a database:
 *   set -a; . ./.env.local; set +a; CAREOS_TEST_DB=1 pnpm exec vitest run tests/pg.test.ts
 */
const enabled = Boolean(process.env.CAREOS_TEST_DB && process.env.DATABASE_URL);
const schema = `careos_test_${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!enabled)("Postgres / TimescaleDB store", () => {
  let pool: pg.Pool;
  let store: PgEventStore;
  const query = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL!;
    await migrate(url, { schema });
    pool = new pg.Pool({ ...poolConfig(url), max: 6 });
    pool.on("connect", (c) => void c.query(`set search_path to "${schema}", public`));
    store = new PgEventStore(pool);
  }, 120_000);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`drop schema if exists "${schema}" cascade`);
    await pool.end();
  }, 60_000);

  let n = 0;
  const base = Date.parse("2026-03-01T09:00:00Z");
  const at = (sec: number) => new Date(base + sec * 1000).toISOString();
  function ev(type: EventType, role: CareEvent["actorRole"], over: Partial<CareEvent> = {}): CareEvent {
    n++;
    return {
      eventId: `e${schema}-${n}`, workflowId: "w1", patientId: "p1", type, actorId: `${role}-1`, actorRole: role,
      sourceSystem: "test", occurredAt: at(n), recordedAt: at(n), payload: {}, verification: "confirmed", simulated: true,
      correlationId: "c1", idempotencyKey: `k${schema}-${n}`, ...over,
    };
  }

  it("round-trips an event exactly and returns a workflow in recorded order", async () => {
    const a = ev("prescription.authorized", "clinician", { workflowId: "rt", payload: { medicationReference: "Demo", nested: { x: [1, 2] } }, recordedAt: at(10), occurredAt: at(10) });
    const b = ev("prescription.transmitted", "system", { workflowId: "rt", recordedAt: at(20), occurredAt: at(20) });
    await store.append(b); // inserted out of order on purpose
    await store.append(a);
    const got = await store.listByWorkflow("rt");
    expect(got.map((e) => e.type)).toEqual(["prescription.authorized", "prescription.transmitted"]);
    expect(got[0]).toEqual(a);
  });

  it("claims each idempotency key once, even under concurrent writers", async () => {
    const e = ev("notification.sent", "system", { workflowId: "idem", idempotencyKey: `same-${schema}` });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => store.append({ ...e, eventId: `${e.eventId}-${i}` })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.hasIdempotencyKey(`same-${schema}`)).toBe(true);
    expect(await store.listByWorkflow("idem")).toHaveLength(1);
  });

  it("derives acknowledgment latency from the two events", async () => {
    // Recent timestamps, so the rows fall inside the analytics query windows.
    const anchor = Date.now() - 600_000; // one fixed moment, so the offsets below are exact
    const recent = (sec: number) => new Date(anchor + sec * 1000).toISOString();
    await store.append(ev("prescription.transmitted", "system", { workflowId: "lat", recordedAt: recent(0), occurredAt: recent(0) }));
    await store.append(ev("prescription.received", "pharmacy_sim", { workflowId: "lat", recordedAt: recent(30), occurredAt: recent(30) }));
    await store.append(ev("prescription.acknowledged", "pharmacy_sim", { workflowId: "lat", recordedAt: recent(90), occurredAt: recent(90) }));
    const rows = await query("select metric, value_seconds from workflow_metrics where workflow_id = 'lat'");
    expect(rows).toEqual([{ metric: "ack_latency", value_seconds: 90 }]);
  });

  it("keeps synthetic history out of app views but counts it in analytics", async () => {
    await store.append(ev("prescription.authorized", "clinician", { workflowId: "syn", patientId: "hist_1", sourceSystem: SYNTHETIC_SOURCE }));
    expect((await store.listAll()).some((e) => e.sourceSystem === SYNTHETIC_SOURCE)).toBe(false);
    expect(await store.listByPatient("hist_1")).toHaveLength(0);
    const a = await store.analytics();
    expect(a.available && a.totals.syntheticEvents).toBeGreaterThanOrEqual(1);
  });

  it("records each care-gap transition exactly once, even with concurrent polling", async () => {
    const gap = { key: "pharmacy_ack_overdue:g1", rule: "pharmacy_ack_overdue", patientId: "p1", workflowId: "g1", responsible: "clinician" };
    await Promise.all([store.recordGaps([gap]), store.recordGaps([gap])]);
    await store.recordGaps([gap]);
    expect(await query("select transition from care_gap_events where gap_key = $1", [gap.key])).toEqual([{ transition: "detected" }]);
    expect(await query("select count(*)::int n from care_gaps_open where gap_key = $1", [gap.key])).toEqual([{ n: 1 }]);

    await Promise.all([store.recordGaps([]), store.recordGaps([])]);
    expect((await query("select transition from care_gap_events where gap_key = $1 order by seq", [gap.key])).map((r) => r.transition)).toEqual(["detected", "resolved"]);
    expect(await query("select count(*)::int n from care_gaps_open where gap_key = $1", [gap.key])).toEqual([{ n: 0 }]);
  });

  it("answers analytics from continuous aggregates and agrees with the raw rows", async () => {
    await store.logAgentExecution({ agent: "patient", patientId: "p1", startedAt: new Date().toISOString(), durationMs: 120, ok: true, model: "m", inputTokens: 50, outputTokens: 7 });
    await store.append(ev("prescription.received", "pharmacy_sim", { workflowId: "an", recordedAt: new Date().toISOString(), occurredAt: new Date().toISOString() }));
    const a = await store.analytics();
    expect(a.available).toBe(true);
    if (!a.available) return;
    expect(a.totals.events).toBeGreaterThan(5);
    expect(a.ackLatency.samples).toBeGreaterThanOrEqual(1);
    expect(a.ackLatency.medianSeconds).toBe(90);
    expect(a.eventsHourly.some((p) => p.key === "prescription.received")).toBe(true);
    expect(a.agentHourly[0]).toMatchObject({ agent: "patient", calls: 1, inputTokens: 50, outputTokens: 7 });
    expect(a.gapsDaily.find((g) => g.rule === "pharmacy_ack_overdue")).toMatchObject({ detected: 1, resolved: 1 });
    expect(a.timings.resultsMatch).toBe(true);
    expect(a.storage.chunks).toBeGreaterThanOrEqual(1);
    expect(a.storage.hypertableBytes).toBeGreaterThan(0);
  });

  it("resets live demo data but never the synthetic history, and refreshes the aggregates", async () => {
    const stamp = new Date().toISOString();
    // synthetic history that must survive
    await store.append(ev("prescription.authorized", "clinician", { workflowId: "hx_keep_1", patientId: "hist_9", sourceSystem: SYNTHETIC_SOURCE, occurredAt: stamp, recordedAt: stamp }));
    await query("insert into workflow_metrics (occurred_at, workflow_id, patient_id, metric, value_seconds, simulated) values ($1,'hx_keep_1','hist_9','ack_latency',42,true)", [stamp]);
    await query("insert into care_gap_events (occurred_at, gap_key, rule, patient_id, workflow_id, responsible, transition) values ($1,'k:hx_keep_1','pharmacy_ack_overdue','hist_9','hx_keep_1','clinician','detected')", [stamp]);
    // live demo data that must go
    await store.append(ev("prescription.authorized", "clinician", { workflowId: "live_1", occurredAt: stamp, recordedAt: stamp }));
    await store.recordGaps([{ key: "pharmacy_ack_overdue:live_1", rule: "pharmacy_ack_overdue", patientId: "p1", workflowId: "live_1", responsible: "clinician" }]);
    await store.logAgentExecution({ agent: "patient", patientId: "p1", startedAt: stamp, durationMs: 5, ok: true });
    const liveKeys = (await query("select count(*)::int n from event_idempotency")).at(0)!.n as number;
    expect(liveKeys).toBeGreaterThan(0);

    const counts = await store.resetDemoData();
    expect(counts.events).toBeGreaterThan(0);

    const left = await query("select count(*) filter (where source_system = $1)::int synth, count(*) filter (where source_system <> $1)::int live from care_events", [SYNTHETIC_SOURCE]);
    expect(left[0]).toEqual({ synth: 2, live: 0 }); // both synthetic rows (one from an earlier test, one added here) survive
    expect((await query("select count(*)::int n from workflow_metrics where workflow_id = 'hx_keep_1'"))[0].n).toBe(1);
    expect((await query("select count(*)::int n from care_gap_events where workflow_id = 'hx_keep_1'"))[0].n).toBe(1);
    expect((await query("select count(*)::int n from care_gap_events where workflow_id = 'live_1'"))[0].n).toBe(0);
    expect((await query("select count(*)::int n from care_gaps_open"))[0].n).toBe(0);
    expect((await query("select count(*)::int n from agent_executions"))[0].n).toBe(0);
    // keys of the deleted live events are gone (so the same actions can be repeated); the two synthetic rows keep theirs
    expect((await query("select count(*)::int n from event_idempotency"))[0].n).toBe(2);
    expect((await query("select count(*)::int n from event_idempotency where event_id not in (select event_id from care_events)"))[0].n).toBe(0);
    // the same keys are usable again
    expect(await store.append(ev("notification.sent", "system", { workflowId: "again", idempotencyKey: `again-${schema}` }))).toBe(true);
    const a = await store.analytics();
    expect(a.available && a.totals.openGaps).toBe(0);
    expect(a.available && a.totals.syntheticEvents).toBeGreaterThanOrEqual(1);
  });

  it("round-trips agent executions", async () => {
    await store.logAgentExecution({ agent: "doctor", patientId: "p9", startedAt: new Date().toISOString(), durationMs: 33.6, ok: false, error: "boom", tool: "draft_care_plan", model: "m" });
    const last = (await store.listAgentExecutions()).at(-1)!;
    expect(last).toMatchObject({ agent: "doctor", ok: false, error: "boom", tool: "draft_care_plan", durationMs: 34 });
  });

  it("enforces the same workflow rules through the orchestrator when backed by Postgres", async () => {
    let t = 0;
    const orch = new Orchestrator(store, () => at(5000 + ++t));
    const clinician: Actor = { id: "dr", role: "clinician" };
    const pharmacy: Actor = { id: "ph", role: "pharmacy_sim" };
    const send = (actor: Actor, type: EventType, key: string) =>
      orch.handle(actor, { ...ev(type, actor.role, { workflowId: "orch", actorId: actor.id, idempotencyKey: `${key}-${schema}` }) });

    expect((await send(clinician, "prescription.authorized", "a")).status).toBe("applied");
    expect((await send(clinician, "prescription.authorized", "a")).status).toBe("duplicate");
    expect((await send(pharmacy, "prescription.ready", "r")).status).toBe("rejected"); // cannot jump to ready
    expect(await store.listByWorkflow("orch")).toHaveLength(1);
    expect(foldPrescriptionState(await store.listByWorkflow("orch"))).toBe("AUTHORIZED");
  });
});
