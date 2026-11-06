import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  acceptSnapshot,
  acquireCaptureLock,
  assertLiveModelProviders,
  beginAction,
  newManifest,
  modelRequestMatches,
  captureModelMode,
  privateWrite,
  validatePickup,
} from "./promo/manifest.mjs";

const identity = { baseUrl: "http://127.0.0.1:3310", commit: "a".repeat(40) };

test("requested auto mode is preserved in capture metadata and cannot be forced to DeepSeek", () => {
  const automatic = newManifest({ ...identity, modelMode: "auto" });
  assert.equal(automatic.modelMode, "auto");
  assert.match(automatic.modelSelection, /do not establish a quality comparison/);
  assert.equal(modelRequestMatches({ modelMode: "auto" }, automatic.modelMode), true);
  assert.equal(modelRequestMatches({ modelMode: "deepseek" }, automatic.modelMode), false);
  assert.equal(modelRequestMatches({ modelMode: "gpt" }, automatic.modelMode), false);
  assert.equal(modelRequestMatches({}, automatic.modelMode), false);
  assert.equal(newManifest(identity).modelMode, "deepseek");
  assert.equal(newManifest({ ...identity, modelMode: "gpt" }).modelMode, "gpt");
  assert.equal(captureModelMode(), "deepseek");
  assert.throws(() => captureModelMode("unknown"), /--model-mode/);
});

test("auto preflight needs both providers and explicit choices never silently fall back", () => {
  const health = (...providers) => ({
    model: { providers: providers.map((provider) => ({ provider, configured: true })) },
  });
  assert.throws(() => assertLiveModelProviders(health("deepseek"), "auto"), /openai/);
  assert.throws(() => assertLiveModelProviders(health("openai"), "auto"), /deepseek/);
  assert.doesNotThrow(() => assertLiveModelProviders(health("deepseek", "openai"), "auto"));
  assert.doesNotThrow(() => assertLiveModelProviders(health("deepseek"), "deepseek"));
  assert.doesNotThrow(() => assertLiveModelProviders(health("openai"), "gpt"));
  assert.throws(() => assertLiveModelProviders(health("deepseek"), "gpt"), /openai/);
  assert.throws(
    () =>
      assertLiveModelProviders(
        { model: { providers: [{ provider: "openai", configured: false }] } },
        "gpt",
      ),
    /openai/,
  );
});
const captureScript = fileURLToPath(new URL("./capture-live-promo.mjs", import.meta.url));
const runCaptureValidation = (directory) =>
  spawnSync(
    process.execPath,
    [
      captureScript,
      "--base-url",
      identity.baseUrl,
      "--commit",
      identity.commit,
      "--output-dir",
      directory,
      "--mode",
      "read-only",
    ],
    { encoding: "utf8" },
  );

test("exclusive capture lock blocks competing captures and never auto-reclaims stale locks", () => {
  const directory = mkdtempSync(join(tmpdir(), "promo-lock-"));
  try {
    const lock = acquireCaptureLock(directory);
    assert.equal(statSync(lock.file).mode & 0o777, 0o600);
    assert.throws(() => acquireCaptureLock(directory), /Capture lock exists/);
    const competingProcess = runCaptureValidation(directory);
    assert.notEqual(competingProcess.status, 0);
    assert.match(competingProcess.stderr, /Capture lock exists/);
    lock.release();
    lock.release();
    assert.equal(existsSync(lock.file), false);
    const next = acquireCaptureLock(directory);
    next.release();
    writeFileSync(lock.file, JSON.stringify({ pid: 99999999, owner: "stale" }));
    assert.throws(() => acquireCaptureLock(directory), /never automatically reclaimed/);
    assert.equal(JSON.parse(readFileSync(lock.file)).owner, "stale");
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("CLI validation failure releases its exclusive lock before exiting", () => {
  const directory = mkdtempSync(join(tmpdir(), "promo-lock-validation-"));
  try {
    const result = runCaptureValidation(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Read-only capture requires/);
    assert.equal(existsSync(join(directory, "capture.lock")), false);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("an interrupted create with unknown result cannot become a duplicate live run", () => {
  const manifest = newManifest(identity);
  beginAction(manifest, { method: "POST", path: "/api/arenas", body: { modelMode: "deepseek" } });
  assert.throws(() => validatePickup(manifest, { ...identity, mode: "live" }), /already exists/);
  assert.throws(
    () => validatePickup(manifest, { ...identity, mode: "read-only" }),
    /may have succeeded/,
  );
  assert.doesNotThrow(() =>
    validatePickup(manifest, { ...identity, mode: "read-only", arenaId: "known-server-id" }),
  );
});

test("recovery preserves arena and every version identity without mixing arenas", () => {
  const manifest = newManifest(identity);
  acceptSnapshot(
    manifest,
    { id: "arena", activeVersionId: "v1", versions: [{ id: "v1", number: 1 }] },
    "one.json",
  );
  acceptSnapshot(
    manifest,
    {
      id: "arena",
      activeVersionId: "v2",
      versions: [
        { id: "v1", number: 1 },
        { id: "v2", number: 2 },
      ],
    },
    "two.json",
  );
  assert.deepEqual(manifest.versionIds, ["v1", "v2"]);
  assert.equal(manifest.snapshots[1].activeVersionId, "v2");
  assert.throws(
    () => acceptSnapshot(manifest, { id: "other", versions: [] }, "bad.json"),
    /another arena/,
  );
  assert.throws(
    () => validatePickup(manifest, { ...identity, mode: "read-only", arenaId: "other" }),
    /differs/,
  );
  assert.throws(
    () => validatePickup(manifest, { ...identity, mode: "read-only", commit: "b".repeat(40) }),
    /identity/,
  );
});

test("intent and returned identity survive atomic private persistence", () => {
  const directory = mkdtempSync(join(tmpdir(), "promo-manifest-"));
  try {
    const file = join(directory, "manifest.json");
    const manifest = newManifest(identity);
    beginAction(manifest, { method: "POST", path: "/api/arenas/arena/versions" });
    privateWrite(file, manifest);
    assert.equal(JSON.parse(readFileSync(file)).actions[0].status, "request-intent-persisted");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    acceptSnapshot(manifest, { id: "arena", versions: [{ id: "v2" }] }, "snapshot.json");
    privateWrite(file, manifest);
    assert.equal(JSON.parse(readFileSync(file)).arenaId, "arena");
  } finally {
    rmSync(directory, { recursive: true });
  }
});
