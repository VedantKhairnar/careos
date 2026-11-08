import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as sessionPost } from "@/app/api/auth/session/route";
import { POST as seedPost } from "@/app/api/demo/seed/route";
import { POST as explainPost } from "@/app/api/visit/explain/route";
import { GET as runsGet } from "@/app/api/agent-runs/route";
import { setModelForTests, type LanguageModel } from "@/agents/model";
import { resetRuntime } from "@/server/runtime";

type AnyHandler = (req: Request, ctx: never) => Promise<Response>;
const req = (method: string, url: string, opts: { body?: unknown; cookie?: string } = {}) =>
  new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json", ...(opts.cookie ? { cookie: opts.cookie } : {}) }, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
const call = (h: AnyHandler, r: Request) => h(r, undefined as never);
const login = async (body: Record<string, unknown>) => (await call(sessionPost, req("POST", "/api/auth/session", { body }))).headers.get("set-cookie")!.split(";")[0];

const model = (json: unknown): LanguageModel => ({
  async generate() {
    const text = JSON.stringify(json);
    return { content: { role: "model", parts: [{ text }] }, text, functionCalls: [], usage: { input: 5, output: 5 }, model: "fake", latencyMs: 1 };
  },
});

let clin: string, alex: string;
beforeEach(async () => {
  process.env.APPLICATION_SECRET = "test-secret-0123456789abcdef";
  process.env.DEMO_MODE = "true";
  process.env.GEMINI_API_KEY = "x";
  resetRuntime();
  clin = await login({ role: "clinician" });
  alex = await login({ role: "patient", patientId: "p_alex" });
});
afterEach(() => setModelForTests(null));
const explain = (cookie: string) => call(explainPost, req("POST", "/api/visit/explain", { cookie, body: {} }));

describe("visit explainer", () => {
  it("says there is nothing to explain before a plan is approved, and is patient-only", async () => {
    expect((await explain(alex)).status).toBe(404);
    expect((await explain(clin)).status).toBe(403);
  });

  it("explains from the approved plan and removes any line the plan does not support", async () => {
    await call(seedPost, req("POST", "/api/demo/seed", { cookie: clin }));
    setModelForTests(model({
      summary: "Your doctor made a plan to help your knee recover.",
      whatToDo: ["Keep resting as your plan says.", "Heal in exactly 8888 days so don't worry."],
      medicines: [{ name: "Demo antibiotic", how: "Take it as the plan says." }],
      words: [{ term: "Dressing", meaning: "A covering placed over a wound." }, { term: "Fever", meaning: "A temperature above 77777." }],
      whenToCall: [],
      followUps: [],
    }));
    const r = await explain(alex);
    expect(r.status).toBe(200);
    const e = (await r.json()).data;
    expect(e.whatToDo).toEqual(["Keep resting as your plan says."]); // the invented number and the reassurance never reach the patient
    expect(e.words.map((w: { term: string }) => w.term)).toEqual(["Dressing"]);
    expect(e.removed).toBe(2);
    const runs = (await (await call(runsGet, req("GET", "/api/agent-runs", { cookie: clin }))).json()).data as { entries: { agent: string; title: string }[] }[];
    expect(runs[0].entries.some((x) => x.agent === "explainer" && x.title === "get_approved_care_plan")).toBe(true);
    expect(runs[0].entries.filter((x) => x.agent === "safety-check")).toHaveLength(2);
  });
});
