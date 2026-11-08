"use client";

import { useState } from "react";
import { LogView } from "@/components/LogView";
import { Badge, Button, Card, CardSkeleton, EmptyState, ErrorState, useToast } from "@/components/ui";
import type { RunRecord } from "@/agents/runLog";
import { api, ApiError } from "@/lib/api";
import { patientName } from "@/lib/demoPatients";
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

const STATUS: Record<RunRecord["status"], { label: string; tone: "info" | "warning" | "success" | "danger" }> = {
  running: { label: "Working now", tone: "info" },
  awaiting_human: { label: "Waiting for a clinician", tone: "warning" },
  done: { label: "Finished", tone: "success" },
  failed: { label: "Stopped (failed)", tone: "danger" },
};

/** The live room: every agent run, as it happens. Polls once a second while anything is running. */
function LiveRuns() {
  const toast = useToast();
  const [anyRunning, setAnyRunning] = useState(false);
  const runs = useApi<RunRecord[]>("/api/agent-runs", { pollMs: anyRunning ? 1000 : 3000 });
  const [busy, setBusy] = useState(false);
  const running = (runs.data ?? []).some((r) => r.status === "running");
  if (running !== anyRunning) setAnyRunning(running);

  async function sweep() {
    setBusy(true);
    try {
      const r = await api<{ started: number }>("/api/agent-runs/sweep", { body: {} });
      toast(r.started ? `Coordinator started on ${r.started} problem${r.started > 1 ? "s" : ""}.` : "Nothing new for the coordinator to look at.");
      await runs.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "That did not work.", "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Live agent room">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-prose text-sm text-muted">
          Three agents work together: a <b>Coordinator</b> that investigates and decides, a <b>Writer</b> it hands wording to, and an independent <b>Safety Reviewer</b>. Code blocks the coordinator from proposing anything unreviewed. Press Report a delay in the pharmacy tab and watch.
        </p>
        <Button variant="secondary" loading={busy} onClick={sweep}>
          Look for problems now
        </Button>
      </div>
      {runs.loading && <CardSkeleton rows={3} />}
      {runs.data && runs.data.length === 0 && <EmptyState title="No agent has run yet" hint="Agents wake when the pharmacy reports a delay, a question or a rejection." />}
      <ul className="space-y-3">
        {(runs.data ?? []).map((r, i) => (
          <li key={r.runId}>
            <details open={i === 0} className="rounded-xl border border-line">
              <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 p-3">
                <span className="font-medium">
                  {patientName(r.patientId)} · {r.trigger.replace("prescription.", "pharmacy ")}
                </span>
                <span className="flex items-center gap-2 text-xs text-muted">
                  {r.entries.length} steps
                  <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                </span>
              </summary>
              <div className="border-t border-line p-3">
                <LogView entries={r.entries} />
              </div>
            </details>
          </li>
        ))}
      </ul>
    </Card>
  );
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
      <h1 className="text-2xl font-bold">Agent room</h1>
      <p className="text-sm text-muted">
        Everything below is real activity from this running server, not sample data: the live log of agent runs first, then totals for every model call and tool call. The live log resets when the server restarts; each finished run is also saved with its draft.
      </p>

      <LiveRuns />

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
