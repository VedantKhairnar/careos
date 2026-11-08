import { z } from "zod";
import { summarizeFulfilment } from "@/agents/pharmacyAgent";
import { ok, parseBody, requireSession, route } from "@/server/http";
import { toActor } from "@/server/session";

const Body = z.object({ workflowId: z.string().min(1) });

/** Read-only drafts (patient message and clinician summary) from the verified event history. Nothing is sent. */
export const POST = route(async (req) => {
  const session = requireSession(req, ["clinician", "demo_operator"]);
  const { workflowId } = await parseBody(req, Body);
  return ok(await summarizeFulfilment(toActor(session), workflowId));
});
