# Workflow state machines

Source of truth is the code in `src/domain/`. Invalid transitions and unauthorised actors are rejected. No `agent` actor can move a prescription.

## Prescription (`prescription.ts`)
| Event | From | To | Actor |
|---|---|---|---|
| authorized | DRAFT | AUTHORIZED | clinician |
| transmitted | AUTHORIZED | TRANSMITTED | system |
| failed | TRANSMITTED | FAILED | system |
| received | TRANSMITTED | RECEIVED | pharmacy_sim |
| acknowledged | RECEIVED | ACKNOWLEDGED | pharmacy_sim |
| processing | ACKNOWLEDGED, DELAYED | PROCESSING | pharmacy_sim |
| delayed | ACKNOWLEDGED, PROCESSING | DELAYED | pharmacy_sim |
| clarification_requested | ACKNOWLEDGED, PROCESSING | CLARIFICATION_REQUIRED | pharmacy_sim |
| clarification_resolved | CLARIFICATION_REQUIRED | PROCESSING | clinician |
| ready | PROCESSING | READY_FOR_PICKUP | pharmacy_sim |
| picked_up | READY_FOR_PICKUP | PICKED_UP | pharmacy_sim |
| rejected | RECEIVED, ACKNOWLEDGED, PROCESSING | REJECTED | pharmacy_sim |
| cancelled | any non-terminal | CANCELLED | clinician |

`prescription.pickup_reported` (patient/caregiver) is recorded as patient-reported and changes no state.

## Care plan (`carePlan.ts`)
DRAFT → PENDING_REVIEW (clinician or agent submits) → APPROVED (clinician only). SUPERSEDED is declared but has no transition yet.

## Care task, clarification, care gap (`lifecycles.ts`)
- **Task:** CREATED → ASSIGNED → SCHEDULED → IN_PROGRESS → COMPLETED. COMPLETED requires evidence. Also BLOCKED, OVERDUE (system), NEEDS_CLARIFICATION (agent may raise), CANCELLED.
- **Clarification:** CREATED → ASSIGNED → REVIEWED → RESPONSE_PREPARED (agent may prepare) → APPROVED (clinician only) → RESOLVED.
- **Care gap:** DETECTED → ASSIGNED → ACKNOWLEDGED → ACTION_IN_PROGRESS → RESOLVED, plus ESCALATED (system) and DISMISSED_WITH_REASON (clinician, reason required). Reopen requires a reason and appends to history; nothing is deleted.

## Dose status (`dose.ts`)
scheduled → taken / not_taken / unsure (patient-reported) or unconfirmed after the grace window. There is intentionally no "missed".
