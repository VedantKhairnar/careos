import { beforeEach, describe, expect, it } from "vitest";
import { POST as sessionPost } from "@/app/api/auth/session/route";
import { POST as logoutPost } from "@/app/api/auth/logout/route";
import { GET as meGet } from "@/app/api/auth/me/route";
import { resetRuntime } from "@/server/runtime";

type AnyHandler = (req: Request, ctx: never) => Promise<Response>;
const req = (method: string, url: string, opts: { body?: unknown; cookie?: string; as?: string } = {}) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.as ? { "x-careos-as": opts.as } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
const call = (h: AnyHandler, r: Request) => h(r, undefined as never);

async function login(body: Record<string, unknown>) {
  const res = await call(sessionPost, req("POST", "/api/auth/session", { body }));
  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]);
  return { cookies, as: (await res.json()).data.as as string, res };
}
const me = async (cookie: string, as?: string) => {
  const r = await call(meGet, req("GET", "/api/auth/me", { cookie, as }));
  return { status: r.status, body: await r.json() };
};

beforeEach(() => {
  process.env.APPLICATION_SECRET = "test-secret-0123456789abcdef";
  process.env.DEMO_MODE = "true";
  resetRuntime();
});

describe("several people signed in at once in one browser", () => {
  it("sets a legacy cookie first and an identity-specific cookie second, and reports the identity key", async () => {
    const a = await login({ role: "patient", patientId: "p_alex" });
    expect(a.as).toBe("patient:p_alex");
    expect(a.cookies).toHaveLength(2);
    expect(a.cookies[0]).toMatch(/^careos_demo_session=/);
    expect(a.cookies[1]).toMatch(/^careos_s_patient_p_alex=/);
    expect((await login({ role: "clinician" })).as).toBe("clinician");
    expect((await login({ role: "demo_operator" })).as).toBe("operator");
  });

  it("lets each tab keep its own identity even though the browser shares cookies", async () => {
    const clin = await login({ role: "clinician" });
    const alex = await login({ role: "patient", patientId: "p_alex" });
    const maria = await login({ role: "patient", patientId: "p_maria" });
    const op = await login({ role: "demo_operator" }); // the LAST sign-in, so it owns the legacy cookie
    const jar = [...clin.cookies.slice(1), ...alex.cookies.slice(1), ...maria.cookies.slice(1), ...op.cookies].join("; ");
    const legacyOnly = jar.replace(/careos_demo_session=[^;]+/, op.cookies[0]);

    expect((await me(legacyOnly, "clinician")).body.data).toMatchObject({ role: "clinician" });
    expect((await me(legacyOnly, "patient:p_alex")).body.data).toMatchObject({ role: "patient", patientId: "p_alex" });
    expect((await me(legacyOnly, "patient:p_maria")).body.data).toMatchObject({ role: "patient", patientId: "p_maria" });
    expect((await me(legacyOnly, "operator")).body.data).toMatchObject({ role: "demo_operator" });
    // No header: API clients and older tabs get the last sign-in, exactly as before.
    expect((await me(legacyOnly)).body.data).toMatchObject({ role: "demo_operator" });
  });

  it("signs a tab out instead of falling back to someone else's login", async () => {
    const op = await login({ role: "demo_operator" });
    const r = await me(op.cookies.join("; "), "patient:p_alex"); // valid cookies exist, but none for this identity
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("unauthenticated");
  });

  it("refuses a cookie that belongs to a different identity than the one claimed", async () => {
    const alex = await login({ role: "patient", patientId: "p_alex" });
    const token = alex.cookies[0].split("=")[1];
    // Alex's perfectly valid token, planted under the clinician's and Maria's cookie names.
    expect((await me(`careos_s_clinician=${token}`, "clinician")).status).toBe(401);
    expect((await me(`careos_s_patient_p_maria=${token}`, "patient:p_maria")).status).toBe(401);
  });

  it("refuses a tampered identity cookie", async () => {
    const clin = await login({ role: "clinician" });
    const [name, token] = clin.cookies[1].split("=");
    const [payload, sig] = token.split(".");
    const evil = Buffer.from(JSON.stringify({ userId: "x", role: "clinician", exp: 9999999999 })).toString("base64url");
    expect((await me(`${name}=${evil}.${sig}`, "clinician")).status).toBe(401);
    expect((await me(`${name}=${payload}.${sig}`, "clinician")).status).toBe(200);
  });

  it("signs out only the identity the tab is acting as", async () => {
    const withHeader = await call(logoutPost, req("POST", "/api/auth/logout", { as: "patient:p_alex" }));
    const cleared = withHeader.headers.getSetCookie();
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatch(/^careos_s_patient_p_alex=; .*Max-Age=0/);

    const legacy = await call(logoutPost, req("POST", "/api/auth/logout"));
    expect(legacy.headers.getSetCookie()[0]).toMatch(/^careos_demo_session=; .*Max-Age=0/);
  });
});
