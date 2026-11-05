import { advanceArena, modelInfo } from "./runtime";
import { ArenaError, atomic, db } from "./db";
import { expireLeases } from "./runtime";

type WorkerState = {
  timer: ReturnType<typeof setInterval>;
  stopped: boolean;
  active: Set<string>;
  cooldowns: Map<string, number>;
};
type WorkerGlobal = typeof globalThis & { __strategyArenaWorker?: WorkerState };
const globalWorker = globalThis as WorkerGlobal;

/** Long-lived Node process only. SQLite claims remain authoritative across workers and UI triggers. */
export function startArenaWorker(): (() => void) | undefined {
  if (process.env.ARENA_WORKER_ENABLED !== "true" || !modelInfo().configured) return undefined;
  if (globalWorker.__strategyArenaWorker && !globalWorker.__strategyArenaWorker.stopped)
    return () => stopArenaWorker();
  const state: WorkerState = {
    timer: undefined as unknown as ReturnType<typeof setInterval>,
    stopped: false,
    active: new Set(),
    cooldowns: new Map(),
  };
  globalWorker.__strategyArenaWorker = state;
  state.timer = setInterval(() => {
    void tick(state);
  }, 1000);
  state.timer.unref?.();
  return () => stopArenaWorker();
}
export function stopArenaWorker() {
  const state = globalWorker.__strategyArenaWorker;
  if (!state) return;
  state.stopped = true;
  clearInterval(state.timer);
  delete globalWorker.__strategyArenaWorker;
}
async function tick(state: WorkerState) {
  if (state.stopped) return;
  for (const [key, until] of state.cooldowns) if (until <= Date.now()) state.cooldowns.delete(key);
  try {
    if (!modelInfo().configured) return;
    const candidates = atomic(() => {
      expireLeases();
      return db()
        .prepare(
          "SELECT a.id,a.owner,a.active_version_id FROM arenas a JOIN versions v ON v.id=a.active_version_id WHERE json_extract(v.body,'$.status') IN ('ready','running') AND NOT EXISTS(SELECT 1 FROM steps s WHERE s.version_id=v.id AND s.status='running') ORDER BY a.created_at LIMIT 100",
        )
        .all() as { id: string; owner: string; active_version_id: string }[];
    });
    for (const row of candidates) {
      if (state.stopped || state.active.size >= 3) break;
      if (state.active.has(row.id) || state.cooldowns.has(row.id)) continue;
      state.active.add(row.id);
      void advanceArena(row.id, row.owner, row.active_version_id)
        .catch((error) => {
          // Budget/key/concurrency failures happen before network requests. Delay without replaying uncertain calls.
          const delay =
            error instanceof ArenaError && (error.status === 429 || error.status === 503)
              ? 30_000
              : 60_000;
          state.cooldowns.set(row.id, Date.now() + delay);
        })
        .finally(() => {
          state.active.delete(row.id);
        });
    }
  } catch {
    // Startup/database/configuration failures are retried by this same single bounded polling loop.
  }
}
