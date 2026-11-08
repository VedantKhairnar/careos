"use client";

import { Sparkles } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Card, CardSkeleton, EmptyState, ErrorState, useToast } from "@/components/ui";
import { RxBadge } from "@/components/rx";
import { RxActions } from "@/components/RxActions";
import type { PharmacyDraft } from "@/agents/pharmacyAgent";
import type { PrescriptionSummary } from "@/server/services";
import { api, ApiError } from "@/lib/api";
import { patientName } from "@/lib/demoPatients";
import { timeAgo } from "@/lib/format";
import { useApi } from "@/lib/useApi";

function AiPharmacySummary({ workflowId }: { workflowId: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<PharmacyDraft | null>(null);

  async function run() {
    setBusy(true);
    try {
      setOut(await api<PharmacyDraft>("/api/agents/pharmacy/process", { body: { workflowId } }));
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "That did not work.", "danger");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-3">
      <Button variant="secondary" loading={busy} onClick={run}>
        <Sparkles aria-hidden className="h-4 w-4" /> Summarize with AI
      </Button>
      {out && (
        <div className="mt-3 space-y-2 rounded-xl bg-surface-2 p-3 text-sm">
          <Badge tone="info">AI draft. Nothing has been sent.</Badge>
          <p>
            <strong>For you:</strong> {out.clinicianSummary}
          </p>
          <p>
            <strong>Possible message to the patient:</strong> {out.patientMessage}
          </p>
          {out.missingInformation.length > 0 && <p className="text-muted">Not known: {out.missingInformation.join("; ")}</p>}
        </div>
      )}
    </div>
  );
}

export default function PrescriptionsPage() {
  const { data, loading, error, reload } = useApi<PrescriptionSummary[]>("/api/prescriptions", { pollMs: 5000 });
  return (
    <>
      <h1 className="text-2xl font-bold">Prescriptions</h1>
      {loading && <CardSkeleton rows={4} />}
      {error && <ErrorState message={error.message} onRetry={reload} />}
      {data && data.length === 0 && <EmptyState title="No prescriptions yet" />}
      <ul className="space-y-3">
        {data?.map((r) => (
          <li key={r.workflowId}>
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-semibold">{r.medicationReference}</p>
                  <p className="text-sm text-muted">
                    {patientName(r.patientId)} · updated {timeAgo(r.lastUpdated)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {r.simulated && <Badge tone="info">Simulated</Badge>}
                  <RxBadge state={r.state} />
                </div>
              </div>
              <p className="mt-2 text-sm">{r.text}</p>
              <div className="mt-3">
                <RxActions workflowId={r.workflowId} state={r.state} onDone={reload} />
              </div>
              <AiPharmacySummary workflowId={r.workflowId} />
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}
