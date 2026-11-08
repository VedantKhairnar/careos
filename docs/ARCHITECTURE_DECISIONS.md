# Architecture decision log

Format: decision, reason, expected benefit, trade-off.

## ADR-001: Single Next.js app, not a pnpm/Turborepo monorepo
- **Why:** The project already had a working scaffold and tested domain core; the original spec asks for the smallest maintainable architecture with no unnecessary services.
- **Benefit:** Faster to ship; one build, one deploy target.
- **Trade-off:** Package boundaries are folders (`src/domain`, `src/server`, later `src/agents`), not workspaces. Revisit if a second deployable appears. Folder names deliberately mirror the proposed packages so a split is mechanical.

## ADR-002: Prescription state is derived from the event history
- **Why:** If state were stored separately from events, the patient view and doctor view could disagree.
- **Benefit:** One source of truth; full audit by construction; replayable.
- **Trade-off:** Reads fold the event list. Fine at demo scale; use a materialised state table later if needed.

## ADR-003: Patient and doctor statuses come from one function
- **Why:** Spec requires consistent statuses. `prescriptionStatus()` is the only place that computes them.
- **Benefit:** Consistency cannot regress silently; covered by a test.

## ADR-004: Patient-reported pickup is a separate event that does not change state
- **Why:** Spec: patient-reported and verified information must stay distinct; completion needs evidence.
- **Benefit:** `PICKED_UP` can only come from the pharmacy simulator.
- **Trade-off:** The patient's report is visible on the timeline but the workflow stays `READY_FOR_PICKUP` until the pharmacy confirms.

## ADR-005: The `agent` role appears in no clinical transition
- **Why:** An LLM must never authorize, approve or complete clinical workflow steps.
- **Benefit:** Enforced in a table, not in prompts; mutation-tested (making clinician-ready or agent-authorize pass fails the suite).
- **Exception by design:** agents may submit a care plan for review, prepare a clarification response, and raise a task clarification.

## ADR-006: No "missed dose" state
- **Why:** A non-response is not evidence the dose was not taken.
- **Benefit:** Wording stays truthful; the state is `unconfirmed`.

## ADR-007: State names aligned with the implementation addendum
- Renamed `READY`→`READY_FOR_PICKUP`, `CLARIFICATION_REQUESTED`→`CLARIFICATION_REQUIRED`, added `FAILED` (system-detected transmission failure). Event type names unchanged.

## ADR-008: In-memory store for tests behind an `EventStore` interface
- **Why:** Domain logic can be verified without a database.
- **Trade-off:** Passing in-memory tests does not prove the SQL layer; the Postgres implementation needs its own tests when a database is available.

## ADR-009: Out-of-order delivery is not yet supported (open)
- **Problem:** An event that arrives before its predecessor (e.g. `acknowledged` before `received`) is rejected, because it cannot be told apart from an invalid event on arrival.
- **Options:** (a) buffer early events per workflow and retry after each applied event, with a cap and expiry; (b) require a per-workflow sequence number from sources. Option (b) is cleaner for the simulator we control.
- **Status:** Undecided; no code. Tracked in IMPLEMENTATION_STATUS.md.
