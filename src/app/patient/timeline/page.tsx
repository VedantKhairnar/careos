"use client";

import { Badge, Card, CardSkeleton, EmptyState, ErrorState, SourceDetails } from "@/components/ui";
import type { NotificationView } from "@/server/patientCare";
import { formatDateTime } from "@/lib/format";
import { useApi } from "@/lib/useApi";

export default function TimelinePage() {
  const { data, loading, error, reload } = useApi<{ notifications: NotificationView[] }>("/api/notifications", { pollMs: 10000 });
  const items = data?.notifications ?? [];

  return (
    <>
      <h1 className="text-2xl font-bold">Care timeline</h1>
      <p className="text-sm text-muted">Everything that has happened in your care, newest first. Open any item to see where it came from.</p>

      {loading && <CardSkeleton rows={5} />}
      {error && <ErrorState message={error.message} onRetry={reload} />}
      {data && items.length === 0 && <EmptyState title="Nothing has happened yet" />}

      {items.length > 0 && (
        <Card>
          <ol className="relative space-y-5 border-l-2 border-line pl-5">
            {items.map((n) => (
              <li key={n.id} className="relative">
                <span aria-hidden className="absolute -left-[27px] top-1.5 h-3 w-3 rounded-full border-2 border-accent bg-surface" />
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{n.title}</p>
                  {n.source.simulated && <Badge tone="info">Simulated</Badge>}
                </div>
                <p className="text-sm text-muted">{formatDateTime(n.at)}</p>
                <SourceDetails source={n.source} />
              </li>
            ))}
          </ol>
        </Card>
      )}
    </>
  );
}
