import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allowedReleaseSource } from "./release-safety.mjs";

const require = createRequire(import.meta.url);
const markerPath = (root) => join(root, ".next/arena-build-info.json");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** Next loads .env.local during compilation. Empty overrides prevent paid work at build time. */
export function buildEnvironment(inherited = process.env) {
  return {
    ...inherited,
    MODEL_API_KEY: "",
    DEEPSEEK_API_KEY: "",
    OPENAI_API_KEY: "",
    ARENA_WORKER_ENABLED: "false",
    ARENA_BILLING_DATABASE_PATH: "",
  };
}
function git(root, args, input) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
  });
}
const generatedRoots = new Set([
  ".next",
  "node_modules",
  "out",
  "coverage",
  "test-results",
  "playwright-report",
  "artifacts",
  "work",
  "outputs",
  "private",
  "data",
]);
function isSource(path) {
  const name = basename(path);
  return (
    !generatedRoots.has(path.split("/")[0]) &&
    path !== "next-env.d.ts" &&
    !path.endsWith(".tsbuildinfo") &&
    !(/^\.env($|\.)/.test(name) && name !== ".env.example")
  );
}
function fileIdentity(root, path) {
  const absolute = join(root, path);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    if (error.code === "ENOENT") return [path, "deleted"];
    throw error;
  }
  if (stat.isSymbolicLink()) return [path, "symlink", readlinkSync(absolute)];
  if (!stat.isFile()) throw new Error(`Unsupported source/build entry: ${path}`);
  return [path, "file", Boolean(stat.mode & 0o111), digest(readFileSync(absolute))];
}
/** Hash tracked source plus non-ignored untracked files. Never open environment/data/generated files.
 * Git ignore rules do not untrack already-tracked source, so those files stay fingerprinted. */
export function sourceIdentity(directory = process.cwd()) {
  const root = resolve(directory);
  const commit = git(root, ["rev-parse", "HEAD"]).trim();
  const paths = [
    ...new Set(
      git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
  const sourcePaths = paths.filter(isSource);
  const changed = git(root, ["diff", "--name-only", "-z", "HEAD"]).split("\0").filter(Boolean);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean);
  const identity = {
    commit,
    sourceFingerprint: digest(JSON.stringify(sourcePaths.map((path) => fileIdentity(root, path)))),
    workingTreeDirty: [...changed, ...untracked].some(isSource),
  };
  if (git(root, ["rev-parse", "HEAD"]).trim() !== commit)
    throw new Error("Git HEAD changed while checking source identity.");
  return identity;
}
/** Bind the compiled files actually copied by package-release, without following symlinks. */
export function buildOutputFingerprint(directory = process.cwd()) {
  const root = resolve(directory);
  const entries = [];
  function walk(path, filterRoot) {
    if (!allowedReleaseSource(path, filterRoot)) return;
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) walk(join(path, name), filterRoot);
      return;
    }
    entries.push(fileIdentity(root, relative(root, path)));
  }
  const standalone = join(root, ".next/standalone");
  if (
    !existsSync(join(standalone, "server.js")) ||
    !existsSync(join(root, ".next/BUILD_ID")) ||
    !existsSync(join(root, ".next/static"))
  )
    throw new Error("Standalone build is incomplete. Run pnpm build.");
  entries.push(fileIdentity(root, ".next/BUILD_ID"));
  for (const name of ["server.js", "package.json", "node_modules", ".next"]) {
    const path = join(standalone, name);
    if (existsSync(path)) walk(path, standalone);
  }
  walk(join(root, ".next/static"), root);
  return digest(JSON.stringify(entries));
}
function sameSource(a, b) {
  return (
    a.commit === b.commit &&
    a.sourceFingerprint === b.sourceFingerprint &&
    a.workingTreeDirty === b.workingTreeDirty
  );
}
export function assertBuildMatchesSource(directory = process.cwd()) {
  const root = resolve(directory);
  let info;
  try {
    info = JSON.parse(readFileSync(markerPath(root), "utf8"));
  } catch {
    throw new Error(
      "Build identity marker is missing or invalid. Run pnpm build before packaging.",
    );
  }
  if (
    info.markerVersion !== 1 ||
    !/^[a-f0-9]{40}$/.test(info.commit ?? "") ||
    !/^[a-f0-9]{64}$/.test(info.sourceFingerprint ?? "") ||
    typeof info.workingTreeDirty !== "boolean" ||
    !info.platform ||
    !info.arch ||
    !info.node ||
    !info.version ||
    !info.packageManager
  )
    throw new Error("Build identity marker is incomplete or obsolete. Run pnpm build.");
  if (!sameSource(info, sourceIdentity(root)))
    throw new Error(
      "Source or Git HEAD changed since the build. Run pnpm build again; stale compiled files cannot be relabeled.",
    );
  if (info.outputFingerprint !== buildOutputFingerprint(root))
    throw new Error(
      "Compiled build output changed since the successful build. Run pnpm build again.",
    );
  return info;
}
/** A failed/changed build never leaves an old marker that packaging could mistake for success. */
export function build({ directory = process.cwd(), run } = {}) {
  const root = resolve(directory);
  rmSync(markerPath(root), { force: true });
  const before = sourceIdentity(root);
  try {
    if (run) run(root);
    else
      execFileSync(process.execPath, [require.resolve("next/dist/bin/next"), "build"], {
        cwd: root,
        stdio: "inherit",
        env: buildEnvironment(),
      });
    const after = sourceIdentity(root);
    if (!sameSource(before, after))
      throw new Error(
        "Source or Git HEAD changed during next build; no build identity was recorded.",
      );
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const info = {
      markerVersion: 1,
      ...after,
      outputFingerprint: buildOutputFingerprint(root),
      builtAt: new Date().toISOString(),
      version: pkg.version,
      packageManager: pkg.packageManager,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    };
    mkdirSync(dirname(markerPath(root)), { recursive: true });
    writeFileSync(markerPath(root), JSON.stringify(info, null, 2) + "\n");
    return info;
  } catch (error) {
    rmSync(markerPath(root), { force: true });
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    build();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Build failed; no valid build identity was saved.",
    );
    process.exitCode = 1;
  }
}
