/** Synthetic temporary repositories/build outputs; never production release evidence. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { assertBuildMatchesSource, build, buildEnvironment, sourceIdentity } from "./build.mjs";
const packagingScript = resolve("scripts/package-release.mjs");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "arena-build-fixture-"));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Synthetic build test");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(root, ".gitignore"), ".next/\nartifacts/\n.env.local\nnext-env.d.ts\n");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ version: "0.0.0-fixture", packageManager: "pnpm@11.19.0" }),
  );
  writeFileSync(join(root, "source.ts"), "explicit original test source\n");
  mkdirSync(join(root, "migrations"));
  writeFileSync(join(root, "migrations/001_fixture.sql"), "-- explicit test migration\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "Synthetic temporary fixture only");
  const marker = join(root, ".next/arena-build-info.json");
  const archive = join(root, "artifacts/fixture.tar.gz");
  const packageRun = () =>
    spawnSync(process.execPath, [packagingScript, archive], { cwd: root, encoding: "utf8" });
  return {
    root,
    git,
    marker,
    archive,
    packageRun,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
function fakeCompile(root) {
  mkdirSync(join(root, ".next/standalone/.next/server"), { recursive: true });
  mkdirSync(join(root, ".next/static"), { recursive: true });
  writeFileSync(join(root, ".next/BUILD_ID"), "explicit-fixture-build-id");
  writeFileSync(
    join(root, ".next/standalone/server.js"),
    "// Explicit synthetic standalone fixture, not a real app.\n",
  );
  writeFileSync(join(root, ".next/standalone/package.json"), "{}");
  writeFileSync(
    join(root, ".next/standalone/.next/server/chunk.js"),
    "// explicit compiled fixture\n",
  );
  writeFileSync(join(root, ".next/static/chunk.js"), "// explicit static fixture\n");
}
test("packages a stable dirty development build using its recorded build identity", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "source.ts"), "explicit dirty source before compiling\n");
    const info = build({ directory: f.root, run: fakeCompile });
    assert.equal(info.workingTreeDirty, true);
    assert.equal(assertBuildMatchesSource(f.root).commit, info.commit);
    const result = f.packageRun();
    assert.equal(result.status, 0, result.stderr);
    const release = JSON.parse(
      execFileSync("tar", ["-xOf", f.archive, "./release-info.json"], { encoding: "utf8" }),
    );
    assert.equal(release.commit, info.commit);
    assert.equal(release.sourceFingerprint, info.sourceFingerprint);
    assert.equal(release.outputFingerprint, info.outputFingerprint);
    assert.equal(release.workingTreeDirty, true);
  } finally {
    f.cleanup();
  }
});
test("ignores generated and ignored files while detecting untracked source", () => {
  const f = fixture();
  try {
    const before = sourceIdentity(f.root);
    writeFileSync(
      join(f.root, ".env.local"),
      "explicit placeholder; this ignored file is not hashed",
    );
    writeFileSync(join(f.root, "next-env.d.ts"), "explicit generated declarations");
    mkdirSync(join(f.root, "artifacts"));
    writeFileSync(join(f.root, "artifacts/ignored.json"), "{}");
    assert.deepEqual(sourceIdentity(f.root), before);
    writeFileSync(join(f.root, "new-source.ts"), "explicit new source");
    assert.notEqual(sourceIdentity(f.root).sourceFingerprint, before.sourceFingerprint);
    assert.equal(sourceIdentity(f.root).workingTreeDirty, true);
  } finally {
    f.cleanup();
  }
});
test("tracked source stays fingerprinted even if an ignore pattern later matches it", () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.root, ".gitignore"),
      ".next/\nartifacts/\n.env.local\nnext-env.d.ts\nsource.ts\n",
    );
    const before = sourceIdentity(f.root);
    writeFileSync(join(f.root, "source.ts"), "changed tracked source despite ignore pattern");
    assert.notEqual(sourceIdentity(f.root).sourceFingerprint, before.sourceFingerprint);
  } finally {
    f.cleanup();
  }
});
test("rejects a missing or obsolete marker before packaging", () => {
  const f = fixture();
  try {
    fakeCompile(f.root);
    assert.match(f.packageRun().stderr, /marker is missing or invalid/);
    writeFileSync(f.marker, JSON.stringify({ markerVersion: 0 }));
    assert.match(f.packageRun().stderr, /incomplete or obsolete/);
    assert.equal(existsSync(f.archive), false);
  } finally {
    f.cleanup();
  }
});
test("rejects a new Git HEAD even if source bytes are unchanged", () => {
  const f = fixture();
  try {
    build({ directory: f.root, run: fakeCompile });
    f.git("commit", "--quiet", "--allow-empty", "-m", "Another synthetic temporary commit");
    assert.match(f.packageRun().stderr, /Git HEAD changed since the build/);
    assert.equal(existsSync(f.archive), false);
  } finally {
    f.cleanup();
  }
});
test("rejects changed tracked or newly untracked source after compilation", () => {
  const f = fixture();
  try {
    build({ directory: f.root, run: fakeCompile });
    writeFileSync(join(f.root, "source.ts"), "changed after compiling");
    assert.match(f.packageRun().stderr, /Source or Git HEAD changed/);
    writeFileSync(join(f.root, "source.ts"), "explicit original test source\n");
    writeFileSync(join(f.root, "new-source.ts"), "new after compiling");
    assert.match(f.packageRun().stderr, /Source or Git HEAD changed/);
    assert.equal(existsSync(f.archive), false);
  } finally {
    f.cleanup();
  }
});
test("rejects modified compiled chunks despite an unchanged source marker", () => {
  const f = fixture();
  try {
    build({ directory: f.root, run: fakeCompile });
    writeFileSync(
      join(f.root, ".next/standalone/.next/server/chunk.js"),
      "tampered compiled fixture",
    );
    assert.match(f.packageRun().stderr, /Compiled build output changed/);
    assert.equal(existsSync(f.archive), false);
  } finally {
    f.cleanup();
  }
});
test("failed builds and source changes during compilation remove any previous valid marker", () => {
  const f = fixture();
  try {
    build({ directory: f.root, run: fakeCompile });
    assert.equal(existsSync(f.marker), true);
    assert.throws(
      () =>
        build({
          directory: f.root,
          run: () => {
            throw new Error("explicit simulated compiler failure");
          },
        }),
      /compiler failure/,
    );
    assert.equal(existsSync(f.marker), false);
    assert.throws(
      () =>
        build({
          directory: f.root,
          run: (root) => {
            fakeCompile(root);
            writeFileSync(join(root, "source.ts"), "changed during compile");
          },
        }),
      /changed during next build/,
    );
    assert.equal(existsSync(f.marker), false);
  } finally {
    f.cleanup();
  }
});

test("production compilation disables inherited model credentials and background execution", () => {
  const inherited = {
    MODEL_API_KEY: "legacy-test-value",
    DEEPSEEK_API_KEY: "ds-test-value",
    OPENAI_API_KEY: "openai-test-value",
    ARENA_WORKER_ENABLED: "true",
    ARENA_BILLING_DATABASE_PATH: "/production/billing.sqlite",
    PATH: "/bin",
  };
  const env = buildEnvironment(inherited);
  for (const key of [
    "MODEL_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENAI_API_KEY",
    "ARENA_BILLING_DATABASE_PATH",
  ])
    assert.equal(env[key], "");
  assert.equal(env.ARENA_WORKER_ENABLED, "false");
  assert.equal(env.PATH, "/bin");
  assert.equal(inherited.ARENA_WORKER_ENABLED, "true");
});
