# Implementation status

Last updated by the build agent. Anything not marked DONE is not done.

## Done and verified (tests run, type-check clean)
- Next.js + TypeScript + Tailwind scaffold, git initialised.
- Event envelope with verification categories and simulation flag (`src/domain/events.ts`).
- Prescription state machine incl. `FAILED`, `READY_FOR_PICKUP`, `CLARIFICATION_REQUIRED`.
- Care-plan approval rule (clinician-only).
- Care task, clarification and care-gap lifecycles with recorded history (`src/domain/lifecycles.ts`).
- Reminder derivation that refuses to invent doses/times; unanswered = `unconfirmed`, never missed.
- Care-gap detection rules with deterministic keys.
- Orchestrator: identity match, per-patient authorization, idempotency, agent-run wrapper.
- Status view shared by patient and doctor, every item carries source info.
- Tests: `tests/careos.test.ts`, `tests/lifecycles.test.ts`.

## Not started
| Item | Why |
|---|---|
| SQL migrations, hypertables, continuous aggregates | Need a TimescaleDB instance to run and verify them. No Tiger Data URL, Docker daemon not running. SQL will not be committed unrun. |
| Postgres `EventStore` implementation | Same blocker. In-memory store only. |
| Seed data | Depends on schema. |
| API routes and auth | Next.js version has breaking changes (see AGENTS.md); docs in `node_modules/next/dist/docs/` must be read first. |
| Patient and Doctor portals | Depends on API. |
| Gemini agents | No `GEMINI_API_KEY`. Contracts are in `AGENT_CONTRACTS.md` but nothing calls Gemini yet. |
| Notifications, reminder scheduler | Depends on API/DB. |
| Out-of-order event delivery | Currently out-of-order events are rejected, not buffered. Needs a design and tests (see ADR-009). |
| Analytics | Depends on aggregates. |
| Entire, Vultr, GoDaddy, Grok Bot | See `SPONSOR_INTEGRATIONS.md`. |

## Blockers needing the user
1. `GEMINI_API_KEY`.
2. A Tiger Cloud service URL (preferred) or permission to start Docker Desktop and pull a TimescaleDB image.
3. Vultr account/credentials, and the `entire` CLI installed.
