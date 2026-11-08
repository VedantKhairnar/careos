import { z } from "zod";
import type { Actor } from "@/domain/events";
import { CarePlanContentSchema, createCarePlan, type CarePlanContent, type CarePlanView } from "@/server/carePlans";
import { HttpError } from "@/server/http";
import { runtime } from "@/server/runtime";
import { AiUnavailable, getModel } from "./model";
import { loggedRun } from "./loggedRun";
import { runAgent } from "./runner";
import { logStep } from "./runLog";
import { DOCTOR_TOOLS } from "./tools";

/** The Doctor Agent has its own identity. It can draft and submit for review, never approve. */
export const DOCTOR_AGENT_ACTOR: Actor = { id: "doctor-agent", role: "agent" };

export const DRAFT_SYSTEM = `You turn a clinician's own visit notes into a structured care-plan DRAFT for that clinician to review. Never put the word "draft" in the plan title; use a short plain title such as "Recovery plan for <condition>". A human will read and approve it before any patient sees it.

HARD RULES
1. Use ONLY what is written in the notes. Never add instructions, medicines, doses, times, dates, follow-ups or warning signs that are not in the notes.
2. If a medicine is mentioned without a dose, without clock times, or without a start date, leave those fields OUT. Never guess them and never infer clock times from words like "twice a day".
3. Times must be 24-hour HH:MM and dates YYYY-MM-DD, only when the notes state them.
4. Do not diagnose or recommend treatment. Do not add commentary.
5. warningSigns: only text the clinician wrote about when to seek help. If none, return an empty list.
6. Write instructions in plain, simple language but keep the clinician's meaning.`;

export const SUMMARY_SYSTEM = `You help a clinician quickly understand where one patient's care coordination stands. Use ONLY tool results. Be concise (a short paragraph and at most five bullets).

HARD RULES
1. Report administrative and workflow facts: plan status, prescription status, open care gaps, unanswered questions.
2. Do not diagnose, recommend treatment, change medications, or estimate clinical risk.
3. Say who each open item is waiting on. If everything is on track, say so.
4. Mark anything that is simulated demonstration data as simulated.`;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

/** Does the notes text plausibly contain this clock time (08:00, 8:00, 8am, 8 am, 20:00, 8pm...)? */
function mentionsTime(notes: string, hhmm: string): boolean {
  const n = norm(notes);
  const [hs, ms] = hhmm.split(":");
  const h = Number(hs);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const suffix = h < 12 ? "am" : "pm";
  const candidates = [hhmm, `${h}:${ms}`];
  if (ms === "00") candidates.push(`${h12}${suffix}`, `${h12} ${suffix}`, `${h12} o'clock`);
  else candidates.push(`${h12}:${ms}${suffix}`, `${h12}:${ms} ${suffix}`);
  return candidates.some((c) => n.includes(c));
}

/**
 * Anti-hallucination guard. Whatever the model returns, a dose, time or date that does not appear in the
 * clinician's notes is removed, which makes the medicine "incomplete" (the patient is told the schedule is
 * not confirmed) instead of letting an invented value reach a reminder. Returns what it removed.
 */
export function groundDraft(content: CarePlanContent, notes: string): { content: CarePlanContent; removed: string[] } {
  const n = norm(notes);
  const removed: string[] = [];
  const medications = content.medications.map((m) => {
    const out = { ...m };
    if (out.dose && !n.includes(norm(out.dose))) {
      removed.push(`${m.name}: dose "${out.dose}" is not in your notes`);
      delete out.dose;
    }
    if (out.times) {
      const kept = out.times.filter((t) => mentionsTime(notes, t));
      const dropped = out.times.filter((t) => !kept.includes(t));
      if (dropped.length) removed.push(`${m.name}: time ${dropped.join(", ")} is not in your notes`);
      if (kept.length) out.times = kept;
      else delete out.times;
    }
    for (const k of ["startDate", "endDate"] as const) {
      if (out[k] && !n.includes(out[k]!)) {
        removed.push(`${m.name}: ${k === "startDate" ? "start date" : "end date"} ${out[k]} is not in your notes`);
        delete out[k];
      }
    }
    return out;
  });
  const followUps = content.followUps.map((f) => {
    if (f.dueDate && !n.includes(f.dueDate)) {
      removed.push(`Follow-up "${f.description}": date ${f.dueDate} is not in your notes`);
      return { description: f.description };
    }
    return f;
  });
  return { content: { ...content, medications, followUps }, removed };
}

export interface DraftResult {
  plan: CarePlanView;
  /** Values the guard removed because they were not in the notes. Shown to the clinician. */
  removed: string[];
  model: string;
}

/** Some models fill an optional field they have no value for with "" or null. Treat those as absent. */
export function dropEmpty(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropEmpty);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== "" && x !== null).map(([k, x]) => [k, dropEmpty(x)]));
  return v;
}

export async function draftCarePlanFromNotes(clinician: Actor, input: { patientId: string; notes: string }): Promise<DraftResult> {
  if (clinician.role !== "clinician") throw new HttpError(403, "forbidden", "Only a clinician can request a draft");
  const notes = input.notes.trim();
  if (notes.length < 10) throw new HttpError(400, "validation_failed", "Please paste your visit notes (at least a sentence)");
  if (notes.length > 6000) throw new HttpError(400, "validation_failed", "Please keep the notes under 6000 characters");

  const schema = z.toJSONSchema(CarePlanContentSchema) as Record<string, unknown>;
  delete schema.$schema;
  const startedAt = new Date().toISOString();
  let draftRunId = "";
  const res = await loggedRun(
    { agent: "doctor-agent", trigger: "doctor.draft_plan", patientId: input.patientId, start: "Clinician asked for a care-plan draft from visit notes" },
    async (_o, runId) => {
      draftRunId = runId;
      const r = await getModel().generate({
    system: DRAFT_SYSTEM,
    contents: [{ role: "user", parts: [{ text: `Visit notes:\n"""\n${notes}\n"""` }] }],
    responseJsonSchema: schema,
    maxOutputTokens: 2048,
      });
      logStep(runId, { agent: "doctor-agent", kind: "think", title: "Gemini call", detail: `${r.model} · ${r.usage.input} tokens in, ${r.usage.output} out`, ms: r.latencyMs, ok: true });
      return r;
    },
    () => "The model answered. Checking the draft against the clinician's notes next.",
  );
  await runtime().store.logAgentExecution({ agent: "doctor", patientId: input.patientId, startedAt, durationMs: res.latencyMs, ok: true, tool: "draft_care_plan", model: res.model, inputTokens: res.usage.input, outputTokens: res.usage.output });

  let json: unknown;
  try {
    json = JSON.parse(res.text);
  } catch {
    throw new AiUnavailable("bad_output", "The assistant's draft could not be read. Please try again.");
  }
  const parsed = CarePlanContentSchema.safeParse(dropEmpty(json));
  if (!parsed.success) {
    logStep(draftRunId, { agent: "doctor-agent", kind: "error", title: "Draft rejected", detail: `The draft was not in the expected format: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`, ok: false });
    throw new AiUnavailable("bad_output", "The assistant's draft was not in the expected format. Please try again.");
  }

  const grounded = groundDraft(parsed.data, notes);
  // Submitted as the agent: it enters review, it cannot approve, and the patient cannot see it yet.
  const plan = await createCarePlan(DOCTOR_AGENT_ACTOR, { patientId: input.patientId, content: grounded.content });
  logStep(draftRunId, { agent: "doctor-agent", kind: "decision", title: "Draft saved for review", detail: `Nothing the notes did not say was kept${grounded.removed.length ? ` (${grounded.removed.length} unsupported value(s) removed)` : ""}. The agent cannot approve it.`, ok: true });
  return { plan, removed: grounded.removed, model: res.model };
}

export async function summarizePatientForClinician(clinician: Actor, patientId: string): Promise<{ summary: string; sources: string[]; model: string }> {
  if (clinician.role !== "clinician") throw new HttpError(403, "forbidden", "Clinicians only");
  const run = await loggedRun(
    { agent: "doctor-agent", trigger: "doctor.summary", patientId, start: "Clinician asked for a status summary" },
    (onStep) => runAgent({ name: "doctor", system: SUMMARY_SYSTEM, tools: DOCTOR_TOOLS, maxModelCalls: 3, onStep }, clinician, patientId, `Summarize the current care coordination status for patient id "${patientId}".`),
    (r) => r.text.slice(0, 200),
  );
  return { summary: run.text, sources: [...new Set(run.toolsUsed.filter((t) => t.ok).map((t) => t.name))], model: run.model };
}
