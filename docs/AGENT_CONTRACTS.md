# Agent contracts

**Status: contracts defined. No agent is implemented and nothing calls Gemini yet** (no API key).

Rules for all agents: structured JSON in and out (Zod-validated); tools enforce authorization server-side; agents never write workflow state, they call orchestrator-validated tools; agents communicate only through the orchestrator using the message envelope below; a Gemini failure surfaces an "AI unavailable" state and never a made-up answer.

## Message envelope
`message_id, sender_agent, recipient_agent, patient_id, workflow_id, message_type, structured_payload, source_references, created_at, authorization_context, correlation_id`

## Patient Agent
- **Tools:** get_approved_care_plan, get_medication_schedule, get_prescription_status, get_upcoming_appointments, get_care_timeline, create_clarification_request, record_patient_report.
- **Forbidden:** prescribing, changing medication, diagnosing, inventing instructions, marking a pharmacy workflow complete.
- **Urgent symptoms:** fixed safety message directing to human medical services; no triage.

## Doctor Agent
- **Tools:** get_patient_summary, get_pending_clarifications, draft_care_plan, draft_follow_up_message, get_care_gap_summary, submit_for_clinician_review.
- **Forbidden:** approving its own drafts, prescribing, changing authorized medication instructions, diagnosing.
- **Enforced in code today:** an `agent` actor cannot approve a care plan or authorize a prescription (tests in `careos.test.ts`).

## Pharmacy Agent
- **Tools:** get_prescription_workflow, get_pharmacy_events, summarize_fulfillment_status, create_administrative_clarification, draft_status_notification.
- **Forbidden:** prescribing, substituting, modifying prescriptions, claiming inventory without data, manufacturing fulfillment confirmations.
- **Enforced in code today:** `ready` and `picked_up` require a `pharmacy_sim` actor with `simulated: true`.
