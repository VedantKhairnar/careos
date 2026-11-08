import type { Actor } from "@/domain/events";
import { approveCarePlan, createCarePlan, type CarePlanContent } from "./carePlans";
import { createPrescription } from "./services";

export { DEMO_PATIENTS } from "@/lib/demoPatients";

const SEED_CLINICIAN: Actor = { id: "demo-clinician-seed", role: "clinician" };
const SEED = { simulated: true, sourceSystem: "demo-seed" } as const;
const NOT_ADVICE = "Demonstration plan for a fictional patient. It is not medical advice.";
const URGENT = "If you feel worse or are worried, contact your care team. For an emergency, call your local emergency number.";

const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

function plans(): { key: string; patientId: string; content: CarePlanContent }[] {
  const today = day();
  return [
    {
      key: "seed-plan-alex-v2", // v2: every demo medicine now has a complete, clinician-written schedule
      patientId: "p_alex",
      content: {
        title: "Knee surgery recovery (fictional demo)",
        summary: NOT_ADVICE,
        instructions: [
          "Keep the dressing clean and dry, as your care team showed you.",
          "Do the gentle movement exercises your physiotherapist showed you.",
          "Bring your medication list to your follow-up visit.",
        ],
        medications: [
          { name: "Demo-Analgesic (fictional)", dose: "1 tablet", times: ["08:00", "20:00"], startDate: today, notes: "Fictional demo medication." },
          { name: "Demo-Antibiotic (fictional)", dose: "1 capsule", times: ["09:00", "21:00"], startDate: today, notes: "Fictional demo medication." },
        ],
        followUps: [{ description: "Follow-up visit with Dr. Chen (fictional)", dueDate: day(14) }],
        warningSigns: [URGENT],
      },
    },
    {
      key: "seed-plan-maria-a",
      patientId: "p_maria",
      content: {
        title: "Condition A check-in (fictional demo)",
        summary: NOT_ADVICE,
        instructions: ["Keep a short daily note of how you feel.", "Attend your scheduled review."],
        medications: [{ name: "Demo-Medication A (fictional)", dose: "1 capsule", times: ["09:00"], startDate: today }],
        followUps: [{ description: "Review for Condition A (fictional)", dueDate: day(10) }],
        warningSigns: [URGENT],
      },
    },
    {
      key: "seed-plan-maria-b",
      patientId: "p_maria",
      content: {
        title: "Condition B management (fictional demo)",
        summary: NOT_ADVICE,
        instructions: ["Follow the activity guidance your care team gave you."],
        medications: [{ name: "Demo-Medication B (fictional)", dose: "2 tablets", times: ["13:00", "21:00"], startDate: today }],
        followUps: [{ description: "Lab visit for Condition B (fictional)", dueDate: day(7) }],
        warningSigns: [URGENT],
      },
    },
  ];
}

/** Idempotent: fixed keys mean a second call changes nothing. */
export async function seedDemo(): Promise<{ plans: number; prescriptions: number }> {
  for (const p of plans()) {
    const plan = await createCarePlan(SEED_CLINICIAN, { patientId: p.patientId, content: p.content }, p.key, SEED);
    await approveCarePlan(SEED_CLINICIAN, plan.planId, `${p.key}:approved`, SEED);
  }
  const rx = [
    { key: "seed-rx-alex", patientId: "p_alex", medicationReference: "Demo-Analgesic (fictional)" },
    { key: "seed-rx-maria", patientId: "p_maria", medicationReference: "Demo-Medication B (fictional)" },
  ];
  for (const r of rx) {
    await createPrescription(
      SEED_CLINICIAN,
      { patientId: r.patientId, medicationReference: r.medicationReference, approvedInstructions: "Fictional demo instructions." },
      r.key,
      SEED,
    );
  }
  return { plans: plans().length, prescriptions: rx.length };
}
