"use client";

import type { PrescriptionStatus } from "@/domain/status";
import { Badge, type Tone } from "./ui";

const RX: Record<string, { label: string; tone: Tone }> = {
  DRAFT: { label: "Being prepared", tone: "neutral" },
  AUTHORIZED: { label: "Authorized", tone: "info" },
  TRANSMITTED: { label: "Sent to pharmacy", tone: "info" },
  RECEIVED: { label: "Pharmacy received it", tone: "info" },
  ACKNOWLEDGED: { label: "Pharmacy acknowledged", tone: "info" },
  PROCESSING: { label: "Being prepared", tone: "info" },
  DELAYED: { label: "Delayed", tone: "warning" },
  CLARIFICATION_REQUIRED: { label: "Question pending", tone: "warning" },
  READY_FOR_PICKUP: { label: "Ready for pickup", tone: "success" },
  PICKED_UP: { label: "Picked up", tone: "success" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
  REJECTED: { label: "Could not be filled", tone: "danger" },
  FAILED: { label: "Could not be sent", tone: "danger" },
};

export function RxBadge({ state }: { state: string }) {
  const m = RX[state] ?? { label: state, tone: "neutral" as Tone };
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export const TERMINAL_RX = new Set(["PICKED_UP", "CANCELLED", "REJECTED", "FAILED"]);

export type RxView = Pick<PrescriptionStatus, "state" | "timeline" | "currentSource"> & { text: string; patientId: string };

export const GAP_LABEL: Record<string, string> = {
  pharmacy_ack_overdue: "Pharmacy has not acknowledged",
  delay_unaddressed: "Delay not followed up",
  clarification_unresolved: "Pharmacy question waiting",
  notification_unacknowledged: "Update not yet acknowledged by patient",
};
