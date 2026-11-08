"use client";

import { useState } from "react";
import { Badge, Button, Card, CardSkeleton, EmptyState, ErrorState, useToast } from "@/components/ui";
import type { NotificationView } from "@/server/patientCare";
import { api, ApiError } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useApi } from "@/lib/useApi";

export default function NotificationsPage() {
  const { data, loading, error, reload } = useApi<{ notifications: NotificationView[]; unread: number }>("/api/notifications", { pollMs: 10000 });
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  async function ack(id: string) {
    setBusy(id);
    try {
      await api(`/api/notifications/${id}/acknowledge`, { method: "POST" });
      toast("Marked as seen.");
      await reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not update. Please try again.", "danger");
    } finally {
      setBusy(null);
    }
  }

  const items = data?.notifications ?? [];
  const unread = items.filter((n) => !n.acknowledged);
  const seen = items.filter((n) => n.acknowledged);

  return (
    <>
      <h1 className="text-2xl font-bold">Updates</h1>

      {loading && <CardSkeleton rows={4} />}
      {error && <ErrorState message={error.message} onRetry={reload} />}
      {data && items.length === 0 && <EmptyState title="No updates yet" />}

      {unread.length > 0 && (
        <Card title={`Needs a look (${unread.length})`}>
          <ul className="space-y-2">
            {unread.map((n) => (
              <li key={n.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-3">
                <div>
                  <p className="font-medium">{n.title}</p>
                  <p className="text-sm text-muted">{timeAgo(n.at)}</p>
                </div>
                <div className="flex items-center gap-2">
                  {n.important && <Badge tone="warning">Important</Badge>}
                  <Button variant="secondary" loading={busy === n.id} onClick={() => ack(n.id)}>
                    Mark as seen
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {seen.length > 0 && (
        <Card title="Seen">
          <ul className="space-y-2">
            {seen.map((n) => (
              <li key={n.id} className="flex items-center justify-between gap-3 rounded-xl border border-line p-3">
                <p>{n.title}</p>
                <span className="shrink-0 text-sm text-muted">{timeAgo(n.at)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
