import { ok, route } from "@/server/http";
import { clearCookieHeader } from "@/server/session";

export const POST = route(async () => {
  const res = ok({ signedOut: true });
  res.headers.set("Set-Cookie", clearCookieHeader());
  return res;
});
