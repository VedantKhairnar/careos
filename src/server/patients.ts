import type { Actor } from "@/domain/events";
import { listCarePlans } from "./carePlans";
import { DEMO_PATIENTS } from "./demoData";
import { HttpError } from "./http";
import { careGaps, listPrescriptions } from "./services";

const isPatientSide = (a: Actor) => a.role === "patient" || a.role === "caregiver";
const profile = (id: string) => DEMO_PATIENTS.find((p) => p.id === id) ?? { id, displayName: "Patient", scenario: "" };

export async function patientSummary(actor: Actor, patientId: string) {
  if (isPatientSide(actor)) {
    if (actor.patientId !== patientId) throw new HttpError(404, "not_found", "Patient not found");
  } else if (actor.role !== "clinician") {
    throw new HttpError(403, "forbidden", "Not allowed");
  }
  const [plans, prescriptions, gaps] = await Promise.all([
    listCarePlans(actor, patientId),
    listPrescriptions(actor, patientId),
    careGaps(actor, patientId),
  ]);
  return { patient: profile(patientId), plans, prescriptions, gaps };
}

export async function listPatients(actor: Actor) {
  if (actor.role !== "clinician") throw new HttpError(403, "forbidden", "Clinicians only");
  const rows = await Promise.all(
    DEMO_PATIENTS.map(async (p) => {
      const s = await patientSummary(actor, p.id);
      return {
        ...p,
        plansApproved: s.plans.filter((x) => x.state === "APPROVED").length,
        plansPendingReview: s.plans.filter((x) => x.state === "PENDING_REVIEW").length,
        prescriptions: s.prescriptions.map((x) => x.state),
        openGaps: s.gaps.length,
      };
    }),
  );
  return rows;
}
