import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { detectGaps } from "@/domain/careGap";
import { deriveReminders } from "@/domain/dose";
import type { Actor } from "@/domain/events";
import { foldPrescriptionState } from "@/domain/prescription";
import { prescriptionStatus } from "@/domain/status";
import { nowMs, runtime } from "@/server/runtime";
import { envelope, submit } from "@/server/services";
import { AiUnavailable, getModel } from "./model";
import { runAgent } from "./runner";
import { endRun, listRuns, logStep, startRun } from "./runLog";
import type { ToolDef } from "./tools";

/** Role "agent": no clinical transition accepts it. It can only append drafts for a human to review. */
export const COORDINATOR: Actor = { id: "agent:coordinator", role: "agent" };

/** Pharmacy updates that wake the coordinator. */
export const AGENT_TRIGGERS = new Set(["prescription.delayed", "prescription.clarification_requested", "prescription.rejected"]);

const Why = z.string().min(3).max(240).describe("One short sentence: what you want to learn or do, and why");

/* ---------------------------------- the three agents' instructions ---------------------------------- */

export const COORDINATOR_SYSTEM = `You are the Care Coordinator, an autonomous agent inside CareOS. A pharmacy update just arrived that may need a human's attention. You work out how urgent it is and prepare a SAFE, VERIFIED proposal for the clinician. You cannot message the patient and you cannot change any record. A clinician decides.

HOW YOU WORK
1. Investigate with your tools. Independent tools can be called together in one step. Every tool call needs a short "why".
2. Reason about urgency from DATA only. A delay matters more if the patient's next dose of that same medicine is soon (get_dose_timeline). If the timeline shows no matching medicine, or no dose within 24 hours, say it is routine.
3. Call delegate_to_writer to have the wording drafted. Then call request_safety_review. If the review lists issues, call delegate_to_writer again (it sees the issues) and review again. At most 2 revisions.
4. Only when the review approved, call propose_actions with your urgency decision and the reason. The system refuses it otherwise.
5. Finish with one plain sentence saying what you proposed.

NEVER invent a reason for a delay, a ready time, stock, or any fact the tools did not return. Never suggest a clinical action.`;

export const WRITER_SYSTEM = `You are the Writer agent. You turn verified facts into two short drafts. You use ONLY the facts JSON you are given. If reviewer issues are provided, fix every one of them.

RULES
- patientMessage: two or three plain, calm sentences a patient understands. Say what the pharmacy reported and what is not known. No promises, no reassurance such as "don't worry", no advice, no jargon, no ids, no timestamps.
- clinicianSummary: one short paragraph: what happened, what is unknown, and why it matters (use the dose timeline if given).
- suggestedNextStep: one short ADMINISTRATIVE step (for example "call the pharmacy to ask for a time"). Never a clinical action, never a substitute medicine.
- missingInformation: things the records do not say.
- Mention a number or time only if it appears in the facts.
Reply with ONLY JSON: {"patientMessage": string, "clinicianSummary": string, "suggestedNextStep": string, "missingInformation": string[]}.`;

export const REVIEWER_SYSTEM = `You are the Safety Reviewer, an independent agent. You do NOT trust the Writer. You receive FACTS and a DRAFT. Find every problem.

Report an issue for each of these:
- any claim (a reason, a time, a quantity, stock, a ready time, a number) that is not in FACTS;
- any clinical advice, medicine substitution, dose or timing change, reassurance ("don't worry") or promise;
- jargon, internal ids or raw timestamps in the patient message;
- a patient message that sounds certain about something FACTS marks unknown.
Approve ONLY if there are zero issues. Reply with ONLY JSON: {"approved": boolean, "issues": string[]}.`;

/* ---------------------------------------- drafts and checks ---------------------------------------- */

const DraftSchema = z.object({
  patientMessage: z.string().min(1).max(600),
  clinicianSummary: z.string().min(1).max(900),
  suggestedNextStep: z.string().min(1).max(300),
  missingInformation: z.array(z.string().max(200)).max(6).default([]),
});
type Draft = z.infer<typeof DraftSchema>;
const VerdictSchema = z.object({ approved: z.boolean(), issues: z.array(z.string().max(300)).max(8).default([]) });

const hash = (d: Draft) => createHash("sha256").update(JSON.stringify([d.patientMessage, d.clinicianSummary, d.suggestedNextStep])).digest("hex");

/** Deterministic checks that run in code, whatever the model says. */
export function deterministicChecks(draft: Draft, facts: unknown): string[] {
  return checkText([draft.patientMessage, draft.clinicianSummary, draft.suggestedNextStep].join(" "), facts);
}

/** The same code checks for any text an agent wrote: no invented numbers, ids, timestamps, advice or reassurance. */
export function checkText(all: string, facts: unknown): string[] {
  const issues: string[] = [];
  const factsText = JSON.stringify(facts).toLowerCase();
  if (/\brx_[0-9a-f]{6,}/i.test(all) || /\b\d{4}-\d{2}-\d{2}t\d{2}/i.test(all)) issues.push("contains an internal id or a raw timestamp");
  for (const m of new Set(all.match(/\d+(?:\.\d+)?/g) ?? [])) if (!factsText.includes(m)) issues.push(`mentions "${m}", which is not in the records`);
  if (/don'?t worry|nothing to worry|no need to worry|you should (?:take|stop|skip|double)|switch to|instead of|increase the dose|decrease the dose/i.test(all)) issues.push("contains advice or reassurance, which only a clinician may give");
  return issues;
}

function parseJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no json");
    return JSON.parse(m[0]);
  }
}

/** One structured model call by a sub-agent. Logged to the live log and to the execution log. */
async function subAgent<T>(runId: string, agent: string, system: string, user: string, schema: z.ZodType<T>, patientId: string): Promise<T> {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  delete jsonSchema.$schema;
  const startedAt = new Date().toISOString();
  const res = await getModel().generate({ system, contents: [{ role: "user", parts: [{ text: user }] }], responseJsonSchema: jsonSchema, maxOutputTokens: 800, background: true });
  await runtime().store.logAgentExecution({ agent: "pharmacy", patientId, startedAt, durationMs: res.latencyMs, ok: true, tool: agent, model: res.model, inputTokens: res.usage.input, outputTokens: res.usage.output });
  logStep(runId, { agent, kind: "think", title: "Gemini call", detail: `${res.model} · ${res.usage.input} tokens in, ${res.usage.output} out`, ms: res.latencyMs, ok: true });
  try {
    return schema.parse(parseJson(res.text));
  } catch {
    throw new AiUnavailable("bad_output", `The ${agent} agent's answer could not be read.`);
  }
}

/* ---------------------------------------------- tools ---------------------------------------------- */

interface RunState {
  runId: string;
  workflowId: string;
  patientId: string;
  trigger: string;
  triggerEventId: string;
  facts: Record<string, unknown>;
  draft?: Draft;
  approvedHash?: string;
  issues: string[];
  revisions: number;
  proposed: boolean;
}

const tool = <S extends z.ZodType>(name: string, description: string, args: S, run: (a: z.infer<S>) => Promise<unknown>) =>
  ({ name, description, args, run: async (_actor: Actor, a: z.infer<S>) => run(a) }) as unknown as ToolDef;

function buildTools(st: RunState): ToolDef[] {
  const store = () => runtime().store;
  return [
    tool("get_prescription_history", "Verified event history and current state of one prescription. Read-only.", z.object({ workflowId: z.string().min(1), why: Why }), async (a) => {
      const events = await store().listByWorkflow(a.workflowId);
      if (!events.some((e) => e.type === "prescription.authorized")) return { error: "no such prescription" };
      const s = prescriptionStatus(events);
      const r = {
        medication: String(events.find((e) => e.type === "prescription.authorized")?.payload.medicationReference ?? "unknown"),
        currentState: s.state,
        events: s.timeline.map((t) => ({ what: t.label, at: t.at, by: t.source.actorRole, simulated: t.source.simulated })),
        pharmacyNotes: events.filter((e) => e.actorRole === "pharmacy_sim" && e.payload.note).map((e) => String(e.payload.note)),
        pharmacyGaveReasonOrTime: events.some((e) => e.actorRole === "pharmacy_sim" && e.payload.note),
      };
      st.facts.prescription = r;
      return r;
    }),
    tool("get_patient_care_plan", "The patient's approved care plans, including medicines, doses and times as written by the clinician. Read-only.", z.object({ patientId: z.string().min(1), why: Why }), async (a) => {
      const events = await store().listByPatient(a.patientId);
      const r = events
        .filter((e) => e.type === "care_plan.approved")
        .map((ap) => {
          const c = (events.find((e) => e.workflowId === ap.workflowId && e.type === "care_plan.submitted")?.payload.content ?? {}) as { title?: string; medications?: unknown[] };
          return { title: c.title ?? "Care plan", medications: c.medications ?? [] };
        });
      st.facts.carePlan = r;
      return r;
    }),
    tool(
      "get_dose_timeline",
      "For the prescription's patient: the next scheduled dose of each medicine in the approved plan, and whether it is the SAME medicine as this prescription. Computed in code from the plan. Read-only.",
      z.object({ workflowId: z.string().min(1), why: Why }),
      async (a) => {
        const events = await store().listByWorkflow(a.workflowId);
        const med = String(events.find((e) => e.type === "prescription.authorized")?.payload.medicationReference ?? "").toLowerCase();
        const all = await store().listByPatient(events[0]?.patientId ?? st.patientId);
        const now = nowMs();
        const today = new Date(now).toISOString().slice(0, 10);
        const out = all
          .filter((e) => e.type === "care_plan.approved")
          .flatMap((ap) => {
            const c = (all.find((e) => e.workflowId === ap.workflowId && e.type === "care_plan.submitted")?.payload.content ?? {}) as { medications?: { name: string; dose?: string; times?: string[]; startDate?: string; endDate?: string }[] };
            return (c.medications ?? []).map((m) => {
              const d = deriveReminders({ medicationName: m.name, dose: m.dose, times: m.times, startDate: m.startDate && m.startDate > today ? m.startDate : today, endDate: m.endDate, source: { carePlanVersionId: ap.workflowId, approvedBy: ap.actorId } }, { horizonDays: 3 });
              const next = d.status === "ok" ? d.reminders.map((r) => Date.parse(r.scheduledFor)).find((t) => t >= now) : undefined;
              const name = m.name.toLowerCase();
              return {
                medicine: m.name,
                sameMedicineAsThisPrescription: name.length > 2 && (med.includes(name) || name.includes(med)),
                nextDoseKnown: next !== undefined,
                hoursUntilNextDose: next !== undefined ? Math.round(((next - now) / 3_600_000) * 10) / 10 : null,
                scheduleIncomplete: d.status !== "ok",
              };
            });
          });
        const r = { medicines: out, note: out.length === 0 ? "The patient has no approved plan with medicines." : undefined };
        st.facts.doseTimeline = r;
        return r;
      },
    ),
    tool("get_open_care_gaps", "Open administrative care gaps for this patient (an expected step was not recorded by its deadline). Read-only.", z.object({ patientId: z.string().min(1), why: Why }), async (a) => {
      const gaps = detectGaps(await store().listByPatient(a.patientId), new Date(nowMs()).toISOString());
      const r = gaps.map((g) => ({ rule: g.rule, responsible: g.responsible, description: g.description }));
      st.facts.openGaps = r;
      return r;
    }),
    tool("delegate_to_writer", "Hand the wording to the Writer agent. It sees everything you have learned so far and any issues from the last safety review. Returns the draft.", z.object({ focus: z.string().min(3).max(600).describe("What the drafts should emphasise (one or two sentences)"), why: Why }), async (a) => {
      logStep(st.runId, { agent: "coordinator", kind: "handoff", title: "Handoff → Writer", detail: a.focus });
      const draft = await subAgent(st.runId, "writer", WRITER_SYSTEM, `FACTS:\n${JSON.stringify(st.facts, null, 2)}\n\nFOCUS: ${a.focus}\n${st.issues.length ? `REVIEWER ISSUES TO FIX:\n- ${st.issues.join("\n- ")}` : ""}`, DraftSchema, st.patientId);
      st.draft = draft;
      st.approvedHash = undefined;
      logStep(st.runId, { agent: "writer", kind: "decision", title: "Draft written", detail: `Patient message: ${draft.patientMessage}`, ok: true });
      return { drafted: true, patientMessagePreview: draft.patientMessage, suggestedNextStep: draft.suggestedNextStep };
    }),
    tool("request_safety_review", "Send the current draft to the independent Safety Reviewer. Returns whether it was approved and any issues.", z.object({ why: Why }), async () => {
      if (!st.draft) return { error: "there is no draft yet: call delegate_to_writer first" };
      logStep(st.runId, { agent: "coordinator", kind: "handoff", title: "Handoff → Safety Reviewer", detail: "Reviewing the draft against the verified facts." });
      const code = deterministicChecks(st.draft, st.facts);
      logStep(st.runId, { agent: "safety-check", kind: "review", title: code.length ? "Code checks FAILED" : "Code checks passed", detail: code.length ? code.join("; ") : "No invented numbers, ids, timestamps, advice or reassurance.", ok: code.length === 0 });
      const llm = await subAgent(st.runId, "reviewer", REVIEWER_SYSTEM, `FACTS:\n${JSON.stringify(st.facts, null, 2)}\n\nDRAFT:\n${JSON.stringify({ patientMessage: st.draft.patientMessage, clinicianSummary: st.draft.clinicianSummary, suggestedNextStep: st.draft.suggestedNextStep }, null, 2)}`, VerdictSchema, st.patientId);
      const issues = [...code, ...llm.issues];
      const approved = llm.approved && issues.length === 0;
      logStep(st.runId, { agent: "reviewer", kind: "review", title: approved ? "Approved by the Safety Reviewer" : "Rejected by the Safety Reviewer", detail: approved ? "No issues found." : issues.join("; "), ok: approved });
      st.issues = approved ? [] : issues;
      if (approved) st.approvedHash = hash(st.draft);
      else st.revisions++;
      return { approved, issues, revisionsUsed: st.revisions };
    }),
    tool(
      "propose_actions",
      "Put the reviewed draft in front of the clinician with your urgency decision. Refused unless the current draft passed the safety review.",
      z.object({ urgency: z.enum(["routine", "time_sensitive"]), urgencyReason: z.string().min(3).max(300), why: Why }),
      async (a) => {
        if (!st.draft) throw new Error("blocked: there is no draft to propose");
        if (st.approvedHash !== hash(st.draft)) throw new Error("blocked: this draft has not passed the safety review (or it changed after the review)");
        if (a.urgency === "time_sensitive") {
          const t = st.facts.doseTimeline as { medicines?: { sameMedicineAsThisPrescription: boolean; hoursUntilNextDose: number | null }[] } | undefined;
          const supported = t?.medicines?.some((m) => m.sameMedicineAsThisPrescription && m.hoursUntilNextDose !== null && m.hoursUntilNextDose < 24);
          if (!supported) throw new Error("blocked: time_sensitive is not supported by the dose timeline (no matching medicine with a dose in the next 24 hours). Use routine, or check the timeline first");
        }
        const suggestionId = randomUUID();
        // Logged BEFORE the draft is recorded, so the log saved inside the draft already tells the whole story.
        logStep(st.runId, { agent: "coordinator", kind: "decision", title: `Proposed to the clinician (${a.urgency === "time_sensitive" ? "TIME-SENSITIVE" : "routine"})`, detail: a.urgencyReason, ok: true });
        logStep(st.runId, { agent: "coordinator", kind: "gate", title: "Waiting for a clinician", detail: "Nothing has been sent to the patient. A human must approve." });
        const rec = listRuns().find((r) => r.runId === st.runId);
        const r = await submit(
          COORDINATOR,
          envelope(
            COORDINATOR,
            { workflowId: st.workflowId, patientId: st.patientId, type: "agent.suggestion_created", idempotencyKey: `agent-suggest:${st.triggerEventId}`, correlationId: `corr_${st.workflowId}` },
            { payload: { suggestionId, runId: st.runId, trigger: st.trigger, ...st.draft, urgency: a.urgency, urgencyReason: a.urgencyReason, safetyReviewRounds: st.revisions + 1, log: rec?.entries ?? [] }, simulated: true, sourceSystem: "care-coordinator" },
          ),
        );
        if (r.status !== "applied") throw new Error("could not record the proposal");
        st.proposed = true;
        return { proposed: true, suggestionId };
      },
    ),
  ];
}

/* ------------------------------------------------- run ------------------------------------------------- */

const inFlight = new Set<string>();

export async function runCoordinator(input: { workflowId: string; patientId: string; triggerEventId: string; triggerType: string }): Promise<{ created: boolean; runId?: string }> {
  if ((await runtime().store.hasIdempotencyKey(`agent-suggest:${input.triggerEventId}`)) || inFlight.has(input.triggerEventId)) return { created: false };
  inFlight.add(input.triggerEventId);
  const runId = randomUUID();
  const st: RunState = { runId, workflowId: input.workflowId, patientId: input.patientId, trigger: input.triggerType, triggerEventId: input.triggerEventId, facts: {}, issues: [], revisions: 0, proposed: false };
  startRun({ runId, trigger: input.triggerType, workflowId: input.workflowId, patientId: input.patientId });
  logStep(runId, { agent: "coordinator", kind: "start", title: `Woke up: ${input.triggerType.replace("prescription.", "pharmacy ")}`, detail: "An event arrived. No one clicked anything." });
  const own = new Set(["delegate_to_writer", "request_safety_review", "propose_actions"]);

  try {
    const run = await runAgent(
      {
        name: "pharmacy",
        system: COORDINATOR_SYSTEM,
        tools: buildTools(st),
        maxModelCalls: 9,
        background: true,
        onStep: (s) => {
          if (s.kind === "model") logStep(runId, { agent: "coordinator", kind: "think", title: "Gemini call", detail: [s.text, s.detail].filter(Boolean).join(" · "), ms: s.ms, ok: true });
          else if (s.kind === "blocked") logStep(runId, { agent: "coordinator", kind: "blocked", title: s.name, detail: s.detail, ms: s.ms, ok: false });
          else if (!own.has(s.name)) {
            const a = (s.args ?? {}) as { why?: string };
            logStep(runId, { agent: "coordinator", kind: "tool", title: s.name, detail: `why: ${a.why ?? "n/a"}\nresult: ${s.detail}`, ms: s.ms, ok: true });
          }
        },
      },
      COORDINATOR,
      input.patientId,
      `Trigger: ${input.triggerType}\nworkflowId: ${input.workflowId}\npatientId: ${input.patientId}\nInvestigate, decide the urgency, and prepare a verified proposal.`,
    );
    if (!st.proposed) throw new AiUnavailable("bad_output", "The coordinator finished without proposing anything.");
    logStep(runId, { agent: "coordinator", kind: "think", title: "Coordinator finished", detail: run.text });
    endRun(runId, "awaiting_human");
    return { created: true, runId };
  } catch (err) {
    logStep(runId, { agent: "coordinator", kind: "error", title: "Run stopped", detail: err instanceof Error ? err.message : "failed", ok: false });
    endRun(runId, "failed");
    throw err;
  } finally {
    inFlight.delete(input.triggerEventId);
  }
}

/** Find pharmacy problems that no agent has looked at yet and run the coordinator on each (at most 3 per sweep). */
export async function runSweep(): Promise<{ started: number }> {
  const all = await runtime().store.listAll();
  const byWf = new Map<string, typeof all>();
  for (const e of all) byWf.set(e.workflowId, [...(byWf.get(e.workflowId) ?? []), e]);
  const todo: { workflowId: string; patientId: string; triggerEventId: string; triggerType: string }[] = [];
  for (const [wf, evs] of byWf) {
    if (!evs.some((e) => e.type === "prescription.authorized")) continue;
    const state = foldPrescriptionState([...evs].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)));
    if (!["DELAYED", "CLARIFICATION_REQUIRED", "REJECTED"].includes(state)) continue;
    const trig = [...evs].reverse().find((e) => AGENT_TRIGGERS.has(e.type));
    if (!trig || evs.some((e) => e.type === "agent.suggestion_created" && e.payload.triggerEventId === trig.eventId) || (await runtime().store.hasIdempotencyKey(`agent-suggest:${trig.eventId}`))) continue;
    todo.push({ workflowId: wf, patientId: trig.patientId, triggerEventId: trig.eventId, triggerType: trig.type });
  }
  for (const t of todo.slice(0, 3)) void runCoordinator(t).catch((e) => console.warn("[coordinator]", e instanceof Error ? e.message : e));
  return { started: Math.min(todo.length, 3) };
}
