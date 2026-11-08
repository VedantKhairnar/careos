"use client";

import { useState } from "react";
import type { DoseView } from "@/server/patientCare";
import { api, ApiError } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { Badge, Button, useToast, type Tone } from "./ui";

const STATUS: Record<DoseView["status"], { label: string; tone: Tone }> = {
  scheduled: { label: "Scheduled", tone: "neutral" },
  taken: { label: "You reported: taken", tone: "success" },
  not_taken: { label: "You reported: not taken", tone: "warning" },
  unsure: { label: "You reported: unsure", tone: "warning" },
  // Deliberately not "missed": no answer is not evidence either way.
  unconfirmed: { label: "Not confirmed yet", tone: "warning" },
};

export function DoseRow({ dose, doseLabel, onChanged }: { dose: DoseView; doseLabel?: string | null; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const s = STATUS[dose.status];
  const canReport = dose.status === "scheduled" || dose.status === "unconfirmed";

  async function report(response: "taken" | "not_taken" | "unsure") {
    setBusy(response);
    try {
      await api("/api/doses", { body: { planId: dose.planId, medicationName: dose.medicationName, scheduledFor: dose.scheduledFor, response } });
      toast("Saved as reported by you.");
      onChanged();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not save. Please try again.", "danger");
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-semibold">
            {formatTime(dose.scheduledFor)} · {dose.medicationName}
          </p>
          {doseLabel && <p className="text-sm text-muted">{doseLabel}</p>}
        </div>
        <Badge tone={s.tone}>{s.label}</Badge>
      </div>
      {canReport && (
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Button variant="primary" loading={busy === "taken"} disabled={busy !== null} onClick={() => report("taken")}>
            Taken
          </Button>
          <Button variant="secondary" loading={busy === "not_taken"} disabled={busy !== null} onClick={() => report("not_taken")}>
            Not taken
          </Button>
          <Button variant="secondary" loading={busy === "unsure"} disabled={busy !== null} onClick={() => report("unsure")}>
            Unsure
          </Button>
        </div>
      )}
    </li>
  );
}
