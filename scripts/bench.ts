import pg from "pg";
import { poolConfig } from "@/server/db";

/**
 * Measures, on whatever database DATABASE_URL points at: row counts, chunk layout, continuous-aggregate versus
 * raw-query timings (best and median of several runs), and optionally real columnstore compression.
 * Usage:  node --import tsx scripts/bench.ts [--compress]
 */
const RUNS = 7;
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`);

async function main() {
  const c = new pg.Client(poolConfig(process.env.DATABASE_URL!));
  await c.connect();
  const q = async (sql: string) => (await c.query(sql)).rows;
  const time = async (label: string, sql: string) => {
    const ms: number[] = [];
    let rows = 0;
    for (let i = 0; i < RUNS; i++) {
      const t = performance.now();
      rows = (await c.query(sql)).rowCount ?? 0;
      ms.push(performance.now() - t);
    }
    console.log(`  ${label.padEnd(46)} best ${Math.min(...ms).toFixed(1).padStart(7)} ms   median ${median(ms).toFixed(1).padStart(7)} ms   (${rows} result rows)`);
    return median(ms);
  };

  // Server-side execution time from EXPLAIN ANALYZE, which excludes the network round trip to the cloud database.
  const serverMs = async (sql: string) => {
    const ms: number[] = [];
    for (let i = 0; i < RUNS; i++) ms.push(Number(((await q(`explain (analyze, format json) ${sql}`))[0]["QUERY PLAN"] as { "Execution Time": number }[])[0]["Execution Time"]));
    return median(ms);
  };

  const [n] = await q("select count(*)::bigint e, count(*) filter (where source_system='synthetic-history')::bigint s from care_events");
  console.log(`care_events: ${Number(n.e).toLocaleString()} rows (${Number(n.s).toLocaleString()} synthetic)`);
  const chunks = await q("select count(*)::int n, count(*) filter (where is_compressed)::int c from timescaledb_information.chunks where hypertable_name='care_events'");
  console.log(`chunks: ${chunks[0].n} (${chunks[0].c} compressed)`);

  if (process.argv.includes("--compress")) {
    const before = (await q("select * from hypertable_compression_stats('care_events')"))[0];
    const beforeSize = Number((await q("select hypertable_size('care_events') s"))[0].s);
    const t = performance.now();
    const done = await q("select compress_chunk(c, if_not_compressed => true) from show_chunks('care_events', older_than => interval '7 days') c");
    console.log(`compressed ${done.length} chunk(s) older than 7 days in ${((performance.now() - t) / 1000).toFixed(1)}s`);
    const after = (await q("select * from hypertable_compression_stats('care_events')"))[0];
    const afterSize = Number((await q("select hypertable_size('care_events') s"))[0].s);
    const b = Number(after.before_compression_total_bytes), a = Number(after.after_compression_total_bytes);
    console.log(`  compressed chunks: ${fmtBytes(b)} -> ${fmtBytes(a)}  (${(b / a).toFixed(1)}x smaller)`);
    console.log(`  whole hypertable:  ${fmtBytes(beforeSize)} -> ${fmtBytes(afterSize)}`);
    void before;
  }

  console.log(`\nSame question, 30-day window (${RUNS} runs each):`);
  const w = "date_trunc('hour', now()) - interval '720 hours'";
  const agg = await time("A) continuous aggregate (care_events_hourly)", `select event_type, sum(events)::bigint n from care_events_hourly where bucket >= ${w} group by 1 order by 1`);
  const raw = await time("B) raw rows (care_events)", `select event_type, count(*)::bigint n from care_events where event_type like 'prescription.%' and occurred_at >= ${w} group by 1 order by 1`);
  const a1 = await q(`select event_type, sum(events)::bigint n from care_events_hourly where bucket >= ${w} group by 1 order by 1`);
  const b1 = await q(`select event_type, count(*)::bigint n from care_events where event_type like 'prescription.%' and occurred_at >= ${w} group by 1 order by 1`);
  console.log(`  results identical: ${JSON.stringify(a1) === JSON.stringify(b1)}   round-trip speedup ${(raw / agg).toFixed(1)}x`);
  const sa = await serverMs(`select event_type, sum(events)::bigint n from care_events_hourly where bucket >= ${w} group by 1 order by 1`);
  const sb = await serverMs(`select event_type, count(*)::bigint n from care_events where event_type like 'prescription.%' and occurred_at >= ${w} group by 1 order by 1`);
  console.log(`  server-side execution (EXPLAIN ANALYZE, median): aggregate ${sa.toFixed(1)} ms vs raw ${sb.toFixed(1)} ms  ->  ${(sb / sa).toFixed(1)}x`);

  console.log("\nA lookup the app does constantly (one workflow, via the composite index):");
  const wf = (await q("select workflow_id from care_events where source_system='synthetic-history' limit 1"))[0]?.workflow_id;
  if (wf) await time("events for one workflow", `select * from care_events where workflow_id = '${wf}' order by recorded_at, seq`);
  await c.end();
}
main().catch((e) => { console.error("bench failed:", (e as Error).message); process.exit(1); });
