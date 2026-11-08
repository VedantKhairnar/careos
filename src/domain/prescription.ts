import type { ActorRole, CareEvent, EventType } from "./events";

export type PrescriptionState =
  | "DRAFT"
  | "AUTHORIZED"
  | "TRANSMITTED"
  | "RECEIVED"
  | "ACKNOWLEDGED"
  | "PROCESSING"
  | "DELAYED"
  | "CLARIFICATION_REQUESTED"
  | "READY"
  | "PICKED_UP"
  | "CANCELLED"
  | "REJECTED";

interface Rule {
  from: PrescriptionState[];
  to: PrescriptionState;
  actors: ActorRole[];
}

const NON_TERMINAL: PrescriptionState[] = [
  "DRAFT",
  "AUTHORIZED",
  "TRANSMITTED",
  "RECEIVED",
  "ACKNOWLEDGED",
  "PROCESSING",
  "DELAYED",
  "CLARIFICATION_REQUESTED",
  "READY",
];

/**
 * Allowed transitions. Note what is absent: no "agent" role appears anywhere,
 * so an LLM can never authorize, advance or complete a prescription.
 * READY and PICKED_UP require a pharmacy (simulator) actor, so they can only
 * follow a genuine pharmacy event.
 */
export const PRESCRIPTION_TRANSITIONS: Partial<Record<EventType, Rule>> = {
  "prescription.authorized": { from: ["DRAFT"], to: "AUTHORIZED", actors: ["clinician"] },
  "prescription.transmitted": { from: ["AUTHORIZED"], to: "TRANSMITTED", actors: ["system"] },
  "prescription.received": { from: ["TRANSMITTED"], to: "RECEIVED", actors: ["pharmacy_sim"] },
  "prescription.acknowledged": { from: ["RECEIVED"], to: "ACKNOWLEDGED", actors: ["pharmacy_sim"] },
  "prescription.processing": {
    from: ["ACKNOWLEDGED", "DELAYED"],
    to: "PROCESSING",
    actors: ["pharmacy_sim"],
  },
  "prescription.delayed": {
    from: ["ACKNOWLEDGED", "PROCESSING"],
    to: "DELAYED",
    actors: ["pharmacy_sim"],
  },
  "prescription.clarification_requested": {
    from: ["ACKNOWLEDGED", "PROCESSING"],
    to: "CLARIFICATION_REQUESTED",
    actors: ["pharmacy_sim"],
  },
  // Only a clinician can resolve a clarification (clinical changes need human authority).
  "prescription.clarification_resolved": {
    from: ["CLARIFICATION_REQUESTED"],
    to: "PROCESSING",
    actors: ["clinician"],
  },
  "prescription.ready": { from: ["PROCESSING"], to: "READY", actors: ["pharmacy_sim"] },
  "prescription.picked_up": { from: ["READY"], to: "PICKED_UP", actors: ["pharmacy_sim"] },
  "prescription.rejected": {
    from: ["RECEIVED", "ACKNOWLEDGED", "PROCESSING"],
    to: "REJECTED",
    actors: ["pharmacy_sim"],
  },
  "prescription.cancelled": { from: NON_TERMINAL, to: "CANCELLED", actors: ["clinician"] },
};

export type TransitionResult =
  | { ok: true; next: PrescriptionState }
  | { ok: false; reason: string };

export function applyPrescriptionEvent(
  state: PrescriptionState,
  type: EventType,
  actorRole: ActorRole,
): TransitionResult {
  const rule = PRESCRIPTION_TRANSITIONS[type];
  if (!rule) return { ok: false, reason: `${type} is not a prescription transition` };
  if (!rule.actors.includes(actorRole)) {
    return { ok: false, reason: `${actorRole} may not perform ${type}` };
  }
  if (!rule.from.includes(state)) {
    return { ok: false, reason: `${type} is not allowed from ${state}` };
  }
  return { ok: true, next: rule.to };
}

/**
 * Current state is always derived from the event history (event-sourced),
 * so patient and doctor views cannot disagree.
 * The caller supplies events for one workflow, in recorded order.
 */
export function foldPrescriptionState(events: CareEvent[]): PrescriptionState {
  let state: PrescriptionState = "DRAFT";
  for (const e of events) {
    const r = applyPrescriptionEvent(state, e.type, e.actorRole);
    if (r.ok) state = r.next;
  }
  return state;
}
