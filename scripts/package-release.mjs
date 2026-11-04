import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { allowedReleaseSource, assertReleaseSafe } from "./release-safety.mjs";
import { assertBuildMatchesSource } from "./build.mjs";

const output = process.argv[2];
if (!output || !output.endsWith(".tar.gz"))
  throw new Error("Usage: node scripts/package-release.mjs <output.tar.gz>");
if (!existsSync(".next/standalone/server.js"))
  throw new Error("Run pnpm build first; standalone/server.js is missing.");
const buildInfo = assertBuildMatchesSource();
const destination = resolve(output);
const staging = mkdtempSync(join(tmpdir(), "strategy-arena-release-"));
try {
  // Root allowlist prevents broad file tracing from copying project/private folders.
  for (const name of ["server.js", "package.json", "node_modules", ".next"]) {
    const source = join(".next/standalone", name);
    if (existsSync(source))
      cpSync(source, join(staging, name), {
        recursive: true,
        filter: (path) => allowedReleaseSource(path, ".next/standalone"),
        verbatimSymlinks: true,
      });
  }
  cpSync("migrations", join(staging, "migrations"), {
    recursive: true,
    filter: (path) => path.endsWith("migrations") || path.endsWith(".sql"),
  });
  mkdirSync(join(staging, ".next/static"), { recursive: true });
  cpSync(".next/static", join(staging, ".next/static"), {
    recursive: true,
    filter: (path) => allowedReleaseSource(path, "."),
    verbatimSymlinks: true,
  });
  if (existsSync("public"))
    cpSync("public", join(staging, "public"), {
      recursive: true,
      filter: (path) => allowedReleaseSource(path, "."),
      verbatimSymlinks: true,
    });
  writeFileSync(
    join(staging, "release-info.json"),
    JSON.stringify(
      {
        commit: buildInfo.commit,
        workingTreeDirty: buildInfo.workingTreeDirty,
        sourceFingerprint: buildInfo.sourceFingerprint,
        outputFingerprint: buildInfo.outputFingerprint,
        builtAt: buildInfo.builtAt,
        sourceIdentity: buildInfo.workingTreeDirty
          ? "Development bundle includes uncommitted changes; commit does not identify exact source."
          : "Clean working tree at recorded commit.",
        version: buildInfo.version,
        platform: buildInfo.platform,
        arch: buildInfo.arch,
        node: buildInfo.node,
        packageManager: buildInfo.packageManager,
      },
      null,
      2,
    ) + "\n",
  );
  assertReleaseSafe(staging);
  assertBuildMatchesSource();
  mkdirSync(resolve(destination, ".."), { recursive: true });
  execFileSync("tar", ["-czf", destination, "-C", staging, "."]);
  console.log(`Standalone bundle written: ${destination}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
