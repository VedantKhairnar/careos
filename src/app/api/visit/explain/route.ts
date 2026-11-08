import { explainVisit } from "@/agents/explainer";
import { ok, requireSession, route } from "@/server/http";
import { toActor } from "@/server/session";

/** The patient asks for their last visit in plain words. Built only from the approved care plan. */
export const POST = route(async (req) => ok(await explainVisit(toActor(requireSession(req, ["patient"])))));
