import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Local development must not inherit production credentials or a production database. */
export function developmentConfig(role, directory = root, inherited = process.env) {
  if (!["codex", "claude"].includes(role)) throw new Error("Use codex or claude.");
  const port = role === "codex" ? 3000 : 3001;
  return {
    port,
    env: {
      ...inherited,
      NODE_ENV: "development",
      NEXT_TELEMETRY_DISABLED: "1",
      MODEL_API_KEY: "",
      ARENA_DATABASE_PATH: join(resolve(directory), "work", "dev", `${role}.sqlite`),
      ARENA_SESSION_SECRET: "", // The isolated database creates its own development secret.
      ARENA_ACCESS_CODE: "",
      ARENA_PUBLIC_DEMO: "false",
      ARENA_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
      ARENA_WORKER_ENABLED: "false",
      ARENA_GLOBAL_BUDGET_CNY: "1",
      ARENA_RUN_BUDGET_CNY: "1",
      RELEASE_COMMIT: "",
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--help") {
    console.log(
      "node scripts/dev-local.mjs codex|claude\nNo model calls. Ports: 3000/3001. Stop with Ctrl-C. Use a separate browser profile from the preview on 3200.",
    );
  } else {
    try {
      if (process.versions.node.split(".")[0] !== "24") throw new Error("Node.js 24 is required.");
      const config = developmentConfig(process.argv[2]);
      process.umask(0o077);
      mkdirSync(dirname(config.env.ARENA_DATABASE_PATH), { recursive: true, mode: 0o700 });
      const require = createRequire(import.meta.url);
      console.log(
        `Local ${process.argv[2]} development: http://127.0.0.1:${config.port} (model disabled)`,
      );
      const child = spawn(
        process.execPath,
        [
          require.resolve("next/dist/bin/next"),
          "dev",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(config.port),
        ],
        {
          cwd: root,
          env: config.env,
          stdio: "inherit",
        },
      );
      let stopping = false;
      for (const signal of ["SIGINT", "SIGTERM"])
        process.on(signal, () => {
          stopping = true;
          child.kill(signal);
        });
      child.on("error", (error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
      child.on("exit", (code) => {
        process.exitCode = stopping ? 0 : (code ?? 1);
      });
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
