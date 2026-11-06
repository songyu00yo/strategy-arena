import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

/** wx is atomic across processes. Stale locks require explicit operator inspection/removal. */
export function acquireCaptureLock(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const file = resolve(directory, "capture.lock");
  const owner = randomUUID();
  let descriptor;
  try {
    descriptor = openSync(file, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        `Capture lock exists at ${file}. Another capture may be active; inspect its PID before manually removing a stale lock. Locks are never automatically reclaimed.`,
      );
    throw error;
  }
  try {
    writeFileSync(
      descriptor,
      JSON.stringify({ pid: process.pid, owner, startedAt: new Date().toISOString() }) + "\n",
    );
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  let released = false;
  return {
    file,
    release() {
      if (released) return;
      try {
        // Do not delete a replacement owner's lock if someone manually removed ours too early.
        if (JSON.parse(readFileSync(file, "utf8")).owner === owner) unlinkSync(file);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      released = true;
    },
  };
}

export const SCENES = [
  { id: "intro", target: [0, 8] },
  { id: "input", target: [8, 22] },
  { id: "propose", target: [22, 45] },
  { id: "challenge-evidence", target: [45, 70] },
  { id: "rematch", target: [70, 92] },
  { id: "other-cases", target: [92, 104] },
  { id: "outro", target: [104, 110] },
];

export function privateWrite(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function loadManifest(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** A previous live attempt is never automatically repeated, even with no arena ID yet. */
export function validatePickup(prior, { baseUrl, commit, mode, arenaId }) {
  if (!prior) return;
  if (prior.baseUrl !== baseUrl || prior.commit !== commit)
    throw new Error(
      "Capture identity differs from the persisted manifest; use its original URL/SHA.",
    );
  if (mode === "live")
    throw new Error(
      "A capture manifest already exists. Resume with --mode read-only; live actions will not be repeated.",
    );
  if (arenaId && prior.arenaId && arenaId !== prior.arenaId)
    throw new Error(
      "--arena-id differs from the persisted arena; use a separate output directory.",
    );
  if (!arenaId && !prior.arenaId)
    throw new Error(
      "No persisted arena ID. A previous create may have succeeded: inspect the original browser identity; do not repeat it.",
    );
}

export function newManifest({ baseUrl, commit }) {
  return {
    schemaVersion: 1,
    baseUrl,
    commit,
    createdAt: new Date().toISOString(),
    source: "actual-product-ui-real-api",
    inputSource: "repository videoChallenge / explicitly labelled synthetic test materials",
    modelMode: "deepseek",
    modelSelection: "manual; no GPT comparison",
    scenePlan: SCENES,
    arenaId: null,
    versionIds: [],
    sessions: [],
    actions: [],
    snapshots: [],
    observations: [],
    clips: [],
    exclusions: ["private/", "capture.lock", "browser-storage.json", "authentication cookies"],
  };
}

export function beginAction(manifest, { method, path, body, elapsedSeconds, sessionId }) {
  const action = {
    id: manifest.actions.length + 1,
    sessionId,
    at: new Date().toISOString(),
    elapsedSeconds,
    method,
    path,
    body,
    status: "request-intent-persisted",
  };
  manifest.actions.push(action);
  return action;
}

export function acceptSnapshot(manifest, snapshot, file) {
  if (!snapshot?.id || !Array.isArray(snapshot.versions)) return false;
  if (manifest.arenaId && snapshot.id !== manifest.arenaId)
    throw new Error("Received another arena's snapshot; refusing to mix evidence.");
  manifest.arenaId = snapshot.id;
  manifest.versionIds = [
    ...new Set([...manifest.versionIds, ...snapshot.versions.map((v) => v.id)]),
  ];
  manifest.snapshots.push({
    file,
    at: new Date().toISOString(),
    arenaId: snapshot.id,
    activeVersionId: snapshot.activeVersionId,
    versions: snapshot.versions.map((v) => ({
      id: v.id,
      number: v.number,
      status: v.status,
      stage: v.stage,
      modelSelection: v.modelSelection,
      preferred: v.verdict?.preferred ?? null,
      outcome: v.verdict?.outcome ?? null,
      costCny: v.costCny,
      costUsd: v.costUsd,
    })),
  });
  return true;
}
