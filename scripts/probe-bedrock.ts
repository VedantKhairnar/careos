import { BedrockModel } from "../src/agents/bedrock";

/** One real Bedrock call with a tool, then a second turn carrying the tool result. Prints only what the model did. */
async function main() {
  const m = new BedrockModel(process.env.BEDROCK_MODEL!, process.env.AWS_REGION ?? "us-east-1");
  const tools = [{ name: "get_status", description: "Current prescription status.", parametersJsonSchema: { type: "object", properties: { why: { type: "string" } }, required: ["why"] } }];
  const system = "You help a patient. Use tools to find facts. Answer only from tool results.";
  const r1 = await m.generate({ system, contents: [{ role: "user", parts: [{ text: "What is the status of my prescription?" }] }], tools });
  console.log("turn 1:", r1.model, r1.latencyMs + "ms", "calls:", JSON.stringify(r1.functionCalls), "text:", r1.text.slice(0, 80));
  if (!r1.functionCalls.length) return;
  const r2 = await m.generate({
    system,
    contents: [
      { role: "user", parts: [{ text: "What is the status of my prescription?" }] },
      r1.content,
      { role: "user", parts: [{ functionResponse: { name: r1.functionCalls[0].name, response: { result: { state: "DELAYED", note: "pharmacy gave no time" } } } }] },
    ],
    tools,
  });
  console.log("turn 2:", r2.latencyMs + "ms", r2.text.slice(0, 200));
  const r3 = await m.generate({ system: "Reply with JSON only.", contents: [{ role: "user", parts: [{ text: "Give ok=true and a one word note." }] }], responseJsonSchema: { type: "object", properties: { ok: { type: "boolean" }, note: { type: "string" } }, required: ["ok", "note"] } });
  console.log("json:", r3.text);
}
main().catch((e) => { console.error("FAILED:", e.name, String(e.message).slice(0, 200)); process.exit(1); });
