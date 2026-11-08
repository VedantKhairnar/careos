import { getEnv } from "@/server/env";
import { getPool } from "@/server/db";
import { route } from "@/server/http";

/**
 * Health check for deployments and monitors. Public by design and reveals no secrets: only whether the database is
 * reachable and whether the AI is configured. Returns 503 if the database is configured but cannot be reached.
 */
export const GET = route(async () => {
  const env = getEnv();
  let database: "connected" | "unreachable" | "in-memory" = "in-memory";
  if (env.databaseConfigured && process.env.CAREOS_STORE !== "memory") {
    try {
      await getPool().query("select 1");
      database = "connected";
    } catch {
      database = "unreachable";
    }
  }
  const body = { data: { status: database === "unreachable" ? "degraded" : "ok", database, aiConfigured: env.geminiConfigured, demoMode: env.demoMode, time: new Date().toISOString() } };
  return Response.json(body, { status: database === "unreachable" ? 503 : 200 });
});
