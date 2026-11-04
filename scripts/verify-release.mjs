import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { execFileSync } from "node:child_process";
const [manifestPath, archivePath, expectedCommit] = process.argv.slice(2);
if (!manifestPath || !archivePath || !/^[a-f0-9]{40}$/.test(expectedCommit ?? ""))
  throw new Error(
    "Usage: node scripts/verify-release.mjs manifest.json archive.tar.gz <40-character-commit>",
  );
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.workingTreeDirty !== false)
  throw new Error("Only a clean-source manifest can be deployed.");
if (manifest.runtime?.platform !== process.platform || manifest.runtime?.arch !== process.arch)
  throw new Error(
    "Release platform/architecture differs from this server; rebuild for the target platform.",
  );
if (manifest.archiveSource?.workingTreeDirty !== false)
  throw new Error("Archive source must be clean.");
if (manifest.commit !== expectedCommit)
  throw new Error("Manifest commit differs from the approved commit.");
const matches = manifest.artifacts.filter(
  (entry) => basename(entry.path) === basename(archivePath),
);
if (matches.length !== 1) throw new Error("Manifest must contain exactly one matching archive.");
const actual = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
if (actual !== matches[0].sha256) throw new Error("Archive checksum mismatch.");
const releaseInfo = JSON.parse(
  execFileSync("tar", ["-xOf", archivePath, "./release-info.json"], { encoding: "utf8" }),
);
if (
  releaseInfo.commit !== expectedCommit ||
  releaseInfo.workingTreeDirty !== false ||
  releaseInfo.platform !== process.platform ||
  releaseInfo.arch !== process.arch
)
  throw new Error("Archive metadata differs from the approved source or server platform.");
for (const key of ["typecheck", "lint", "unit", "build", "e2e"])
  if (manifest.validation?.checks?.[key] !== "passed") throw new Error(`Check is missing: ${key}`);
console.log(
  `Verified archive for commit ${expectedCommit}. Verify CI origin and live acceptance separately.`,
);
