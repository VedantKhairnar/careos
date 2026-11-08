import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Actor, CareEvent } from "@/domain/events";
import { HttpError } from "./http";
import { runtime } from "./runtime";
import { envelope, submit } from "./services";

/**
 * Home readings. The patient records them (always labelled patient-reported). The clinician decides which range
 * to watch. The system only DESCRIBES change in plain words and flags a reading that is outside a range the
 * clinician set. It never says a value is normal, abnormal or serious, and it has no default ranges.
 */
export const METRICS = {
  heart_rate: { label: "Resting heart rate", unit: "bpm", lo: 20, hi: 250 },
  blood_pressure: { label: "Blood pressure", unit: "mmHg", lo: 50, hi: 260 }, // value = top number, value2 = bottom number
  pain_score: { label: "Pain score (0 to 10)", unit: "", lo: 0, hi: 10 },
  temperature: { label: "Temperature", unit: "°C", lo: 30, hi: 43 },
} as const;
export type Metric = keyof typeof METRICS;
const MetricEnum = z.enum(["heart_rate", "blood_pressure", "pain_score", "temperature"]);

export const ReadingInput = z.object({
  metric: MetricEnum,
  value: z.number().finite(),
  value2: z.number().finite().optional(),
  note: z.string().max(200).optional(),
  idempotencyKey: z.string().min(1).max(100).optional(),
});
export const ThresholdInput = z.object({ patientId: z.string().min(1), metric: MetricEnum, min: z.number().finite().optional(), max: z.number().finite().optional() });

export interface Point {
  at: string;
  value: number;
  value2?: number;
}
export interface Threshold {
  min?: number;
  max?: number;
}
export interface MetricSeries {
  metric: Metric;
  label: string;
  unit: string;
  points: Point[];
  latest: Point | null;
  change: string | null;
  weekly: string | null;
  threshold: Threshold | null;
  flagged: Point | null;
}
export interface ReadingsView {
  series: MetricSeries[];
  flags: { metric: Metric; label: string; at: string; value: number; value2?: number; unit: string; limit: string }[];
}


function describeChange(m: Metric, pts: Point[]): string | null {
  if (pts.length < 2) return null;
  const d = Math.round((pts[pts.length - 1].value - pts[pts.length - 2].value) * 10) / 10;
  const u = METRICS[m].unit ? ` ${METRICS[m].unit}` : "";
  const what = m === "blood_pressure" ? "the top number" : "";
  if (d === 0) return `Same as the previous reading${what ? ` (${what})` : ""}.`;
  return `${d > 0 ? "Up" : "Down"} ${Math.abs(d)}${u} from the previous reading${what ? ` (${what})` : ""}.`;
}

function describeWeek(m: Metric, pts: Point[], nowMs: number): string | null {
  const day = 86_400_000;
  const a = pts.filter((p) => nowMs - Date.parse(p.at) <= 7 * day);
  const b = pts.filter((p) => nowMs - Date.parse(p.at) > 7 * day && nowMs - Date.parse(p.at) <= 14 * day);
  if (a.length === 0 || b.length === 0) return null;
  const avg = (x: Point[]) => x.reduce((n, p) => n + p.value, 0) / x.length;
  const d = Math.round((avg(a) - avg(b)) * 10) / 10;
  const u = METRICS[m].unit ? ` ${METRICS[m].unit}` : "";
  return d === 0 ? "This week's average matches last week's." : `This week's average is ${Math.abs(d)}${u} ${d > 0 ? "higher" : "lower"} than last week's.`;
}

function build(events: CareEvent[], now: number): ReadingsView {
  const series: MetricSeries[] = (Object.keys(METRICS) as Metric[]).map((m) => {
    const points: Point[] = events
      .filter((e) => e.type === "reading.recorded" && e.payload.metric === m)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
      .map((e) => ({ at: e.recordedAt, value: Number(e.payload.value), ...(e.payload.value2 !== undefined ? { value2: Number(e.payload.value2) } : {}) }))
      .slice(-60);
    const t = events.filter((e) => e.type === "reading.threshold_set" && e.payload.metric === m).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
    const threshold: Threshold | null = t ? { ...(t.payload.min !== undefined ? { min: Number(t.payload.min) } : {}), ...(t.payload.max !== undefined ? { max: Number(t.payload.max) } : {}) } : null;
    const latest = points.at(-1) ?? null;
    const out = (p: Point) => Boolean(threshold && ((threshold.max !== undefined && p.value > threshold.max) || (threshold.min !== undefined && p.value < threshold.min)));
    return { metric: m, label: METRICS[m].label, unit: METRICS[m].unit, points, latest, change: describeChange(m, points), weekly: describeWeek(m, points, now), threshold, flagged: latest && out(latest) ? latest : null };
  });
  const flags = series.flatMap((s) =>
    s.flagged && s.threshold
      ? [{ metric: s.metric, label: s.label, at: s.flagged.at, value: s.flagged.value, ...(s.flagged.value2 !== undefined ? { value2: s.flagged.value2 } : {}), unit: s.unit, limit: s.threshold.max !== undefined && s.flagged.value > s.threshold.max ? `above ${s.threshold.max}` : `below ${s.threshold.min}` }]
      : [],
  );
  return { series, flags };
}

const isPatientSide = (a: Actor) => a.role === "patient" || a.role === "caregiver";

export async function listReadings(actor: Actor, patientIdParam?: string): Promise<ReadingsView> {
  const patientId = isPatientSide(actor) ? (actor.patientId ?? "") : actor.role === "clinician" ? patientIdParam : undefined;
  if (!patientId) throw new HttpError(actor.role === "clinician" ? 400 : 403, actor.role === "clinician" ? "validation_failed" : "forbidden", actor.role === "clinician" ? "patientId is required" : "Not allowed");
  return build(await runtime().orchestrator.listEventsFor(actor, patientId), Date.now());
}

export async function recordReading(actor: Actor, input: z.infer<typeof ReadingInput>): Promise<ReadingsView> {
  if (!isPatientSide(actor)) throw new HttpError(403, "forbidden", "Only the patient can record a reading");
  const m = METRICS[input.metric];
  const bad = (v: number) => v < m.lo || v > m.hi;
  if (bad(input.value)) throw new HttpError(400, "validation_failed", `That does not look like a ${m.label.toLowerCase()} (${m.lo} to ${m.hi}). Please check the number.`);
  if (input.metric === "blood_pressure") {
    if (input.value2 === undefined || input.value2 < 30 || input.value2 > 160) throw new HttpError(400, "validation_failed", "Please enter both blood pressure numbers (for example 120 and 80).");
    if (input.value2 >= input.value) throw new HttpError(400, "validation_failed", "The top blood pressure number should be larger than the bottom one.");
  }
  const patientId = actor.patientId ?? "";
  await submit(
    actor,
    envelope(actor, { workflowId: `readings:${patientId}`, patientId, type: "reading.recorded", idempotencyKey: input.idempotencyKey ?? `reading:${randomUUID()}`, correlationId: `corr_readings_${patientId}` }, { payload: { metric: input.metric, value: input.value, ...(input.value2 !== undefined ? { value2: input.value2 } : {}), ...(input.note ? { note: input.note } : {}) } }),
  );
  return listReadings(actor);
}

export async function setThreshold(actor: Actor, input: z.infer<typeof ThresholdInput>): Promise<ReadingsView> {
  if (actor.role !== "clinician") throw new HttpError(403, "forbidden", "Only a clinician can set a range");
  if (input.min === undefined && input.max === undefined) throw new HttpError(400, "validation_failed", "Set a lowest value, a highest value, or both.");
  if (input.min !== undefined && input.max !== undefined && input.min >= input.max) throw new HttpError(400, "validation_failed", "The lowest value must be below the highest value.");
  await submit(
    actor,
    envelope(actor, { workflowId: `readings:${input.patientId}`, patientId: input.patientId, type: "reading.threshold_set", idempotencyKey: `threshold:${randomUUID()}`, correlationId: `corr_readings_${input.patientId}` }, { payload: { metric: input.metric, ...(input.min !== undefined ? { min: input.min } : {}), ...(input.max !== undefined ? { max: input.max } : {}) } }),
  );
  return listReadings(actor, input.patientId);
}
