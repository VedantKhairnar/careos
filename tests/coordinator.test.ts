import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as sessionPost } from "@/app/api/auth/session/route";
import { POST as rxPost } from "@/app/api/prescriptions/route";
import { POST as pharmacyPost } from "@/app/api/demo/pharmacy/events/route";
import { GET as suggestionsGet } from "@/app/api/agent-suggestions/route";
import { POST as reviewPost } from "@/app/api/agent-suggestions/[id]/review/route";
import { GET as runsGet } from "@/app/api/agent-runs/route";
import { GET as notificationsGet } from "@/app/api/notifications/route";
import { deterministicChecks, runCoordinator } from "@/agents/coordinator";
import { clearRuns } from "@/agents/runLog";
import { setModelForTests, type LanguageModel } from "@/agents/model";
import { resetRuntime, runtime } from "@/server/runtime";

type AnyHandler = (req: Request, ctx: never) => Promise<Response>;
const req = (method: string, url: string, opts: { body?: unknown; cookie?: string } = {}) =>
  new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json", ...(opts.cookie ? { cookie: opts.cookie } : {}) }, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
const call = (h: AnyHandler, r: Request, id?: string) => h(r, (id ? { params: Promise.resolve({ id }) } : undefined) as never);
const login = async (body: Record<string, unknown>) => (await call(sessionPost, req("POST", "/api/auth/session", { body }))).headers.get("set-cookie")!.split(";")[0];

const GOOD = { patientMessage: "Your pharmacy reported a delay with your prescription. They did not say when it will be ready.", clinicianSummary: "The pharmacy reported a delay and gave no reason or time.", suggestedNextStep: "Call the pharmacy to ask for a time.", missingInformation: ["Reason", "Ready time"] };
const BAD = { ...GOOD, patientMessage: "Your prescription will be ready within 7777 hours, so don't worry." };

let wf = "";
type Call = { name: string; args: Record<string, unknown> };
const w = (name: string, extra: Record<string, unknown> = {}): Call => ({ name, args: { why: "test", workflowId: wf, patientId: "p_alex", ...extra } });

/** Scripted stand-in for Gemini. Routes by the agent's system prompt, so coordinator, writer and reviewer are separate. */
function world(o: { coordinator: (() => Call[] | string)[]; writer?: unknown[]; reviewer?: unknown[] }) {
  const n = { c: 0, w: 0, r: 0 };
  const model: LanguageModel = {
    async generate(r) {
      const sys = r.system;
      let text = "";
      let calls: Call[] = [];
      if (sys.includes("Care Coordinator")) {
        const step = (o.coordinator[Math.min(n.c++, o.coordinator.length - 1)] ?? (() => "done"))();
        if (typeof step === "string") text = step;
        else calls = step;
      } else if (sys.includes("Writer agent")) text = JSON.stringify(o.writer![Math.min(n.w++, o.writer!.length - 1)]);
      else text = JSON.stringify(o.reviewer?.[Math.min(n.r++, o.reviewer.length - 1)] ?? { approved: true, issues: [] });
      return {
        content: { role: "model", parts: calls.length ? calls.map((c) => ({ functionCall: { name: c.name, args: c.args } })) : [{ text }] },
        text: calls.length ? "" : text,
        functionCalls: calls,
        usage: { input: 10, output: 5 },
        model: "fake-model",
        latencyMs: 1,
      };
    },
  };
  return { model, n };
}
const HAPPY = [() => [w("get_prescription_history"), w("get_dose_timeline")], () => [w("delegate_to_writer", { focus: "delay" })], () => [w("request_safety_review")], () => [w("propose_actions", { urgency: "routine", urgencyReason: "No matching dose in the next day." })], () => "Proposed a routine follow-up."];

let clin: string, op: string, alex: string;
beforeEach(async () => {
  process.env.APPLICATION_SECRET = "test-secret-0123456789abcdef";
  process.env.DEMO_MODE = "true";
  process.env.GEMINI_API_KEY = "test-key-not-used";
  resetRuntime();
  clearRuns();
  clin = await login({ role: "clinician" });
  op = await login({ role: "demo_operator" });
  alex = await login({ role: "patient", patientId: "p_alex" });
});
afterEach(() => setModelForTests(null));

const until = async <T>(f: () => Promise<T | null | undefined | false>) => {
  for (let i = 0; i < 200; i++) {
    const v = await f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out");
};
const pharmacy = (workflowId: string, type: string) => call(pharmacyPost, req("POST", "/api/demo/pharmacy/events", { cookie: op, body: { workflowId, type } }));
type S = { id: string; status: string; urgency: string; log: { kind: string; agent: string; title: string; detail?: string }[]; patientMessage: string; safetyReviewRounds: number };
const list = async () => (await (await call(suggestionsGet, req("GET", "/api/agent-suggestions", { cookie: clin }))).json()).data as S[];
const first = async () => (await until(async () => ((await list()).length ? list() : null)))[0];

async function delayedRx() {
  wf = (await (await call(rxPost, req("POST", "/api/prescriptions", { cookie: clin, body: { patientId: "p_alex", medicationReference: "Demo-Antibiotic (fictional)" } }))).json()).data.workflowId as string;
  await pharmacy(wf, "prescription.received");
  await pharmacy(wf, "prescription.acknowledged");
}
const notes = async () => JSON.stringify(await (await call(notificationsGet, req("GET", "/api/notifications", { cookie: alex }))).json());

describe("care coordinator (event-driven, multi-agent)", () => {
  it("wakes on a delay, investigates, hands off, gets reviewed, proposes - and tells nobody", async () => {
    const m = world({ coordinator: HAPPY, writer: [GOOD] });
    setModelForTests(m.model);
    await delayedRx();
    expect(m.n.c).toBe(0); // routine events do not wake it
    await pharmacy(wf, "prescription.delayed");
    const s = await first();
    expect(s.status).toBe("pending");
    expect(s.urgency).toBe("routine");
    const steps = s.log.map((e) => `${e.agent}:${e.kind}`);
    expect(steps).toContain("coordinator:start");
    expect(steps).toContain("coordinator:tool");
    expect(steps).toContain("coordinator:handoff");
    expect(steps).toContain("writer:decision");
    expect(steps).toContain("safety-check:review");
    expect(steps).toContain("reviewer:review");
    expect(steps).toContain("coordinator:decision");
    expect(s.log.some((e) => e.title === "get_dose_timeline")).toBe(true);
    expect(await notes()).not.toContain("did not say when"); // a draft only
    const runs = (await (await call(runsGet, req("GET", "/api/agent-runs", { cookie: clin }))).json()).data as { status: string }[];
    expect(runs[0].status).toBe("awaiting_human");
  });

  it("is blocked by code from proposing before the safety review, and carries on", async () => {
    const script = [() => [w("propose_actions", { urgency: "routine", urgencyReason: "xxx" })], ...HAPPY];
    setModelForTests(world({ coordinator: script, writer: [GOOD] }).model);
    await delayedRx();
    await pharmacy(wf, "prescription.delayed");
    const s = await first();
    const blocked = s.log.find((e) => e.kind === "blocked");
    expect(blocked?.detail).toMatch(/no draft|safety review/);
    expect(s.log.at(-1)?.kind).not.toBe("error");
  });

  it("rejects an invented time and reassurance, makes the writer revise, then approves", async () => {
    const script = [() => [w("get_prescription_history")], () => [w("delegate_to_writer", { focus: "delay" })], () => [w("request_safety_review")], () => [w("delegate_to_writer", { focus: "fix issues" })], () => [w("request_safety_review")], () => [w("propose_actions", { urgency: "routine", urgencyReason: "fine" })], () => "done"];
    setModelForTests(world({ coordinator: script, writer: [BAD, GOOD] }).model);
    await delayedRx();
    await pharmacy(wf, "prescription.delayed");
    const s = await first();
    const reviews = s.log.filter((e) => e.agent === "reviewer").map((e) => e.title);
    expect(reviews).toEqual(["Gemini call", "Rejected by the Safety Reviewer", "Gemini call", "Approved by the Safety Reviewer"].filter((t) => reviews.includes(t)));
    expect(s.log.some((e) => e.title === "Code checks FAILED" && /7777/.test(e.detail ?? "") && /reassurance/.test(e.detail ?? ""))).toBe(true);
    expect(s.safetyReviewRounds).toBe(2);
    expect(s.patientMessage).toBe(GOOD.patientMessage); // the unsafe wording never reaches the clinician
  });

  it("refuses 'time sensitive' when the dose timeline does not support it", async () => {
    const script = [() => [w("get_dose_timeline")], () => [w("delegate_to_writer", { focus: "delay" })], () => [w("request_safety_review")], () => [w("propose_actions", { urgency: "time_sensitive", urgencyReason: "feels urgent" })], () => [w("propose_actions", { urgency: "routine", urgencyReason: "no dose in 24h" })], () => "done"];
    setModelForTests(world({ coordinator: script, writer: [GOOD] }).model);
    await delayedRx();
    await pharmacy(wf, "prescription.delayed");
    const s = await first();
    expect(s.log.find((e) => e.kind === "blocked")?.detail).toMatch(/not supported by the dose timeline/);
    expect(s.urgency).toBe("routine");
  });

  it("reaches the patient only after a clinician approves, using the clinician's wording; the patient cannot review", async () => {
    setModelForTests(world({ coordinator: HAPPY, writer: [GOOD] }).model);
    await delayedRx();
    await pharmacy(wf, "prescription.delayed");
    const s = await first();
    expect((await call(reviewPost, req("POST", `/api/agent-suggestions/${s.id}/review`, { cookie: alex, body: { decision: "approve" } }), s.id)).status).toBe(403);
    expect((await call(reviewPost, req("POST", `/api/agent-suggestions/${s.id}/review`, { cookie: clin, body: { decision: "approve", message: "We are calling your pharmacy today." } }), s.id)).status).toBe(200);
    expect(await notes()).toContain("We are calling your pharmacy today.");
    const after = await first();
    expect(after.status).toBe("sent");
    expect(after.log.at(-1)?.agent).toBe("clinician");
    expect(((await (await call(reviewPost, req("POST", `/api/agent-suggestions/${s.id}/review`, { cookie: clin, body: { decision: "dismiss" } }), s.id)).json()).data).alreadyReviewed).toBe(true);
  });

  it("a model failure creates no draft, logs the failure and never blocks the pharmacy event", async () => {
    setModelForTests({ generate: async () => { throw new Error("boom"); } });
    await delayedRx();
    expect((await pharmacy(wf, "prescription.delayed")).status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(await list()).toHaveLength(0);
    const runs = (await (await call(runsGet, req("GET", "/api/agent-runs", { cookie: clin }))).json()).data as { status: string; entries: { kind: string }[] }[];
    expect(runs[0].status).toBe("failed");
    expect(runs[0].entries.some((e) => e.kind === "error")).toBe(true);
  });

  it("runs once per triggering event", async () => {
    const m = world({ coordinator: HAPPY, writer: [GOOD] });
    setModelForTests(m.model);
    await delayedRx();
    await pharmacy(wf, "prescription.delayed");
    await first();
    const before = m.n.c;
    const ev = (await runtime().store.listByWorkflow(wf)).find((e) => e.type === "prescription.delayed")!;
    expect((await runCoordinator({ workflowId: wf, patientId: "p_alex", triggerEventId: ev.eventId, triggerType: ev.type })).created).toBe(false);
    expect(m.n.c).toBe(before);
  });
});

describe("deterministic safety checks", () => {
  const facts = { prescription: { medication: "X", note: "none" }, hours: 3.4 };
  it("passes plain wording", () => expect(deterministicChecks(GOOD, facts)).toEqual([]));
  it("flags numbers not in the records, ids, timestamps and reassurance", () => {
    const issues = deterministicChecks({ ...GOOD, patientMessage: "Ready in 48 hours (rx_ab12cd34 at 2026-11-08T10:00). Don't worry." }, facts).join(" | ");
    expect(issues).toMatch(/"48"/);
    expect(issues).toMatch(/internal id/);
    expect(issues).toMatch(/advice or reassurance/);
  });
  it("allows numbers that appear in the records", () => expect(deterministicChecks({ ...GOOD, clinicianSummary: "Next dose in about 3 hours." }, facts)).toEqual([]));
});
