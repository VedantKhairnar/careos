import type { Content, Part } from "@google/genai";
import type { Actor } from "@/domain/events";
import { runtime } from "@/server/runtime";
import { AiUnavailable, getModel } from "./model";
import { declOf, type ToolDef } from "./tools";

export type AgentName = "patient" | "doctor" | "pharmacy";

export interface AgentSpec {
  name: AgentName;
  system: string;
  /** The ONLY tools this agent can call. Anything else is refused and logged. */
  tools: ToolDef[];
  maxModelCalls?: number;
}

export interface AgentRun {
  text: string;
  toolsUsed: { name: string; ok: boolean }[];
  model: string;
  modelCalls: number;
}

const safeError = (err: unknown) => (err instanceof Error ? err.message : "tool failed").slice(0, 200);

/**
 * Tool-use loop. Each model call and each tool call is recorded (agent, tool, model, latency, tokens,
 * outcome) so there is real evidence of what happened. The model never writes state: tools do, through
 * the same validated services as the API, as the person the agent acts for.
 */
export async function runAgent(spec: AgentSpec, actor: Actor, patientId: string, userText: string): Promise<AgentRun> {
  const model = getModel();
  const store = runtime().store;
  const maxCalls = spec.maxModelCalls ?? 4;
  const contents: Content[] = [{ role: "user", parts: [{ text: userText }] }];
  const decls = spec.tools.map(declOf);
  const toolsUsed: AgentRun["toolsUsed"] = [];
  let usedModel = "";

  for (let call = 1; call <= maxCalls; call++) {
    const lastChance = call === maxCalls;
    const startedAt = new Date().toISOString();
    let res;
    try {
      res = await model.generate({ system: spec.system, contents, tools: lastChance || decls.length === 0 ? undefined : decls });
    } catch (err) {
      await store.logAgentExecution({ agent: spec.name, patientId, startedAt, durationMs: 0, ok: false, error: safeError(err), model: usedModel || undefined });
      throw err;
    }
    usedModel = res.model;
    await store.logAgentExecution({ agent: spec.name, patientId, startedAt, durationMs: res.latencyMs, ok: true, model: res.model, inputTokens: res.usage.input, outputTokens: res.usage.output });

    if (res.functionCalls.length === 0) {
      if (!res.text) throw new AiUnavailable("bad_output", "The assistant returned an empty answer.");
      return { text: res.text, toolsUsed, model: res.model, modelCalls: call };
    }
    if (lastChance) throw new AiUnavailable("bad_output", "The assistant could not finish. Please try again.");

    contents.push(res.content);
    const responses: Part[] = [];
    for (const fc of res.functionCalls) {
      const t0 = Date.now();
      const startedTool = new Date().toISOString();
      const tool = spec.tools.find((t) => t.name === fc.name);
      let response: Record<string, unknown>;
      let ok = true;
      let error: string | undefined;
      if (!tool) {
        ok = false;
        error = "tool not permitted for this agent";
        response = { error };
      } else {
        const parsed = tool.args.safeParse(fc.args);
        if (!parsed.success) {
          ok = false;
          error = "invalid arguments";
          response = { error: `invalid arguments: ${parsed.error.issues[0]?.message ?? "bad input"}` };
        } else {
          try {
            response = { result: await tool.run(actor, parsed.data as never) };
          } catch (err) {
            ok = false;
            error = safeError(err);
            response = { error };
          }
        }
      }
      toolsUsed.push({ name: fc.name, ok });
      await store.logAgentExecution({ agent: spec.name, patientId, startedAt: startedTool, durationMs: Date.now() - t0, ok, error, tool: fc.name, model: res.model });
      responses.push({ functionResponse: { name: fc.name, response } });
    }
    contents.push({ role: "user", parts: responses });
  }
  throw new AiUnavailable("bad_output", "The assistant could not finish. Please try again.");
}
