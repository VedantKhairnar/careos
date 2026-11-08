import { beforeEach, describe, expect, it } from "vitest";
import { POST as sessionPost } from "@/app/api/auth/session/route";
import { POST as seedPost } from "@/app/api/demo/seed/route";
import { POST as rxPost } from "@/app/api/prescriptions/route";
import { POST as pharmacyPost } from "@/app/api/demo/pharmacy/events/route";
import { POST as askPost } from "@/app/api/questions/route";
import { POST as answerPost } from "@/app/api/questions/[id]/answer/route";
import { POST as readingPost } from "@/app/api/readings/route";
import { GET as activityGet } from "@/app/api/activity/route";
import { clearRuns } from "@/agents/runLog";
import { resetRuntime } from "@/server/runtime";
import type { LogEntry } from "@/agents/runLog";

type H = (req: Request, ctx: never) => Promise<Response>;
const req = (m: string, u: string, o: { body?: unknown; cookie?: string } = {}) => new Request(`http://localhost${u}`, { method: m, headers: { "content-type": "application/json", ...(o.cookie ? { cookie: o.cookie } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
const call = (h: H, r: Request, id?: string) => h(r, (id ? { params: Promise.resolve({ id }) } : undefined) as never);
const login = async (b: Record<string, unknown>) => (await call(sessionPost, req("POST", "/api/auth/session", { body: b }))).headers.get("set-cookie")!.split(";")[0];

let clin: string, op: string, alex: string;
beforeEach(async () => {
  process.env.APPLICATION_SECRET = "test-secret-0123456789abcdef";
  process.env.DEMO_MODE = "true";
  delete process.env.GEMINI_API_KEY; // no model: background agents fail quietly and the log says so
  delete process.env.AWS_ACCESS_KEY_ID;
  resetRuntime();
  clearRuns();
  clin = await login({ role: "clinician" });
  op = await login({ role: "demo_operator" });
  alex = await login({ role: "patient", patientId: "p_alex" });
});
const feed = async (cookie: string) => (await (await call(activityGet, req("GET", "/api/activity", { cookie }))).json()).data as { entries: LogEntry[]; running: boolean };

describe("activity feed: people, system and agents in one timeline", () => {
  it("shows what the doctor, patient, pharmacy and system did, not only the agents", async () => {
    await call(seedPost, req("POST", "/api/demo/seed", { cookie: clin }));
    const wf = (await (await call(rxPost, req("POST", "/api/prescriptions", { cookie: clin, body: { patientId: "p_alex", medicationReference: "Antibiotic" } }))).json()).data.workflowId as string;
    for (const type of ["prescription.received", "prescription.acknowledged", "prescription.delayed"]) await call(pharmacyPost, req("POST", "/api/demo/pharmacy/events", { cookie: op, body: { workflowId: wf, type } }));
    const q = (await (await call(askPost, req("POST", "/api/questions", { cookie: alex, body: { question: "Can I take it with food?" } }))).json()).data.id as string;
    await call(answerPost, req("POST", `/api/questions/${q}/answer`, { cookie: clin, body: { answer: "Yes." } }), q);
    await call(readingPost, req("POST", "/api/readings", { cookie: alex, body: { metric: "heart_rate", value: 80 } }));
    await new Promise((r) => setTimeout(r, 150));

    const { entries } = await feed(clin);
    const has = (agent: string, title: RegExp) => entries.some((e) => e.agent === agent && title.test(e.title));
    expect(has("doctor", /Approved the care plan/)).toBe(true);
    expect(has("doctor", /Authorized a prescription/)).toBe(true);
    expect(has("orchestrator", /Sent the prescription to the pharmacy/)).toBe(true);
    expect(has("pharmacy", /Received the prescription/)).toBe(true);
    expect(has("pharmacy", /Acknowledged it/)).toBe(true);
    expect(has("pharmacy", /Reported a delay/)).toBe(true);
    expect(has("orchestrator", /Told the patient/)).toBe(true);
    expect(has("patient", /Asked the care team a question/)).toBe(true);
    expect(has("doctor", /Answered the patient's question/)).toBe(true);
    expect(has("patient", /Added a home reading/)).toBe(true);
    // The delay also woke the agents; with no model configured the log says so honestly.
    expect(entries.some((e) => e.agent === "coordinator" && e.kind === "start")).toBe(true);
    expect(entries.some((e) => e.kind === "error")).toBe(true);
    // Oldest first, numbered, and nothing is shown twice.
    expect(entries.map((e) => e.at)).toEqual([...entries.map((e) => e.at)].sort());
    expect(new Set(entries.map((e) => e.n)).size).toBe(entries.length);
  });

  it("is for the doctor and the demo operator only, and never shows another patient's identity to a patient", async () => {
    expect((await call(activityGet, req("GET", "/api/activity", { cookie: alex }))).status).toBe(403);
    expect((await call(activityGet, req("GET", "/api/activity"))).status).toBe(401);
    expect((await call(activityGet, req("GET", "/api/activity", { cookie: op }))).status).toBe(200);
  });
});
