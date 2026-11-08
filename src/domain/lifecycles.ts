import type { ActorRole } from "./events";

/**
 * Generic, table-driven lifecycle used by care tasks, clarifications and care gaps.
 * Every applied step is recorded, so history is never lost (including reopen).
 */
export interface Transition<S extends string> {
  from: S[];
  to: S;
  actors: ActorRole[];
  /** Some steps are only valid with proof or a stated reason. */
  requires?: "evidence" | "reason";
}

export interface StepContext {
  actor: ActorRole;
  at: string;
  evidence?: string[];
  reason?: string;
}

export interface HistoryEntry<S extends string> {
  action: string;
  from: S;
  to: S;
  actor: ActorRole;
  at: string;
  evidence?: string[];
  reason?: string;
}

export type StepResult<S extends string> = { ok: true; entry: HistoryEntry<S> } | { ok: false; reason: string };

export class Lifecycle<S extends string> {
  private _state: S;
  private _history: HistoryEntry<S>[] = [];
  constructor(private table: Record<string, Transition<S>>, initial: S) {
    this._state = initial;
  }
  get state(): S {
    return this._state;
  }
  get history(): readonly HistoryEntry<S>[] {
    return this._history;
  }
  apply(action: string, ctx: StepContext): StepResult<S> {
    const t = this.table[action];
    if (!t) return { ok: false, reason: `Unknown action ${action}` };
    if (!t.actors.includes(ctx.actor)) return { ok: false, reason: `${ctx.actor} may not ${action}` };
    if (!t.from.includes(this._state)) return { ok: false, reason: `${action} is not allowed from ${this._state}` };
    if (t.requires === "evidence" && !(ctx.evidence && ctx.evidence.length > 0)) {
      return { ok: false, reason: `${action} requires completion evidence` };
    }
    if (t.requires === "reason" && !(ctx.reason && ctx.reason.trim())) {
      return { ok: false, reason: `${action} requires a reason` };
    }
    const entry: HistoryEntry<S> = {
      action,
      from: this._state,
      to: t.to,
      actor: ctx.actor,
      at: ctx.at,
      evidence: ctx.evidence,
      reason: ctx.reason,
    };
    this._state = t.to;
    this._history.push(entry);
    return { ok: true, entry };
  }
}

// ---- Care task ----
export type TaskState =
  | "CREATED" | "ASSIGNED" | "SCHEDULED" | "IN_PROGRESS" | "COMPLETED"
  | "BLOCKED" | "OVERDUE" | "NEEDS_CLARIFICATION" | "CANCELLED";

const OPEN_TASK: TaskState[] = ["ASSIGNED", "SCHEDULED", "IN_PROGRESS", "OVERDUE", "BLOCKED", "NEEDS_CLARIFICATION"];

export const TASK_TABLE: Record<string, Transition<TaskState>> = {
  assign: { from: ["CREATED"], to: "ASSIGNED", actors: ["clinician", "system"] },
  schedule: { from: ["ASSIGNED"], to: "SCHEDULED", actors: ["clinician", "system"] },
  start: { from: ["SCHEDULED", "OVERDUE"], to: "IN_PROGRESS", actors: ["patient", "caregiver", "clinician"] },
  // A task is only completed when there is evidence (e.g. a patient-reported confirmation event).
  complete: { from: ["IN_PROGRESS"], to: "COMPLETED", actors: ["patient", "caregiver", "clinician"], requires: "evidence" },
  mark_overdue: { from: ["SCHEDULED"], to: "OVERDUE", actors: ["system"] },
  block: { from: ["ASSIGNED", "SCHEDULED", "IN_PROGRESS"], to: "BLOCKED", actors: ["clinician", "system"] },
  request_clarification: {
    from: ["ASSIGNED", "SCHEDULED", "IN_PROGRESS"],
    to: "NEEDS_CLARIFICATION",
    actors: ["patient", "caregiver", "clinician", "agent"],
  },
  resume: { from: ["BLOCKED", "NEEDS_CLARIFICATION"], to: "ASSIGNED", actors: ["clinician"] },
  cancel: { from: ["CREATED", ...OPEN_TASK], to: "CANCELLED", actors: ["clinician"] },
};

// ---- Clarification ----
export type ClarificationState = "CREATED" | "ASSIGNED" | "REVIEWED" | "RESPONSE_PREPARED" | "APPROVED" | "RESOLVED";

export const CLARIFICATION_TABLE: Record<string, Transition<ClarificationState>> = {
  assign: { from: ["CREATED"], to: "ASSIGNED", actors: ["system", "clinician"] },
  review: { from: ["ASSIGNED"], to: "REVIEWED", actors: ["clinician"] },
  // An agent may PREPARE a response...
  prepare_response: { from: ["REVIEWED"], to: "RESPONSE_PREPARED", actors: ["clinician", "agent"] },
  // ...but only a clinician can approve it.
  approve: { from: ["RESPONSE_PREPARED"], to: "APPROVED", actors: ["clinician"] },
  resolve: { from: ["APPROVED"], to: "RESOLVED", actors: ["clinician", "system"] },
};

// ---- Care gap ----
export type GapState =
  | "DETECTED" | "ASSIGNED" | "ACKNOWLEDGED" | "ACTION_IN_PROGRESS" | "RESOLVED"
  | "ESCALATED" | "DISMISSED_WITH_REASON";

const ACTIVE_GAP: GapState[] = ["DETECTED", "ASSIGNED", "ACKNOWLEDGED", "ACTION_IN_PROGRESS", "ESCALATED"];

export const GAP_TABLE: Record<string, Transition<GapState>> = {
  assign: { from: ["DETECTED"], to: "ASSIGNED", actors: ["system"] },
  acknowledge: { from: ["ASSIGNED", "ESCALATED"], to: "ACKNOWLEDGED", actors: ["clinician", "patient", "caregiver"] },
  begin_action: { from: ["ACKNOWLEDGED"], to: "ACTION_IN_PROGRESS", actors: ["clinician", "patient", "caregiver"] },
  resolve: { from: ["ACTION_IN_PROGRESS", "ACKNOWLEDGED"], to: "RESOLVED", actors: ["clinician", "system"] },
  escalate: { from: ["ASSIGNED", "ACKNOWLEDGED", "ACTION_IN_PROGRESS"], to: "ESCALATED", actors: ["system"] },
  dismiss: { from: ACTIVE_GAP, to: "DISMISSED_WITH_REASON", actors: ["clinician"], requires: "reason" },
  // Reopening is a new, auditable transition; earlier history is retained.
  reopen: { from: ["RESOLVED", "DISMISSED_WITH_REASON"], to: "DETECTED", actors: ["system", "clinician"], requires: "reason" },
};
