"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { Badge, Card, CardSkeleton, EmptyState, ErrorState } from "@/components/ui";
import { useApi } from "@/lib/useApi";

interface Row {
  id: string;
  displayName: string;
  scenario: string;
  plansApproved: number;
  plansPendingReview: number;
  prescriptions: string[];
  openGaps: number;
}

export default function PatientsPage() {
  const { data, loading, error, reload } = useApi<Row[]>("/api/patients", { pollMs: 8000 });
  return (
    <>
      <h1 className="text-2xl font-bold">Patients</h1>
      {loading && <CardSkeleton rows={3} />}
      {error && <ErrorState message={error.message} onRetry={reload} />}
      {data && data.length === 0 && <EmptyState title="No patients" />}
      <ul className="space-y-3">
        {data?.map((p) => (
          <li key={p.id}>
            <Link href={`/doctor/patients/${p.id}`} className="block">
              <Card className="transition hover:border-accent">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-semibold">{p.displayName}</p>
                    <p className="text-sm text-muted">{p.scenario}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Badge tone="success">{p.plansApproved} approved plan{p.plansApproved === 1 ? "" : "s"}</Badge>
                      {p.plansPendingReview > 0 && <Badge tone="warning">{p.plansPendingReview} awaiting approval</Badge>}
                      <Badge tone="neutral">{p.prescriptions.length} prescription{p.prescriptions.length === 1 ? "" : "s"}</Badge>
                      {p.openGaps > 0 && <Badge tone="warning">{p.openGaps} open gap{p.openGaps === 1 ? "" : "s"}</Badge>}
                    </div>
                  </div>
                  <ChevronRight aria-hidden className="h-5 w-5 text-muted" />
                </div>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
