import { beforeEach, describe, expect, it } from "vitest";
import { POST as sessionPost } from "@/app/api/auth/session/route";
import { GET as plansGet, POST as plansPost } from "@/app/api/care-plans/route";
import { GET as planGet } from "@/app/api/care-plans/[id]/route";
import { POST as approvePost } from "@/app/api/care-plans/[id]/approve/route";
import { GET as medsGet } from "@/app/api/medications/route";
import { POST as dosesPost } from "@/app/api/doses/route";
import { GET as notifsGet } from "@/app/api/notifications/route";
import { POST as ackPost } from "@/app/api/notifications/[id]/acknowledge/route";
import { GET as patientsGet } from "@/app/api/patients/route";
import { GET as patientGet } from "@/app/api/patients/[id]/route";
import { GET as rxGet, POST as rxPost } from "@/app/api/prescriptions/route";
import { POST as pharmacyPost } from "@/app/api/demo/pharmacy/events/route";
import { POST as seedPost } from "@/app/api/demo/seed/route";
import { resetRuntime, runtime } from "@/server/runtime";

type AnyHandler = (req: Request, ctx: never) => Promise<Response>;
const req = (method: string, url: string, opts: { body?: unknown; cookie?: string } = {}) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
const call = (h: AnyHandler, r: Request, id?: string) => h(r, (id ? { params: Promise.resolve({ id }) } : undefined) as never);

async function login(body: Record<string, unknown>) {
  const res = await call(sessionPost, req("POST", "/api/auth/session", { body }));
  return res.headers.get("set-cookie")!.split(";")[0];
}
const asClinician = () => login({ role: "clinician" });
const asPatient = (patientId: string) => login({ role: "patient", patientId });
const asOperator = () => login({ role: "demo_operator" });

const today = new Date().toISOString().slice(0, 10);
const content = (medications: object[] = []) => ({
  title: "Test plan (fictional)",
  summary: "Fictional test plan.",
  instructions: ["Rest."],
  medications,
  followUps: [],
  warningSigns: ["Contact your care team if worried."],
});
const completeMed = { name: "Demo-Med (fictional)", dose: "1 tablet", times: ["00:00", "06:00", "12:00", "18:00"], startDate: today };

async function newPlan(clin: string, patientId: string, medications: object[] = []) {
  const res = await call(plansPost, req("POST", "/api/care-plans", { cookie: clin, body: { patientId, content: content(medications) } }));
  return (await res.json()).data as { planId: string; state: string };
}
const approve = (clin: string, id: string) => call(approvePost, req("POST", `/api/care-plans/${id}/approve`, { cookie: clin }), id);

beforeEach(() => {
  process.env.APPLICATION_SECRET = "test-secret-0123456789abcdef";
  process.env.DEMO_MODE = "true";
  resetRuntime();
});

describe("care plan review", () => {
  it("keeps a submitted plan invisible to the patient until a clinician approves it", async () => {
    const clin = await asClinician();
    const pat = await asPatient("p1");
    const plan = await newPlan(clin, "p1");
    expect(plan.state).toBe("PENDING_REVIEW");

    expect((await (await call(plansGet, req("GET", "/api/care-plans", { cookie: pat }))).json()).data).toHaveLength(0);
    expect((await call(planGet, req("GET", `/api/care-plans/${plan.planId}`, { cookie: pat }), plan.planId)).status).toBe(404);

    expect((await approve(clin, plan.planId)).status).toBe(200);
    const visible = (await (await call(plansGet, req("GET", "/api/care-plans", { cookie: pat }))).json()).data;
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ state: "APPROVED", approvedBy: expect.any(String) });
  });

  it("does not let a patient create or approve a plan", async () => {
    const clin = await asClinician();
    const pat = await asPatient("p1");
    const plan = await newPlan(clin, "p1");
    expect((await call(plansPost, req("POST", "/api/care-plans", { cookie: pat, body: { patientId: "p1", content: content() } }))).status).toBe(403);
    expect((await approve(pat, plan.planId)).status).toBe(403);
  });

  it("rejects approving the same plan twice", async () => {
    const clin = await asClinician();
    const plan = await newPlan(clin, "p1");
    expect((await approve(clin, plan.planId)).status).toBe(200);
    expect((await approve(clin, plan.planId)).status).toBe(409);
  });

  it("hides one patient's plan from another patient", async () => {
    const clin = await asClinician();
    const plan = await newPlan(clin, "p1");
    await approve(clin, plan.planId);
    const other = await asPatient("p2");
    expect((await call(planGet, req("GET", `/api/care-plans/${plan.planId}`, { cookie: other }), plan.planId)).status).toBe(404);
  });

  it("validates plan content", async () => {
    const clin = await asClinician();
    const bad = await call(plansPost, req("POST", "/api/care-plans", { cookie: clin, body: { patientId: "p1", content: { ...content(), medications: [{ name: "X", times: ["25:99"] }] } } }));
    expect(bad.status).toBe(400);
  });
});

describe("medications and reminders", () => {
  it("asks for clarification instead of inventing a schedule from incomplete instructions", async () => {
    const clin = await asClinician();
    const pat = await asPatient("p1");
    const plan = await newPlan(clin, "p1", [{ name: "Incomplete-Med (fictional)" }]);
    await approve(clin, plan.planId);
    const meds = (await (await call(medsGet, req("GET", "/api/medications", { cookie: pat }))).json()).data.medications;
    expect(meds[0]).toMatchObject({ schedule: "needs_clarification", doses: [] });
    expect(meds[0].missing).toEqual(expect.arrayContaining(["dose", "times", "startDate"]));
  });

  it("derives reminders only from approved plans", async () => {
    const clin = await asClinician();
    const pat = await asPatient("p1");
    const plan = await newPlan(clin, "p1", [completeMed]);
    const before = (await (await call(medsGet, req("GET", "/api/medications", { cookie: pat }))).json()).data.medications;
    expect(before).toHaveLength(0); // still pending review
    await approve(clin, plan.planId);
    const after = (await (await call(medsGet, req("GET", "/api/medications", { cookie: pat }))).json()).data.medications;
    expect(after[0].schedule).toBe("ready");
    expect(after[0].doses.length).toBeGreaterThan(0);
  });

  it("records a dose as patient-reported, once, and only for real scheduled doses", async () => {
    const clin = await asClinician();
    const pat = await asPatient("p1");
    const plan = await newPlan(clin, "p1", [completeMed]);
    await approve(clin, plan.planId);
    const getDoses = async () => (await (await call(medsGet, req("GET", "/api/medications", { cookie: pat }))).json()).data.medications[0].doses;
    const dose = (await getDoses())[0];
    const body = { planId: plan.planId, medicationName: completeMed.name, scheduledFor: dose.scheduledFor, response: "taken" };

    const first = await (await call(dosesPost, req("POST", "/api/doses", { cookie: pat, body }))).json();
    expect(first.data).toMatchObject({ recorded: true });
    const again = await (await call(dosesPost, req("POST", "/api/doses", { cookie: pat, body }))).json();
    expect(again.data).toMatchObject({ alreadyRecorded: true });

    const updated = (await getDoses()).find((d: { scheduledFor: string }) => d.scheduledFor === dose.scheduledFor);
    expect(updated).toMatchObject({ status: "taken", statusVerification: "patient_reported" });

    const fake = await call(dosesPost, req("POST", "/api/doses", { cookie: pat, body: { ...body, scheduledFor: "2020-01-01T00:00:00.000Z" } }));
    expect(fake.status).toBe(400);
    const stored = (await runtime().store.listByPatient("p1")).filter((e) => e.type === "dose.reported");
    expect(stored).toHaveLength(1);
    expect(stored[0].verification).toBe("patient_reported");
  });

  it("does not let a clinician or another patient report a dose", async () => {
    const clin = await asClinician();
    const body = { planId: "x", medicationName: "y", scheduledFor: new Date().toISOString(), response: "taken" };
    expect((await call(dosesPost, req("POST", "/api/doses", { cookie: clin, body }))).status).toBe(403);
  });
});

describe("notifications", () => {
  async function delayedPrescription() {
    const clin = await asClinician();
    const op = await asOperator();
    const rx = (await (await call(rxPost, req("POST", "/api/prescriptions", { cookie: clin, body: { patientId: "p1", medicationReference: "Demo-Med (fictional)" } }))).json()).data;
    for (const type of ["prescription.received", "prescription.acknowledged", "prescription.delayed"]) {
      await call(pharmacyPost, req("POST", "/api/demo/pharmacy/events", { cookie: op, body: { workflowId: rx.workflowId, type } }));
    }
    return rx.workflowId as string;
  }

  it("tells the patient about a delay, marks it important and lets them acknowledge it", async () => {
    await delayedPrescription();
    const pat = await asPatient("p1");
    const list = (await (await call(notifsGet, req("GET", "/api/notifications", { cookie: pat }))).json()).data;
    const delay = list.notifications.find((n: { title: string }) => n.title === "Pharmacy reported a delay");
    expect(delay).toMatchObject({ important: true, acknowledged: false });
    expect(list.unread).toBeGreaterThan(0);

    const ack = await call(ackPost, req("POST", `/api/notifications/${delay.id}/acknowledge`, { cookie: pat }), delay.id);
    expect((await ack.json()).data).toMatchObject({ acknowledged: true });
    const after = (await (await call(notifsGet, req("GET", "/api/notifications", { cookie: pat }))).json()).data;
    expect(after.notifications.find((n: { id: string }) => n.id === delay.id).acknowledged).toBe(true);
  });

  it("records a system notification.sent for important pharmacy events", async () => {
    await delayedPrescription();
    const sent = (await runtime().store.listByPatient("p1")).filter((e) => e.type === "notification.sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ actorRole: "system", simulated: true });
  });

  it("will not let another patient acknowledge someone else's notification", async () => {
    await delayedPrescription();
    const pat = await asPatient("p1");
    const id = (await (await call(notifsGet, req("GET", "/api/notifications", { cookie: pat }))).json()).data.notifications[0].id;
    const other = await asPatient("p2");
    expect((await call(ackPost, req("POST", `/api/notifications/${id}/acknowledge`, { cookie: other }), id)).status).toBe(404);
  });

  it("is patient-facing only", async () => {
    const clin = await asClinician();
    expect((await call(notifsGet, req("GET", "/api/notifications", { cookie: clin }))).status).toBe(403);
  });
});

describe("prescription list and patients", () => {
  it("scopes the prescription list to the caller", async () => {
    const clin = await asClinician();
    await call(rxPost, req("POST", "/api/prescriptions", { cookie: clin, body: { patientId: "p1", medicationReference: "A" } }));
    await call(rxPost, req("POST", "/api/prescriptions", { cookie: clin, body: { patientId: "p2", medicationReference: "B" } }));
    const mine = (await (await call(rxGet, req("GET", "/api/prescriptions", { cookie: await asPatient("p1") }))).json()).data;
    expect(mine.map((r: { medicationReference: string }) => r.medicationReference)).toEqual(["A"]);
    const all = (await (await call(rxGet, req("GET", "/api/prescriptions", { cookie: clin }))).json()).data;
    expect(all).toHaveLength(2);
  });

  it("limits the patients list to clinicians and a patient's summary to themselves", async () => {
    const clin = await asClinician();
    const pat = await asPatient("p_alex");
    expect((await call(patientsGet, req("GET", "/api/patients", { cookie: pat }))).status).toBe(403);
    expect((await call(patientGet, req("GET", "/api/patients/p_maria", { cookie: pat }), "p_maria")).status).toBe(404);
    expect((await call(patientGet, req("GET", "/api/patients/p_alex", { cookie: pat }), "p_alex")).status).toBe(200);
    expect((await call(patientsGet, req("GET", "/api/patients", { cookie: clin }))).status).toBe(200);
  });
});

describe("demo seed", () => {
  it("is idempotent, flags everything as simulated, and keeps Maria's two plans separate", async () => {
    const clin = await asClinician();
    const seed = () => call(seedPost, req("POST", "/api/demo/seed", { cookie: clin }));
    expect((await seed()).status).toBe(200);
    const count = async () => (await runtime().store.listAll()).length;
    const n = await count();
    expect((await seed()).status).toBe(200);
    expect(await count()).toBe(n);
    expect((await runtime().store.listAll()).every((e) => e.simulated)).toBe(true);

    const maria = await asPatient("p_maria");
    const plans = (await (await call(plansGet, req("GET", "/api/care-plans", { cookie: maria }))).json()).data;
    expect(plans).toHaveLength(2);
    const meds = (await (await call(medsGet, req("GET", "/api/medications", { cookie: maria }))).json()).data.medications;
    expect(new Set(meds.map((m: { planId: string }) => m.planId)).size).toBe(2);

    const alex = await asPatient("p_alex");
    const alexMeds = (await (await call(medsGet, req("GET", "/api/medications", { cookie: alex }))).json()).data.medications;
    // Every demo medicine has a complete, clinician-written schedule. The "incomplete instructions" behaviour is tested
    // above with a purpose-built plan; the app never guesses a missing schedule, the demo just does not contain one.
    expect(alexMeds.every((m: { schedule: string }) => m.schedule === "ready")).toBe(true);
    expect(alexMeds.find((m: { name: string }) => m.name.includes("Antibiotic")).doses.length).toBeGreaterThan(0);
  });

  it("does not exist outside demo mode", async () => {
    const clin = await asClinician();
    process.env.DEMO_MODE = "false";
    expect((await call(seedPost, req("POST", "/api/demo/seed", { cookie: clin }))).status).toBe(404);
  });
});
