"use client";

import { Badge, Card, CardSkeleton, EmptyState, ErrorState } from "@/components/ui";
import type { Analytics } from "@/server/store";
import { useApi } from "@/lib/useApi";

type Ready = Extract<Analytics, { available: true }>;

const METRIC_LABEL: Record<string, string> = {
  ack_latency: "Pharmacy acknowledgment",
  fulfilment_time: "Acknowledged to ready",
  clarification_resolution: "Pharmacy question answered",
};
const GAP_LABEL: Record<string, string> = {
  pharmacy_ack_overdue: "Pharmacy has not acknowledged",
  delay_unaddressed: "Delay not followed up",
  clarification_unresolved: "Pharmacy question waiting",
  notification_unacknowledged: "Update not acknowledged",
};

const duration = (s: number | null) => (s === null ? "no data" : s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${(s / 60).toFixed(1)} min` : `${(s / 3600).toFixed(1)} h`);
const bytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`);
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const hour = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric" });

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <p className="text-2xl font-bold sm:text-3xl">{value}</p>
      <p className="mt-1 text-sm text-muted">{label}</p>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** One horizontal bar per row, with the number printed next to it so it never relies on length alone. */
function BarRows({ rows, format = (n: number) => n.toLocaleString() }: { rows: { label: string; value: number; extra?: string }[]; format?: (n: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2">
      {rows.map((r, i) => (
        <li key={i} className="grid grid-cols-[7.5rem_1fr_auto] items-center gap-3 text-sm">
          <span className="truncate text-muted">{r.label}</span>
          <span className="h-3 overflow-hidden rounded-full bg-surface-2">
            <span className="block h-full rounded-full bg-accent" style={{ width: `${(r.value / max) * 100}%` }} />
          </span>
          <span className="tabular-nums">
            {format(r.value)}
            {r.extra && <span className="text-muted"> {r.extra}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function AnalyticsPage() {
  const { data, loading, error, reload } = useApi<Analytics>("/api/analytics", { pollMs: 15000 });

  if (loading) return <CardSkeleton rows={6} />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data || !data.available) {
    return (
      <>
        <h1 className="text-2xl font-bold">Analytics</h1>
        <EmptyState title="Analytics need Tiger Data" hint={data && !data.available ? data.reason : "No data."} />
      </>
    );
  }
  const a: Ready = data;

  const hourly = new Map<string, number>();
  for (const p of a.eventsHourly) hourly.set(p.bucket, (hourly.get(p.bucket) ?? 0) + p.value);
  const hourlyRows = [...hourly.entries()].slice(-24).map(([b, v], i, all) => ({ label: i === 0 || day(b) !== day(all[i - 1][0]) ? `${day(b)} ${hour(b)}` : hour(b), value: v }));

  const metricNames = [...new Set(a.metricsDaily.map((m) => m.metric))];
  const notifDays = [...new Set(a.notificationsDaily.map((n) => n.bucket))].slice(-7);
  const gapDays = [...new Set(a.gapsDaily.map((g) => g.bucket))].slice(-7);
  const ratio = a.storage.compressedFromBytes && a.storage.compressedToBytes ? a.storage.compressedFromBytes / a.storage.compressedToBytes : null;

  return (
    <>
      <div>
        <h1 className="text-2xl font-bold">Analytics</h1>
        <p className="text-sm text-muted">
          Every figure here is a live query against {a.source}. Updated {new Date(a.generatedAt).toLocaleTimeString()}.
        </p>
      </div>

      {a.totals.syntheticEvents > 0 && (
        <div role="note" className="rounded-xl bg-info-bg p-3 text-sm text-info">
          <strong>{a.totals.syntheticEvents.toLocaleString()} of these events are synthetic history</strong> generated to give the time-series features real volume. They are labelled simulated, they are hidden from patient and clinician screens, and they are not real care activity.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Events recorded" value={a.totals.events.toLocaleString()} />
        <Stat label="Prescription workflows" value={a.totals.prescriptions.toLocaleString()} />
        <Stat label="Open care gaps right now" value={a.totals.openGaps.toLocaleString()} hint={`${a.totals.resolvedGaps.toLocaleString()} resolved to date`} />
        <Stat label="Median pharmacy acknowledgment" value={duration(a.ackLatency.medianSeconds)} hint={`${a.ackLatency.samples.toLocaleString()} samples, last 30 days`} />
        <Stat label="90th percentile" value={duration(a.ackLatency.p90Seconds)} hint="9 in 10 acknowledged within this" />
        <Stat label="Storage" value={bytes(a.storage.hypertableBytes)} hint={`${a.storage.compressedChunks} of ${a.storage.chunks} chunks compressed${ratio ? ` (${ratio.toFixed(1)}x smaller)` : ""}`} />
      </div>

      <Card title="Prescription events per hour (last 24 hours with activity)">
        {hourlyRows.length === 0 ? <EmptyState title="No events in the last 48 hours" /> : <BarRows rows={hourlyRows} />}
      </Card>

      <Card title="How long things take (daily average, last 7 days)">
        {metricNames.length === 0 ? (
          <EmptyState title="No timing data yet" />
        ) : (
          <div className="space-y-5">
            {metricNames.map((m) => (
              <div key={m}>
                <p className="mb-2 font-medium">{METRIC_LABEL[m] ?? m}</p>
                <BarRows
                  format={duration}
                  rows={a.metricsDaily.filter((r) => r.metric === m).slice(-7).map((r) => ({ label: day(r.bucket), value: r.avgSeconds, extra: `· ${r.samples.toLocaleString()} samples` }))}
                />
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Care gaps per day">
          {gapDays.length === 0 ? (
            <EmptyState title="No gaps recorded" />
          ) : (
            <ul className="space-y-3 text-sm">
              {gapDays.map((d) => {
                const rows = a.gapsDaily.filter((g) => g.bucket === d);
                return (
                  <li key={d}>
                    <p className="font-medium">{day(d)}</p>
                    {rows.map((g) => (
                      <p key={g.rule} className="flex justify-between gap-3 text-muted">
                        <span>{GAP_LABEL[g.rule] ?? g.rule}</span>
                        <span className="tabular-nums">{g.detected} found · {g.resolved} resolved</span>
                      </p>
                    ))}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Updates sent and acknowledged (per day)">
          {notifDays.length === 0 ? (
            <EmptyState title="No notifications yet" />
          ) : (
            <ul className="space-y-2 text-sm">
              {notifDays.map((d) => {
                const sent = a.notificationsDaily.find((n) => n.bucket === d && n.event === "notification.sent")?.events ?? 0;
                const acked = a.notificationsDaily.find((n) => n.bucket === d && n.event === "notification.acknowledged")?.events ?? 0;
                return (
                  <li key={d} className="flex justify-between gap-3">
                    <span className="text-muted">{day(d)}</span>
                    <span className="tabular-nums">
                      {sent.toLocaleString()} sent · {acked.toLocaleString()} acknowledged{sent ? ` (${Math.round((acked / sent) * 100)}%)` : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <Card title="AI assistants, per hour (live)">
        {a.agentHourly.length === 0 ? (
          <EmptyState title="No assistant calls yet" hint="Ask the patient assistant a question to see it appear here." />
        ) : (
          <ul className="divide-y divide-line text-sm">
            {a.agentHourly.slice(-12).map((r, i) => (
              <li key={i} className="flex flex-wrap justify-between gap-2 py-2">
                <span>
                  <span className="capitalize">{r.agent}</span> <span className="text-muted">{hour(r.bucket)}</span>
                </span>
                <span className="tabular-nums text-muted">
                  {r.calls} call{r.calls === 1 ? "" : "s"} · avg {Math.round(r.avgMs)} ms · {r.inputTokens.toLocaleString()} in / {r.outputTokens.toLocaleString()} out tokens
                  {r.failures ? ` · ${r.failures} failed` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="How fast is the aggregate? (measured just now)" action={<Badge tone={a.timings.resultsMatch ? "success" : "danger"}>{a.timings.resultsMatch ? "Results identical" : "Results differ"}</Badge>}>
        <p className="text-sm">
          The same question over the last {a.timings.windowHours / 24} days, answered two ways: from the continuous aggregate, and by counting {a.timings.rawRowsScanned.toLocaleString()} raw event rows.
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-xl bg-surface-2 p-3">
            <dt className="text-muted">Continuous aggregate</dt>
            <dd className="text-xl font-bold tabular-nums">{a.timings.aggregateMs} ms</dd>
          </div>
          <div className="rounded-xl bg-surface-2 p-3">
            <dt className="text-muted">Raw rows</dt>
            <dd className="text-xl font-bold tabular-nums">{a.timings.rawMs} ms</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-muted">These include the network round trip to the cloud database, which is the same for both and hides part of the gap. Timings vary run to run; this is one measurement, not a benchmark average.</p>
      </Card>
    </>
  );
}
