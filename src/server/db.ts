import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import pg from "pg";

/**
 * Postgres/TimescaleDB connection (Tiger Cloud).
 *
 * TLS is verified strictly (certificate chain AND hostname). Tiger Cloud services start with a certificate
 * issued by Timescale's own CA and later switch to a publicly trusted one, so we trust Node's normal roots
 * plus Timescale's CA (db/timescale-ca.pem, a public certificate). Either chain verifies; nothing is skipped.
 */
export function pinnedCa(): string[] {
  const file = path.join(process.cwd(), "db", "timescale-ca.pem");
  const extra = fs.existsSync(file) ? [fs.readFileSync(file, "utf8")] : [];
  return [...tls.rootCertificates, ...extra];
}

export function poolConfig(connectionString: string): pg.PoolConfig {
  const url = new URL(connectionString);
  const mode = url.searchParams.get("sslmode");
  url.searchParams.delete("sslmode"); // pg treats require as verify-full; we configure TLS explicitly below
  const useTls = mode !== "disable";
  return {
    connectionString: url.toString(),
    ssl: useTls ? { ca: pinnedCa(), rejectUnauthorized: true } : undefined,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  };
}

const KEY = Symbol.for("careos.pgpool");
type G = typeof globalThis & { [KEY]?: pg.Pool };

/** One pool per process, preserved across dev hot reloads. Secrets stay on the server. */
export function getPool(): pg.Pool {
  const g = globalThis as G;
  if (!g[KEY]) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    g[KEY] = new pg.Pool(poolConfig(url));
    g[KEY].on("error", (err) => console.error("[db] idle client error:", err.message));
  }
  return g[KEY]!;
}

export async function closePool(): Promise<void> {
  const g = globalThis as G;
  if (g[KEY]) {
    await g[KEY]!.end();
    g[KEY] = undefined;
  }
}
