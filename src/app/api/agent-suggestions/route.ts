import { ok, requireSession, route } from "@/server/http";
import { toActor } from "@/server/session";
import { listSuggestions } from "@/server/suggestions";

/** Drafts prepared by the fulfilment agent, waiting for a clinician. */
export const GET = route(async (req) => ok(await listSuggestions(toActor(requireSession(req, ["clinician"])))));
