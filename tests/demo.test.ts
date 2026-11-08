import { beforeEach, describe, expect, it } from "vitest";
import { POST as sessionPost } from "@/app/api/auth/session/route";
import { GET as gapsGet } from "@/app/api/care-gaps/route";
import { GET as clockGet, POST as clockPost } from "@/app/api/demo/clock/route";
import { POST as pharmacyPost } from "@/app/api/demo/pharmacy/events/route";
import { GET as workflowsGet } from "@/app/api/demo/pharmacy/workflows/route";
import { GET as notifsGet } from "@/app/api/notifications/route";
import { POST as ackPost } from "@/app/api/notifications/[id]/acknowledge/route";
import { POST as actionsPost } from "@/app/api/prescriptions/[id]/actions/route";
import { POST as rxPost } from "@/app/api/prescriptions/route";
import { POST as plansPost } from "@/app/api/care-plans/route";
import { resetRuntime } from "@/server/runtime";

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

let clin: string, op: string, pat: string;
beforeEach(async () => {
  process.env.APPLICATION_SECRET = "test-secret-0123456789abcdef";
  process.env.DEMO_MODE = "true";
  resetRuntime();
  clin = await login({ role: "clinician" });
  op = await login({ role: "demo_operator" });
  pat = await login({ role: "patient", patientId: "p1" });
});

const advance = (m: number) => call(clockPost, req("POST", "/api/demo/clock", { cookie: op, body: { advanceMinutes: m } }));
const send = (workflowId: string, type: string) => call(pharmacyPost, req("POST", "/api/demo/pharmacy/events", { cookie: op, body: { workflowId, type } }));
const gaps = async (cookie = clin) => (await (await call(gapsGet, req("GET", "/api/care-gaps", { cookie }))).json()).data.gaps as { rule: string; responsible: string; sinceAt: string }[];
async function prescribe() {
  const res = await call(rxPost, req("POST", "/api/prescriptions", { cookie: clin, body: { patientId: "p1", medicationReference: "Demo (fictional)" } }));
  return (await res.json()).data.workflowId as string;
}

describe("demo clock", () => {
  it("is operator-only to change, and visible to the clinician", async () => {
    expect((await call(clockPost, req("POST", "/api/demo/clock", { cookie: clin, body: { advanceMinutes: 5 } }))).status).toBe(403);
    expect((await call(clockPost, req("POST", "/api/demo/clock", { body: { advanceMinutes: 5 } }))).status).toBe(401);
    await advance(45);
    expect((await (await call(clockGet, req("GET", "/api/demo/clock", { cookie: clin }))).json()).data.offsetMinutes).toBe(45);
    await call(clockPost, req("POST", "/api/demo/clock", { cookie: op, body: { reset: true } }));
    expect((await (await call(clockGet, req("GET", "/api/demo/clock", { cookie: op }))).json()).data.offsetMinutes).toBe(0);
  });
  it("rejects nonsense amounts", async () => {
    expect((await advance(-5)).status).toBe(400);
    expect((await advance(999999)).status).toBe(400);
  });
  it("does not exist outside demo mode", async () => {
    process.env.DEMO_MODE = "false";
    expect((await call(clockGet, req("GET", "/api/demo/clock", { cookie: clin }))).status).toBe(404);
  });
});

describe("care gaps over the API", () => {
  it("shows nothing until a deadline passes, then flags a missing pharmacy acknowledgment", async () => {
    await prescribe();
    expect(await gaps()).toHaveLength(0);
    await advance(60);
    const g = await gaps();
    expect(g.map((x) => x.rule)).toEqual(["pharmacy_ack_overdue"]);
    expect(g[0].responsible).toBe("clinician");
    expect(g[0].sinceAt).toEqual(expect.any(String));
  });

  it("closes the gap by itself once the pharmacy acknowledges", async () => {
    const id = await prescribe();
    await advance(60);
    expect(await gaps()).toHaveLength(1);
    await send(id, "prescription.received");
    await send(id, "prescription.acknowledged");
    expect(await gaps()).toHaveLength(0);
  });

  it("flags an unaddressed delay and clears it when the clinician logs a follow-up", async () => {
    const id = await prescribe();
    for (const t of ["prescription.received", "prescription.acknowledged", "prescription.delayed"]) await send(id, t);
    await advance(90);
    expect((await gaps()).map((x) => x.rule)).toContain("delay_unaddressed");
    expect((await call(actionsPost, req("POST", `/api/prescriptions/${id}/actions`, { cookie: clin, body: { action: "followup_completed" } }), id)).status).toBe(200);
    expect((await gaps()).map((x) => x.rule)).not.toContain("delay_unaddressed");
  });

  it("flags an unresolved pharmacy question until the clinician resolves it", async () => {
    const id = await prescribe();
    for (const t of ["prescription.received", "prescription.acknowledged", "prescription.clarification_requested"]) await send(id, t);
    await advance(150);
    expect((await gaps()).map((x) => x.rule)).toContain("clarification_unresolved");
    await call(actionsPost, req("POST", `/api/prescriptions/${id}/actions`, { cookie: clin, body: { action: "resolve_clarification" } }), id);
    expect((await gaps()).map((x) => x.rule)).not.toContain("clarification_unresolved");
  });

  it("flags an update the patient never acknowledged, and clears it when they do", async () => {
    const id = await prescribe();
    for (const t of ["prescription.received", "prescription.acknowledged", "prescription.processing", "prescription.ready"]) await send(id, t);
    await advance(300);
    const mine = await gaps(pat);
    expect(mine.map((x) => x.rule)).toContain("notification_unacknowledged");
    expect(mine.find((x) => x.rule === "notification_unacknowledged")!.responsible).toBe("patient");

    const list = (await (await call(notifsGet, req("GET", "/api/notifications", { cookie: pat }))).json()).data.notifications as { id: string; title: string }[];
    const ready = list.find((n) => n.title === "Ready for pickup")!;
    await call(ackPost, req("POST", `/api/notifications/${ready.id}/acknowledge`, { cookie: pat }), ready.id);
    expect((await gaps(pat)).map((x) => x.rule)).not.toContain("notification_unacknowledged");
  });

  it("lists only prescriptions (not care plans) in the simulator, and only for the operator", async () => {
    await prescribe();
    await call(plansPost, req("POST", "/api/care-plans", { cookie: clin, body: { patientId: "p1", content: { title: "T", summary: "S" } } }));
    const rows = (await (await call(workflowsGet, req("GET", "/api/demo/pharmacy/workflows", { cookie: op }))).json()).data.workflows;
    expect(rows).toHaveLength(1);
    expect((await call(workflowsGet, req("GET", "/api/demo/pharmacy/workflows", { cookie: clin }))).status).toBe(403);
  });
});
