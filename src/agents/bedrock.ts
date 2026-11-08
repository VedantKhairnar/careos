import { BedrockRuntimeClient, ConverseCommand, type ContentBlock, type Message } from "@aws-sdk/client-bedrock-runtime";
import type { Content } from "@google/genai";
import { AiUnavailable, toGeminiSchema, type LanguageModel, type ModelRequest, type ModelResult } from "./model";

const CALL_TIMEOUT_MS = 40_000;

/**
 * Convert the conversation (kept in Gemini's format so a run can switch models half way) into Bedrock Converse
 * messages. Tool calls get stable ids by order. If no tools are offered this turn, earlier tool calls and results
 * are written out as plain text, because Converse refuses tool blocks in a request that has no tool configuration.
 */
export function toConverse(contents: Content[], withTools: boolean): Message[] {
  const out: Message[] = [];
  const pending: { name: string; id: string }[] = [];
  let n = 0;
  const push = (role: "user" | "assistant", blocks: ContentBlock[]) => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content = [...(last.content ?? []), ...blocks]; // Converse needs alternating roles
    else out.push({ role, content: blocks });
  };
  for (const c of contents) {
    const role = c.role === "model" ? "assistant" : "user";
    const blocks: ContentBlock[] = [];
    for (const p of c.parts ?? []) {
      if (typeof p.text === "string" && p.text) blocks.push({ text: p.text });
      if (p.functionCall) {
        const id = `tool_${++n}`;
        pending.push({ name: p.functionCall.name ?? "", id });
        blocks.push(withTools ? { toolUse: { toolUseId: id, name: p.functionCall.name ?? "", input: (p.functionCall.args ?? {}) as never } } : { text: `[called ${p.functionCall.name} with ${JSON.stringify(p.functionCall.args ?? {})}]` });
      }
      if (p.functionResponse) {
        const i = pending.findIndex((x) => x.name === p.functionResponse!.name);
        const id = i >= 0 ? pending.splice(i, 1)[0].id : `tool_${++n}`;
        const body = (p.functionResponse.response ?? {}) as Record<string, unknown>;
        blocks.push(withTools ? { toolResult: { toolUseId: id, content: [{ json: JSON.parse(JSON.stringify(body)) }] } } : { text: `[result of ${p.functionResponse.name}: ${JSON.stringify(body)}]` });
      }
    }
    push(role, blocks);
  }
  if (out[0]?.role === "assistant") out.unshift({ role: "user", content: [{ text: "Continue." }] });
  return out;
}

function extractJson(text: string): string {
  const t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  if (t.startsWith("{") || t.startsWith("[")) return t;
  const m = t.match(/\{[\s\S]*\}/);
  return m ? m[0] : t;
}

/** Amazon Bedrock (Converse API). Used as the fallback when Gemini is rate limited or failing. */
export class BedrockModel implements LanguageModel {
  private client: BedrockRuntimeClient;
  constructor(private modelId: string, region: string) {
    this.client = new BedrockRuntimeClient({ region }); // credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
  }

  async generate(req: ModelRequest): Promise<ModelResult> {
    const t0 = Date.now();
    const jsonNote = req.responseJsonSchema ? `\n\nReply with ONLY a JSON object that matches this JSON Schema, with no other text:\n${JSON.stringify(toGeminiSchema(req.responseJsonSchema))}` : "";
    const tools = req.tools?.length
      ? { tools: req.tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: toGeminiSchema(t.parametersJsonSchema) as Record<string, never> } } })) }
      : undefined;
    try {
      const res = await this.client.send(
        new ConverseCommand({
          modelId: this.modelId,
          system: [{ text: req.system + jsonNote }],
          messages: toConverse(req.contents, Boolean(tools)),
          inferenceConfig: { maxTokens: req.maxOutputTokens ?? 1024, temperature: 0.2 },
          ...(tools ? { toolConfig: tools } : {}),
        }),
        { abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
      );
      const blocks = res.output?.message?.content ?? [];
      const calls = blocks.filter((b) => b.toolUse).map((b) => ({ name: b.toolUse!.name ?? "", args: (b.toolUse!.input ?? {}) as Record<string, unknown> }));
      let text = blocks.map((b) => b.text ?? "").join("").replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim();
      if (req.responseJsonSchema) text = extractJson(text);
      if (!text && calls.length === 0) throw new AiUnavailable("bad_output", "The assistant returned nothing usable.");
      return {
        content: { role: "model", parts: [...(text && calls.length === 0 ? [{ text }] : text ? [{ text }] : []), ...calls.map((c) => ({ functionCall: { name: c.name, args: c.args } }))] },
        text: calls.length ? "" : text,
        functionCalls: calls,
        usage: { input: res.usage?.inputTokens ?? 0, output: res.usage?.outputTokens ?? 0 },
        model: `bedrock:${this.modelId}`,
        latencyMs: Date.now() - t0,
      };
    } catch (err) {
      if (err instanceof AiUnavailable) throw err;
      const name = err instanceof Error ? err.name : "Error";
      console.error(`[bedrock] ${this.modelId} failed: ${name}: ${err instanceof Error ? err.message.slice(0, 300) : ""}`);
      if (name === "ThrottlingException") throw new AiUnavailable("rate_limited", "The assistant is busy right now. Please try again in a minute.");
      throw new AiUnavailable("model_error", "The assistant could not answer.");
    }
  }
}

/** Tries the primary model; if it is rate limited or failing, the same request goes to the fallback. */
export class FallbackModel implements LanguageModel {
  constructor(private primary: LanguageModel, private fallback: LanguageModel, private onFallback: (why: string) => void = () => {}) {}
  async generate(req: ModelRequest): Promise<ModelResult> {
    try {
      return await this.primary.generate(req);
    } catch (err) {
      if (!(err instanceof AiUnavailable) || err.reason === "no_key" || err.reason === "bad_output") throw err;
      this.onFallback(err.reason);
      return this.fallback.generate(req);
    }
  }
}
