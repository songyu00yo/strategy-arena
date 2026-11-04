import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
const script = resolve("scripts/verify-release.mjs");
const commit = "a".repeat(40);
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "arena-integrity-test-"));
  const archive = join(dir, "build.tar.gz");
  const manifest = join(dir, "manifest.json");
  const staging = join(dir, "synthetic-package");
  mkdirSync(staging);
  writeFileSync(
    join(staging, "release-info.json"),
    JSON.stringify({
      commit,
      workingTreeDirty: false,
      platform: process.platform,
      arch: process.arch,
    }),
  );
  execFileSync("tar", ["-czf", archive, "-C", staging, "."]);
  const value = {
    commit,
    workingTreeDirty: false,
    runtime: { platform: process.platform, arch: process.arch },
    archiveSource: { commit, workingTreeDirty: false },
    artifacts: [
      {
        path: "build.tar.gz",
        sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
      },
    ],
    validation: {
      checks: Object.fromEntries(
        ["typecheck", "lint", "unit", "build", "e2e"].map((key) => [key, "passed"]),
      ),
    },
  };
  return {
    dir,
    archive,
    manifest,
    value,
    run: () =>
      spawnSync(process.execPath, [script, manifest, archive, commit], { encoding: "utf8" }),
  };
}
test("accepts matching archive and approved commit", () => {
  const f = fixture();
  try {
    writeFileSync(f.manifest, JSON.stringify(f.value));
    assert.equal(f.run().status, 0);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
test("rejects archive altered after manifest creation", () => {
  const f = fixture();
  try {
    writeFileSync(f.manifest, JSON.stringify(f.value));
    writeFileSync(f.archive, "tampered");
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksum mismatch/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
test("rejects incomplete checks even when archive hash matches", () => {
  const f = fixture();
  try {
    f.value.validation.checks.e2e = "failed";
    writeFileSync(f.manifest, JSON.stringify(f.value));
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Check is missing: e2e/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("bundle scanner rejects private filenames before opening them and detects credential bytes", async () => {
  const { assertReleaseSafe } = await import("./release-safety.mjs");
  const dir = mkdtempSync(join(tmpdir(), "arena-bundle-test-"));
  try {
    writeFileSync(join(dir, ".env.local"), "not read by scanner");
    assert.throws(() => assertReleaseSafe(dir), /private path/);
    rmSync(join(dir, ".env.local"));
    writeFileSync(join(dir, "server.js"), "sk-" + "x".repeat(32));
    assert.throws(() => assertReleaseSafe(dir), /credential pattern found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects a development bundle manifest with uncommitted source", () => {
  const f = fixture();
  try {
    f.value.workingTreeDirty = true;
    writeFileSync(f.manifest, JSON.stringify(f.value));
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /clean-source manifest/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("rejects a package built for a different server platform", () => {
  const f = fixture();
  try {
    f.value.runtime.platform = process.platform === "linux" ? "darwin" : "linux";
    writeFileSync(f.manifest, JSON.stringify(f.value));
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /platform\/architecture differs/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
