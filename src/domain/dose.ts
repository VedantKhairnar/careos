/**
 * Medication reminders and adherence.
 *
 * Rules enforced here:
 *  - Reminders are only derived from complete, clinician-approved instructions.
 *    We never infer clock times from "twice a day" or invent a dose.
 *  - An unanswered reminder is "unconfirmed", never "missed".
 *  - A delivered reminder never implies the dose was taken.
 */

export interface ApprovedInstruction {
  medicationName: string;
  dose?: string; // e.g. "250 mg" - verbatim from the approved plan
  /** Explicit local clock times, "HH:MM". Required; we do not infer them. */
  times?: string[];
  startDate?: string; // "YYYY-MM-DD"
  endDate?: string; // "YYYY-MM-DD", optional
  source: { carePlanVersionId: string; approvedBy: string };
}

export type ReminderDerivation =
  | { status: "ok"; reminders: { scheduledFor: string; medicationName: string }[] }
  | { status: "needs_clarification"; missing: string[] };

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function deriveReminders(
  instr: ApprovedInstruction,
  opts: { horizonDays?: number; utcOffsetMinutes?: number } = {},
): ReminderDerivation {
  const missing: string[] = [];
  if (!instr.dose || instr.dose.trim() === "") missing.push("dose");
  if (!instr.times || instr.times.length === 0) missing.push("times");
  else if (!instr.times.every((t) => TIME_RE.test(t))) missing.push("valid times");
  if (!instr.startDate || !DATE_RE.test(instr.startDate)) missing.push("startDate");
  if (instr.endDate !== undefined && !DATE_RE.test(instr.endDate)) missing.push("valid endDate");
  if (missing.length > 0) return { status: "needs_clarification", missing };

  const horizon = opts.horizonDays ?? 7;
  const offset = opts.utcOffsetMinutes ?? 0;
  const [y, m, d] = instr.startDate!.split("-").map(Number);
  const reminders: { scheduledFor: string; medicationName: string }[] = [];

  for (let day = 0; day < horizon; day++) {
    const dateUtc = Date.UTC(y, m - 1, d + day);
    const dateStr = new Date(dateUtc).toISOString().slice(0, 10);
    if (instr.endDate && dateStr > instr.endDate) break;
    for (const t of instr.times!) {
      const [hh, mm] = t.split(":").map(Number);
      const ms = Date.UTC(y, m - 1, d + day, hh, mm) - offset * 60_000;
      reminders.push({ scheduledFor: new Date(ms).toISOString(), medicationName: instr.medicationName });
    }
  }
  return { status: "ok", reminders };
}

export type PatientDoseResponse = "taken" | "not_taken" | "unsure";
export type DoseStatus =
  | "scheduled"
  | "taken" // patient-reported
  | "not_taken" // patient-reported
  | "unsure" // patient-reported
  | "unconfirmed"; // no response after the grace window. NOT "missed".

export function resolveDoseStatus(args: {
  scheduledFor: string;
  now: string;
  graceMinutes: number;
  response?: PatientDoseResponse;
}): DoseStatus {
  if (args.response) return args.response;
  const deadline = Date.parse(args.scheduledFor) + args.graceMinutes * 60_000;
  return Date.parse(args.now) > deadline ? "unconfirmed" : "scheduled";
}
