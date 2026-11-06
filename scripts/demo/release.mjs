import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sourceIdentity } from "../build.mjs";

/** The copied bundle has its own build identity; a HEAD-only stamp misses dirty config/source. */
export function demoReleaseIsCurrent(directory, serverDir) {
  let release;
  try {
    release = JSON.parse(readFileSync(join(serverDir, "release-info.json"), "utf8"));
  } catch {
    return false;
  }
  if (!release || typeof release !== "object") return false;
  const source = sourceIdentity(directory);
  return (
    release.commit === source.commit &&
    release.sourceFingerprint === source.sourceFingerprint &&
    release.workingTreeDirty === source.workingTreeDirty &&
    /^[a-f0-9]{64}$/.test(release.outputFingerprint ?? "") &&
    typeof release.builtAt === "string" &&
    Number.isFinite(Date.parse(release.builtAt)) &&
    release.platform === process.platform &&
    release.arch === process.arch &&
    release.node === process.version &&
    ["server.js", ".next/BUILD_ID", ".next/static"].every((path) =>
      existsSync(join(serverDir, path)),
    )
  );
}

/** Allowlist the page process environment; inherited credentials and Node preload flags stay out. */
export function demoPageEnvironment(root, port, inherited = process.env) {
  return {
    PATH: inherited.PATH,
    NODE_ENV: "production",
    MODEL_API_KEY: "",
    DEEPSEEK_API_KEY: "",
    OPENAI_API_KEY: "",
    MODEL_BASE_URL: "",
    MODEL_ID: "",
    ARENA_WORKER_ENABLED: "false",
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
    ARENA_DATABASE_PATH: join(root, "demo.sqlite"),
  };
}
