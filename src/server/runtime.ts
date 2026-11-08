import { Orchestrator } from "./orchestrator";
import { InMemoryEventStore, type EventStore } from "./store";

interface Runtime {
  store: EventStore;
  orchestrator: Orchestrator;
  /** Demo-only clock offset so time-based care gaps can be shown live. Always shown to the operator. */
  clock: { offsetMs: number };
}

const KEY = Symbol.for("careos.runtime");
type G = typeof globalThis & { [KEY]?: Runtime };

function build(): Runtime {
  // In-memory only for now. A Postgres/Timescale store will replace this behind the same interface.
  const store = new InMemoryEventStore();
  return { store, orchestrator: new Orchestrator(store), clock: { offsetMs: 0 } };
}

/** "Now" as the care-gap engine sees it: real time plus any demo offset. */
export function nowMs(): number {
  return Date.now() + runtime().clock.offsetMs;
}

/** One runtime per process, preserved across dev hot reloads. */
export function runtime(): Runtime {
  const g = globalThis as G;
  return (g[KEY] ??= build());
}

/** Test helper. */
export function resetRuntime(): void {
  (globalThis as G)[KEY] = build();
}
