import { ApiError, GoogleGenAI, type Content } from "@google/genai";

/**
 * The only place that talks to Gemini. Server-side only: the key is read from the environment here
 * and never leaves this module.
 *
 * Free-tier limits (as shown in AI Studio for this key) are small: the Flash-Lite models allow
 * 15 requests/minute and 500/day, the regular Flash models only 5/minute and 20/day. So this layer
 * paces itself, falls back to a second model on a 429, and fails fast with a clear reason instead of
 * hanging or inventing an answer.
 */

export type AiFailure = "no_key" | "rate_limited" | "model_error" | "bad_output";

export class AiUnavailable extends Error {
  constructor(public reason: AiFailure, message: string) {
    super(message);
    this.name = "AiUnavailable";
  }
}

export interface ToolDecl {
  name: string;
  description: string;
  parametersJsonSchema: unknown;
}

export interface ModelRequest {
  system: string;
  contents: Content[];
  tools?: ToolDecl[];
  /** Ask for JSON that matches this schema instead of free text. */
  responseJsonSchema?: unknown;
  maxOutputTokens?: number;
}

export interface ModelResult {
  /** The model's turn exactly as returned. It must be appended to the history unchanged. */
  content: Content;
  text: string;
  functionCalls: { name: string; args: Record<string, unknown> }[];
  usage: { input: number; output: number };
  model: string;
  latencyMs: number;
}

export interface LanguageModel {
  generate(req: ModelRequest): Promise<ModelResult>;
}

const DEFAULT_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
const MAX_REQUESTS_PER_MINUTE = 12; // headroom under the 15 RPM free limit
const MAX_QUEUE_WAIT_MS = 15_000;
const CALL_TIMEOUT_MS = 30_000;

/**
 * Gemini's structured-output mode accepts only a subset of JSON Schema and answers "invalid argument" to
 * the rest (patterns, defaults, length limits, additionalProperties...). Strip those before sending. Nothing
 * is lost: every constraint is re-checked with Zod on our side after the model answers.
 */
const UNSUPPORTED = new Set(["pattern", "default", "additionalProperties", "maxLength", "minLength", "maxItems", "minItems", "format", "$schema"]);
export function toGeminiSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toGeminiSchema);
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node as Record<string, unknown>).filter(([k]) => !UNSUPPORTED.has(k)).map(([k, v]) => [k, toGeminiSchema(v)]));
  }
  return node;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sliding-window pacing. Refuses (rather than queueing forever) if the wait would be too long. */
export class RateLimiter {
  private stamps: number[] = [];
  constructor(private max: number, private windowMs = 60_000, private maxWaitMs = MAX_QUEUE_WAIT_MS, private now = () => Date.now()) {}
  async acquire(): Promise<void> {
    for (;;) {
      const t = this.now();
      this.stamps = this.stamps.filter((s) => t - s < this.windowMs);
      if (this.stamps.length < this.max) {
        this.stamps.push(t);
        return;
      }
      const wait = this.stamps[0] + this.windowMs - t;
      if (wait > this.maxWaitMs) throw new AiUnavailable("rate_limited", "The assistant is busy right now. Please try again in a minute.");
      await sleep(wait + 5);
    }
  }
}

function modelChain(): string[] {
  const configured = (process.env.GEMINI_MODEL ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return configured.length ? configured : DEFAULT_MODELS;
}

function textOf(content: Content | undefined): string {
  return (content?.parts ?? []).filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text as string).join("").trim();
}

export class GeminiModel implements LanguageModel {
  private client: GoogleGenAI;
  private limiter = new RateLimiter(MAX_REQUESTS_PER_MINUTE);
  private cooldownUntil = new Map<string, number>();

  constructor(private apiKey: string, private models: string[] = modelChain()) {
    this.client = new GoogleGenAI({ apiKey });
  }

  private scrub(msg: string): string {
    return msg.split(this.apiKey).join("[key]").slice(0, 300);
  }

  async generate(req: ModelRequest): Promise<ModelResult> {
    let lastRateLimited = false;
    for (const model of this.models) {
      if ((this.cooldownUntil.get(model) ?? 0) > Date.now()) {
        lastRateLimited = true;
        continue;
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        await this.limiter.acquire();
        const t0 = Date.now();
        try {
          const res = await Promise.race([
            this.client.models.generateContent({
              model,
              contents: req.contents,
              config: {
                systemInstruction: req.system,
                temperature: 0.2,
                maxOutputTokens: req.maxOutputTokens ?? 1024,
                ...(req.tools?.length ? { tools: [{ functionDeclarations: req.tools.map((t) => ({ ...t, parametersJsonSchema: toGeminiSchema(t.parametersJsonSchema) })) }] } : {}),
                ...(req.responseJsonSchema ? { responseMimeType: "application/json", responseJsonSchema: toGeminiSchema(req.responseJsonSchema) } : {}),
              },
            }),
            sleep(CALL_TIMEOUT_MS).then(() => {
              throw new ApiError({ message: "timeout", status: 504 });
            }),
          ]);
          const content = res.candidates?.[0]?.content;
          if (!content) throw new AiUnavailable("bad_output", "The assistant returned nothing usable.");
          return {
            content,
            text: textOf(content),
            functionCalls: (res.functionCalls ?? []).map((fc) => ({ name: fc.name ?? "", args: (fc.args ?? {}) as Record<string, unknown> })),
            usage: { input: res.usageMetadata?.promptTokenCount ?? 0, output: res.usageMetadata?.candidatesTokenCount ?? 0 },
            model,
            latencyMs: Date.now() - t0,
          };
        } catch (err) {
          if (err instanceof AiUnavailable) throw err;
          const status = err instanceof ApiError ? err.status : 0;
          const msg = this.scrub(err instanceof Error ? err.message : String(err));
          if (status === 429) {
            const m = /retry in ([\d.]+)s/i.exec(msg);
            this.cooldownUntil.set(model, Date.now() + Math.min(120, m ? Math.ceil(Number(m[1])) + 1 : 60) * 1000);
            lastRateLimited = true;
            break; // try the next model
          }
          if (status === 404) {
            this.cooldownUntil.set(model, Date.now() + 10 * 60_000);
            break;
          }
          if (status >= 500 || status === 0) {
            if (attempt === 0) continue; // one retry on a transient failure
            break;
          }
          // Full detail stays in the server log (key scrubbed). The caller only gets a generic message.
          console.error(`[gemini] ${model} failed (${status || "error"}): ${msg}`);
          throw new AiUnavailable("model_error", `The assistant could not answer (${status || "error"}).`);
        }
      }
    }
    if (lastRateLimited) throw new AiUnavailable("rate_limited", "The assistant is busy right now. Please try again in a minute.");
    throw new AiUnavailable("model_error", "The assistant is temporarily unavailable.");
  }
}

class NoKeyModel implements LanguageModel {
  async generate(): Promise<ModelResult> {
    throw new AiUnavailable("no_key", "The AI assistant is not configured on this server.");
  }
}

let override: LanguageModel | null = null;
let cached: { key: string; model: LanguageModel } | null = null;

/** Tests inject a fake model here. Production never does. */
export function setModelForTests(m: LanguageModel | null): void {
  override = m;
}

export function getModel(): LanguageModel {
  if (override) return override;
  const key = process.env.GEMINI_API_KEY;
  if (!key) return new NoKeyModel();
  if (!cached || cached.key !== key) cached = { key, model: new GeminiModel(key) };
  return cached.model;
}
