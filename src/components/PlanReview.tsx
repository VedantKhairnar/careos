"use client";

import { useState } from "react";
import type { CarePlanView } from "@/server/carePlans";
import { api, ApiError } from "@/lib/api";
import { Badge, Button, useToast } from "./ui";

/** Explicit, auditable clinician approval: read the plan, confirm, then approve. */
export function PlanReview({ plan, onDone }: { plan: CarePlanView; onDone: () => void }) {
  const toast = useToast();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function approve() {
    setBusy(true);
    try {
      await api(`/api/care-plans/${plan.planId}/approve`, { method: "POST" });
      toast("Approved. The patient can now see this plan.");
      onDone();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not approve.", "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-line bg-surface-2 p-3">
      <p className="text-sm">
        Drafted by <strong>{plan.draftedBy === "agent" ? "an AI assistant" : "a clinician"}</strong>. It is <strong>not visible to the patient</strong> until you approve it.
      </p>
      <ul className="mt-2 space-y-1 text-sm">
        {plan.content.medications.map((m, i) => (
          <li key={i}>
            <strong>{m.name}</strong>{" "}
            {m.dose && m.times?.length && m.startDate ? (
              <span>
                {m.dose} at {m.times.join(", ")} from {m.startDate}
              </span>
            ) : (
              <Badge tone="warning">Incomplete schedule: patient will see &quot;not confirmed&quot;</Badge>
            )}
          </li>
        ))}
        {plan.content.medications.length === 0 && <li className="text-muted">No medicines in this plan.</li>}
      </ul>
      <label className="mt-3 flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1 h-5 w-5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        <span>I have reviewed this plan and approve it as the responsible clinician.</span>
      </label>
      <Button className="mt-3" disabled={!confirmed} loading={busy} onClick={approve}>
        Approve care plan
      </Button>
    </div>
  );
}
