import { describe, expect, it } from "vitest";
import type { Content } from "@google/genai";
import { FallbackModel, toConverse } from "@/agents/bedrock";
import { AiUnavailable, type LanguageModel } from "@/agents/model";

const history: Content[] = [
  { role: "user", parts: [{ text: "status?" }] },
  { role: "model", parts: [{ functionCall: { name: "get_status", args: { why: "x" } } }, { functionCall: { name: "get_plan", args: {} } }] },
  { role: "user", parts: [{ functionResponse: { name: "get_plan", response: { result: 1 } } }, { functionResponse: { name: "get_status", response: { result: "DELAYED" } } }] },
];

describe("toConverse", () => {
  it("pairs tool calls with their results by name, in order", () => {
    const m = toConverse(history, true);
    expect(m.map((x) => x.role)).toEqual(["user", "assistant", "user"]);
    const uses = m[1].content!.map((b) => b.toolUse!.toolUseId);
    const results = m[2].content!.map((b) => [b.toolResult!.toolUseId, b.toolResult!.content]);
    expect(uses).toEqual(["tool_1", "tool_2"]);
    expect(results[0][0]).toBe("tool_2"); // get_plan
    expect(results[1][0]).toBe("tool_1"); // get_status
  });
  it("writes tool history as plain text when no tools are offered (Converse rejects tool blocks without a tool config)", () => {
    const blocks = toConverse(history, false).flatMap((m) => m.content!);
    expect(blocks.every((b) => !b.toolUse && !b.toolResult)).toBe(true);
    expect(JSON.stringify(blocks)).toContain("DELAYED");
  });
  it("never starts with an assistant turn and keeps roles alternating", () => {
    const m = toConverse([{ role: "model", parts: [{ text: "hi" }] }, { role: "user", parts: [{ text: "a" }] }, { role: "user", parts: [{ text: "b" }] }], true);
    expect(m.map((x) => x.role)).toEqual(["user", "assistant", "user"]);
    expect(m[2].content).toHaveLength(2);
  });
});

describe("FallbackModel", () => {
  const ok: LanguageModel = { generate: async () => ({ content: { role: "model", parts: [{ text: "from fallback" }] }, text: "from fallback", functionCalls: [], usage: { input: 1, output: 1 }, model: "fb", latencyMs: 1 }) };
  const failing = (reason: ConstructorParameters<typeof AiUnavailable>[0]): LanguageModel => ({ generate: async () => { throw new AiUnavailable(reason, "x"); } });
  const req = { system: "s", contents: [] as Content[] };
  it("uses the fallback when the primary is rate limited or failing", async () => {
    const seen: string[] = [];
    for (const r of ["rate_limited", "model_error"] as const) expect((await new FallbackModel(failing(r), ok, (w) => seen.push(w)).generate(req)).text).toBe("from fallback");
    expect(seen).toEqual(["rate_limited", "model_error"]);
  });
  it("does not hide a bad answer or a missing key behind the fallback", async () => {
    for (const r of ["bad_output", "no_key"] as const) await expect(new FallbackModel(failing(r), ok).generate(req)).rejects.toThrow();
  });
  it("does not call the fallback when the primary works", async () => {
    let called = false;
    const fb: LanguageModel = { generate: async () => { called = true; return ok.generate(req); } };
    const primary: LanguageModel = { generate: async () => ({ ...(await ok.generate(req)), text: "primary" }) };
    expect((await new FallbackModel(primary, fb).generate(req)).text).toBe("primary");
    expect(called).toBe(false);
  });
});
