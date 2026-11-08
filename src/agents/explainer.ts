import { z } from "zod";
import type { Actor } from "@/domain/events";
import { listCarePlans } from "@/server/carePlans";
import { HttpError } from "@/server/http";
import { runtime } from "@/server/runtime";
import { checkText } from "./coordinator";
import { loggedRun } from "./loggedRun";
import { AiUnavailable, getModel } from "./model";
import { logStep } from "./runLog";

export const EXPLAINER_SYSTEM = `You are the Visit Explainer inside CareOS. You turn the patient's clinician-approved care plan into a plain-language explanation of their last visit, like a patient-side "reverse scribe". You use ONLY the plan you are given.

RULES
1. Every fact, medicine, dose, time, date and warning sign must come from the plan. Never add medical facts, advice, diagnoses, reassurance or predictions.
2. summary: two or three calm sentences about what the visit decided, in everyday words.
3. whatToDo: short steps taken from the plan's instructions, each in plain words.
4. medicines: for each medicine in the plan, say in one sentence how and when to take it, exactly as the plan says. If the plan does not say, write "your care team has not confirmed this yet".
5. words: up to 5 medical or technical words that appear in the plan, each with a short everyday meaning. Do not include numbers or thresholds in a meaning.
6. whenToCall: ONLY the plan's own warning signs, rephrased simply. If the plan lists none, return an empty list.
7. followUps: the plan's follow-up visits, with dates only if the plan gives them.
8. No markdown symbols. Reply with ONLY JSON: {"summary": string, "whatToDo": string[], "medicines": [{"name": string, "how": string}], "words": [{"term": string, "meaning": string}], "whenToCall": string[], "followUps": string[]}.`;

const Out = z.object({
  summary: z.string().min(1).max(700),
  whatToDo: z.array(z.string().max(300)).max(10).default([]),
  medicines: z.array(z.object({ name: z.string().max(120), how: z.string().max(300) })).max(10).default([]),
  words: z.array(z.object({ term: z.string().max(80), meaning: z.string().max(240) })).max(6).default([]),
  whenToCall: z.array(z.string().max(300)).max(8).default([]),
  followUps: z.array(z.string().max(300)).max(6).default([]),
});
export type VisitExplanation = z.infer<typeof Out> & { planTitle: string; model: string; removed: number };

function parseJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no json");
    return JSON.parse(m[0]);
  }
}

/**
 * Explains the last approved plan in plain words. Reads only the plan, and every sentence is checked in code against it:
 * a line that mentions a number, id or advice that the plan does not contain is dropped, never shown.
 */
export async function explainVisit(actor: Actor): Promise<VisitExplanation> {
  if (actor.role !== "patient" && actor.role !== "caregiver") throw new HttpError(403, "forbidden", "Only the patient can ask for this");
  const plans = (await listCarePlans(actor)).filter((p) => p.state === "APPROVED").sort((a, b) => (b.approvedAt ?? "").localeCompare(a.approvedAt ?? ""));
  const plan = plans[0];
  if (!plan) throw new HttpError(404, "not_found", "Your care team has not approved a care plan yet, so there is nothing to explain.");
  const facts = { title: plan.content.title, summary: plan.content.summary, instructions: plan.content.instructions, medications: plan.content.medications, followUps: plan.content.followUps, warningSigns: plan.content.warningSigns };
  const schema = z.toJSONSchema(Out) as Record<string, unknown>;
  delete schema.$schema;
  const pid = actor.patientId ?? "";
  const startedAt = new Date().toISOString();

  let runId = "";
  const res = await loggedRun(
    { agent: "explainer", trigger: "patient.explain_visit", patientId: pid, start: "Patient asked: explain my visit in plain words" },
    async (_o, id) => {
      runId = id;
      logStep(id, { agent: "explainer", kind: "tool", title: "get_approved_care_plan", detail: `read the approved plan "${plan.content.title}" (the only source)`, ok: true });
      const r = await getModel().generate({ system: EXPLAINER_SYSTEM, contents: [{ role: "user", parts: [{ text: `Approved care plan:\n${JSON.stringify(facts, null, 2)}` }] }], responseJsonSchema: schema, maxOutputTokens: 1400 });
      logStep(id, { agent: "explainer", kind: "think", title: "Gemini call", detail: `${r.model} · ${r.usage.input} tokens in, ${r.usage.output} out`, ms: r.latencyMs, ok: true });
      return r;
    },
    () => "The model answered. Checking every line against the plan next.",
  );
  await runtime().store.logAgentExecution({ agent: "patient", patientId: pid, startedAt, durationMs: res.latencyMs, ok: true, tool: "explain_visit", model: res.model, inputTokens: res.usage.input, outputTokens: res.usage.output });

  let out: z.infer<typeof Out>;
  try {
    out = Out.parse(parseJson(res.text));
  } catch {
    logStep(runId, { agent: "explainer", kind: "error", title: "Explanation rejected", detail: "The answer was not in the expected format.", ok: false });
    throw new AiUnavailable("bad_output", "The explanation could not be read. Please try again.");
  }

  // Code check of every line against the plan. Offending lines are removed, not softened.
  let removed = 0;
  const keep = (text: string, what: string) => {
    const issues = checkText(text, facts);
    if (issues.length) {
      removed++;
      logStep(runId, { agent: "safety-check", kind: "review", title: `Removed a ${what}`, detail: issues.join("; "), ok: false });
    }
    return issues.length === 0;
  };
  const summary = keep(out.summary, "summary") ? out.summary : plan.content.summary; // fall back to the clinician's own words
  const clean = {
    summary,
    whatToDo: out.whatToDo.filter((x) => keep(x, "step")),
    medicines: out.medicines.filter((m) => keep(`${m.name} ${m.how}`, "medicine line")),
    words: out.words.filter((w) => keep(`${w.term} ${w.meaning}`, "word meaning")),
    whenToCall: out.whenToCall.filter((x) => keep(x, "warning line")),
    followUps: out.followUps.filter((x) => keep(x, "follow-up line")),
  };
  logStep(runId, { agent: "explainer", kind: "decision", title: "Explanation ready", detail: removed ? `${removed} line(s) removed because the plan did not support them.` : "Every line is supported by the plan.", ok: true });
  return { ...clean, planTitle: plan.content.title, model: res.model, removed };
}
