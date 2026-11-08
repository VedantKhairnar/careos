import { ok, requireDemoMode, requireSession, route } from "@/server/http";
import { listWorkflows } from "@/server/services";

/** DEMO ONLY. Lists simulated pharmacy workflows for the operator panel. */
export const GET = route(async (req) => {
  requireDemoMode();
  requireSession(req, ["demo_operator"]);
  return ok({ simulated: true, workflows: await listWorkflows() });
});
