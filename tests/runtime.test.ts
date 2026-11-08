import { describe, expect, it } from "vitest";
import { resetRuntime, runtime } from "@/server/runtime";

describe("runtime after a code reload", () => {
  it("replaces a store built from an older version of the class, so newer methods exist (the 'cannot be reset' bug)", async () => {
    resetRuntime();
    const g = globalThis as unknown as Record<symbol, { store: unknown; storeCtor: unknown; clock: { offsetMs: number } }>;
    const key = Symbol.for("careos.runtime");
    class OldStore {} // what an already running dev server still holds: no resetDemoData
    g[key] = { ...g[key], store: new OldStore(), storeCtor: OldStore, clock: { offsetMs: 45 * 60_000 } };

    const rt = runtime();
    expect(typeof rt.store.resetDemoData).toBe("function");
    expect(rt.clock.offsetMs).toBe(45 * 60_000); // the demo clock survives the rebuild
    expect(await rt.store.resetDemoData!()).toMatchObject({ events: 0 });
  });

  it("keeps the same runtime (and its data) when nothing changed", () => {
    resetRuntime();
    expect(runtime()).toBe(runtime());
  });
});
