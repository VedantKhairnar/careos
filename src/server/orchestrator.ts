import { CareEventSchema, type Actor, type ActorRole, type CareEvent, type EventType } from "@/domain/events";
import { applyCarePlanEvent, CARE_PLAN_TRANSITIONS, type CarePlanState } from "@/domain/carePlan";
import {
  applyPrescriptionEvent,
  foldPrescriptionState,
  PRESCRIPTION_TRANSITIONS,
} from "@/domain/prescription";
import type { EventStore } from "./store";

export class Forbidden extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "Forbidden";
  }
}

export type HandleResult =
  | { status: "applied"; event: CareEvent }
  | { status: "duplicate" }
  | { status: "rejected"; reason: string };

/** Event types that carry no state transition but still have per-role rules. */
const OTHER_EVENT_ACTORS: Partial<Record<EventType, ActorRole[]>> = {
  "prescription.pickup_reported": ["patient", "caregiver"],
  "notification.sent": ["system"],
  "notification.acknowledged": ["patient", "caregiver", "clinician"],
  "followup.completed": ["clinician"],
  "task.confirmed": ["patient", "caregiver"],
  "gap.resolved": ["clinician", "system"],
};

const PATIENT_SIDE: ActorRole[] = ["patient", "caregiver"];

/**
 * Deterministic coordination layer. Not an LLM.
 * Every state change goes through handle(); agents never write state directly.
 */
export class Orchestrator {
  constructor(private store: EventStore, private now: () => string = () => new Date().toISOString()) {}

  async handle(actor: Actor, raw: unknown): Promise<HandleResult> {
    const parsed = CareEventSchema.safeParse(raw);
    if (!parsed.success) {
      return { status: "rejected", reason: `Invalid event: ${parsed.error.issues[0]?.message ?? "schema error"}` };
    }
    const event = parsed.data;

    // The claimed identity must match the authenticated actor. No spoofing.
    if (event.actorId !== actor.id || event.actorRole !== actor.role) {
      return { status: "rejected", reason: "Event actor does not match the authenticated actor" };
    }
    // Patient-side actors may only touch their own record.
    if (PATIENT_SIDE.includes(actor.role) && actor.patientId !== event.patientId) {
      return { status: "rejected", reason: "Not authorized for this patient" };
    }
    // Patient-reported information must stay labelled as such.
    if (PATIENT_SIDE.includes(actor.role) && event.verification !== "patient_reported") {
      return { status: "rejected", reason: "Patient-reported information cannot be marked as verified" };
    }
    // Simulator events must always be flagged as simulated.
    if (actor.role === "pharmacy_sim" && !event.simulated) {
      return { status: "rejected", reason: "Pharmacy simulator events must be flagged as simulated" };
    }

    // Idempotency: a repeated key never produces a second transition.
    if (await this.store.hasIdempotencyKey(event.idempotencyKey)) return { status: "duplicate" };

    const history = await this.store.listByWorkflow(event.workflowId);

    if (PRESCRIPTION_TRANSITIONS[event.type]) {
      const r = applyPrescriptionEvent(foldPrescriptionState(history), event.type, event.actorRole);
      if (!r.ok) return { status: "rejected", reason: r.reason };
    } else if (CARE_PLAN_TRANSITIONS[event.type]) {
      let plan: CarePlanState = "DRAFT";
      for (const e of history) {
        const step = applyCarePlanEvent(plan, e.type, e.actorRole);
        if (step.ok) plan = step.next;
      }
      const r = applyCarePlanEvent(plan, event.type, event.actorRole);
      if (!r.ok) return { status: "rejected", reason: r.reason };
    } else {
      const allowed = OTHER_EVENT_ACTORS[event.type];
      if (!allowed) return { status: "rejected", reason: `Unknown event type ${event.type}` };
      if (!allowed.includes(event.actorRole)) {
        return { status: "rejected", reason: `${event.actorRole} may not perform ${event.type}` };
      }
    }

    const stored = { ...event, recordedAt: this.now() };
    const inserted = await this.store.append(stored);
    if (!inserted) return { status: "duplicate" }; // lost a race with another writer
    return { status: "applied", event: stored };
  }

  /** Read access with server-side authorization. */
  async listEventsFor(actor: Actor, patientId: string): Promise<CareEvent[]> {
    const patientSide = PATIENT_SIDE.includes(actor.role);
    const canRead = (patientSide && actor.patientId === patientId) || actor.role === "clinician";
    if (!canRead) throw new Forbidden("Not authorized for this patient");
    return this.store.listByPatient(patientId);
  }

  /**
   * Runs an agent call. A failure is recorded and surfaced, never converted into
   * a made-up answer, and never touches workflow state.
   */
  async runAgent<T>(
    agent: "patient" | "doctor" | "pharmacy",
    patientId: string,
    fn: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    const startedAt = this.now();
    const t0 = Date.now();
    try {
      const value = await fn();
      await this.store.logAgentExecution({ agent, patientId, startedAt, durationMs: Date.now() - t0, ok: true });
      return { ok: true, value };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.store.logAgentExecution({ agent, patientId, startedAt, durationMs: Date.now() - t0, ok: false, error });
      return { ok: false, error };
    }
  }
}
