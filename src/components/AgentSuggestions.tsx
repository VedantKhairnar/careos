"use client";

import { Bot } from "lucide-react";
import { useState } from "react";
import type { SuggestionView } from "@/server/suggestions";
import { api, ApiError } from "@/lib/api";
import { patientName } from "@/lib/demoPatients";
import { timeAgo } from "@/lib/format";
import { useApi } from "@/lib/useApi";
import Link from "next/link";
import { LogView } from "./LogView";
import { Badge, Button, Card, useToast } from "./ui";

const TRIGGER: Record<string, string> = {
  "prescription.delayed": "the pharmacy reported a delay",
  "prescription.clarification_requested": "the pharmacy asked a question",
  "prescription.rejected": "the pharmacy could not fill a prescription",
};

/**
 * The Fulfilment agent wakes on pharmacy events by itself. What it prepares appears here as a DRAFT.
 * Nothing reaches the patient until a clinician approves, and the clinician can edit the wording first.
 */
export function AgentSuggestionsCard() {
  const toast = useToast();
  const list = useApi<SuggestionView[]>("/api/agent-suggestions", { pollMs: 3000 });
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const items = (list.data ?? []).filter((s) => s.status === "pending");
  const recent = (list.data ?? []).filter((s) => s.status !== "pending").slice(0, 2);
  if (!list.data || (items.length === 0 && recent.length === 0)) return null;

  async function review(s: SuggestionView, decision: "approve" | "dismiss") {
    setBusy(s.id + decision);
    try {
      await api(`/api/agent-suggestions/${s.id}/review`, { body: { decision, ...(decision === "approve" ? { message: edit[s.id] ?? s.patientMessage } : {}) } });
      toast(decision === "approve" ? "Sent to the patient." : "Draft dismissed. Nothing was sent.");
      await list.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "That did not work. Please try again.", "danger");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title={`Care coordinator proposals${items.length ? ` (${items.length} waiting for you)` : ""}`}>
      <p className="mb-3 flex items-start gap-2 text-sm text-muted">
        <Bot aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
        A coordinator agent woke up on its own when a pharmacy update arrived, investigated, handed the wording to a writer agent, and had it checked by an independent safety reviewer. It cannot send anything. You decide.
      </p>
      <ul className="space-y-3">
        {items.map((s) => (
          <li key={s.id} className="rounded-xl border border-line p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">
                {patientName(s.patientId)} · {s.medication}
              </p>
              <div className="flex flex-wrap gap-2">{s.urgency === "time_sensitive" && <Badge tone="warning">Time-sensitive</Badge>}<Badge tone="info">Draft by agent · not sent</Badge></div>
            </div>
            <p className="text-xs text-muted">
              Triggered because {TRIGGER[s.trigger] ?? s.trigger} · {timeAgo(s.createdAt)}
            </p>
            <p className="mt-2 text-sm"><span className="font-medium">{s.urgency === "time_sensitive" ? "Why it is time-sensitive:" : "Why routine:"}</span> {s.urgencyReason}</p>
            <p className="mt-1 text-sm">{s.clinicianSummary}</p>
            <p className="mt-1 text-sm">
              <span className="font-medium">Suggested next step:</span> {s.suggestedNextStep}
            </p>
            {s.missingInformation.length > 0 && <p className="mt-1 text-sm text-muted">Not known: {s.missingInformation.join("; ")}</p>}
            <label className="mt-2 block text-sm font-medium">
              Message to the patient (edit if you like)
              <textarea rows={3} maxLength={600} className="mt-1 block w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm" value={edit[s.id] ?? s.patientMessage} onChange={(e) => setEdit((d) => ({ ...d, [s.id]: e.target.value }))} />
            </label>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button loading={busy === s.id + "approve"} disabled={busy !== null || !(edit[s.id] ?? s.patientMessage).trim()} onClick={() => review(s, "approve")}>
                Approve and send to patient
              </Button>
              <Button variant="secondary" loading={busy === s.id + "dismiss"} disabled={busy !== null} onClick={() => review(s, "dismiss")}>
                Dismiss
              </Button>
            </div>
            <details className="mt-2 rounded-lg border border-line text-xs">
              <summary className="cursor-pointer select-none px-2 py-1.5 font-medium text-muted">
                Agent log · {s.log.length} steps · safety review rounds: {s.safetyReviewRounds}
              </summary>
              <div className="p-2">
                <LogView entries={s.log} />
                <Link href="/doctor/agents" className="mt-2 inline-block font-sans text-accent underline">
                  Open the live agent room
                </Link>
              </div>
            </details>
          </li>
        ))}
        {recent.map((s) => (
          <li key={s.id} className="rounded-xl border border-line p-3 text-sm">
            <span className="font-medium">{patientName(s.patientId)} · {s.medication}</span> · {s.status === "sent" ? "approved and sent" : "dismissed"} {s.reviewedAt ? timeAgo(s.reviewedAt) : ""}
          </li>
        ))}
      </ul>
    </Card>
  );
}
