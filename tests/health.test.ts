import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";

describe("health check", () => {
  it("is public, reports the storage mode, and never exposes a secret", async () => {
    process.env.APPLICATION_SECRET = "test-secret-0123456789abcdef";
    process.env.GEMINI_API_KEY = "test-key-should-not-leak";
    const res = await GET(new Request("http://localhost/api/health"), undefined as never);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text).data).toMatchObject({ status: "ok", database: "in-memory", aiConfigured: true });
    expect(text).not.toContain("test-key-should-not-leak");
    expect(text).not.toContain("test-secret");
  });
});
