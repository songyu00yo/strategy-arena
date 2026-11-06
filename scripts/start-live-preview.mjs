import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const protectedPorts = new Set([3000, 3001, 3100, 3101, 3200, 3302, 3303]);
function absolute(value, name) {
  if (typeof value !== "string" || !isAbsolute(value))
    throw new Error(`${name} must be an absolute path.`);
  return resolve(value);
}
function outsideRelease(path, release) {
  const rel = relative(release, path);
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)))
    throw new Error("Preview data, environment and session files must be outside the release.");
}
export function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () =>
      reject(new Error("Preview port is unavailable; no process stopped.")),
    );
    probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => probe.close(resolve));
  });
}
function billingStatus(databasePath) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        join(root, "scripts/billing-admin.ts"),
        "status",
        "--database",
        databasePath,
      ],
      {
        cwd: root,
        env: { PATH: process.env.PATH },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
}
function sessionSecret(path, create) {
  if (!existsSync(path)) {
    if (!create) return undefined;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Session file must be an owned regular file with permissions 0600.");
    const secret = readFileSync(fd, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error("Session file has an invalid format.");
    return secret;
  } finally {
    closeSync(fd);
  }
}

/** --check validates the same launch constraints without creating data or starting an app. */
export async function prepareLivePreview(options, dependencies = {}) {
  if ((dependencies.nodeVersion ?? process.versions.node).split(".")[0] !== "24")
    throw new Error("Node.js 24 is required.");
  const release = absolute(options.release, "release");
  const envFile = absolute(options.envFile, "env-file");
  const database = absolute(options.database, "database");
  const billingDatabase = absolute(options.billingDatabase, "billing-database");
  const sessionFile = absolute(
    options.sessionFile ?? join(dirname(database), "live-preview-session.key"),
    "session-file",
  );
  if (!sessionFile.endsWith(".key"))
    throw new Error("Session file must use the ignored .key suffix.");
  for (const path of [envFile, database, billingDatabase, sessionFile])
    outsideRelease(path, release);
  if (new Set([envFile, database, billingDatabase, sessionFile]).size !== 4)
    throw new Error(
      "Environment, application database, billing database and session file must be distinct.",
    );
  for (const path of [envFile, database, billingDatabase, sessionFile]) {
    if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()))
      throw new Error("Preview paths must be regular files, never symlinks.");
  }
  if (!existsSync(envFile)) throw new Error("Environment file does not exist.");
  const portText = String(options.port ?? 3340);
  const port = Number(portText);
  if (
    !/^\d+$/.test(portText) ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    protectedPorts.has(port)
  )
    throw new Error("Use a nonreserved local preview port (default 3340; 3302/3303 are reserved).");
  const info = JSON.parse(readFileSync(join(release, "release-info.json"), "utf8"));
  if (
    !/^[a-f0-9]{40}$/.test(info.commit ?? "") ||
    info.workingTreeDirty !== false ||
    !/^[a-f0-9]{64}$/.test(info.sourceFingerprint ?? "") ||
    !/^[a-f0-9]{64}$/.test(info.outputFingerprint ?? "") ||
    !Number.isFinite(Date.parse(info.builtAt)) ||
    info.platform !== process.platform ||
    info.arch !== process.arch ||
    info.node !== process.version
  )
    throw new Error(
      "Release must have a clean full SHA and complete build identity for this platform and Node version.",
    );
  if (
    ![
      "server.js",
      ".next/BUILD_ID",
      ".next/static",
      "migrations/001_initial.sql",
      "migrations/billing/002_limit_audit.sql",
    ].every((path) => existsSync(join(release, path)))
  )
    throw new Error("Standalone release is incomplete.");
  const billing = (dependencies.readBillingStatus ?? billingStatus)(billingDatabase);
  if (
    billing.usdLimitMicros !== 10_000_000 ||
    billing.requestLimit !== 300 ||
    billing.tokenLimit !== 5_000_000 ||
    billing.hardTotalUsdMicros !== 200_000_000 ||
    billing.developmentMaxUsdMicros !== 120_000_000 ||
    billing.finalReserveUsdMicros !== 80_000_000 ||
    !billing.activeStage ||
    billing.revision < 1
  )
    throw new Error(
      "Ledger must already have audited cumulative USD 10 / 300 requests / 5000000 token limits; launcher never raises them.",
    );
  if (
    billing.committedUsdMicros >= billing.usdLimitMicros ||
    billing.requests >= billing.requestLimit ||
    billing.tokens >= billing.tokenLimit
  )
    throw new Error("Shared billing allowance is exhausted.");
  await (dependencies.assertPortFree ?? assertPortFree)(port);
  const secret = sessionSecret(sessionFile, !options.check);
  if (!options.check) mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
    ARENA_DATABASE_PATH: database,
    ARENA_BILLING_DATABASE_PATH: billingDatabase,
    ARENA_BILLING_USD_LIMIT: String(billing.usdLimitMicros / 1_000_000),
    ARENA_BILLING_REQUEST_LIMIT: String(billing.requestLimit),
    ARENA_BILLING_TOKEN_LIMIT: String(billing.tokenLimit),
    ARENA_SESSION_SECRET: secret,
    ARENA_PUBLIC_DEMO: "true",
    ARENA_ACCESS_CODE: "",
    ARENA_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    ARENA_WORKER_ENABLED: "false",
    ARENA_RUN_BUDGET_USD: "0.5",
    ARENA_RUN_BUDGET_CNY: "3",
    ARENA_GLOBAL_BUDGET_USD: "10",
    ARENA_GLOBAL_BUDGET_CNY: "60",
    ARENA_MAX_CONCURRENT_CALLS: "1",
  };
  return { release, envFile, port, commit: info.commit, sessionFile, env };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        release: { type: "string" },
        "env-file": { type: "string" },
        database: { type: "string" },
        "billing-database": { type: "string" },
        port: { type: "string" },
        "session-file": { type: "string" },
        check: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    });
    if (values.help) {
      console.log(
        "node scripts/start-live-preview.mjs --release ABS --env-file ABS --database ABS --billing-database ABS [--port 3340] [--session-file ABS.key] [--check]\nReal production API on loopback only. --check starts no app and makes no model requests. Stop with Ctrl-C.",
      );
    } else {
      const config = await prepareLivePreview({
        release: values.release,
        envFile: values["env-file"],
        database: values.database,
        billingDatabase: values["billing-database"],
        port: values.port,
        sessionFile: values["session-file"],
        check: values.check,
      });
      console.log(
        `${values.check ? "Validated" : "Starting"} real local preview http://127.0.0.1:${config.port}; release ${config.commit}; worker disabled.`,
      );
      if (!values.check) {
        const child = spawn(
          process.execPath,
          [`--env-file=${config.envFile}`, join(config.release, "server.js")],
          { cwd: config.release, env: config.env, stdio: "inherit" },
        );
        let stopping = false;
        for (const signal of ["SIGINT", "SIGTERM"])
          process.on(signal, () => {
            stopping = true;
            child.kill(signal);
          });
        child.on("error", () => {
          console.error("Preview process could not start; no configuration values printed.");
          process.exitCode = 1;
        });
        child.on("exit", (code) => {
          process.exitCode = stopping ? 0 : (code ?? 1);
        });
      }
    }
  } catch {
    console.error(
      "Live preview validation/start failed. Check paths, clean release identity, audited billing caps, session permissions and port availability. No secrets printed.",
    );
    process.exitCode = 1;
  }
}
