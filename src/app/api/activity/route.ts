import { ok, requireSession, route } from "@/server/http";
import { listActivity } from "@/server/activity";
import { toActor } from "@/server/session";

/** One timeline of people, system and agent activity. Doctor and demo operator only. */
export const GET = route(async (req) => {
  const session = requireSession(req, ["clinician", "demo_operator"]);
  return ok(await listActivity(toActor(session), session.role as "clinician" | "demo_operator"));
});
