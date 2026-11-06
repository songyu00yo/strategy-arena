import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateScene } from "./promo-render/provenance.mjs";

// Synthetic manifests and empty recordings only; tests never render or call a model.
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "arena-promo-provenance-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, "capture/raw"), { recursive: true });
  writeFileSync(join(base, "capture/raw/real.webm"), "synthetic test placeholder");
  writeFileSync(join(base, "unrelated.webm"), "unrelated test placeholder");
  const spec = { commit: "a".repeat(40) };
  const capture = {
    source: "actual-product-ui-real-api",
    commit: spec.commit,
    sessions: [
      {
        id: "001",
        rawFile: "raw/real.webm",
        health: {
          commit: spec.commit,
          sourceDirty: false,
          version: "0.2.0",
          model: { id: "deepseek-fixture" },
        },
      },
    ],
    clips: [
      {
        sessionId: "001",
        id: "result",
        status: "completed",
        rawFile: "raw/real.webm",
        startSeconds: 10,
        endSeconds: 20,
      },
    ],
  };
  const scene = {
    captureManifest: "capture/manifest.json",
    clipIndex: 0,
    source: "capture/raw/real.webm",
    start: 11,
    duration: 5,
  };
  const save = () => writeFileSync(join(base, "capture/manifest.json"), JSON.stringify(capture));
  save();
  return { base, spec, capture, scene, save };
}

test("binds an exact completed clip, recording and clean health identity", (t) => {
  const { base, spec, scene } = fixture(t);
  const verified = validateScene(spec, scene, base);
  assert.equal(verified.source, join(base, "capture/raw/real.webm"));
  assert.equal(verified.captureManifest, join(base, "capture/manifest.json"));
  assert.equal(verified.footageKind, "replay");
  assert.match(verified.label, /记录回看/);
  assert.equal(validateScene(spec, { ...scene, source: undefined }, base).source, verified.source);
});

test("rejects a different capture SHA, unrelated source, mismatched session or demo health", (t) => {
  const { base, spec, scene, capture, save } = fixture(t);
  assert.throws(() => validateScene({ ...spec, commit: "b".repeat(40) }, scene, base), /commit/);
  assert.throws(() => validateScene(spec, { ...scene, source: "unrelated.webm" }, base), /source/);
  capture.sessions[0].rawFile = "../unrelated.webm";
  save();
  assert.throws(() => validateScene(spec, scene, base), /source/);
  capture.sessions[0].rawFile = "raw/real.webm";
  capture.sessions[0].health.model.id = "demo-no-model";
  save();
  assert.throws(() => validateScene(spec, scene, base), /health/);
  capture.sessions[0].health.model.id = "deepseek-fixture";
  capture.sessions[0].health.commit = "b".repeat(40);
  save();
  assert.throws(() => validateScene(spec, scene, base), /health/);
  capture.sessions[0].health.commit = spec.commit;
  capture.source = "fixture";
  save();
  assert.throws(() => validateScene(spec, scene, base), /source/);
});

test("requires an exact clip index and a completed finite range within its original boundaries", (t) => {
  const { base, spec, scene, capture, save } = fixture(t);
  for (const clipIndex of [undefined, -1, 0.1, 1, "0"])
    assert.throws(() => validateScene(spec, { ...scene, clipIndex }, base), /clip/);
  for (const changes of [
    { start: 9.8 },
    { start: 19, duration: 2 },
    { duration: 0 },
    { duration: Infinity },
    { start: NaN },
    { start: -1 },
  ])
    assert.throws(() => validateScene(spec, { ...scene, ...changes }, base), /range/);
  assert.doesNotThrow(() => validateScene(spec, { ...scene, start: 9.95, duration: 10.1 }, base));
  capture.clips[0].status = "partial";
  save();
  assert.throws(() => validateScene(spec, scene, base), /completed/);
});

test("classifies sample inputs, actual live calls and replay from manifest rather than editable labels", (t) => {
  const { base, spec, scene, capture, save } = fixture(t);
  for (const id of ["intro", "input", "outro", "other-case-input"]) {
    capture.clips[0].id = id;
    save();
    const checked = validateScene(spec, scene, base);
    assert.equal(checked.footageKind, "input");
    assert.match(checked.label, /未展示模型结果/);
  }
  for (const id of ["initial-live-run", "rematch-input-and-live-run"]) {
    capture.clips[0].id = id;
    save();
    assert.equal(validateScene(spec, scene, base).footageKind, "live");
  }
  capture.clips[0].id = "first-result-before-rematch";
  save();
  assert.equal(validateScene(spec, scene, base).footageKind, "replay");
  capture.clips[0].id = "invented-result";
  save();
  assert.throws(() => validateScene(spec, scene, base), /unsupported footage kind/);
});
