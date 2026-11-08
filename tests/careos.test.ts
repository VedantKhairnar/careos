import { beforeEach, describe, expect, it } from "vitest";
import type { Actor, CareEvent, EventType } from "@/domain/events";
import { deriveReminders, resolveDoseStatus } from "@/domain/dose";
import { detectGaps } from "@/domain/careGap";
import { prescriptionStatus } from "@/domain/status";
import { foldPrescriptionState } from "@/domain/prescription";
import { Forbidden, Orchestrator } from "@/server/orchestrator";
import { InMemoryEventStore } from "@/server/store";

const clinician: Actor = { id: "dr1", role: "clinician" };
const system: Actor = { id: "sys", role: "system" };
const pharmacy: Actor = { id: "pharm1", role: "pharmacy_sim" };
const patient1: Actor = { id: "u-p1", role: "patient", patientId: "p1" };
const patient2: Actor = { id: "u-p2", role: "patient", patientId: "p2" };
const agent: Actor = { id: "agent-doctor", role: "agent" };

let clock = 0;
let seq = 0;
let store: InMemoryEventStore;
let orch: Orchestrator;
const iso = () => new Date(clock).toISOString();
const advance = (minutes: number) => {
  clock += minutes * 60_000;
};

function ev(type: EventType, actor: Actor, over: Partial<CareEvent> = {}): CareEvent {
  const n = ++seq;
  return {
    eventId: `e${n}`,
    workflowId: "rx1",
    patientId: "p1",
    type,
    actorId: actor.id,
    actorRole: actor.role,
    sourceSystem: actor.role === "pharmacy_sim" ? "pharmacy-simulator" : "careos",
    occurredAt: iso(),
    recordedAt: iso(),
    payload: {},
    verification: actor.role === "patient" ? "patient_reported" : "confirmed",
    simulated: actor.role === "pharmacy_sim",
    correlationId: "c1",
    idempotencyKey: `k${n}`,
    ...over,
  };
}

async function send(actor: Actor, type: EventType, over: Partial<CareEvent> = {}) {
  return orch.handle(actor, ev(type, actor, over));
}

/** Drive a prescription to the given point using valid events. */
async function authorizeAndTransmit() {
  await send(clinician, "prescription.authorized");
  await send(system, "prescription.transmitted");
}

beforeEach(() => {
  clock = Date.parse("2026-03-01T09:00:00Z");
  seq = 0;
  store = new InMemoryEventStore();
  orch = new Orchestrator(store, iso);
});

describe("1. authorization", () => {
  it("blocks reading another patient's information", async () => {
    await send(clinician, "prescription.authorized");
    await expect(orch.listEventsFor(patient2, "p1")).rejects.toBeInstanceOf(Forbidden);
    await expect(orch.listEventsFor(patient1, "p1")).resolves.toHaveLength(1);
  });
  it("blocks a patient writing to another patient's record", async () => {
    const r = await orch.handle(patient2, ev("task.confirmed", patient2, { patientId: "p1" }));
    expect(r.status).toBe("rejected");
  });
  it("rejects events that claim a different actor than the authenticated one", async () => {
    const r = await orch.handle(patient1, ev("prescription.ready", pharmacy));
    expect(r.status).toBe("rejected");
  });
  it("keeps patient-reported information labelled as patient-reported", async () => {
    const r = await orch.handle(
      patient1,
      ev("prescription.pickup_reported", patient1, { verification: "confirmed" }),
    );
    expect(r.status).toBe("rejected");
  });
});

describe("2-3. workflow transitions", () => {
  it("rejects invalid transitions", async () => {
    await send(clinician, "prescription.authorized");
    const r = await send(pharmacy, "prescription.acknowledged"); // skips transmitted/received
    expect(r.status).toBe("rejected");
  });
  it("cannot be marked ready without a valid pharmacy event", async () => {
    await authorizeAndTransmit();
    expect((await send(pharmacy, "prescription.ready")).status).toBe("rejected");
    await send(pharmacy, "prescription.received");
    await send(pharmacy, "prescription.acknowledged");
    await send(pharmacy, "prescription.processing");
    // a clinician or patient cannot manufacture readiness either
    expect((await send(clinician, "prescription.ready")).status).toBe("rejected");
    expect((await send(pharmacy, "prescription.ready")).status).toBe("applied");
  });
  it("requires simulator events to be flagged as simulated", async () => {
    await authorizeAndTransmit();
    const r = await send(pharmacy, "prescription.received", { simulated: false });
    expect(r.status).toBe("rejected");
  });
  it("patient-reported pickup does not complete the workflow", async () => {
    await authorizeAndTransmit();
    for (const t of ["received", "acknowledged", "processing", "ready"] as const) {
      await send(pharmacy, `prescription.${t}`);
    }
    await send(patient1, "prescription.pickup_reported");
    const events = await store.listByWorkflow("rx1");
    expect(foldPrescriptionState(events)).toBe("READY");
    await send(pharmacy, "prescription.picked_up");
    expect(foldPrescriptionState(await store.listByWorkflow("rx1"))).toBe("PICKED_UP");
  });
});

describe("4. agents have no clinical authority", () => {
  it("an agent cannot approve a care plan or authorize a prescription", async () => {
    expect((await send(agent, "care_plan.submitted", { workflowId: "plan1" })).status).toBe("applied");
    expect((await send(agent, "care_plan.approved", { workflowId: "plan1" })).status).toBe("rejected");
    expect((await send(agent, "prescription.authorized")).status).toBe("rejected");
  });
  it("a clinician can approve a submitted plan", async () => {
    await send(agent, "care_plan.submitted", { workflowId: "plan1" });
    expect((await send(clinician, "care_plan.approved", { workflowId: "plan1" })).status).toBe("applied");
  });
});

describe("5-6. reminders and adherence", () => {
  const source = { carePlanVersionId: "v1", approvedBy: "dr1" };
  it("does not invent reminders from incomplete instructions", () => {
    const r = deriveReminders({ medicationName: "Drug X", source });
    expect(r.status).toBe("needs_clarification");
    if (r.status === "needs_clarification") expect(r.missing).toEqual(expect.arrayContaining(["dose", "times", "startDate"]));
  });
  it("does not infer clock times from frequency", () => {
    const r = deriveReminders({ medicationName: "Drug X", dose: "1 tablet", startDate: "2026-03-01", source });
    expect(r.status).toBe("needs_clarification");
  });
  it("derives reminders only from complete approved instructions", () => {
    const r = deriveReminders(
      { medicationName: "Drug X", dose: "1 tablet", times: ["08:00", "20:00"], startDate: "2026-03-01", endDate: "2026-03-02", source },
      { horizonDays: 7 },
    );
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.reminders).toHaveLength(4); // stops at endDate
  });
  it("marks an unanswered reminder unconfirmed, never missed", () => {
    const status = resolveDoseStatus({
      scheduledFor: "2026-03-01T08:00:00.000Z",
      now: "2026-03-01T12:00:00.000Z",
      graceMinutes: 60,
    });
    expect(status).toBe("unconfirmed");
    expect(status).not.toBe("missed");
  });
  it("keeps a dose scheduled inside the grace window", () => {
    expect(
      resolveDoseStatus({ scheduledFor: "2026-03-01T08:00:00.000Z", now: "2026-03-01T08:30:00.000Z", graceMinutes: 60 }),
    ).toBe("scheduled");
  });
});

describe("7. idempotency", () => {
  it("a duplicate event does not produce a second transition", async () => {
    const e = ev("prescription.authorized", clinician);
    expect((await orch.handle(clinician, e)).status).toBe("applied");
    expect((await orch.handle(clinician, e)).status).toBe("duplicate");
    expect(await store.listByWorkflow("rx1")).toHaveLength(1);
  });
});

describe("8-9. care gap engine", () => {
  it("detects an overdue pharmacy acknowledgment", async () => {
    await authorizeAndTransmit();
    advance(10);
    expect(detectGaps(await store.listByWorkflow("rx1"), iso())).toHaveLength(0); // inside deadline
    advance(40);
    const gaps = detectGaps(await store.listByWorkflow("rx1"), iso());
    expect(gaps.map((g) => g.rule)).toEqual(["pharmacy_ack_overdue"]);
    expect(gaps[0].responsible).toBe("clinician");
  });
  it("does not re-create a gap on every run (deterministic key)", async () => {
    await authorizeAndTransmit();
    advance(60);
    const events = await store.listByWorkflow("rx1");
    expect(detectGaps(events, iso())[0].key).toBe(detectGaps(events, iso())[0].key);
  });
  it("a resolved gap is no longer open", async () => {
    await authorizeAndTransmit();
    advance(60);
    const [gap] = detectGaps(await store.listByWorkflow("rx1"), iso());
    await send(clinician, "gap.resolved", { payload: { gapKey: gap.key } });
    expect(detectGaps(await store.listByWorkflow("rx1"), iso())).toHaveLength(0);
  });
  it("closes naturally when the pharmacy acknowledges", async () => {
    await authorizeAndTransmit();
    advance(60);
    await send(pharmacy, "prescription.received");
    await send(pharmacy, "prescription.acknowledged");
    expect(detectGaps(await store.listByWorkflow("rx1"), iso())).toHaveLength(0);
  });
  it("flags an unresolved clarification and an unaddressed delay", async () => {
    await authorizeAndTransmit();
    await send(pharmacy, "prescription.received");
    await send(pharmacy, "prescription.acknowledged");
    await send(pharmacy, "prescription.clarification_requested");
    advance(180);
    expect(detectGaps(await store.listByWorkflow("rx1"), iso()).map((g) => g.rule)).toContain("clarification_unresolved");
  });
  it("flags an unacknowledged important notification for the patient", async () => {
    await send(system, "notification.sent", { payload: { important: true, notificationId: "n1" } });
    advance(300);
    const gaps = detectGaps(await store.listByWorkflow("rx1"), iso());
    expect(gaps[0]).toMatchObject({ rule: "notification_unacknowledged", responsible: "patient" });
  });
});

describe("10. patient and doctor views agree", () => {
  it("derives both statuses from the same events", async () => {
    await authorizeAndTransmit();
    await send(pharmacy, "prescription.received");
    await send(pharmacy, "prescription.acknowledged");
    await send(pharmacy, "prescription.delayed");
    const events = await orch.listEventsFor(clinician, "p1");
    const patientView = prescriptionStatus(await orch.listEventsFor(patient1, "p1"));
    const doctorView = prescriptionStatus(events);
    expect(patientView.state).toBe(doctorView.state);
    expect(patientView.state).toBe("DELAYED");
  });
});

describe("11. agent failures", () => {
  it("do not corrupt workflow state and are not replaced by a made-up answer", async () => {
    await authorizeAndTransmit();
    const before = await store.listByWorkflow("rx1");
    const r = await orch.runAgent("doctor", "p1", async () => {
      throw new Error("model unavailable");
    });
    expect(r).toEqual({ ok: false, error: "model unavailable" });
    expect(await store.listByWorkflow("rx1")).toEqual(before);
    const log = await store.listAgentExecutions();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ agent: "doctor", ok: false, error: "model unavailable" });
  });
});

describe("12. source information", () => {
  it("every patient-facing timeline item carries its source", async () => {
    await authorizeAndTransmit();
    await send(pharmacy, "prescription.received");
    const status = prescriptionStatus(await store.listByWorkflow("rx1"));
    expect(status.timeline.length).toBeGreaterThan(0);
    for (const item of status.timeline) {
      expect(item.source).toMatchObject({
        eventId: expect.any(String),
        sourceSystem: expect.any(String),
        recordedAt: expect.any(String),
        verification: expect.any(String),
        simulated: expect.any(Boolean),
      });
    }
    expect(status.timeline.at(-1)?.source.simulated).toBe(true);
  });
  it("says 'Awaiting pharmacy confirmation' when the pharmacy status is unknown", async () => {
    await authorizeAndTransmit();
    expect(prescriptionStatus(await store.listByWorkflow("rx1")).patientText).toContain("Awaiting pharmacy confirmation");
  });
});

describe("scenario A: post-surgery prescription with a pharmacy delay", () => {
  it("runs end to end through valid states, gaps and resolution", async () => {
    // Clinician authorizes; system transmits.
    await authorizeAndTransmit();
    // Pharmacy simulator receives and acknowledges.
    advance(5);
    await send(pharmacy, "prescription.received");
    await send(pharmacy, "prescription.acknowledged");
    expect(prescriptionStatus(await store.listByWorkflow("rx1")).state).toBe("ACKNOWLEDGED");
    // Pharmacy reports a delay; no follow-up happens.
    await send(pharmacy, "prescription.delayed");
    advance(90);
    let gaps = detectGaps(await store.listByWorkflow("rx1"), iso());
    expect(gaps.map((g) => g.rule)).toEqual(["delay_unaddressed"]);
    // Clinician follows up; pharmacy resumes and asks a question; clinician answers.
    await send(clinician, "followup.completed");
    await send(pharmacy, "prescription.processing");
    await send(pharmacy, "prescription.clarification_requested");
    await send(clinician, "prescription.clarification_resolved");
    await send(pharmacy, "prescription.ready");
    advance(5);
    expect(detectGaps(await store.listByWorkflow("rx1"), iso())).toHaveLength(0);
    const status = prescriptionStatus(await store.listByWorkflow("rx1"));
    expect(status.state).toBe("READY");
    expect(status.patientText).toBe("Ready for pickup.");
    // Completion is only evidenced by a pharmacy-confirmed pickup.
    await send(pharmacy, "prescription.picked_up");
    expect(prescriptionStatus(await store.listByWorkflow("rx1")).state).toBe("PICKED_UP");
  });
});
