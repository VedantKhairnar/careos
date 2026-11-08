import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as sessionPost } from "@/app/api/auth/session/route";
import { POST as rxPost } from "@/app/api/prescriptions/route";
import { POST as pharmacyPost } from "@/app/api/demo/pharmacy/events/route";
import { GET as suggestionsGet } from "@/app/api/agent-suggestions/route";
import { POST as reviewPost } from "@/app/api/agent-suggestions/[id]/review/route";
import { GET as notificationsGet } from "@/app/api/notifications/route";
import { setModelForTests, type LanguageModel } from "@/agents/model";
import { resetRuntime, runtime } from "@/server/runtime";

type AnyHandler = (req: Request, ctx: never) => Promise<Response>;
const req = (method: string, url: string, opts: { body?: unknown; cookie?: string } = {}) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
const call = (h: AnyHandler, r: Request, id?: string) => h(r, (id ? { params: Promise.resolve({ id }) } : undefined) as never);
const login = async (body: Record<string, unknown>) => (await call(sessionPost, req("POST", "/api/auth/session", { body }))).headers.get("set-cookie")!.split(";")[0];

const DRAFT = JSON.stringify({
  patientMessage: "Your pharmacy reported a delay with your prescription. They did not give a new time.",
  clinicianSummary: "The pharmacy reported a delay. No reason or time was given.",
  suggestedNextStep: "Call the pharmacy to ask for a time.",
  missingInformation: ["Reason for the delay", "New ready time"],
});

/** Scripted model: the first call uses the history tool, the second returns the JSON draft. */
function fake(): { model: LanguageModel; calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    model: {
      async generate() {
        n++;
        const useTool = n % 2 === 1;
        return {
          content: { role: "model", parts: useTool ? [{ functionCall: { name: "get_prescription_history", args: { workflowId: currentWorkflow } } }] : [{ text: DRAFT }] },
          text: useTool ? "" : DRAFT,
          functionCalls: useTool ? [{ name: "get_prescription_history", args: { workflowId: currentWorkflow } }] : [],
          usage: { input: 10, output: 5 },
          model: "fake-model",
          latencyMs: 1,
        };
      },
    },
  };
}
let currentWorkflow = "";

let clin: string, op: string, alex: string;
beforeEach(async () => {
  process.env.APPLICATION_SECRET = "test-secret-0123456789abcdef";
  process.env.DEMO_MODE = "true";
  process.env.GEMINI_API_KEY = "test-key-not-used";
  resetRuntime();
  clin = await login({ role: "clinician" });
  op = await login({ role: "demo_operator" });
  alex = await login({ role: "patient", patientId: "p_alex" });
});
afterEach(() => setModelForTests(null));

const until = async <T>(f: () => Promise<T | null | undefined | false>) => {
  for (let i = 0; i < 100; i++) {
    const v = await f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out");
};
const pharmacy = (workflowId: string, type: string) => call(pharmacyPost, req("POST", "/api/demo/pharmacy/events", { cookie: op, body: { workflowId, type } }));
const list = async () => (await (await call(suggestionsGet, req("GET", "/api/agent-suggestions", { cookie: clin }))).json()).data as { id: string; status: string; trace: { kind: string; name: string }[]; patientMessage: string }[];

async function delayedRx() {
  const w = (await (await call(rxPost, req("POST", "/api/prescriptions", { cookie: clin, body: { patientId: "p_alex", medicationReference: "Demo-Antibiotic (fictional)" } }))).json()).data.workflowId as string;
  currentWorkflow = w;
  await pharmacy(w, "prescription.received");
  await pharmacy(w, "prescription.acknowledged");
  return w;
}

describe("fulfilment agent (event-driven)", () => {
  it("wakes on a pharmacy delay by itself, uses a tool, and only drafts", async () => {
    const f = fake();
    setModelForTests(f.model);
    const w = await delayedRx();
    expect(f.calls()).toBe(0); // routine events do not wake it
    const stateBefore = (await runtime().store.listByWorkflow(w)).map((e) => e.type);
    await pharmacy(w, "prescription.delayed");
    const [s] = await until(async () => {
      const l = await list();
      return l.length ? l : null;
    });
    expect(s.status).toBe("pending");
    expect(s.trace.map((t) => `${t.kind}:${t.name}`)).toEqual(["model:fake-model", "tool:get_prescription_history", "model:fake-model"]);
    // It wrote a draft and nothing else: no extra prescription transition, no notification to the patient yet.
    const after = (await runtime().store.listByWorkflow(w)).map((e) => e.type);
    expect(after.filter((t) => !stateBefore.includes(t))).toEqual(["prescription.delayed", "notification.sent", "agent.suggestion_created"].filter((t) => after.includes(t as never)));
    const mine = await (await call(notificationsGet, req("GET", "/api/notifications", { cookie: alex }))).json();
    expect(JSON.stringify(mine)).not.toContain("did not give a new time");
    const log = await runtime().store.listAgentExecutions();
    expect(log.some((e) => e.agent === "pharmacy" && e.tool === "get_prescription_history" && e.ok)).toBe(true);
  });

  it("reaches the patient only after a clinician approves; the patient cannot review", async () => {
    setModelForTests(fake().model);
    const w = await delayedRx();
    await pharmacy(w, "prescription.delayed");
    const [s] = await until(async () => {
      const l = await list();
      return l.length ? l : null;
    });
    expect((await call(reviewPost, req("POST", `/api/agent-suggestions/${s.id}/review`, { cookie: alex, body: { decision: "approve" } }), s.id)).status).toBe(403);
    const ok = await call(reviewPost, req("POST", `/api/agent-suggestions/${s.id}/review`, { cookie: clin, body: { decision: "approve", message: "Your pharmacy is late. We are calling them today." } }), s.id);
    expect(ok.status).toBe(200);
    expect((await list())[0].status).toBe("sent");
    const n = JSON.stringify(await (await call(notificationsGet, req("GET", "/api/notifications", { cookie: alex }))).json());
    expect(n).toContain("We are calling them today."); // the clinician's edited wording, not the agent's
    // Reviewing again changes nothing.
    const again = await (await call(reviewPost, req("POST", `/api/agent-suggestions/${s.id}/review`, { cookie: clin, body: { decision: "dismiss" } }), s.id)).json();
    expect(again.data.alreadyReviewed).toBe(true);
  });

  it("a model failure creates no draft and does not block the pharmacy event", async () => {
    setModelForTests({ generate: async () => { throw new Error("boom"); } });
    const w = await delayedRx();
    const r = await pharmacy(w, "prescription.delayed");
    expect(r.status).toBe(200);
    await new Promise((res) => setTimeout(res, 100));
    expect(await list()).toHaveLength(0);
  });

  it("is idempotent per triggering event", async () => {
    const f = fake();
    setModelForTests(f.model);
    const w = await delayedRx();
    await pharmacy(w, "prescription.delayed");
    await until(async () => ((await list()).length ? true : null));
    const n = f.calls();
    const ev = (await runtime().store.listByWorkflow(w)).find((e) => e.type === "prescription.delayed")!;
    const { runFulfilmentAgent } = await import("@/agents/fulfilmentAgent");
    expect((await runFulfilmentAgent({ workflowId: w, patientId: "p_alex", triggerEventId: ev.eventId, triggerType: ev.type })).created).toBe(false);
    expect(f.calls()).toBe(n);
  });
});
