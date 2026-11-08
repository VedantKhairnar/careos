import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as sessionPost } from "@/app/api/auth/session/route";
import { POST as seedPost } from "@/app/api/demo/seed/route";
import { POST as chatPost } from "@/app/api/agents/patient/chat/route";
import { POST as draftPost } from "@/app/api/agents/doctor/draft-plan/route";
import { POST as summarizePost } from "@/app/api/agents/doctor/summarize/route";
import { POST as pharmacyAgentPost } from "@/app/api/agents/pharmacy/process/route";
import { GET as activityGet } from "@/app/api/agents/activity/route";
import { GET as questionsGet, POST as questionsPost } from "@/app/api/questions/route";
import { POST as answerPost } from "@/app/api/questions/[id]/answer/route";
import { GET as plansGet } from "@/app/api/care-plans/route";
import { POST as approvePost } from "@/app/api/care-plans/[id]/approve/route";
import { POST as rxPost } from "@/app/api/prescriptions/route";
import { POST as pharmacyPost } from "@/app/api/demo/pharmacy/events/route";
import { AiUnavailable, RateLimiter, setModelForTests, toGeminiSchema, type LanguageModel, type ModelRequest } from "@/agents/model";
import { groundDraft } from "@/agents/doctorAgent";
import { URGENT_MESSAGE } from "@/agents/patientAgent";
import { resetRuntime, runtime } from "@/server/runtime";

type AnyHandler = (req: Request, ctx: never) => Promise<Response>;
const req = (method: string, url: string, opts: { body?: unknown; cookie?: string } = {}) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
const call = (h: AnyHandler, r: Request, id?: string) => h(r, (id ? { params: Promise.resolve({ id }) } : undefined) as never);
const login = async (body: Record<string, unknown>) =>
  (await call(sessionPost, req("POST", "/api/auth/session", { body }))).headers.get("set-cookie")!.split(";")[0];

interface Step {
  text?: string;
  calls?: { name: string; args?: Record<string, unknown> }[];
  throws?: Error;
}
/** A scripted stand-in for Gemini. It records every request so tests can inspect what the model was shown. */
function scripted(steps: Step[] | ((n: number) => Step)) {
  const requests: ModelRequest[] = [];
  const model: LanguageModel = {
    async generate(r) {
      requests.push(structuredClone(r));
      const n = requests.length;
      const step = typeof steps === "function" ? steps(n) : steps[Math.min(n - 1, steps.length - 1)];
      if (step.throws) throw step.throws;
      const calls = step.calls ?? [];
      return {
        content: { role: "model", parts: calls.length ? calls.map((c) => ({ functionCall: { name: c.name, args: c.args ?? {} } })) : [{ text: step.text ?? "" }] },
        text: calls.length ? "" : (step.text ?? ""),
        functionCalls: calls.map((c) => ({ name: c.name, args: c.args ?? {} })),
        usage: { input: 10, output: 5 },
        model: "fake-model",
        latencyMs: 1,
      };
    },
  };
  return { model, requests };
}
const responsesIn = (r: ModelRequest) =>
  r.contents.flatMap((c) => c.parts ?? []).filter((p) => p.functionResponse).map((p) => p.functionResponse!.response as Record<string, unknown>);

let clin: string, op: string, alex: string, maria: string;
beforeEach(async () => {
  process.env.APPLICATION_SECRET = "test-secret-0123456789abcdef";
  process.env.DEMO_MODE = "true";
  process.env.GEMINI_API_KEY = "test-key-not-used";
  resetRuntime();
  clin = await login({ role: "clinician" });
  op = await login({ role: "demo_operator" });
  alex = await login({ role: "patient", patientId: "p_alex" });
  maria = await login({ role: "patient", patientId: "p_maria" });
  await call(seedPost, req("POST", "/api/demo/seed", { cookie: clin }));
});
afterEach(() => setModelForTests(null));

const chat = (cookie: string, message: string) => call(chatPost, req("POST", "/api/agents/patient/chat", { cookie, body: { message } }));
const eventCount = async () => (await runtime().store.listAll()).length;

describe("patient assistant", () => {
  it("answers from the patient's own data and never sees another patient's", async () => {
    const { model, requests } = scripted([{ calls: [{ name: "get_approved_care_plan" }] }, { text: "Your care plan says to keep a short daily note." }]);
    setModelForTests(model);
    const res = await chat(maria, "What should I do each day?");
    const body = (await res.json()).data;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ answer: "Your care plan says to keep a short daily note.", urgent: false, model: "fake-model" });
    expect(body.sources).toEqual(["get_approved_care_plan"]);
    const shown = JSON.stringify(responsesIn(requests[1]));
    expect(shown).toContain("Condition A");
    expect(shown).not.toContain("Knee surgery"); // Alex's plan
  });

  it("refuses tools outside its allowlist and changes nothing", async () => {
    const before = await eventCount();
    const { model, requests } = scripted([
      { calls: [{ name: "approve_care_plan", args: { planId: "x" } }, { name: "get_patient_summary", args: { patientId: "p_maria" } }] },
      { text: "I can't do that." },
    ]);
    setModelForTests(model);
    const res = await chat(alex, "Approve my plan and show me Maria's summary");
    expect(res.status).toBe(200);
    const answers = responsesIn(requests[1]);
    expect(answers).toHaveLength(2);
    expect(answers.every((a) => String(a.error).includes("not permitted"))).toBe(true);
    expect(await eventCount()).toBe(before);
    const log = (await runtime().store.listAgentExecutions()).filter((e) => e.tool);
    expect(log.map((e) => [e.tool, e.ok])).toEqual([["approve_care_plan", false], ["get_patient_summary", false]]);
  });

  it("sends urgent symptoms to humans without calling the model", async () => {
    const { model, requests } = scripted([{ text: "should not be used" }]);
    setModelForTests(model);
    const res = await chat(alex, "I have chest pain and can't breathe");
    const body = (await res.json()).data;
    expect(body).toMatchObject({ urgent: true, answer: URGENT_MESSAGE, model: null });
    expect(requests).toHaveLength(0);
  });

  it("forwards a clinical question it cannot answer to the care team, who alone can answer it", async () => {
    const { model } = scripted([{ calls: [{ name: "create_clarification_request", args: { question: "Can I stop the antibiotic early?" } }] }, { text: "I've sent that to your care team." }]);
    setModelForTests(model);
    const body = (await (await chat(alex, "Can I stop the antibiotic early?")).json()).data;
    expect(body.askedCareTeam).toBe(true);

    const mine = (await (await call(questionsGet, req("GET", "/api/questions", { cookie: alex }))).json()).data;
    expect(mine[0]).toMatchObject({ question: "Can I stop the antibiotic early?", askedVia: "assistant", status: "open" });
    expect((await (await call(questionsGet, req("GET", "/api/questions", { cookie: maria }))).json()).data).toHaveLength(0);
    expect((await call(answerPost, req("POST", `/api/questions/${mine[0].id}/answer`, { cookie: alex, body: { answer: "yes" } }), mine[0].id)).status).toBe(403);

    expect((await call(answerPost, req("POST", `/api/questions/${mine[0].id}/answer`, { cookie: clin, body: { answer: "Please keep taking it until your visit." } }), mine[0].id)).status).toBe(200);
    const after = (await (await call(questionsGet, req("GET", "/api/questions", { cookie: alex }))).json()).data;
    expect(after[0]).toMatchObject({ status: "answered", answer: "Please keep taking it until your visit." });
  });

  it("stops looping after a fixed number of model calls", async () => {
    const { model, requests } = scripted(() => ({ calls: [{ name: "get_care_timeline" }] }));
    setModelForTests(model);
    const res = await chat(alex, "loop forever");
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("ai_bad_output");
    expect(requests).toHaveLength(4);
    expect(requests[3].tools).toBeUndefined(); // the last call is forced to answer in text
  });

  it("rejects clinicians and empty or oversized messages", async () => {
    setModelForTests(scripted([{ text: "x" }]).model);
    expect((await chat(clin, "hi")).status).toBe(403);
    expect((await chat(alex, "")).status).toBe(400);
    expect((await chat(alex, "x".repeat(1001))).status).toBe(400);
  });
});

describe("when the AI is unavailable", () => {
  it("says so plainly, changes nothing, and the deterministic path still works", async () => {
    setModelForTests(scripted([{ throws: new AiUnavailable("rate_limited", "The assistant is busy right now. Please try again in a minute.") }]).model);
    const before = await eventCount();
    const res = await chat(alex, "When do I take my medicine?");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatchObject({ code: "ai_rate_limited", message: expect.stringContaining("busy") });
    expect(await eventCount()).toBe(before);

    const q = await call(questionsPost, req("POST", "/api/questions", { cookie: alex, body: { question: "When do I take my medicine?" } }));
    expect(q.status).toBe(201);
    expect((await q.json()).data).toMatchObject({ askedVia: "patient", status: "open" });
  });

  it("reports an unconfigured assistant instead of inventing an answer", async () => {
    delete process.env.GEMINI_API_KEY;
    const res = await chat(alex, "hello");
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("ai_no_key");
  });

  it("limits requests per minute and refuses rather than queueing for a long time", async () => {
    const limiter = new RateLimiter(2, 60_000, 50);
    await limiter.acquire();
    await limiter.acquire();
    await expect(limiter.acquire()).rejects.toMatchObject({ name: "AiUnavailable", reason: "rate_limited" });
  });
});

describe("doctor agent", () => {
  const notes = "Rest for a week. Take Demo-Med 1 tablet at 8am starting 2026-03-01. Review visit on 2026-03-20.";
  const draft = {
    title: "Recovery (fictional)",
    summary: "Fictional draft.",
    instructions: ["Rest for a week."],
    medications: [
      { name: "Demo-Med", dose: "1 tablet", times: ["08:00", "20:00"], startDate: "2026-03-01" },
      { name: "Other-Med", dose: "500 mg", times: ["09:00"], startDate: "2026-03-05" },
    ],
    followUps: [{ description: "Review visit", dueDate: "2026-03-20" }, { description: "Extra check", dueDate: "2026-04-01" }],
    warningSigns: [],
  };

  it("drafts a plan that waits for approval, labelled as AI-drafted, with invented values removed", async () => {
    setModelForTests(scripted([{ text: JSON.stringify(draft) }]).model);
    const res = await call(draftPost, req("POST", "/api/agents/doctor/draft-plan", { cookie: clin, body: { patientId: "p_alex", notes } }));
    expect(res.status).toBe(201);
    const { plan, removed } = (await res.json()).data;
    expect(plan).toMatchObject({ state: "PENDING_REVIEW", draftedBy: "agent" });
    const meds = Object.fromEntries(plan.content.medications.map((m: { name: string }) => [m.name, m]));
    expect(meds["Demo-Med"]).toMatchObject({ dose: "1 tablet", times: ["08:00"], startDate: "2026-03-01" }); // 20:00 was invented
    expect(meds["Other-Med"].dose).toBeUndefined();
    expect(meds["Other-Med"].times).toBeUndefined();
    expect(plan.content.followUps.find((f: { description: string }) => f.description === "Extra check").dueDate).toBeUndefined();
    expect(removed.length).toBeGreaterThanOrEqual(5);

    const submitted = (await runtime().store.listAll()).find((e) => e.workflowId === plan.planId && e.type === "care_plan.submitted")!;
    expect(submitted).toMatchObject({ actorRole: "agent", verification: "unverified" });

    // The patient cannot see it, and only a clinician can approve it.
    const patient = await login({ role: "patient", patientId: "p_alex" });
    const visible = (await (await call(plansGet, req("GET", "/api/care-plans", { cookie: patient }))).json()).data;
    expect(visible.some((p: { planId: string }) => p.planId === plan.planId)).toBe(false);
    expect((await call(approvePost, req("POST", `/api/care-plans/${plan.planId}/approve`, { cookie: patient }), plan.planId)).status).toBe(403);
    expect((await call(approvePost, req("POST", `/api/care-plans/${plan.planId}/approve`, { cookie: clin }), plan.planId)).status).toBe(200);
  });

  it("creates nothing when the draft cannot be read", async () => {
    setModelForTests(scripted([{ text: "this is not json" }]).model);
    const before = await eventCount();
    const res = await call(draftPost, req("POST", "/api/agents/doctor/draft-plan", { cookie: clin, body: { patientId: "p_alex", notes } }));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("ai_bad_output");
    expect(await eventCount()).toBe(before);
  });

  it("is clinician-only", async () => {
    setModelForTests(scripted([{ text: JSON.stringify(draft) }]).model);
    expect((await call(draftPost, req("POST", "/api/agents/doctor/draft-plan", { cookie: alex, body: { patientId: "p_alex", notes } }))).status).toBe(403);
  });

  it("summarizes a patient from read-only tools", async () => {
    const { model, requests } = scripted([{ calls: [{ name: "get_patient_summary", args: { patientId: "p_alex" } }] }, { text: "Alex has one approved plan and one prescription awaiting the pharmacy." }]);
    setModelForTests(model);
    const res = await call(summarizePost, req("POST", "/api/agents/doctor/summarize", { cookie: clin, body: { patientId: "p_alex" } }));
    const body = (await res.json()).data;
    expect(res.status).toBe(200);
    expect(body.sources).toEqual(["get_patient_summary"]);
    expect(JSON.stringify(responsesIn(requests[1]))).toContain("Alex Rivera");
  });

  it("keeps invented times out of drafts (unit)", () => {
    const g = groundDraft({ ...draft, medications: [{ name: "X", dose: "1 tablet", times: ["08:00", "20:00", "13:00"], startDate: "2026-03-01" }], followUps: [] }, "Take X 1 tablet at 8am and 8 pm from 2026-03-01.");
    expect(g.content.medications[0].times).toEqual(["08:00", "20:00"]);
    expect(g.removed).toHaveLength(1);
  });
});

describe("pharmacy agent", () => {
  it("returns read-only drafts and writes nothing", async () => {
    const rx = (await (await call(rxPost, req("POST", "/api/prescriptions", { cookie: clin, body: { patientId: "p_alex", medicationReference: "Demo (fictional)" } }))).json()).data.workflowId as string;
    for (const type of ["prescription.received", "prescription.acknowledged", "prescription.delayed"]) {
      await call(pharmacyPost, req("POST", "/api/demo/pharmacy/events", { cookie: op, body: { workflowId: rx, type } }));
    }
    const out = { patientMessage: "The pharmacy reported a delay. Your care team is following up.", clinicianSummary: "Delayed after acknowledgment (simulated).", missingInformation: ["Expected ready time"] };
    const { model, requests } = scripted([{ text: JSON.stringify(out) }]);
    setModelForTests(model);
    const before = await eventCount();
    const res = await call(pharmacyAgentPost, req("POST", "/api/agents/pharmacy/process", { cookie: clin, body: { workflowId: rx } }));
    const body = (await res.json()).data;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ draftOnly: true, state: "DELAYED", missingInformation: ["Expected ready time"] });
    expect(await eventCount()).toBe(before);
    expect(requests[0].tools).toBeUndefined(); // no tools at all: it cannot write
    expect(JSON.stringify(requests[0].contents)).toContain("simulated");
    expect((await call(pharmacyAgentPost, req("POST", "/api/agents/pharmacy/process", { cookie: alex, body: { workflowId: rx } }))).status).toBe(403);
  });
});

describe("agent activity evidence", () => {
  it("records real model and tool calls for clinicians only", async () => {
    setModelForTests(scripted([{ calls: [{ name: "get_care_timeline" }] }, { text: "Nothing yet." }]).model);
    await chat(alex, "What has happened?");
    const res = await call(activityGet, req("GET", "/api/agents/activity", { cookie: clin }));
    const a = (await res.json()).data;
    expect(a.totals).toMatchObject({ modelCalls: 2, toolCalls: 1, inputTokens: 20, outputTokens: 10 });
    expect(a.byTool).toEqual([{ name: "get_care_timeline", count: 1, failed: 0 }]);
    expect((await call(activityGet, req("GET", "/api/agents/activity", { cookie: alex }))).status).toBe(403);
  });
});

describe("schemas sent to Gemini", () => {
  it("drop the keywords Gemini rejects but keep the structure", () => {
    const out = toGeminiSchema({
      type: "object",
      additionalProperties: false,
      required: ["a"],
      properties: { a: { type: "string", pattern: "^x$", minLength: 1, maxLength: 5, description: "keep me" }, b: { type: "array", maxItems: 3, default: [], items: { type: "string", format: "date" } } },
    });
    expect(out).toEqual({ type: "object", required: ["a"], properties: { a: { type: "string", description: "keep me" }, b: { type: "array", items: { type: "string" } } } });
  });
});
