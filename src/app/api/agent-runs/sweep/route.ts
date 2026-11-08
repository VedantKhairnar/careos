import { runSweep } from "@/agents/coordinator";
import { ok, requireSession, route } from "@/server/http";

/** Asks the coordinator to look for pharmacy problems nobody has looked at yet. Starts runs in the background. */
export const POST = route(async (req) => {
  requireSession(req, ["clinician"]);
  return ok(await runSweep());
});
