import { z } from "zod";
import { ok, parseBody, requireSession, route } from "@/server/http";
import { askQuestion, listQuestions } from "@/server/questions";
import { toActor } from "@/server/session";

const Body = z.object({ question: z.string().min(1).max(1000) });

/** A patient sends a question straight to their care team (no AI involved). */
export const POST = route(async (req) => {
  const session = requireSession(req, ["patient"]);
  const { question } = await parseBody(req, Body);
  return ok(await askQuestion(toActor(session), question, "patient"), 201);
});

export const GET = route(async (req) => {
  const session = requireSession(req, ["patient", "clinician"]);
  const patientId = new URL(req.url).searchParams.get("patientId") ?? undefined;
  return ok(await listQuestions(toActor(session), patientId));
});
