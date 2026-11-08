"use client";

import { useState } from "react";
import type { MetricSeries, Metric, ReadingsView } from "@/server/readings";
import { api, ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useApi } from "@/lib/useApi";
import { Badge, Button, Card, CardSkeleton, EmptyState, ErrorState, useToast } from "./ui";

const LABEL: Record<Metric, string> = { heart_rate: "Resting heart rate", blood_pressure: "Blood pressure", pain_score: "Pain score (0 to 10)", temperature: "Temperature" };
/** Pre-filled so nothing has to be typed during a demo. The patient can change every value. */
const PATIENT_DEFAULT: Record<Metric, { v: string; v2?: string }> = { heart_rate: { v: "74" }, blood_pressure: { v: "124", v2: "80" }, pain_score: { v: "3" }, temperature: { v: "36.8" } };
/** A starting point for the clinician, editable. The system itself has no default ranges. */
const RANGE_DEFAULT: Record<Metric, { min: string; max: string }> = { heart_rate: { min: "50", max: "100" }, blood_pressure: { min: "", max: "140" }, pain_score: { min: "", max: "7" }, temperature: { min: "", max: "38" } };
const input = "mt-1 block min-h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm";

function Spark({ s }: { s: MetricSeries }) {
  const pts = s.points.slice(-20);
  if (pts.length < 2) return <p className="text-xs text-muted">Add another reading to see a trend.</p>;
  const vals = pts.map((p) => p.value);
  const lo = Math.min(...vals, s.threshold?.min ?? Infinity);
  const hi = Math.max(...vals, s.threshold?.max ?? -Infinity);
  const y = (v: number) => 4 + (hi === lo ? 24 : ((hi - v) / (hi - lo)) * 48);
  const x = (i: number) => 4 + (i / (pts.length - 1)) * 232;
  return (
    <svg viewBox="0 0 240 56" className="h-14 w-full" role="img" aria-label={`${s.label}: ${pts.length} readings, latest ${pts.at(-1)!.value}`}>
      {s.threshold?.max !== undefined && <line x1="0" x2="240" y1={y(s.threshold.max)} y2={y(s.threshold.max)} stroke="currentColor" strokeDasharray="3 3" className="text-warning" />}
      {s.threshold?.min !== undefined && <line x1="0" x2="240" y1={y(s.threshold.min)} y2={y(s.threshold.min)} stroke="currentColor" strokeDasharray="3 3" className="text-warning" />}
      <polyline fill="none" stroke="currentColor" strokeWidth="2" className="text-accent" points={pts.map((p, i) => `${x(i)},${y(p.value)}`).join(" ")} />
      {pts.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p.value)} r="3" className={i === pts.length - 1 ? "fill-accent" : "fill-surface stroke-accent"} strokeWidth="1.5" />
      ))}
    </svg>
  );
}

/**
 * Home readings. Patient mode (no patientId): add a reading, see the trend. Clinician mode: see the trend, set the range
 * worth flagging. Descriptive only: the app never calls a value normal, abnormal or serious.
 */
export function ReadingsPanel({ patientId }: { patientId?: string }) {
  const toast = useToast();
  const r = useApi<ReadingsView>(`/api/readings${patientId ? `?patientId=${patientId}` : ""}`, { pollMs: 4000 });
  const [metric, setMetric] = useState<Metric>("heart_rate");
  const [vals, setVals] = useState(PATIENT_DEFAULT);
  const [range, setRange] = useState(RANGE_DEFAULT);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      if (!patientId) {
        const v = vals[metric];
        await api("/api/readings", { body: { metric, value: Number(v.v), ...(metric === "blood_pressure" ? { value2: Number(v.v2) } : {}) } });
        toast("Reading saved. Your care team can see it.");
      } else {
        const g = range[metric];
        await api("/api/readings/thresholds", { body: { patientId, metric, ...(g.min !== "" ? { min: Number(g.min) } : {}), ...(g.max !== "" ? { max: Number(g.max) } : {}) } });
        toast("Range saved. Readings outside it will be flagged for you.");
      }
      await r.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "That did not work. Please try again.", "danger");
    } finally {
      setBusy(false);
    }
  }

  if (r.loading) return <CardSkeleton rows={3} />;
  if (r.error) return <ErrorState message={r.error.message} onRetry={r.reload} />;
  const data = r.data!;
  const shown = data.series.filter((s) => s.points.length > 0 || s.threshold);

  return (
    <Card title={patientId ? "Home readings" : "Your home readings"}>
      {data.flags.length > 0 && patientId && (
        <div role="note" className="mb-3 rounded-xl bg-warning-bg p-3 text-sm text-warning">
          {data.flags.map((f) => (
            <p key={f.metric}>
              <strong>{f.label}</strong> {f.value}
              {f.value2 !== undefined ? `/${f.value2}` : ""} {f.unit} on {formatDateTime(f.at)} is {f.limit}, outside the range you set. Patient-reported; please review.
            </p>
          ))}
        </div>
      )}

      <div className="rounded-xl border border-line p-3">
        <label className="block text-sm font-medium">
          {patientId ? "Watch this measurement" : "What did you measure?"}
          <select className={input} value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
            {(Object.keys(LABEL) as Metric[]).map((m) => (
              <option key={m} value={m}>
                {LABEL[m]}
              </option>
            ))}
          </select>
        </label>
        {!patientId ? (
          <div className="mt-2 flex gap-2">
            <label className="block flex-1 text-sm font-medium">
              {metric === "blood_pressure" ? "Top number" : "Value"}
              <input className={input} inputMode="decimal" value={vals[metric].v} onChange={(e) => setVals((s) => ({ ...s, [metric]: { ...s[metric], v: e.target.value } }))} />
            </label>
            {metric === "blood_pressure" && (
              <label className="block flex-1 text-sm font-medium">
                Bottom number
                <input className={input} inputMode="decimal" value={vals[metric].v2 ?? ""} onChange={(e) => setVals((s) => ({ ...s, [metric]: { ...s[metric], v2: e.target.value } }))} />
              </label>
            )}
          </div>
        ) : (
          <div className="mt-2 flex gap-2">
            <label className="block flex-1 text-sm font-medium">
              Flag if below
              <input className={input} inputMode="decimal" value={range[metric].min} onChange={(e) => setRange((s) => ({ ...s, [metric]: { ...s[metric], min: e.target.value } }))} />
            </label>
            <label className="block flex-1 text-sm font-medium">
              Flag if above
              <input className={input} inputMode="decimal" value={range[metric].max} onChange={(e) => setRange((s) => ({ ...s, [metric]: { ...s[metric], max: e.target.value } }))} />
            </label>
          </div>
        )}
        {patientId && <p className="mt-1 text-xs text-muted">Your own range. The system has no default ranges and never judges a value; it only flags what is outside the range you set.</p>}
        <Button className="mt-3" loading={busy} onClick={save}>
          {patientId ? "Save range" : "Add reading"}
        </Button>
      </div>

      {shown.length === 0 ? (
        <div className="mt-3">
          <EmptyState title="No readings yet" hint={patientId ? "When the patient adds a reading, the trend appears here." : "Add a reading above. Your care team sees the trend."} />
        </div>
      ) : (
        <ul className="mt-3 space-y-3">
          {shown.map((s) => (
            <li key={s.metric} className="rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">{s.label}</p>
                {s.flagged ? <Badge tone="warning">Outside the range set</Badge> : s.threshold ? <Badge tone="success">Within the range set</Badge> : null}
              </div>
              {s.latest && (
                <p className="text-sm">
                  Latest: <strong>{s.metric === "blood_pressure" && s.latest.value2 !== undefined ? `${s.latest.value}/${s.latest.value2}` : s.latest.value}</strong> {s.unit} <span className="text-muted">· {formatDateTime(s.latest.at)} · reported by the patient</span>
                </p>
              )}
              <Spark s={s} />
              {s.change && <p className="text-sm text-muted">{s.change}</p>}
              {s.weekly && <p className="text-sm text-muted">{s.weekly}</p>}
              {s.threshold && (
                <p className="text-xs text-muted">
                  Range set by the clinician: {s.threshold.min !== undefined ? `from ${s.threshold.min} ` : ""}
                  {s.threshold.max !== undefined ? `up to ${s.threshold.max}` : ""}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted">These are the patient&apos;s own measurements. They are not verified, and CareOS does not diagnose or say whether a value is serious.</p>
    </Card>
  );
}
