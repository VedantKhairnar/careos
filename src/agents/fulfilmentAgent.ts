import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Actor } from "@/domain/events";
import { prescriptionStatus } from "@/domain/status";
import { runtime } from "@/server/runtime";
import { envelope, submit } from "@/server/services";
import { AiUnavailable } from "./model";
import { runAgent, type TraceStep } from "./runner";
import type { ToolDef } from "./tools";

/** The agent's own identity. It has role "agent", which no clinical transition accepts. */
export const FULFILMENT_AGENT: Actor = { id: "agent:fulfilment", role: "agent" };

export const FULFILMENT_SYSTEM = `You are the Fulfilment agent inside CareOS. A pharmacy update just arrived that needs a human's attention. You investigate with your tools, then prepare TWO drafts for a clinician to review. You cannot send anything and you cannot change any record. A clinician approves or dismisses what you write.

HARD RULES
1. Call get_prescription_history for the workflow you were given. Call get_patient_care_plan too if the plan could help. Use ONLY what the tools return.
2. Never state stock, quantities, prices, delay lengths or ready times that are not in the history. If the pharmacy gave no reason or time, say it did not give one.
3. Never suggest substituting a medicine, changing a dose or any clinical action. The clinician decides.
4. Never say it is ready or picked up unless the current state says so.
5. patientMessage: two or three plain sentences a patient would understand. No codes, no jargon, no promises. Say the care team is following up only as a statement of what the drafts are for.
6. clinicianSummary: one short paragraph: what happened, how long ago, what is still unknown.
7. suggestedNextStep: one short sentence naming an administrative step the clinician could take (for example "call the pharmacy to ask for a time" or "answer the pharmacy's question"). Never a clinical action.
8. Never quote workflow ids, event ids or raw timestamps. Refer to the medicine by name and to time in plain words (for example "a few minutes ago").
9. Reply with ONLY a JSON object: {"patientMessage": string, "clinicianSummary": string, "suggestedNextStep": string, "missingInformation": string[]}. No other text.`;

const Output = z.object({
  patientMessage: z.string().min(1).max(600),
  clinicianSummary: z.string().min(1).max(900),
  suggestedNextStep: z.string().min(1).max(300),
  missingInformation: z.array(z.string().max(200)).max(6).default([]),
});

const historyTool: ToolDef = {
  name: "get_prescription_history",
  description: "The verified event history and current state of one prescription workflow. Read-only.",
  args: z.object({ workflowId: z.string().min(1) }),
  run: async (_actor: Actor, args: { workflowId: string }) => {
    const events = await runtime().store.listByWorkflow(args.workflowId);
    if (!events.some((e) => e.type === "prescription.authorized")) return { error: "no such prescription" };
    const s = prescriptionStatus(events);
    return {
      medication: String(events.find((e) => e.type === "prescription.authorized")?.payload.medicationReference ?? "unknown"),
      currentState: s.state,
      events: s.timeline.map((t) => ({ what: t.label, at: t.at, by: t.source.actorRole, verification: t.source.verification, simulated: t.source.simulated })),
      pharmacyNotes: events.filter((e) => e.actorRole === "pharmacy_sim" && e.payload.note).map((e) => String(e.payload.note)),
    };
  },
} as unknown as ToolDef;

const planTool: ToolDef = {
  name: "get_patient_care_plan",
  description: "Titles and medicine names of the patient's approved care plans. Read-only.",
  args: z.object({ patientId: z.string().min(1) }),
  run: async (_actor: Actor, args: { patientId: string }) => {
    const events = await runtime().store.listByPatient(args.patientId);
    return events
      .filter((e) => e.type === "care_plan.approved")
      .map((a) => {
        const sub = events.find((e) => e.workflowId === a.workflowId && e.type === "care_plan.submitted");
        const c = (sub?.payload.content ?? {}) as { title?: string; medications?: { name?: string }[] };
        return { title: c.title ?? "Care plan", medicines: (c.medications ?? []).map((m) => m.name).filter(Boolean), approvedAt: a.recordedAt };
      });
  },
} as unknown as ToolDef;

export const FULFILMENT_TOOLS: ToolDef[] = [historyTool, planTool];

/** Pharmacy updates that wake the agent. Each is one a clinician may need to act on. */
export const AGENT_TRIGGERS = new Set(["prescription.delayed", "prescription.clarification_requested", "prescription.rejected"]);

function parseJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  }
}

/**
 * Event-driven: runs when a pharmacy event arrives, with nobody clicking "AI". It reads the record with
 * read-only tools and writes ONE `agent.suggestion_created` event: a draft. It changes no workflow state,
 * sends nothing to the patient, and waits for a clinician. Idempotent per triggering event.
 */
export async function runFulfilmentAgent(input: { workflowId: string; patientId: string; triggerEventId: string; triggerType: string }): Promise<{ created: boolean }> {
  const key = `agent-suggest:${input.triggerEventId}`;
  if (await runtime().store.hasIdempotencyKey(key)) return { created: false };

  const run = await runAgent(
    { name: "pharmacy", system: FULFILMENT_SYSTEM, tools: FULFILMENT_TOOLS, maxModelCalls: 4 },
    FULFILMENT_AGENT,
    input.patientId,
    `Trigger: ${input.triggerType}\nworkflowId: ${input.workflowId}\npatientId: ${input.patientId}\nInvestigate and prepare the drafts.`,
  );

  let draft: z.infer<typeof Output>;
  try {
    const parsed = Output.safeParse(parseJson(run.text));
    if (!parsed.success) throw new Error("bad shape");
    draft = parsed.data;
  } catch {
    throw new AiUnavailable("bad_output", "The fulfilment agent's draft could not be read.");
  }

  const suggestionId = randomUUID();
  const r = await submit(
    FULFILMENT_AGENT,
    envelope(
      FULFILMENT_AGENT,
      { workflowId: input.workflowId, patientId: input.patientId, type: "agent.suggestion_created", idempotencyKey: key, correlationId: `corr_${input.workflowId}` },
      { payload: { suggestionId, trigger: input.triggerType, triggerEventId: input.triggerEventId, ...draft, model: run.model, trace: run.trace satisfies TraceStep[] }, simulated: true, sourceSystem: "fulfilment-agent" },
    ),
  );
  return { created: r.status === "applied" };
}
