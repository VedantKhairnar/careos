import { beforeEach, describe, expect, it } from "vitest";
import { POST as sessionPost } from "@/app/api/auth/session/route";
import { POST as seedPost } from "@/app/api/demo/seed/route";
import { POST as resetPost } from "@/app/api/demo/reset/route";
import { GET as clockGet, POST as clockPost } from "@/app/api/demo/clock/route";
import { GET as plansGet } from "@/app/api/care-plans/route";
import { GET as rxGet } from "@/app/api/prescriptions/route";
import { GET as questionsGet, POST as questionsPost } from "@/app/api/questions/route";
import { GET as notifsGet } from "@/app/api/notifications/route";
import { GET as activityGet } from "@/app/api/agents/activity/route";
import { GET as patientsGet } from "@/app/api/patients/route";
import { resetRuntime, runtime } from "@/server/runtime";

type AnyHandler = (req: Request, ctx: never) => Promise<Response>;
const req = (method: string, url: string, opts: { body?: unknown; cookie?: string } = {}) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
const call = (h: AnyHandler, r: Request) => h(r, undefined as never);
const login = async (body: Record<string, unknown>) =>
  (await call(sessionPost, req("POST", "/api/auth/session", { body }))).headers.get("set-cookie")!.split(";")[0];

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

const data = async (h: AnyHandler, cookie: string, url: string) => (await (await call(h, req("GET", url, { cookie }))).json()).data;

describe("Start afresh", () => {
  async function populate() {
    await call(seedPost, req("POST", "/api/demo/seed", { cookie: clin }));
    await call(questionsPost, req("POST", "/api/questions", { cookie: alex, body: { question: "A question?" } }));
    await call(clockPost, req("POST", "/api/demo/clock", { cookie: op, body: { advanceMinutes: 90 } }));
  }

  it("clears every kind of live demo activity and returns the demo clock to real time", async () => {
    await populate();
    expect((await data(plansGet, maria, "/api/care-plans")).length).toBe(2);
    expect((await data(rxGet, clin, "/api/prescriptions")).length).toBeGreaterThan(0);
    expect((await data(questionsGet, alex, "/api/questions")).length).toBe(1);
    expect((await data(notifsGet, alex, "/api/notifications")).notifications.length).toBeGreaterThan(0);

    const res = await call(resetPost, req("POST", "/api/demo/reset", { cookie: op }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ cleared: true, keptSyntheticHistory: true, events: expect.any(Number) });

    expect(await data(plansGet, maria, "/api/care-plans")).toEqual([]);
    expect(await data(plansGet, alex, "/api/care-plans")).toEqual([]);
    expect(await data(rxGet, clin, "/api/prescriptions")).toEqual([]);
    expect(await data(questionsGet, alex, "/api/questions")).toEqual([]);
    expect((await data(notifsGet, alex, "/api/notifications")).notifications).toEqual([]);
    expect((await data(activityGet, clin, "/api/agents/activity")).totals.executions).toBe(0);
    expect((await data(clockGet, op, "/api/demo/clock")).offsetMinutes).toBe(0);
    expect(await runtime().store.listAll()).toEqual([]);
  });

  it("leaves Alex and Maria in place, just with nothing assigned", async () => {
    await populate();
    await call(resetPost, req("POST", "/api/demo/reset", { cookie: op }));
    const patients = await data(patientsGet, clin, "/api/patients");
    expect(patients.map((p: { displayName: string }) => p.displayName)).toEqual(["Alex Rivera", "Maria Santos"]);
    expect(patients.every((p: { plansApproved: number; prescriptions: unknown[] }) => p.plansApproved === 0 && p.prescriptions.length === 0)).toBe(true);
  });

  it("lets the same demo run again afterwards (the same actions are not blocked as duplicates)", async () => {
    await populate();
    await call(resetPost, req("POST", "/api/demo/reset", { cookie: op }));
    expect((await call(seedPost, req("POST", "/api/demo/seed", { cookie: clin }))).status).toBe(200);
    expect((await data(plansGet, maria, "/api/care-plans")).length).toBe(2);
  });

  it("can be pressed twice in a row and on an already empty demo", async () => {
    expect((await call(resetPost, req("POST", "/api/demo/reset", { cookie: op }))).status).toBe(200);
    expect((await call(resetPost, req("POST", "/api/demo/reset", { cookie: op }))).status).toBe(200);
  });

  it("is only for the demo operator, and does not exist outside demo mode", async () => {
    await populate();
    for (const cookie of [clin, alex]) expect((await call(resetPost, req("POST", "/api/demo/reset", { cookie }))).status).toBe(403);
    expect((await call(resetPost, req("POST", "/api/demo/reset"))).status).toBe(401);
    expect((await runtime().store.listAll()).length).toBeGreaterThan(0); // nothing was deleted by the refused calls
    process.env.DEMO_MODE = "false";
    expect((await call(resetPost, req("POST", "/api/demo/reset", { cookie: op }))).status).toBe(404);
    expect((await runtime().store.listAll()).length).toBeGreaterThan(0);
  });
});
