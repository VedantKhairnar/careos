import type { CareEvent, EventType, Verification } from "./events";
import { foldPrescriptionState, type PrescriptionState } from "./prescription";

/** Source information that must travel with every patient-facing status. */
export interface SourceInfo {
  eventId: string;
  actorRole: CareEvent["actorRole"];
  sourceSystem: string;
  recordedAt: string;
  verification: Verification;
  simulated: boolean;
}

export interface TimelineItem {
  label: string;
  at: string;
  source: SourceInfo;
}

export interface PrescriptionStatus {
  state: PrescriptionState;
  /** Plain-language status. Uses "Awaiting pharmacy confirmation" when unknown. */
  patientText: string;
  /** Operational wording for clinicians. */
  clinicianText: string;
  timeline: TimelineItem[];
  /** Source of the current state: the last event that actually changed it. */
  currentSource: SourceInfo | null;
}

const LABELS: Partial<Record<EventType, string>> = {
  "care_plan.approved": "Care plan approved by your clinician",
  "prescription.authorized": "Prescription authorized by your clinician",
  "prescription.transmitted": "Prescription sent to the pharmacy",
  "prescription.received": "Pharmacy received the prescription",
  "prescription.acknowledged": "Pharmacy acknowledged the prescription",
  "prescription.processing": "Pharmacy is preparing the prescription",
  "prescription.delayed": "Pharmacy reported a delay",
  "prescription.clarification_requested": "Pharmacy asked your clinician a question",
  "prescription.clarification_resolved": "Your clinician answered the pharmacy",
  "prescription.ready": "Ready for pickup",
  "prescription.picked_up": "Pickup confirmed by the pharmacy",
  "prescription.pickup_reported": "You reported picking this up (not yet confirmed by the pharmacy)",
  "prescription.cancelled": "Prescription cancelled",
  "prescription.rejected": "Pharmacy could not fill this prescription",
  "prescription.failed": "Sending to the pharmacy failed",
};

const PATIENT_TEXT: Record<PrescriptionState, string> = {
  DRAFT: "Your clinician is preparing this prescription.",
  AUTHORIZED: "Authorized. It has not been sent to the pharmacy yet.",
  TRANSMITTED: "Sent to the pharmacy. Awaiting pharmacy confirmation.",
  RECEIVED: "The pharmacy has received it. Awaiting pharmacy confirmation that they are working on it.",
  ACKNOWLEDGED: "The pharmacy has acknowledged it. Awaiting pharmacy confirmation of timing.",
  PROCESSING: "The pharmacy is preparing it. Awaiting pharmacy confirmation of when it will be ready.",
  DELAYED: "The pharmacy reported a delay. We are following up with your care team.",
  CLARIFICATION_REQUIRED: "The pharmacy has a question for your clinician. We will update you once it is answered.",
  READY_FOR_PICKUP: "Ready for pickup.",
  PICKED_UP: "Picked up.",
  CANCELLED: "This prescription was cancelled.",
  REJECTED: "The pharmacy could not fill this prescription. Your care team has been notified.",
  FAILED: "We could not send this prescription to the pharmacy. Your care team has been notified.",
};

const CLINICIAN_TEXT: Record<PrescriptionState, string> = {
  DRAFT: "Draft",
  AUTHORIZED: "Authorized, not yet transmitted",
  TRANSMITTED: "Transmitted, awaiting pharmacy receipt",
  RECEIVED: "Received, awaiting acknowledgment",
  ACKNOWLEDGED: "Acknowledged",
  PROCESSING: "Processing",
  DELAYED: "Delayed (pharmacy-reported)",
  CLARIFICATION_REQUIRED: "Clarification requested, clinician action needed",
  READY_FOR_PICKUP: "Ready for pickup",
  PICKED_UP: "Pickup confirmed",
  CANCELLED: "Cancelled",
  REJECTED: "Rejected by pharmacy",
  FAILED: "Transmission failed, retry or contact the pharmacy",
};

export function sourceOf(e: CareEvent): SourceInfo {
  return {
    eventId: e.eventId,
    actorRole: e.actorRole,
    sourceSystem: e.sourceSystem,
    recordedAt: e.recordedAt,
    verification: e.verification,
    simulated: e.simulated,
  };
}

/**
 * The single place status is computed. Patient and doctor views both call this,
 * so they cannot disagree.
 */
export function prescriptionStatus(workflowEvents: CareEvent[]): PrescriptionStatus {
  const ordered = [...workflowEvents].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  const state = foldPrescriptionState(ordered);
  const timeline: TimelineItem[] = ordered
    .filter((e) => LABELS[e.type] !== undefined)
    .map((e) => ({ label: LABELS[e.type]!, at: e.recordedAt, source: sourceOf(e) }));

  const lastTransition = [...ordered].reverse().find((e) => {
    // an event that actually moved the state
    const idx = ordered.indexOf(e);
    return foldPrescriptionState(ordered.slice(0, idx + 1)) !== foldPrescriptionState(ordered.slice(0, idx));
  });

  return {
    state,
    patientText: PATIENT_TEXT[state],
    clinicianText: CLINICIAN_TEXT[state],
    timeline,
    currentSource: lastTransition ? sourceOf(lastTransition) : null,
  };
}
