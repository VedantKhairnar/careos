import { Orchestrator } from "./orchestrator";
import { PgEventStore } from "./pgStore";
import { InMemoryEventStore, type EventStore } from "./store";

interface Runtime {
  store: EventStore;
  orchestrator: Orchestrator;
  /** Demo-only clock offset so time-based care gaps can be shown live. Always shown to the operator. */
  clock: { offsetMs: number };
  /** The class the store was built from. If code reloads and the class changes, the runtime is rebuilt. */
  storeCtor: unknown;
}

const KEY = Symbol.for("careos.runtime");
type G = typeof globalThis & { [KEY]?: Runtime };

const wantsPg = () => Boolean(process.env.DATABASE_URL) && process.env.NODE_ENV !== "test" && process.env.CAREOS_STORE !== "memory";

function build(): Runtime {
  // Tiger Data (Postgres/TimescaleDB) when DATABASE_URL is set; in-memory otherwise. Tests always use memory
  // unless they build a PgEventStore themselves, so running them can never touch a real database.
  const usePg = wantsPg();
  const store: EventStore = usePg ? new PgEventStore() : new InMemoryEventStore();
  return { store, orchestrator: new Orchestrator(store), clock: { offsetMs: 0 }, storeCtor: usePg ? PgEventStore : InMemoryEventStore };
}

/** "Now" as the care-gap engine sees it: real time plus any demo offset. */
export function nowMs(): number {
  return Date.now() + runtime().clock.offsetMs;
}

/** One runtime per process, preserved across dev hot reloads. */
export function runtime(): Runtime {
  const g = globalThis as G;
  const ctor = wantsPg() ? PgEventStore : InMemoryEventStore;
  // In development the server reloads code without restarting. A runtime built from an older version of the store
  // would lack newer methods (and was the cause of "this storage cannot be reset"), so rebuild it when the class
  // changes. The demo clock offset is carried over.
  if (!g[KEY] || g[KEY]!.storeCtor !== ctor) {
    const offsetMs = g[KEY]?.clock.offsetMs ?? 0;
    g[KEY] = build();
    g[KEY]!.clock.offsetMs = offsetMs;
  }
  return g[KEY]!;
}

/** Test helper. */
export function resetRuntime(): void {
  (globalThis as G)[KEY] = build();
}
