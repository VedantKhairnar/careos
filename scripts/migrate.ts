import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { poolConfig } from "@/server/db";

/**
 * Applies db/migrations/*.sql in order, once each, recorded in schema_migrations.
 * Usage:  node --env-file=.env.local --import tsx scripts/migrate.ts [--schema name]
 * Statements are split on lines that contain only "--#" and run one at a time (no wrapping transaction),
 * because continuous aggregates cannot be created inside one.
 */
export async function migrate(connectionString: string, opts: { schema?: string; log?: (m: string) => void } = {}): Promise<string[]> {
  const log = opts.log ?? (() => {});
  const client = new pg.Client(poolConfig(connectionString));
  await client.connect();
  const applied: string[] = [];
  try {
    if (opts.schema) {
      await client.query(`create schema if not exists "${opts.schema}"`);
      await client.query(`set search_path to "${opts.schema}", public`);
    }
    await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const dir = path.join(process.cwd(), "db", "migrations");
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      const done = await client.query("select 1 from schema_migrations where name = $1", [file]);
      if (done.rowCount) {
        log(`skip   ${file} (already applied)`);
        continue;
      }
      const statements = fs.readFileSync(path.join(dir, file), "utf8").split(/^--#\s*$/m).map((s) => s.trim()).filter(Boolean);
      for (const [i, sql] of statements.entries()) {
        try {
          await client.query(sql);
        } catch (err) {
          throw new Error(`${file} statement ${i + 1} failed: ${(err as Error).message}\n--- statement ---\n${sql.slice(0, 300)}`);
        }
      }
      await client.query("insert into schema_migrations(name) values ($1)", [file]);
      applied.push(file);
      log(`applied ${file} (${statements.length} statements)`);
    }
  } finally {
    await client.end();
  }
  return applied;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const i = process.argv.indexOf("--schema");
  const schema = i > -1 ? process.argv[i + 1] : undefined;
  const applied = await migrate(url, { schema, log: (m) => console.log(m) });
  console.log(applied.length ? `done: ${applied.length} migration(s) applied` : "done: nothing to apply");
}

if (process.argv[1]?.endsWith("migrate.ts")) {
  main().catch((e) => {
    console.error("migration failed:", (e as Error).message);
    process.exit(1);
  });
}
