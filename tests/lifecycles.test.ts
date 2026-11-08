import { describe, expect, it } from "vitest";
import {
  CLARIFICATION_TABLE,
  GAP_TABLE,
  Lifecycle,
  TASK_TABLE,
  type ClarificationState,
  type GapState,
  type TaskState,
} from "@/domain/lifecycles";
import { applyPrescriptionEvent } from "@/domain/prescription";

const at = "2026-03-01T09:00:00.000Z";

describe("care task lifecycle", () => {
  const mk = () => new Lifecycle<TaskState>(TASK_TABLE, "CREATED");
  it("walks CREATED to COMPLETED only with completion evidence", () => {
    const t = mk();
    expect(t.apply("assign", { actor: "clinician", at }).ok).toBe(true);
    expect(t.apply("schedule", { actor: "system", at }).ok).toBe(true);
    expect(t.apply("start", { actor: "patient", at }).ok).toBe(true);
    const noEvidence = t.apply("complete", { actor: "patient", at });
    expect(noEvidence).toMatchObject({ ok: false });
    expect(t.state).toBe("IN_PROGRESS");
    expect(t.apply("complete", { actor: "patient", at, evidence: ["event:e42"] }).ok).toBe(true);
    expect(t.state).toBe("COMPLETED");
  });
  it("rejects skipping steps", () => {
    expect(mk().apply("complete", { actor: "patient", at, evidence: ["x"] }).ok).toBe(false);
  });
  it("lets an agent raise a clarification but not complete a task", () => {
    const t = mk();
    t.apply("assign", { actor: "clinician", at });
    expect(t.apply("request_clarification", { actor: "agent", at }).ok).toBe(true);
    expect(t.apply("complete", { actor: "agent", at, evidence: ["x"] }).ok).toBe(false);
  });
});

describe("clarification lifecycle", () => {
  const mk = () => new Lifecycle<ClarificationState>(CLARIFICATION_TABLE, "CREATED");
  const toPrepared = (c: Lifecycle<ClarificationState>) => {
    c.apply("assign", { actor: "system", at });
    c.apply("review", { actor: "clinician", at });
    return c.apply("prepare_response", { actor: "agent", at });
  };
  it("lets an agent prepare a response", () => {
    const c = mk();
    expect(toPrepared(c).ok).toBe(true);
    expect(c.state).toBe("RESPONSE_PREPARED");
  });
  it("does not let an agent approve its own prepared response", () => {
    const c = mk();
    toPrepared(c);
    expect(c.apply("approve", { actor: "agent", at }).ok).toBe(false);
    expect(c.state).toBe("RESPONSE_PREPARED");
    expect(c.apply("approve", { actor: "clinician", at }).ok).toBe(true);
    expect(c.apply("resolve", { actor: "system", at }).ok).toBe(true);
  });
});

describe("care gap lifecycle", () => {
  const mk = () => new Lifecycle<GapState>(GAP_TABLE, "DETECTED");
  it("retains history through resolve and reopen", () => {
    const g = mk();
    g.apply("assign", { actor: "system", at });
    g.apply("acknowledge", { actor: "clinician", at });
    g.apply("begin_action", { actor: "clinician", at });
    g.apply("resolve", { actor: "clinician", at });
    expect(g.state).toBe("RESOLVED");
    const withoutReason = g.apply("reopen", { actor: "system", at });
    expect(withoutReason.ok).toBe(false);
    expect(g.apply("reopen", { actor: "system", at, reason: "pharmacy reported a new delay" }).ok).toBe(true);
    expect(g.state).toBe("DETECTED");
    expect(g.history.map((h) => h.action)).toEqual(["assign", "acknowledge", "begin_action", "resolve", "reopen"]);
  });
  it("requires a reason to dismiss and only a clinician may dismiss", () => {
    const g = mk();
    expect(g.apply("dismiss", { actor: "clinician", at }).ok).toBe(false);
    expect(g.apply("dismiss", { actor: "patient", at, reason: "n/a" }).ok).toBe(false);
    expect(g.apply("dismiss", { actor: "clinician", at, reason: "duplicate of another gap" }).ok).toBe(true);
    expect(g.state).toBe("DISMISSED_WITH_REASON");
  });
});

describe("prescription FAILED state", () => {
  it("is reachable only from TRANSMITTED and only by the system", () => {
    expect(applyPrescriptionEvent("TRANSMITTED", "prescription.failed", "system")).toMatchObject({ ok: true, next: "FAILED" });
    expect(applyPrescriptionEvent("TRANSMITTED", "prescription.failed", "agent").ok).toBe(false);
    expect(applyPrescriptionEvent("PROCESSING", "prescription.failed", "system").ok).toBe(false);
  });
});
