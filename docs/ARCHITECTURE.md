# Architecture (actual, current)

`[BUILT]` = exists and tested. `[PENDING]` = not built.

```
 Patient Portal [PENDING]      Doctor Portal [PENDING]      Pharmacy simulator [PENDING]
        \                           |                            /
         \--------------- API routes + auth [PENDING] ----------/
                                    |
                    CareOS Orchestrator [BUILT: src/server/orchestrator.ts]
          identity check · authorization · idempotency · state machines
                 |                      |                       |
   Domain rules [BUILT]        Care Gap Engine [BUILT rules]     Agents [PENDING]
   src/domain/*                src/domain/careGap.ts             Gemini x3
                 \                      |                       /
                  \--------------- EventStore ----------------/
                       InMemory [BUILT]   ·   Postgres/TimescaleDB [PENDING]
```

## Principles in force
- Deterministic orchestrator; agents are not a fourth LLM.
- State derived from events; patient and doctor views share one function.
- Agents hold no clinical authority.
- Simulated pharmacy events are always flagged.

## Pending infrastructure
Tiger Data (hypertables, continuous aggregates), Gemini, Vultr deployment, Entire, domain. See `IMPLEMENTATION_STATUS.md`.
