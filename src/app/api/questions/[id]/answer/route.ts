import { z } from "zod";
import { ok, parseBody, requireSession, route } from "@/server/http";
import { answerQuestion } from "@/server/questions";
import { toActor } from "@/server/session";

const Body = z.object({ answer: z.string().min(1).max(2000) });

/** Only a clinician can answer a patient's question. */
export const POST = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const session = requireSession(req, ["clinician"]);
  const { id } = await ctx.params;
  const { answer } = await parseBody(req, Body);
  return ok(await answerQuestion(toActor(session), id, answer));
});
