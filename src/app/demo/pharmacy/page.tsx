"use client";

import { Clock, LogOut } from "lucide-react";
import { useState } from "react";
import { RxBadge } from "@/components/rx";
import { SessionGate, useSignOut } from "@/components/session";
import { Badge, Button, Card, CardSkeleton, EmptyState, ErrorState, useToast } from "@/components/ui";
import { PRESCRIPTION_TRANSITIONS, type PrescriptionState } from "@/domain/prescription";
import { api, ApiError } from "@/lib/api";
import { patientName } from "@/lib/demoPatients";
import { useApi } from "@/lib/useApi";

interface Workflow {
  workflowId: string;
  patientId: string;
  medicationReference: string;
  state: string;
  text: string;
}

const LABEL: Record<string, string> = {
  "prescription.received": "Receive prescription",
  "prescription.acknowledged": "Acknowledge",
  "prescription.processing": "Start processing",
  "prescription.delayed": "Report a delay",
  "prescription.clarification_requested": "Ask clinician a question",
  "prescription.ready": "Mark ready for pickup",
  "prescription.picked_up": "Confirm pickup",
  "prescription.rejected": "Reject",
};

/** Events the pharmacy may legitimately send from this state, taken from the same state machine the server enforces. */
function validEvents(state: string): string[] {
  return Object.entries(PRESCRIPTION_TRANSITIONS)
    .filter(([, r]) => r!.actors.includes("pharmacy_sim") && r!.from.includes(state as PrescriptionState))
    .map(([type]) => type);
}

export default function PharmacySimulator() {
  return (
    <SessionGate role="demo_operator">
      <Console />
    </SessionGate>
  );
}

function Console() {
  const toast = useToast();
  const signOut = useSignOut();
  const wf = useApi<{ workflows: Workflow[] }>("/api/demo/pharmacy/workflows", { pollMs: 3000 });
  const clock = useApi<{ offsetMinutes: number }>("/api/demo/clock", { pollMs: 3000 });
  const [busy, setBusy] = useState<string | null>(null);

  async function send(w: Workflow, type: string) {
    setBusy(w.workflowId + type);
    try {
      await api("/api/demo/pharmacy/events", { body: { workflowId: w.workflowId, type } });
      toast(`Sent (simulated): ${LABEL[type] ?? type}`);
      await wf.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not send the event.", "danger");
    } finally {
      setBusy(null);
    }
  }

  async function advance(body: { advanceMinutes: number } | { reset: true }) {
    try {
      await api("/api/demo/clock", { body });
      await clock.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not change the clock.", "danger");
    }
  }

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Pharmacy simulator</h1>
          <p className="text-sm text-muted">Demo operator console. Every event sent from here is recorded as simulated and labelled that way in both portals.</p>
        </div>
        <button onClick={signOut} className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl px-3 text-sm hover:bg-surface-2">
          <LogOut aria-hidden className="h-4 w-4" /> Switch role
        </button>
      </header>

      <Card title="Demo clock" action={<Badge tone="info">Demo only</Badge>}>
        <p className="flex items-center gap-2 text-sm">
          <Clock aria-hidden className="h-4 w-4" />
          The care-gap engine currently sees time moved forward by <strong>{clock.data?.offsetMinutes ?? 0} minutes</strong>.
        </p>
        <p className="mt-1 text-sm text-muted">Move it forward to show a deadline passing without waiting. Real timestamps on events are not changed.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {[30, 60, 180].map((m) => (
            <Button key={m} variant="secondary" onClick={() => advance({ advanceMinutes: m })}>
              +{m} min
            </Button>
          ))}
          <Button variant="ghost" onClick={() => advance({ reset: true })}>
            Reset
          </Button>
        </div>
      </Card>

      {wf.loading && <CardSkeleton rows={3} />}
      {wf.error && <ErrorState message={wf.error.message} onRetry={wf.reload} />}
      {wf.data && wf.data.workflows.length === 0 && <EmptyState title="No prescriptions have been sent to the pharmacy yet" />}

      <ul className="space-y-3">
        {wf.data?.workflows.map((w) => {
          const events = validEvents(w.state);
          return (
            <li key={w.workflowId}>
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-semibold">{w.medicationReference || "Prescription"}</p>
                    <p className="text-sm text-muted">for {patientName(w.patientId)}</p>
                    <p className="text-xs text-muted">{w.workflowId}</p>
                  </div>
                  <RxBadge state={w.state} />
                </div>
                <p className="mt-2 text-sm text-muted">{w.text}</p>
                {events.length === 0 ? (
                  <p className="mt-3 text-sm text-muted">
                    {w.state === "CLARIFICATION_REQUIRED" ? "Waiting for the clinician to answer the question." : "No pharmacy action is possible from this state."}
                  </p>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {events.map((t) => (
                      <Button key={t} variant={t === "prescription.rejected" ? "danger" : "secondary"} loading={busy === w.workflowId + t} disabled={busy !== null} onClick={() => send(w, t)}>
                        {LABEL[t] ?? t}
                      </Button>
                    ))}
                  </div>
                )}
              </Card>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
