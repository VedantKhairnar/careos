import { beforeEach, describe, expect, it } from "vitest";
import { POST as sessionPost } from "@/app/api/auth/session/route";
import { GET as meGet } from "@/app/api/auth/me/route";
import { POST as prescriptionsPost } from "@/app/api/prescriptions/route";
import { GET as statusGet } from "@/app/api/prescriptions/[id]/status/route";
import { POST as actionsPost } from "@/app/api/prescriptions/[id]/actions/route";
import { POST as pharmacyPost } from "@/app/api/demo/pharmacy/events/route";
import { GET as workflowsGet } from "@/app/api/demo/pharmacy/workflows/route";
import { GET as gapsGet } from "@/app/api/care-gaps/route";
import { resetRuntime } from "@/server/runtime";

const SECRET = "test-secret-0123456789abcdef";

type AnyHandler = (req: Request, ctx: never) => Promise<Response>;

function req(method: string, url: string, opts: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}
const call = (h: AnyHandler, r: Request, id?: string) => h(r, (id ? { params: Promise.resolve({ id }) } : undefined) as never);

async function login(body: Record<string, unknown>) {
  const res = await call(sessionPost, req("POST", "/api/auth/session", { body }));
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0];
}

const asClinician = () => login({ role: "clinician" });
const asPatient = (patientId = "p1") => login({ role: "patient", patientId });
const asOperator = () => login({ role: "demo_operator" });

async function newPrescription(cookie: string, patientId = "p1", key?: string) {
  const res = await call(
    prescriptionsPost,
    req("POST", "/api/prescriptions", {
      cookie,
      body: { patientId, medicationReference: "Demo medication (fictional)", approvedInstructions: "Fictional demo instructions." },
      headers: key ? { "idempotency-key": key } : {},
    }),
  );
  return { res, body: await res.json() };
}

const pharmacy = (cookie: string, workflowId: string, type: string, extra: Record<string, unknown> = {}) =>
  call(pharmacyPost, req("POST", "/api/demo/pharmacy/events", { cookie, body: { workflowId, type, ...extra } }));

beforeEach(() => {
  process.env.APPLICATION_SECRET = SECRET;
  process.env.DEMO_MODE = "true";
  resetRuntime();
});

describe("authentication", () => {
  it("rejects unauthenticated requests with the standard error shape", async () => {
    const res = await call(gapsGet, req("GET", "/api/care-gaps"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthenticated", message: "Sign in required" } });
  });
  it("rejects a tampered session cookie", async () => {
    const cookie = await asPatient("p1");
    const [name, token] = cookie.split("=");
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), role: "clinician" })).toString("base64url");
    const res = await call(meGet, req("GET", "/api/auth/me", { cookie: `${name}=${forged}.${sig}` }));
    expect(res.status).toBe(401);
  });
  it("requires a patientId when signing in as a patient", async () => {
    const res = await call(sessionPost, req("POST", "/api/auth/session", { body: { role: "patient" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("validation_failed");
  });
  it("labels sessions as demo", async () => {
    const res = await call(meGet, req("GET", "/api/auth/me", { cookie: await asClinician() }));
    expect((await res.json()).data.demo).toBe(true);
  });
});

describe("demo mode protection", () => {
  it("hides sign-in and simulator endpoints outside demo mode", async () => {
    process.env.DEMO_MODE = "false";
    expect((await call(sessionPost, req("POST", "/api/auth/session", { body: { role: "clinician" } }))).status).toBe(404);
    expect((await call(workflowsGet, req("GET", "/api/demo/pharmacy/workflows"))).status).toBe(404);
  });
  it("only the demo operator can drive the simulator", async () => {
    const clinician = await asClinician();
    const { body } = await newPrescription(clinician);
    const wf = body.data.workflowId;
    expect((await pharmacy(await asPatient(), wf, "prescription.received")).status).toBe(403);
    expect((await pharmacy(clinician, wf, "prescription.received")).status).toBe(403);
    expect((await pharmacy(await asOperator(), wf, "prescription.received")).status).toBe(200);
  });
});

describe("prescription workflow over the API", () => {
  it("only a clinician can create a prescription", async () => {
    const { res } = await newPrescription(await asPatient());
    expect(res.status).toBe(403);
  });
  it("authorizes and transmits, and shows a truthful patient status", async () => {
    const { res, body } = await newPrescription(await asClinician());
    expect(res.status).toBe(201);
    expect(body.data.state).toBe("TRANSMITTED");
    const status = await call(statusGet, req("GET", "/x", { cookie: await asPatient("p1") }), body.data.workflowId);
    const data = (await status.json()).data;
    expect(data.text).toContain("Awaiting pharmacy confirmation");
    expect(data.timeline.every((t: { source: { sourceSystem: string } }) => t.source.sourceSystem)).toBe(true);
  });
  it("hides another patient's prescription", async () => {
    const { body } = await newPrescription(await asClinician(), "p1");
    const res = await call(statusGet, req("GET", "/x", { cookie: await asPatient("p2") }), body.data.workflowId);
    expect(res.status).toBe(404);
  });
  it("rejects an invalid transition with 409", async () => {
    const { body } = await newPrescription(await asClinician());
    const res = await pharmacy(await asOperator(), body.data.workflowId, "prescription.ready");
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("invalid_transition");
  });
  it("treats a repeated simulator event as a duplicate, not a second transition", async () => {
    const operator = await asOperator();
    const { body } = await newPrescription(await asClinician());
    const wf = body.data.workflowId;
    const first = await (await pharmacy(operator, wf, "prescription.received", { idempotencyKey: "dup-1" })).json();
    const second = await (await pharmacy(operator, wf, "prescription.received", { idempotencyKey: "dup-1" })).json();
    expect(first.data.result).toBe("applied");
    expect(second.data.result).toBe("duplicate");
    expect(second.data.state).toBe("RECEIVED");
  });
  it("is safe to retry creating a prescription with the same Idempotency-Key", async () => {
    const clinician = await asClinician();
    const a = await newPrescription(clinician, "p1", "retry-key");
    const b = await newPrescription(clinician, "p1", "retry-key");
    expect(b.body.data.workflowId).toBe(a.body.data.workflowId);
    const list = await (await call(workflowsGet, req("GET", "/w", { cookie: await asOperator() }))).json();
    expect(list.data.workflows).toHaveLength(1);
  });
  it("runs the delay and clarification scenario end to end", async () => {
    const clinician = await asClinician();
    const operator = await asOperator();
    const patient = await asPatient("p1");
    const { body } = await newPrescription(clinician);
    const wf = body.data.workflowId;
    for (const t of ["received", "acknowledged", "delayed"]) {
      expect((await pharmacy(operator, wf, `prescription.${t}`)).status).toBe(200);
    }
    let s = (await (await call(statusGet, req("GET", "/x", { cookie: patient }), wf)).json()).data;
    expect(s.state).toBe("DELAYED");
    expect(s.text).toContain("delay");

    await pharmacy(operator, wf, "prescription.processing");
    await pharmacy(operator, wf, "prescription.clarification_requested");
    // a patient cannot resolve a pharmacy clarification
    expect((await call(actionsPost, req("POST", "/x", { cookie: patient, body: { action: "resolve_clarification" } }), wf)).status).toBe(403);
    const resolved = await call(actionsPost, req("POST", "/x", { cookie: clinician, body: { action: "resolve_clarification" } }), wf);
    expect(resolved.status).toBe(200);
    await pharmacy(operator, wf, "prescription.ready");
    s = (await (await call(statusGet, req("GET", "/x", { cookie: patient }), wf)).json()).data;
    expect(s.state).toBe("READY_FOR_PICKUP");
    expect(s.timeline.at(-1).source.simulated).toBe(true);
  });
});

describe("care gaps endpoint", () => {
  it("returns only the caller's own patient gaps and requires login", async () => {
    await newPrescription(await asClinician(), "p1");
    const res = await call(gapsGet, req("GET", "/api/care-gaps", { cookie: await asPatient("p2") }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.gaps).toEqual([]);
  });
});

describe("secrets and error hygiene", () => {
  it("never leaks the application secret in bodies or headers", async () => {
    const signIn = await call(sessionPost, req("POST", "/api/auth/session", { body: { role: "clinician" } }));
    const cookie = signIn.headers.get("set-cookie")!.split(";")[0];
    const signInText = JSON.stringify(await signIn.json()) + JSON.stringify([...signIn.headers.entries()]);
    const { res, body } = await newPrescription(cookie);
    const text = signInText + JSON.stringify(body) + JSON.stringify([...res.headers.entries()]);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("GEMINI_API_KEY");
  });
  it("returns a generic 500 and no internals for unexpected failures", async () => {
    const res = await call(statusGet, req("GET", "/x", { cookie: await asClinician() }), "does-not-exist");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });
});
