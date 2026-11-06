/** Operator-only export of an acceptance run's own identity. Never makes a model request. */
import { createHmac } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { sha256 } from "./live-acceptance-plan";

export function acceptanceBrowserState(
  owner: string,
  arenaId: string,
  origin: string,
  secret: string,
  production: boolean,
) {
  if (!/^[a-f0-9-]{36}$/.test(owner) || !/^[a-f0-9-]{36}$/.test(arenaId))
    throw new Error("Acceptance owner and arena IDs must be UUIDs");
  const url = new URL(origin);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Only a loopback origin is allowed");
  if (secret.length < 32) throw new Error("Session secret is invalid");
  const signature = createHmac("sha256", secret).update(owner).digest("base64url");
  return {
    cookies: [
      {
        name: "arena_owner",
        value: `${owner}.${signature}`,
        domain: url.hostname,
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 86400,
        httpOnly: true,
        secure: production || url.protocol === "https:",
        sameSite: "Lax" as const,
      },
    ],
    origins: [
      { origin: url.origin, localStorage: [{ name: "strategy-arena:last-id", value: arenaId }] },
    ],
  };
}

const RecordSchema = z.object({
  kind: z.literal("real-runtime-on-synthetic-input"),
  databaseIdentity: z.string(),
  cases: z.array(z.object({ id: z.string(), owner: z.string(), arenaId: z.string().optional() })),
});
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "pnpm exec tsx scripts/export-acceptance-browser-state.ts --record artifacts/RUN.json --case CASE --origin http://127.0.0.1:3340 --session-file /absolute/private/session-key --out artifacts/private/state.json\nRequires explicit matching ARENA_DATABASE_PATH and ARENA_BILLING_DATABASE_PATH. No environment files, model requests or access-code grants. Session files must be regular private files (0600). Output carries private browser identity; do not publish.",
    );
    return;
  }
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index],
      value = args[index + 1];
    if (
      !["--record", "--case", "--origin", "--session-file", "--out"].includes(key) ||
      !value ||
      value.startsWith("--") ||
      values[key]
    )
      throw new Error("Invalid export arguments");
    values[key] = value;
  }
  for (const key of ["--record", "--case", "--origin", "--session-file", "--out"])
    if (!values[key]) throw new Error("Missing export argument");
  for (const key of ["ARENA_DATABASE_PATH", "ARENA_BILLING_DATABASE_PATH"])
    if (!process.env[key] || !isAbsolute(process.env[key]!))
      throw new Error("Explicit absolute database paths are required");
  if (!existsSync(process.env.ARENA_DATABASE_PATH!))
    throw new Error("Arena database does not exist");
  const privateRoot = resolve("artifacts/private");
  const output = resolve(values["--out"]);
  if (!output.startsWith(`${privateRoot}${sep}`) || existsSync(output))
    throw new Error("Choose a new output under artifacts/private/");
  const recordPath = resolve(values["--record"]);
  if (!recordPath.startsWith(`${resolve("artifacts")}${sep}`))
    throw new Error("Record must be under artifacts/");
  const record = RecordSchema.parse(JSON.parse(readFileSync(recordPath, "utf8")));
  const databaseIdentity = sha256(
    JSON.stringify([process.env.ARENA_DATABASE_PATH, process.env.ARENA_BILLING_DATABASE_PATH]),
  );
  if (record.databaseIdentity !== databaseIdentity)
    throw new Error("Record database identity does not match");
  const item = record.cases.find((candidate) => candidate.id === values["--case"]);
  if (!item?.arenaId) throw new Error("Selected case has no saved arena");
  const sessionFile = values["--session-file"];
  if (!isAbsolute(sessionFile)) throw new Error("Session file path must be absolute");
  const stat = statSync(sessionFile);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600)
    throw new Error("Session file must be a regular file with mode 0600");
  const secret = readFileSync(sessionFile, "utf8").trim();
  // This explicit file is the same private key used by the operator's local server.
  // It is never printed, stored in the output, or loaded from an environment file.
  if (secret.length < 32) throw new Error("Session secret is invalid");
  process.env.ARENA_SESSION_SECRET = secret;
  const { getArena } = await import("../src/lib/server/runtime");
  const { sessionSecret, closeDb } = await import("../src/lib/server/db");
  try {
    const snapshot = getArena(item.arenaId, item.owner); // Existing runtime ownership check.
    const state = acceptanceBrowserState(
      item.owner,
      snapshot.id,
      values["--origin"],
      sessionSecret(),
      process.env.NODE_ENV === "production",
    );
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    writeFileSync(output, JSON.stringify(state, null, 2), { mode: 0o600, flag: "wx" });
    chmodSync(output, 0o600);
    console.log(JSON.stringify({ output, caseId: item.id, modelRequests: 0 }));
  } finally {
    closeDb();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(
      "Browser-state export refused. Check explicit paths, private-file permissions, matching database identity, case UUID owner and server session key. No secrets printed and no model requests made.",
    );
    process.exitCode = 1;
  });
}
