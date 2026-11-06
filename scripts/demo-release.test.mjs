/** Synthetic temporary repository/bundle metadata only; never production release evidence. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sourceIdentity } from "./build.mjs";
import { demoPageEnvironment, demoReleaseIsCurrent } from "./demo/release.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "arena-demo-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "--quiet");
  git("config", "user.name", "Synthetic demo test");
  git("config", "user.email", "fixture@example.invalid");
  mkdirSync(join(root, "config"));
  for (const file of ["config/model.json", "pnpm-lock.yaml", "next.config.ts", "source.ts"])
    writeFileSync(join(root, file), "explicit original fixture\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "Synthetic temporary demo fixture only");
  const server = join(root, "work/demo-release/server");
  mkdirSync(join(server, ".next/static"), { recursive: true });
  writeFileSync(join(server, "server.js"), "// explicit synthetic page server fixture\n");
  writeFileSync(join(server, ".next/BUILD_ID"), "synthetic-build-id");
  const record = (overrides = {}) => {
    writeFileSync(
      join(server, "release-info.json"),
      JSON.stringify({
        ...sourceIdentity(root),
        outputFingerprint: "a".repeat(64),
        builtAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        ...overrides,
      }),
    );
  };
  record();
  return { root, server, record, git };
}

for (const file of ["config/model.json", "pnpm-lock.yaml", "next.config.ts", "source.ts"])
  test(`copied demo cache detects changed ${file}, including a second dirty edit`, (t) => {
    const f = fixture(t);
    assert.equal(demoReleaseIsCurrent(f.root, f.server), true);
    writeFileSync(join(f.root, file), "explicit changed fixture\n");
    assert.equal(demoReleaseIsCurrent(f.root, f.server), false);
    f.record();
    assert.equal(demoReleaseIsCurrent(f.root, f.server), true);
    writeFileSync(join(f.root, file), "explicit second change while already dirty\n");
    assert.equal(demoReleaseIsCurrent(f.root, f.server), false);
  });

test("copied demo cache detects changed HEAD and new untracked source", (t) => {
  const f = fixture(t);
  f.git("commit", "--quiet", "--allow-empty", "-m", "Synthetic changed HEAD");
  assert.equal(demoReleaseIsCurrent(f.root, f.server), false);
  f.record();
  writeFileSync(join(f.root, "new-source.ts"), "explicit new source\n");
  assert.equal(demoReleaseIsCurrent(f.root, f.server), false);
});

test("copied demo cache rejects missing, malformed, foreign and incomplete release identities", (t) => {
  const f = fixture(t);
  for (const contents of ["not-json", "null", "{}"]) {
    writeFileSync(join(f.server, "release-info.json"), contents);
    assert.equal(demoReleaseIsCurrent(f.root, f.server), false);
  }
  for (const overrides of [
    { outputFingerprint: "" },
    { builtAt: "invalid" },
    { platform: "other-platform" },
    { node: "other-node-version" },
  ]) {
    f.record(overrides);
    assert.equal(demoReleaseIsCurrent(f.root, f.server), false);
  }
  f.record();
  rmSync(join(f.server, ".next/BUILD_ID"));
  assert.equal(demoReleaseIsCurrent(f.root, f.server), false);
  rmSync(join(f.server, "release-info.json"));
  assert.equal(demoReleaseIsCurrent(f.root, f.server), false);
});

test("demo pages never inherit keys, billing settings or executable preload flags", () => {
  const env = demoPageEnvironment("/synthetic/demo", 4321, {
    PATH: "/synthetic/bin",
    MODEL_API_KEY: "explicit test placeholder",
    DEEPSEEK_API_KEY: "explicit test placeholder",
    OPENAI_API_KEY: "explicit test placeholder",
    ARENA_WORKER_ENABLED: "true",
    ARENA_DATABASE_PATH: "/synthetic/private.sqlite",
    ARENA_BILLING_DATABASE_PATH: "/synthetic/billing.sqlite",
    NODE_OPTIONS: "--import=/synthetic/preload.mjs",
  });
  for (const key of ["MODEL_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY"])
    assert.equal(env[key], "");
  assert.equal(env.ARENA_WORKER_ENABLED, "false");
  assert.equal(env.ARENA_BILLING_DATABASE_PATH, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.ARENA_DATABASE_PATH, "/synthetic/demo/demo.sqlite");
  assert.equal(env.PORT, "4321");
});
