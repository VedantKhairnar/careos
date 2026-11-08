"use client";

import { Badge, Card, CardSkeleton, EmptyState, ErrorState } from "@/components/ui";
import type { AgentExecution } from "@/server/store";
import { timeAgo } from "@/lib/format";
import { useApi } from "@/lib/useApi";

interface Activity {
  geminiConfigured: boolean;
  totals: { executions: number; modelCalls: number; toolCalls: number; failed: number; inputTokens: number; outputTokens: number };
  byAgent: { name: string; count: number; failed: number }[];
  byTool: { name: string; count: number; failed: number }[];
  recent: AgentExecution[];
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <p className="text-3xl font-bold">{value.toLocaleString()}</p>
      <p className="mt-1 text-sm text-muted">{label}</p>
    </div>
  );
}

export default function AgentActivity() {
  const { data, loading, error, reload } = useApi<Activity>("/api/agents/activity", { pollMs: 4000 });
  return (
    <>
      <h1 className="text-2xl font-bold">Agent activity</h1>
      <p className="text-sm text-muted">
        A record of every model call and tool call the three assistants have made. This is real activity from this running server, not sample data. It resets when the server restarts.
      </p>

      {loading && <CardSkeleton rows={4} />}
      {error && <ErrorState message={error.message} onRetry={reload} />}
      {data && !data.geminiConfigured && (
        <div role="note" className="rounded-xl bg-warning-bg p-3 text-sm text-warning">
          Gemini is not configured on this server, so the assistants report that they are unavailable. Everything else keeps working.
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Model calls" value={data.totals.modelCalls} />
            <Stat label="Tool calls" value={data.totals.toolCalls} />
            <Stat label="Failed" value={data.totals.failed} />
            <Stat label="Tokens in" value={data.totals.inputTokens} />
            <Stat label="Tokens out" value={data.totals.outputTokens} />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Card title="By agent">
              {data.byAgent.length === 0 ? (
                <EmptyState title="No agent activity yet" />
              ) : (
                <ul className="space-y-1 text-sm">
                  {data.byAgent.map((a) => (
                    <li key={a.name} className="flex justify-between">
                      <span className="capitalize">{a.name} agent</span>
                      <span className="text-muted">
                        {a.count} calls{a.failed ? `, ${a.failed} failed` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="By tool">
              {data.byTool.length === 0 ? (
                <EmptyState title="No tool calls yet" />
              ) : (
                <ul className="space-y-1 text-sm">
                  {data.byTool.map((t) => (
                    <li key={t.name} className="flex justify-between gap-3">
                      <code className="truncate">{t.name}</code>
                      <span className="shrink-0 text-muted">
                        {t.count}
                        {t.failed ? ` (${t.failed} refused or failed)` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card title="Most recent">
            {data.recent.length === 0 ? (
              <EmptyState title="Nothing yet" hint="Ask the patient assistant a question or draft a plan from visit notes." />
            ) : (
              <ul className="divide-y divide-line text-sm">
                {data.recent.map((e, i) => (
                  <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div>
                      <span className="font-medium capitalize">{e.agent}</span>{" "}
                      <span className="text-muted">{e.tool ? `tool: ${e.tool}` : e.model ? "model call" : "run"}</span>
                      {e.error && <span className="ml-2 text-danger">{e.error}</span>}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted">
                      {e.model && <code>{e.model}</code>}
                      {e.inputTokens ? <span>{e.inputTokens} in / {e.outputTokens ?? 0} out</span> : null}
                      <span>{e.durationMs} ms</span>
                      <span>{timeAgo(e.startedAt)}</span>
                      {e.ok ? <Badge tone="success">ok</Badge> : <Badge tone="danger">failed</Badge>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </>
  );
}
