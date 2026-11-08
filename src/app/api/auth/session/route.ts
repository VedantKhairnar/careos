import { z } from "zod";
import { getEnv } from "@/server/env";
import { HttpError, ok, parseBody, requireDemoMode, route } from "@/server/http";
import { createSessionToken, identityKey, keyedSessionCookieHeader, sessionCookieHeader } from "@/server/session";

const Body = z
  .object({
    role: z.enum(["patient", "clinician", "demo_operator"]),
    patientId: z.string().min(1).optional(),
    displayName: z.string().max(80).optional(),
  })
  .refine((b) => b.role !== "patient" || b.patientId, { message: "patientId is required for patients", path: ["patientId"] });

/**
 * DEMO sign-in (role switcher for judges). There is no real identity provider yet,
 * so this endpoint does not exist outside demo mode.
 */
export const POST = route(async (req) => {
  requireDemoMode();
  const body = await parseBody(req, Body);
  if (!getEnv().demoMode) throw new HttpError(404, "not_found", "Not found");
  const userId = `demo-${body.role}-${body.patientId ?? "1"}`;
  const token = createSessionToken({ userId, role: body.role, patientId: body.patientId, displayName: body.displayName });
  const as = identityKey(body);
  const res = ok({ userId, role: body.role, patientId: body.patientId ?? null, demo: true, as });
  // Legacy cookie first (API clients read the first Set-Cookie), then the identity-specific one the portals use.
  res.headers.set("Set-Cookie", sessionCookieHeader(token));
  res.headers.append("Set-Cookie", keyedSessionCookieHeader(token, as));
  return res;
});
