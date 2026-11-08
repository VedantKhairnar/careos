import { ok, requireDemoMode, requireSession, route } from "@/server/http";
import { resetDemo } from "@/server/services";

/**
 * DEMO ONLY. "Start afresh": clears the fictional live activity so the demo can be run live from an empty state.
 * Never touches the synthetic analytics history. Does not exist outside demo mode; operator only.
 */
export const POST = route(async (req) => {
  requireDemoMode();
  requireSession(req, ["demo_operator"]);
  return ok({ ...(await resetDemo()), cleared: true, keptSyntheticHistory: true });
});
