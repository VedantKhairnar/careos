import { ok, requireSession, route } from "@/server/http";
import { runtime } from "@/server/runtime";

/** Clinician analytics. Every number is a database query (Tiger Data continuous aggregates); nothing is hardcoded. */
export const GET = route(async (req) => {
  requireSession(req, ["clinician"]);
  const store = runtime().store;
  if (!store.analytics) return ok({ available: false, reason: "Tiger Data is not connected, so history and aggregates are unavailable. The app is running on in-memory storage." });
  return ok(await store.analytics());
});
