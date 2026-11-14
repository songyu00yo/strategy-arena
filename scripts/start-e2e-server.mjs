import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { e2eAddress } from "./test-address.mjs";

const { port } = e2eAddress();

// Exercise the same safe standalone package that will be released.
mkdirSync("work", { recursive: true });
const directory = mkdtempSync(resolve("work/e2e-release-"));
const archive = join(directory, "build.tar.gz");
const serverDirectory = join(directory, "server");
mkdirSync(serverDirectory);
execFileSync(process.execPath, ["scripts/package-release.mjs", archive], { stdio: "inherit" });
execFileSync("tar", ["-xzf", archive, "-C", serverDirectory]);
const server = spawn(process.execPath, ["server.js"], {
  cwd: serverDirectory,
  stdio: "inherit",
  env: {
    ...process.env,
    MODEL_API_KEY: "",
    DEEPSEEK_API_KEY: "",
    OPENAI_API_KEY: "",
    TAVILY_API_KEY: "",
    ARENA_ACCEPTANCE_BATCH_ID: "",
    ARENA_TOOL_BATCH_ID: "",
    ARENA_BILLING_DATABASE_PATH: "",
    ARENA_WORKER_ENABLED: "false",
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
    ARENA_DATABASE_PATH: resolve("test-results/e2e.sqlite"),
  },
});
let stopping = false;
function stop(signal) {
  stopping = true;
  server.kill(signal);
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
server.on("exit", (code) => {
  rmSync(directory, { recursive: true, force: true });
  process.exitCode = stopping ? 0 : (code ?? 1);
});
