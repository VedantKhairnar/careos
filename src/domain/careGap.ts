import type { CareEvent } from "./events";
import { foldPrescriptionState } from "./prescription";

/**
 * Care Gap Engine: deterministic, time-aware, administrative only.
 * A gap is "an expected event has not arrived by a configured deadline".
 * It is NOT a clinical finding. Deadlines below are demo configuration,
 * not clinical standards.
 */
export interface GapConfig {
  ackDeadlineMinutes: number;
  delayFollowUpDeadlineMinutes: number;
  clarificationDeadlineMinutes: number;
  notificationAckDeadlineMinutes: number;
}

export const DEMO_GAP_CONFIG: GapConfig = {
  ackDeadlineMinutes: 30,
  delayFollowUpDeadlineMinutes: 60,
  clarificationDeadlineMinutes: 120,
  notificationAckDeadlineMinutes: 240,
};

export type GapRule =
  | "pharmacy_ack_overdue"
  | "delay_unaddressed"
  | "clarification_unresolved"
  | "notification_unacknowledged";

export type ResponsibleParty = "clinician" | "patient";

export interface CareGap {
  /** Deterministic key so re-running detection never creates duplicates. */
  key: string;
  rule: GapRule;
  workflowId: string;
  patientId: string;
  responsible: ResponsibleParty;
  sinceEventId: string;
  detectedAt: string;
  /** Plain description. Deliberately administrative, never diagnostic. */
  description: string;
}

const minutes = (iso: string, now: string) => (Date.parse(now) - Date.parse(iso)) / 60_000;

function byWorkflow(events: CareEvent[]): Map<string, CareEvent[]> {
  const map = new Map<string, CareEvent[]>();
  for (const e of [...events].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))) {
    const list = map.get(e.workflowId) ?? [];
    list.push(e);
    map.set(e.workflowId, list);
  }
  return map;
}

export function detectGaps(
  events: CareEvent[],
  now: string,
  config: GapConfig = DEMO_GAP_CONFIG,
): CareGap[] {
  const gaps: CareGap[] = [];
  const resolvedKeys = new Set(
    events.filter((e) => e.type === "gap.resolved").map((e) => String(e.payload.gapKey ?? "")),
  );

  for (const [workflowId, wf] of byWorkflow(events)) {
    const state = foldPrescriptionState(wf);
    const last = (type: CareEvent["type"]) => [...wf].reverse().find((e) => e.type === type);
    const push = (
      rule: GapRule,
      since: CareEvent,
      responsible: ResponsibleParty,
      description: string,
    ) => {
      const key = `${rule}:${workflowId}`;
      if (resolvedKeys.has(key)) return;
      gaps.push({
        key,
        rule,
        workflowId,
        patientId: since.patientId,
        responsible,
        sinceEventId: since.eventId,
        detectedAt: now,
        description,
      });
    };

    // 1. Sent to the pharmacy but no acknowledgment within the deadline.
    const transmitted = last("prescription.transmitted");
    if (
      transmitted &&
      (state === "TRANSMITTED" || state === "RECEIVED") &&
      minutes(transmitted.recordedAt, now) > config.ackDeadlineMinutes
    ) {
      push(
        "pharmacy_ack_overdue",
        transmitted,
        "clinician",
        "The pharmacy has not acknowledged this prescription within the expected time.",
      );
    }

    // 2. Pharmacy reported a delay and nobody has followed up.
    const delayed = last("prescription.delayed");
    if (delayed && state === "DELAYED") {
      const followed = wf.some(
        (e) => e.type === "followup.completed" && e.recordedAt >= delayed.recordedAt,
      );
      if (!followed && minutes(delayed.recordedAt, now) > config.delayFollowUpDeadlineMinutes) {
        push(
          "delay_unaddressed",
          delayed,
          "clinician",
          "The pharmacy reported a delay and no follow-up has been completed.",
        );
      }
    }

    // 3. Clarification requested and still unresolved.
    const clar = last("prescription.clarification_requested");
    if (
      clar &&
      state === "CLARIFICATION_REQUESTED" &&
      minutes(clar.recordedAt, now) > config.clarificationDeadlineMinutes
    ) {
      push(
        "clarification_unresolved",
        clar,
        "clinician",
        "A pharmacy clarification request is still waiting for a clinician response.",
      );
    }

    // 4. Important notification sent, never acknowledged.
    for (const n of wf.filter((e) => e.type === "notification.sent" && e.payload.important === true)) {
      const acked = wf.some(
        (e) =>
          e.type === "notification.acknowledged" &&
          e.payload.notificationId === n.payload.notificationId,
      );
      if (!acked && minutes(n.recordedAt, now) > config.notificationAckDeadlineMinutes) {
        push(
          "notification_unacknowledged",
          n,
          "patient",
          "An important update has not been acknowledged yet.",
        );
      }
    }
  }
  return gaps;
}
