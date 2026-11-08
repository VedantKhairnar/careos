import { beforeEach, describe, expect, it } from "vitest";
import { POST as sessionPost } from "@/app/api/auth/session/route";
import { POST as seedPost } from "@/app/api/demo/seed/route";
import { GET as visitGet } from "@/app/api/visit/route";
import { POST as pharmacyPost } from "@/app/api/demo/pharmacy/events/route";
import { resetRuntime, runtime } from "@/server/runtime";
import type { VisitView } from "@/server/visit";

type AnyHandler = (req: Request, ctx: never) => Promise<Response>;
const req = (method: string, url: string, opts: { body?: unknown; cookie?: string } = {}) =>
  new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json", ...(opts.cookie ? { cookie: opts.cookie } : {}) }, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
const call = (h: AnyHandler, r: Request) => h(r, undefined as never);
const login = async (body: Record<string, unknown>) => (await call(sessionPost, req("POST", "/api/auth/session", { body }))).headers.get("set-cookie")!.split(";")[0];

let clin: string, op: string, alex: string, maria: string;
beforeEach(async () => {
  process.env.APPLICATION_SECRET = "test-secret-0123456789abcdef";
  process.env.DEMO_MODE = "true";
  resetRuntime();
  clin = await login({ role: "clinician" });
  op = await login({ role: "demo_operator" });
  alex = await login({ role: "patient", patientId: "p_alex" });
  maria = await login({ role: "patient", patientId: "p_maria" });
});
const visit = async (cookie: string, q = "") => {
  const r = await call(visitGet, req("GET", `/api/visit${q}`, { cookie }));
  return { status: r.status, data: (await r.json()).data as VisitView | null };
};

describe("last visit", () => {
  it("is empty before any plan is approved", async () => {
    expect((await visit(alex)).data).toBeNull();
  });

  it("follows the prescription from sent to picked up, and flags a delay as needing attention", async () => {
    await call(seedPost, req("POST", "/api/demo/seed", { cookie: clin }));
    const a = (await visit(alex)).data!;
    expect(a.planTitle).toMatch(/knee/i);
    expect(a.steps.map((s) => s.state)).toEqual(["done", "done", "done", "current", "upcoming", "upcoming"]);
    expect(a.progress).toEqual({ done: 3, total: 6 });
    const wf = (await runtime().store.listAll()).find((e) => e.patientId === "p_alex" && e.type === "prescription.authorized")!.workflowId;
    const step = (type: string) => call(pharmacyPost, req("POST", "/api/demo/pharmacy/events", { cookie: op, body: { workflowId: wf, type } }));
    await step("prescription.received");
    await step("prescription.acknowledged");
    expect((await visit(alex)).data!.steps[3]).toMatchObject({ state: "done", label: "Pharmacy confirmed" });
    await step("prescription.delayed");
    const d = (await visit(alex)).data!;
    expect(d.steps[3]).toMatchObject({ state: "problem", label: "Pharmacy reported a delay" });
    expect(d.next).toMatch(/care team has been told/i);
    await step("prescription.processing");
    await step("prescription.ready");
    await step("prescription.picked_up");
    const done = (await visit(alex)).data!;
    expect(done.progress).toEqual({ done: 6, total: 6 });
    expect(done.next).toMatch(/all set/i);
  });

  it("a patient only ever sees their own visit; a clinician must name the patient", async () => {
    await call(seedPost, req("POST", "/api/demo/seed", { cookie: clin }));
    const asMaria = (await visit(maria, "?patientId=p_alex")).data!; // the parameter is ignored for patients
    expect(asMaria.planTitle).not.toMatch(/knee/i);
    expect((await visit(clin)).status).toBe(400);
    expect((await visit(clin, "?patientId=p_alex")).data!.planTitle).toMatch(/knee/i);
    expect((await visit(op)).status).toBe(403);
  });

  it("describes assistant activity safely: a draft nobody approved is never quoted to the patient", async () => {
    await call(seedPost, req("POST", "/api/demo/seed", { cookie: clin }));
    const store = runtime().store;
    const rx = (await store.listAll()).find((e) => e.patientId === "p_alex" && e.type === "prescription.authorized")!;
    const now = new Date().toISOString();
    await store.append({ eventId: "e-sugg", workflowId: rx.workflowId, patientId: "p_alex", type: "agent.suggestion_created", actorId: "agent:coordinator", actorRole: "agent", sourceSystem: "care-coordinator", occurredAt: now, recordedAt: now, payload: { suggestionId: "s1", patientMessage: "SECRET-UNAPPROVED-DRAFT", clinicianSummary: "SECRET-SUMMARY" }, verification: "unverified", simulated: true, correlationId: "c", idempotencyKey: "k-sugg" });
    const raw = JSON.stringify((await visit(alex)).data);
    expect(raw).toContain("preparing a note for your doctor");
    expect(raw).not.toContain("SECRET");
  });
});
