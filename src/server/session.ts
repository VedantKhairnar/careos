import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Actor } from "@/domain/events";
import { getEnv } from "./env";

/**
 * DEMO sessions only. There is no real identity provider yet.
 * The cookie is HMAC-signed so a client cannot edit its own role or patient.
 */
export const SessionSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["patient", "clinician", "demo_operator"]),
  patientId: z.string().min(1).optional(),
  displayName: z.string().optional(),
  exp: z.number(),
});
export type Session = z.infer<typeof SessionSchema>;

export const SESSION_COOKIE = "careos_demo_session";
const MAX_AGE_SECONDS = 8 * 60 * 60;

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const sign = (payload: string) => createHmac("sha256", getEnv().secret).update(payload).digest("base64url");

export function createSessionToken(s: Omit<Session, "exp">, nowMs = Date.now()): string {
  const payload = b64(JSON.stringify({ ...s, exp: Math.floor(nowMs / 1000) + MAX_AGE_SECONDS }));
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined, nowMs = Date.now()): Session | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = SessionSchema.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString()));
    if (!parsed.success || parsed.data.exp * 1000 < nowMs) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

/**
 * One browser can be signed in as several people at once (a doctor, two patients, the pharmacy) so they can be
 * shown side by side in tabs. Each sign-in gets its own signed cookie, and each tab says which identity it is
 * acting as with this header. The server still verifies the signature and that the cookie really belongs to the
 * identity asked for, so a tab can only act as someone who actually signed in.
 */
export const AS_HEADER = "x-careos-as";

export const identityKey = (s: { role: Session["role"]; patientId?: string | null }) =>
  s.role === "patient" ? `patient:${s.patientId}` : s.role === "clinician" ? "clinician" : "operator";

const keyedCookieName = (key: string) => `careos_s_${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;

export function getSession(req: Request): Session | null {
  const as = req.headers.get(AS_HEADER);
  if (!as) return verifySessionToken(readCookie(req, SESSION_COOKIE)); // API clients and tests: the last sign-in
  const s = verifySessionToken(readCookie(req, keyedCookieName(as)));
  // No fallback to a different login: a tab that asks to be X but has no valid X cookie is signed out.
  return s && keyedCookieName(identityKey(s)) === keyedCookieName(as) ? s : null;
}

export function keyedSessionCookieHeader(token: string, key: string): string {
  const secure = getEnv().secureCookies ? "; Secure" : "";
  return `${keyedCookieName(key)}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_SECONDS}${secure}`;
}

export function clearKeyedCookieHeader(key: string): string {
  return `${keyedCookieName(key)}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

export function sessionCookieHeader(token: string): string {
  const secure = getEnv().secureCookies ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_SECONDS}${secure}`;
}

export function clearCookieHeader(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Map a session to the domain actor. The demo operator acts as the pharmacy simulator. */
export function toActor(s: Session): Actor {
  if (s.role === "patient") return { id: s.userId, role: "patient", patientId: s.patientId };
  if (s.role === "clinician") return { id: s.userId, role: "clinician" };
  return { id: s.userId, role: "pharmacy_sim" };
}
