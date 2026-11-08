import { ok, route } from "@/server/http";
import { AS_HEADER, clearCookieHeader, clearKeyedCookieHeader } from "@/server/session";

/** Signs out only the identity this tab is acting as, so other tabs stay signed in. */
export const POST = route(async (req) => {
  const as = req.headers.get(AS_HEADER);
  const res = ok({ signedOut: true });
  res.headers.set("Set-Cookie", as ? clearKeyedCookieHeader(as) : clearCookieHeader());
  return res;
});
