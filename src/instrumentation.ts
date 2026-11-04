export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.ARENA_WORKER_ENABLED === "true") {
    const { startArenaWorker } = await import("./lib/server/runner");
    startArenaWorker();
  }
}
