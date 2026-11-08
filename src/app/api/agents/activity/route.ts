import { ok, requireSession, route } from "@/server/http";
import { runtime } from "@/server/runtime";

/** Real evidence of what the agents did: every model call and tool call, with model, latency and tokens. */
export const GET = route(async (req) => {
  requireSession(req, ["clinician"]);
  const all = await runtime().store.listAgentExecutions();
  const tally = (key: "agent" | "tool") => {
    const m = new Map<string, { count: number; failed: number }>();
    for (const e of all) {
      const k = key === "agent" ? e.agent : e.tool;
      if (!k) continue;
      const row = m.get(k) ?? { count: 0, failed: 0 };
      row.count++;
      if (!e.ok) row.failed++;
      m.set(k, row);
    }
    return [...m.entries()].map(([name, v]) => ({ name, ...v }));
  };
  const modelCalls = all.filter((e) => e.model && !e.tool);
  return ok({
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    totals: {
      executions: all.length,
      modelCalls: modelCalls.length,
      toolCalls: all.filter((e) => e.tool).length,
      failed: all.filter((e) => !e.ok).length,
      inputTokens: modelCalls.reduce((n, e) => n + (e.inputTokens ?? 0), 0),
      outputTokens: modelCalls.reduce((n, e) => n + (e.outputTokens ?? 0), 0),
    },
    byAgent: tally("agent"),
    byTool: tally("tool"),
    recent: [...all].reverse().slice(0, 40),
  });
});
