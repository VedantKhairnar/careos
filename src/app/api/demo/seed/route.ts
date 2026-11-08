import { ok, requireDemoMode, requireSession, route } from "@/server/http";
import { seedDemo } from "@/server/demoData";

/** Loads the two fictional patients. Demo mode only, any signed-in demo session, safe to call repeatedly. */
export const POST = route(async (req) => {
  requireDemoMode();
  requireSession(req);
  return ok({ ...(await seedDemo()), simulated: true });
});
