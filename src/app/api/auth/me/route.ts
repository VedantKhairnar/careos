import { ok, requireSession, route } from "@/server/http";

export const GET = route(async (req) => {
  const s = requireSession(req);
  return ok({ userId: s.userId, role: s.role, patientId: s.patientId ?? null, displayName: s.displayName ?? null, demo: true });
});
