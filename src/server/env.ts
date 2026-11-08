import { randomBytes } from "node:crypto";
import { z } from "zod";

const Schema = z.object({
  NODE_ENV: z.string().default("development"),
  APP_BASE_URL: z.string().url().optional(),
  APPLICATION_SECRET: z.string().min(16).optional(),
  DEMO_MODE: z.enum(["true", "false"]).optional(),
  GEMINI_API_KEY: z.string().optional(),
  DATABASE_URL: z.string().optional(),
});

export interface Env {
  production: boolean;
  demoMode: boolean;
  secret: string;
  secureCookies: boolean;
  geminiConfigured: boolean;
  databaseConfigured: boolean;
}

let ephemeralSecret: string | undefined;

/** Read lazily so tests can change process.env. Secrets never leave the server. */
export function getEnv(): Env {
  const raw = Schema.parse({
    NODE_ENV: process.env.NODE_ENV,
    APP_BASE_URL: process.env.APP_BASE_URL || undefined,
    APPLICATION_SECRET: process.env.APPLICATION_SECRET || undefined,
    DEMO_MODE: process.env.DEMO_MODE || undefined,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || undefined,
    DATABASE_URL: process.env.DATABASE_URL || undefined,
  });
  const production = raw.NODE_ENV === "production";
  if (production && !raw.APPLICATION_SECRET) {
    throw new Error("APPLICATION_SECRET is required in production");
  }
  // Outside production a missing secret gets a per-process random one (sessions reset on restart).
  ephemeralSecret ??= randomBytes(32).toString("hex");
  return {
    production,
    demoMode: raw.DEMO_MODE ? raw.DEMO_MODE === "true" : !production,
    secret: raw.APPLICATION_SECRET ?? ephemeralSecret,
    secureCookies: raw.APP_BASE_URL?.startsWith("https://") ?? production,
    geminiConfigured: Boolean(raw.GEMINI_API_KEY || (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.BEDROCK_MODEL)),
    databaseConfigured: Boolean(raw.DATABASE_URL),
  };
}
