import { ok, parseBody, requireSession, route } from "@/server/http";
import { toActor } from "@/server/session";
import { setThreshold, ThresholdInput } from "@/server/readings";

/** Only a clinician decides which range is worth flagging. There are no default ranges. */
export const POST = route(async (req) => {
  const session = requireSession(req, ["clinician"]);
  return ok(await setThreshold(toActor(session), await parseBody(req, ThresholdInput)));
});
