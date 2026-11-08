import { z } from "zod";
import { BedrockModel } from "../src/agents/bedrock";
import { DRAFT_SYSTEM, dropEmpty } from "../src/agents/doctorAgent";
import { CarePlanContentSchema } from "../src/server/carePlans";

/** Asks Bedrock for a plan draft exactly as the app does and shows why it would be rejected. */
async function main() {
  const schema = z.toJSONSchema(CarePlanContentSchema) as Record<string, unknown>;
  delete schema.$schema;
  const notes = "Fictional demo visit for Alex Rivera. Recovering well after the procedure. Demo-Antibiotic: 1 capsule at 9am and 9pm, starting 2026-11-08 until 2026-11-12. Demo-Analgesic: 1 tablet at 8am, 2pm and 8pm, starting 2026-11-08. Review visit on 2026-11-22. Call the clinic if the area becomes very red, hot or swollen, or if there is a fever.";
  const m = new BedrockModel(process.env.BEDROCK_MODEL!, process.env.AWS_REGION ?? "us-east-1");
  const r = await m.generate({ system: DRAFT_SYSTEM, contents: [{ role: "user", parts: [{ text: `Visit notes:\n"""\n${notes}\n"""` }] }], responseJsonSchema: schema, maxOutputTokens: 2048 });
  console.log("RAW:", r.text.slice(0, 700));
  try {
    const p = CarePlanContentSchema.safeParse(dropEmpty(JSON.parse(r.text)));
    console.log(p.success ? "VALID" : "INVALID: " + JSON.stringify(p.error.issues.slice(0, 5)));
  } catch (e) {
    console.log("NOT JSON:", String(e));
  }
}
main();
