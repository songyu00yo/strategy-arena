import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";

// Exercise the same safe standalone package that will be released.
mkdirSync("work", { recursive: true });
const directory = mkdtempSync(resolve("work/e2e-release-"));
const archive = join(directory, "build.tar.gz");
const serverDirectory = join(directory, "server");
mkdirSync(serverDirectory);
execFileSync(process.execPath, ["scripts/package-release.mjs", archive], { stdio: "inherit" });
execFileSync("tar", ["-xzf", archive, "-C", serverDirectory]);
const server = spawn(process.execPath, ["server.js"], { cwd: serverDirectory, stdio: "inherit", env: { ...process.env, HOSTNAME: "127.0.0.1", PORT: "3100", ARENA_DATABASE_PATH: resolve("test-results/e2e.sqlite") } });
let stopping = false;
function stop(signal) { stopping = true; server.kill(signal); }
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
server.on("exit", (code) => { rmSync(directory, { recursive: true, force: true }); process.exitCode = stopping ? 0 : (code ?? 1); });
