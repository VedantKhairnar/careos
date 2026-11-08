import type { ActorRole, EventType } from "./events";

export type CarePlanState = "DRAFT" | "PENDING_REVIEW" | "APPROVED" | "SUPERSEDED";

interface Rule {
  from: CarePlanState[];
  to: CarePlanState;
  actors: ActorRole[];
}

/**
 * An agent may draft and submit for review, but approval is clinician-only.
 * There is intentionally no path where an "agent" or "system" actor reaches APPROVED.
 */
export const CARE_PLAN_TRANSITIONS: Partial<Record<EventType, Rule>> = {
  "care_plan.submitted": {
    from: ["DRAFT"],
    to: "PENDING_REVIEW",
    actors: ["clinician", "agent"],
  },
  "care_plan.approved": {
    from: ["PENDING_REVIEW"],
    to: "APPROVED",
    actors: ["clinician"],
  },
};

export type CarePlanResult =
  | { ok: true; next: CarePlanState }
  | { ok: false; reason: string };

export function applyCarePlanEvent(
  state: CarePlanState,
  type: EventType,
  actorRole: ActorRole,
): CarePlanResult {
  const rule = CARE_PLAN_TRANSITIONS[type];
  if (!rule) return { ok: false, reason: `${type} is not a care plan transition` };
  if (!rule.actors.includes(actorRole)) {
    return { ok: false, reason: `${actorRole} may not perform ${type}` };
  }
  if (!rule.from.includes(state)) {
    return { ok: false, reason: `${type} is not allowed from ${state}` };
  }
  return { ok: true, next: rule.to };
}
