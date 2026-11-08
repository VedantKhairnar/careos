import { BedrockModel, FallbackModel } from "../src/agents/bedrock";
import { GeminiModel } from "../src/agents/model";

/** Real failover: Gemini with a deliberately wrong key must fail, and the same request must be answered by Bedrock. */
async function main() {
  const m = new FallbackModel(new GeminiModel("deliberately-wrong-key"), new BedrockModel(process.env.BEDROCK_MODEL!, process.env.AWS_REGION ?? "us-east-1"), (why) => console.log("primary failed:", why));
  const r = await m.generate({ system: "Answer in one short sentence.", contents: [{ role: "user", parts: [{ text: "Say hello to a patient." }] }] });
  console.log("answered by:", r.model, "|", r.text.slice(0, 100));
}
main().catch((e) => { console.error("FAILED", e.name, e.message); process.exit(1); });
