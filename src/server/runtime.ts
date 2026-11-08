import { Orchestrator } from "./orchestrator";
import { InMemoryEventStore, type EventStore } from "./store";

interface Runtime {
  store: EventStore;
  orchestrator: Orchestrator;
}

const KEY = Symbol.for("careos.runtime");
type G = typeof globalThis & { [KEY]?: Runtime };

function build(): Runtime {
  // In-memory only for now. A Postgres/Timescale store will replace this behind the same interface.
  const store = new InMemoryEventStore();
  return { store, orchestrator: new Orchestrator(store) };
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
