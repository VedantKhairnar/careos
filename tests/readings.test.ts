import { beforeEach, describe, expect, it } from "vitest";
import { POST as sessionPost } from "@/app/api/auth/session/route";
import { GET as readingsGet, POST as readingsPost } from "@/app/api/readings/route";
import { POST as thresholdPost } from "@/app/api/readings/thresholds/route";
import { resetRuntime } from "@/server/runtime";
import type { ReadingsView } from "@/server/readings";

type AnyHandler = (req: Request, ctx: never) => Promise<Response>;
const req = (method: string, url: string, opts: { body?: unknown; cookie?: string } = {}) =>
  new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json", ...(opts.cookie ? { cookie: opts.cookie } : {}) }, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
const call = (h: AnyHandler, r: Request) => h(r, undefined as never);
const login = async (body: Record<string, unknown>) => (await call(sessionPost, req("POST", "/api/auth/session", { body }))).headers.get("set-cookie")!.split(";")[0];

let clin: string, alex: string, maria: string;
beforeEach(async () => {
  process.env.APPLICATION_SECRET = "test-secret-0123456789abcdef";
  process.env.DEMO_MODE = "true";
  resetRuntime();
  clin = await login({ role: "clinician" });
  alex = await login({ role: "patient", patientId: "p_alex" });
  maria = await login({ role: "patient", patientId: "p_maria" });
});
const add = (cookie: string, body: Record<string, unknown>) => call(readingsPost, req("POST", "/api/readings", { cookie, body }));
const view = async (cookie: string, q = "") => ((await (await call(readingsGet, req("GET", `/api/readings${q}`, { cookie }))).json()).data as ReadingsView);
const hr = (v: ReadingsView) => v.series.find((s) => s.metric === "heart_rate")!;

describe("home readings", () => {
  it("records patient-reported readings and describes change in plain words, without judging", async () => {
    await add(alex, { metric: "heart_rate", value: 72 });
    await add(alex, { metric: "heart_rate", value: 78 });
    const s = hr(await view(alex));
    expect(s.points.map((p) => p.value)).toEqual([72, 78]);
    expect(s.change).toBe("Up 6 bpm from the previous reading.");
    expect(s.threshold).toBeNull();
    expect(s.flagged).toBeNull(); // no range was set, so nothing is flagged, ever
    expect(JSON.stringify(s)).not.toMatch(/normal|abnormal|serious|dangerous|healthy/i);
  });

  it("rejects implausible numbers and incomplete blood pressure", async () => {
    expect((await add(alex, { metric: "heart_rate", value: 900 })).status).toBe(400);
    expect((await add(alex, { metric: "blood_pressure", value: 120 })).status).toBe(400);
    expect((await add(alex, { metric: "blood_pressure", value: 80, value2: 120 })).status).toBe(400);
    expect((await add(alex, { metric: "blood_pressure", value: 124, value2: 80 })).status).toBe(200);
  });

  it("flags a reading only against a range the clinician set, and only the clinician can set it", async () => {
    await add(alex, { metric: "heart_rate", value: 118 });
    expect((await call(thresholdPost, req("POST", "/api/readings/thresholds", { cookie: alex, body: { patientId: "p_alex", metric: "heart_rate", max: 100 } }))).status).toBe(403);
    expect((await call(thresholdPost, req("POST", "/api/readings/thresholds", { cookie: clin, body: { patientId: "p_alex", metric: "heart_rate" } }))).status).toBe(400);
    const v = ((await (await call(thresholdPost, req("POST", "/api/readings/thresholds", { cookie: clin, body: { patientId: "p_alex", metric: "heart_rate", min: 50, max: 100 } }))).json()).data as ReadingsView);
    expect(v.flags).toHaveLength(1);
    expect(v.flags[0]).toMatchObject({ metric: "heart_rate", value: 118, limit: "above 100" });
    await add(alex, { metric: "heart_rate", value: 80 });
    expect((await view(clin, "?patientId=p_alex")).flags).toHaveLength(0); // back inside the range
  });

  it("keeps each patient's readings private; a clinician must name the patient", async () => {
    await add(alex, { metric: "pain_score", value: 4 });
    expect(hr(await view(maria)).points).toHaveLength(0);
    expect((await view(maria)).series.find((s) => s.metric === "pain_score")!.points).toHaveLength(0);
    expect((await call(readingsGet, req("GET", "/api/readings", { cookie: clin }))).status).toBe(400);
    expect((await view(clin, "?patientId=p_alex")).series.find((s) => s.metric === "pain_score")!.points).toHaveLength(1);
    expect((await add(clin, { metric: "pain_score", value: 3 })).status).toBe(403); // a clinician cannot record on a patient's behalf
  });
});
