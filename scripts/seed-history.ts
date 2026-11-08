import pg from "pg";
import { poolConfig } from "@/server/db";

/**
 * Generates a large, internally consistent SYNTHETIC history of prescription workflows so the time-series
 * features have real volume: hypertable chunks, continuous aggregates, compression and honest timings.
 *
 * Everything written is flagged is_simulated = true and source_system = 'synthetic-history'. The app hides
 * those rows from patient and clinician screens; only analytics counts them.
 *
 * Usage:  node --env-file=.env.local --import tsx scripts/seed-history.ts [--prescriptions 60000] [--force]
 * To test on a fork first:  DATABASE_URL="$(tiger db uri --service-id <fork> --with-password)" node --import tsx scripts/seed-history.ts
 */
const SOURCE = "synthetic-history";

interface Branch {
  k: number;
  type: string;
  actor: string;
  at: string; // SQL expression for the event time (an interval added to t0)
  where?: string;
  payload?: string;
}

// Offsets are seconds after t0 (the moment the prescription was transmitted). Columns come from _hx_rx below.
const BRANCHES: Branch[] = [
  { k: 1, type: "prescription.authorized", actor: "clinician", at: "t0 - interval '5 seconds'" },
  { k: 2, type: "prescription.transmitted", actor: "system", at: "t0" },
  { k: 3, type: "prescription.received", actor: "pharmacy_sim", at: "t0 + interval '8 seconds'" },
  { k: 4, type: "prescription.acknowledged", actor: "pharmacy_sim", at: "t0 + ack_s * interval '1 second'" },
  { k: 5, type: "prescription.delayed", actor: "pharmacy_sim", at: "t0 + (ack_s + 60) * interval '1 second'", where: "delayed" },
  { k: 6, type: "prescription.clarification_requested", actor: "pharmacy_sim", at: "t0 + (ack_s + 120) * interval '1 second'", where: "clar" },
  { k: 7, type: "prescription.clarification_resolved", actor: "clinician", at: "t0 + (ack_s + 120 + clar_s) * interval '1 second'", where: "clar" },
  { k: 8, type: "prescription.processing", actor: "pharmacy_sim", at: "t0 + proc_at * interval '1 second'" },
  { k: 9, type: "prescription.ready", actor: "pharmacy_sim", at: "t0 + ready_at * interval '1 second'" },
  { k: 10, type: "prescription.picked_up", actor: "pharmacy_sim", at: "t0 + (ready_at + 1800) * interval '1 second'", where: "picked" },
  { k: 11, type: "notification.sent", actor: "system", at: "t0 + (ready_at + 1) * interval '1 second'", payload: "jsonb_build_object('important', true)" },
  { k: 12, type: "notification.acknowledged", actor: "patient", at: "t0 + (ready_at + 600 + notif_s) * interval '1 second'", where: "notif_acked" },
  { k: 13, type: "notification.sent", actor: "system", at: "t0 + (ack_s + 61) * interval '1 second'", where: "delayed", payload: "jsonb_build_object('important', true)" },
  { k: 14, type: "notification.acknowledged", actor: "patient", at: "t0 + (ack_s + 900 + notif_s) * interval '1 second'", where: "delayed and notif_acked" },
];

export async function seedHistory(connectionString: string, opts: { prescriptions: number; force?: boolean; log?: (m: string) => void }) {
  const log = opts.log ?? (() => {});
  const c = new pg.Client(poolConfig(connectionString));
  await c.connect();
  const scalar = async (sql: string, params: unknown[] = []) => Number((await c.query(sql, params)).rows[0].n);
  try {
    const existing = await scalar("select count(*) as n from care_events where source_system = $1", [SOURCE]);
    if (existing > 0 && !opts.force) {
      log(`skip: ${existing.toLocaleString()} synthetic events already present (use --force to regenerate)`);
      return { skipped: true, events: existing };
    }
    if (existing > 0) {
      log("removing previous synthetic history...");
      await c.query("delete from care_events where source_system = $1", [SOURCE]);
      await c.query("delete from workflow_metrics where workflow_id like 'hx\\_%'");
      await c.query("delete from care_gap_events where workflow_id like 'hx\\_%'");
    }

    const t0 = Date.now();
    log(`generating ${opts.prescriptions.toLocaleString()} prescription lifecycles...`);
    await c.query("begin");
    // One row of random draws per prescription. Offsets are capped so no event lands in the future:
    // t0 is at least 16 hours ago and the whole lifecycle fits inside 16 hours.
    await c.query(
      `create temp table _hx_rx on commit drop as
       select g as n,
              'hx_' || g as wf,
              'hist_' || lpad((g % 400)::text, 4, '0') as patient,
              date_trunc('second', now() - interval '16 hours' - random() * interval '28 days') as t0,
              least(30 + (-ln(1 - random()) * 420), 7200)::int          as ack_s,
              (60 + random() * 600)::int                                  as proc_s,
              least(900 + (-ln(1 - random()) * 5400), 21600)::int         as ready_s,
              random() < 0.12                                             as delayed,
              random() < 0.08                                             as clar,
              (600 + random() * 7200)::int                                as clar_s,
              random() < 0.85                                             as picked,
              random() < 0.80                                             as notif_acked,
              (random() * 3000)::int                                      as notif_s
       from generate_series(1, $1::int) g`,
      [opts.prescriptions],
    );
    await c.query("alter table _hx_rx add column proc_at int, add column ready_at int");
    await c.query("update _hx_rx set proc_at = ack_s + 120 + case when clar then clar_s else 0 end + proc_s");
    await c.query("update _hx_rx set ready_at = proc_at + ready_s");

    const selects = BRANCHES.map(
      (b) => `select n, wf, patient, ${b.k} as k, '${b.type}' as etype, '${b.actor}' as actor, ${b.at} as ts, ${b.payload ?? "'{}'::jsonb"} as payload from _hx_rx${b.where ? ` where ${b.where}` : ""}`,
    ).join("\n union all\n ");
    await c.query(
      `insert into care_events (event_id, occurred_at, recorded_at, patient_id, workflow_id, event_type, actor_type, actor_id, source_system, payload, verification_status, is_simulated, correlation_id, idempotency_key)
       select 'hx-' || n || '-' || k, ts, ts, patient, wf, etype, actor, actor || '-hist', '${SOURCE}', payload, 'confirmed', true, 'corr_' || wf, 'hx-' || n || '-' || k
       from (${selects}) e`,
    );
    await c.query(
      `insert into workflow_metrics (occurred_at, workflow_id, patient_id, metric, value_seconds, simulated)
       select t0 + ack_s * interval '1 second', wf, patient, 'ack_latency', ack_s::float8, true from _hx_rx
       union all select t0 + ready_at * interval '1 second', wf, patient, 'fulfilment_time', (ready_at - ack_s)::float8, true from _hx_rx
       union all select t0 + (ack_s + 120 + clar_s) * interval '1 second', wf, patient, 'clarification_resolution', clar_s::float8, true from _hx_rx where clar`,
    );
    // Gaps that the engine's demo deadlines (30 min to acknowledge, 120 min for a clarification) would have raised.
    await c.query(
      `insert into care_gap_events (occurred_at, gap_key, rule, patient_id, workflow_id, responsible, transition)
       select t0 + interval '1800 seconds', 'pharmacy_ack_overdue:' || wf, 'pharmacy_ack_overdue', patient, wf, 'clinician', 'detected' from _hx_rx where ack_s > 1800
       union all select t0 + ack_s * interval '1 second', 'pharmacy_ack_overdue:' || wf, 'pharmacy_ack_overdue', patient, wf, 'clinician', 'resolved' from _hx_rx where ack_s > 1800
       union all select t0 + (ack_s + 120 + 7200) * interval '1 second', 'clarification_unresolved:' || wf, 'clarification_unresolved', patient, wf, 'clinician', 'detected' from _hx_rx where clar and clar_s > 7200
       union all select t0 + (ack_s + 120 + clar_s) * interval '1 second', 'clarification_unresolved:' || wf, 'clarification_unresolved', patient, wf, 'clinician', 'resolved' from _hx_rx where clar and clar_s > 7200`,
    );
    await c.query("commit");
    const events = await scalar("select count(*) as n from care_events where source_system = $1", [SOURCE]);
    log(`inserted ${events.toLocaleString()} events in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    log("refreshing continuous aggregates...");
    for (const v of ["care_events_hourly", "workflow_metrics_daily", "care_gaps_daily", "agent_latency_hourly", "notifications_daily"]) {
      const s = Date.now();
      await c.query(`call refresh_continuous_aggregate('${v}', null, null)`);
      log(`  ${v}: ${Date.now() - s} ms`);
    }
    await c.query("analyze care_events");
    return { skipped: false, events };
  } catch (err) {
    await c.query("rollback").catch(() => {});
    throw err;
  } finally {
    await c.end();
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const i = process.argv.indexOf("--prescriptions");
  const prescriptions = i > -1 ? Number(process.argv[i + 1]) : 60_000;
  if (!Number.isInteger(prescriptions) || prescriptions < 1 || prescriptions > 500_000) throw new Error("--prescriptions must be between 1 and 500000");
  const r = await seedHistory(url, { prescriptions, force: process.argv.includes("--force"), log: (m) => console.log(m) });
  console.log(r.skipped ? "nothing changed" : `done: ${r.events.toLocaleString()} synthetic events`);
}

if (process.argv[1]?.endsWith("seed-history.ts")) {
  main().catch((e) => {
    console.error("seed failed:", (e as Error).message);
    process.exit(1);
  });
}
