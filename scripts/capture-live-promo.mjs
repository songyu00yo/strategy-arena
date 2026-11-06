#!/usr/bin/env node
/** Records the real product, with durable one-shot live intent and strictly read-only pickup. */
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import {
  acceptSnapshot,
  acquireCaptureLock,
  beginAction,
  loadManifest,
  newManifest,
  privateWrite,
  validatePickup,
} from "./promo/manifest.mjs";
import {
  cinematicClick,
  fillVideoSample,
  finishedShots,
  openRematch,
  otherCaseShots,
  wait,
} from "./promo/ui.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = {};
const values = new Set([
  "--base-url",
  "--commit",
  "--output-dir",
  "--mode",
  "--arena-id",
  "--storage-state",
  "--timeout-seconds",
  "--version-id",
]);
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (["--help", "--skip-samples"].includes(key)) options[key] = true;
  else if (values.has(key) && process.argv[i + 1] && !process.argv[i + 1].startsWith("--"))
    options[key] = process.argv[++i];
  else throw new Error(`Unknown or incomplete option: ${key}`);
}
if (options["--help"]) {
  console.log(`Actual product capture, no narration or compositing. Requires the real server's full commit SHA.
node scripts/capture-live-promo.mjs --base-url http://127.0.0.1:PORT --commit FULL_SHA --output-dir work/promo-live --mode live
Pickup: use the same arguments with --mode read-only; never creates, advances, retries, stops or rematches.
Existing arena: --mode read-only --arena-id ID --storage-state /absolute/private/browser-storage.json
Live explicitly selects DeepSeek for both runs. All sample inputs are labelled synthetic; results come only from real API responses.
Any existing manifest forbids a second live attempt. Incomplete/unknown requests require operator inspection.
Optional --timeout-seconds 1800. Read-only --version-id ID captures only that stored version.
Read-only captures never fill unrelated sample inputs. Live --skip-samples also omits sample-only shots.
Browser identity is 0600 under OUTPUT/private/ and must never be exported.
Raw recordings retain all normal animations and model waiting; manifest.json supplies recorded clip ranges for editing.`);
  process.exit(0);
}
const mode = options["--mode"];
const commit = options["--commit"];
if (!["live", "read-only"].includes(mode))
  throw new Error("--mode must explicitly be live or read-only");
if (mode === "live" && options["--version-id"])
  throw new Error("--version-id is a read-only capture option");
if (!/^[a-f0-9]{40}$/i.test(commit ?? ""))
  throw new Error("--commit requires the full 40-character server SHA");
if (!options["--base-url"] || !options["--output-dir"])
  throw new Error("--base-url and --output-dir are required");
const base = new URL(options["--base-url"]);
if (
  !/^https?:$/.test(base.protocol) ||
  base.username ||
  base.password ||
  base.search ||
  base.hash ||
  base.pathname !== "/"
)
  throw new Error("Use a credential-free HTTP(S) origin URL without query or path");
const baseUrl = base.origin;
const output = resolve(root, options["--output-dir"]);
// Lock before reading a manifest: two simultaneous fresh invocations must not both create arenas.
const captureLock = acquireCaptureLock(output);
const releaseLockAtExit = () => captureLock.release();
process.once("exit", releaseLockAtExit);
const manifestFile = resolve(output, "manifest.json");
const prior = existsSync(manifestFile) ? loadManifest(manifestFile) : null;
validatePickup(prior, { baseUrl, commit, mode, arenaId: options["--arena-id"] });
if (mode === "read-only" && !prior?.arenaId && !options["--arena-id"])
  throw new Error("Read-only capture requires a persisted arena or --arena-id");
const timeoutSeconds = Number(options["--timeout-seconds"] ?? 1800);
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 7200)
  throw new Error("--timeout-seconds must be between 30 and 7200");
const manifest = prior ?? newManifest({ baseUrl, commit });
manifest.arenaId ??= options["--arena-id"] ?? null;
const privateDirectory = resolve(output, "private");
for (const path of [
  output,
  privateDirectory,
  resolve(output, "raw"),
  resolve(output, "snapshots"),
]) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
const authPath = resolve(privateDirectory, "browser-storage.json");
const suppliedAuth = options["--storage-state"] ? resolve(options["--storage-state"]) : null;
const storageState = suppliedAuth ?? (existsSync(authPath) ? authPath : undefined);
const sessionId = String(manifest.sessions.length + 1).padStart(3, "0");
const session = {
  id: sessionId,
  mode,
  startedAt: new Date().toISOString(),
  status: "starting",
  source:
    "actual product, real server; all recorded playback is labelled as playback in clip metadata",
};
manifest.sessions.push(session);
const save = () => privateWrite(manifestFile, manifest);
save();
let context;
let page;
let browser;
let latest;
let failure;
let recordingStarted;
let blockMutations = mode === "read-only";
let allowedOperation = null;
let observerError;
const responseTasks = new Set();
const actionsByRequest = new WeakMap();
const elapsed = () => (recordingStarted ? (Date.now() - recordingStarted) / 1000 : 0);
const saveAuth = async () => privateWrite(authPath, await context.storageState());
const snapshot = (data, label) => {
  if (!data?.id || !Array.isArray(data.versions)) return;
  const file = `snapshots/${sessionId}-${String(manifest.snapshots.length + 1).padStart(4, "0")}-${label}.json`;
  if (acceptSnapshot(manifest, data, file)) {
    Object.assign(manifest.snapshots.at(-1), { sessionId, elapsedSeconds: elapsed() });
    latest = data;
    privateWrite(resolve(output, file), data);
    save();
  }
};
const observe = (kind, data) => {
  manifest.observations.push({
    sessionId,
    kind,
    at: new Date().toISOString(),
    elapsedSeconds: elapsed(),
    ...data,
  });
  save();
};
const shot = async (id, operation, metadata = {}) => {
  const clip = {
    sessionId,
    id,
    source:
      mode === "read-only" || blockMutations
        ? "read-only playback of stored real records"
        : "live real API product capture",
    startSeconds: elapsed(),
    startedAt: new Date().toISOString(),
    arenaId: manifest.arenaId,
    ...metadata,
  };
  manifest.clips.push(clip);
  save();
  try {
    await operation();
    clip.status = "completed";
  } catch (error) {
    clip.status = "partial";
    clip.error = error.message;
    throw error;
  } finally {
    clip.endSeconds = elapsed();
    save();
  }
};
const fetchSnapshot = async () => {
  const response = await context.request.get(
    `${baseUrl}/api/arenas/${encodeURIComponent(manifest.arenaId)}`,
  );
  if (!response.ok())
    throw new Error(
      `Snapshot GET failed with ${response.status()}; original browser identity may be required`,
    );
  const data = await response.json();
  snapshot(data, "poll");
  await saveAuth();
  return data;
};
const waitCompleted = async () => {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (observerError) throw observerError;
    if (page.isClosed()) throw new Error("Capture page closed");
    if (manifest.arenaId) {
      const data = await fetchSnapshot();
      const active = data.versions.find((v) => v.id === data.activeVersionId);
      if (active?.status === "completed") {
        await wait(7000);
        return active;
      }
      if (active && !["ready", "running"].includes(active.status))
        throw new Error(
          `Real run ended ${active.status}: ${active.error ?? "inspect saved snapshots"}; no automatic retry`,
        );
    }
    await wait(3000);
  }
  throw new Error(
    "Real capture timed out. Original recordings and intents are retained; only read-only pickup is permitted.",
  );
};
const closeOnSignal = () => {
  session.status = "interrupted";
  save();
  void context?.close().catch(() => {});
};
process.once("SIGINT", closeOnSignal);
process.once("SIGTERM", closeOnSignal);

try {
  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    screen: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
    reducedMotion: "no-preference",
    recordVideo: { dir: resolve(output, "raw"), size: { width: 1920, height: 1080 } },
    storageState,
  });
  // Install before opening the page: a restored active version otherwise auto-advances in useArena.
  await context.route("**/*", async (route) => {
    const request = route.request();
    const method = request.method();
    if (["GET", "HEAD", "OPTIONS"].includes(method)) return route.continue();
    // Creation responses can trigger the next UI effect immediately. Persist their returned IDs first.
    await Promise.allSettled([...responseTasks]);
    const url = new URL(request.url());
    if (blockMutations || method !== "POST" || url.origin !== baseUrl) {
      observe("mutation-blocked", { method, path: url.pathname });
      return route.abort("blockedbyclient");
    }
    const body = request.postDataJSON();
    let permitted = !blockMutations && method === "POST" && url.origin === baseUrl;
    permitted &&= !observerError;
    if (url.pathname === "/api/arenas")
      permitted &&= allowedOperation === "create" && body?.modelMode === "deepseek";
    else if (url.pathname === `/api/arenas/${manifest.arenaId}/versions`)
      permitted &&= allowedOperation === "rematch" && body?.modelMode === "deepseek";
    else if (url.pathname === `/api/arenas/${manifest.arenaId}/advance`)
      permitted &&=
        ["create", "rematch"].includes(allowedOperation) &&
        manifest.versionIds.includes(body?.versionId);
    else permitted = false;
    if (url.pathname === "/api/arenas" || url.pathname.endsWith("/versions"))
      permitted &&= !manifest.actions.some((a) => a.path === url.pathname);
    if (!permitted) {
      observe("mutation-blocked", { method, path: url.pathname });
      return route.abort("blockedbyclient");
    }
    const action = beginAction(manifest, {
      method,
      path: url.pathname,
      body,
      elapsedSeconds: elapsed(),
      sessionId,
    });
    actionsByRequest.set(request, action);
    save(); // MUST happen before a request that could create or charge anything leaves the browser.
    await saveAuth();
    return route.continue();
  });
  context.on("response", (response) => {
    const task = (async () => {
      const url = new URL(response.url());
      if (url.origin !== baseUrl || !url.pathname.startsWith("/api/")) return;
      if (url.pathname.endsWith("/events")) return;
      const action = actionsByRequest.get(response.request());
      const data = await response.json().catch(() => null);
      if (action) {
        action.httpStatus = response.status();
        action.status = response.ok() ? "response-received" : "server-error";
        action.responseAt = new Date().toISOString();
        action.responseSeconds = elapsed();
        action.arenaId = data?.id ?? null;
        action.versionId = data?.activeVersionId ?? null;
        action.error = data?.error ?? null;
        action.code = data?.code ?? null;
        save();
        if (
          !response.ok() &&
          !["CONCURRENCY_LIMIT", "STEP_BUSY", "RUN_BUSY", "BUSY"].includes(action.code)
        )
          observerError = new Error(
            `Server rejected a live request (${response.status()} ${action.code ?? ""}): ${action.error ?? "inspect response"}. No automatic retry.`,
          );
      }
      if (data?.id && Array.isArray(data.versions)) {
        snapshot(data, "response");
        await saveAuth();
      }
    })()
      .catch((error) => {
        observerError = error;
      })
      .finally(() => responseTasks.delete(task));
    responseTasks.add(task);
  });
  context.on("requestfailed", (request) => {
    const action = actionsByRequest.get(request);
    if (!action) return;
    action.status = "request-result-unknown";
    action.failure = request.failure()?.errorText ?? "browser request failed";
    action.failedAt = new Date().toISOString();
    save();
    observerError = new Error(
      "A live request failed with an unknown server result. No retry is permitted; inspect saved intents and server state.",
    );
  });
  const healthResponse = await context.request.get(`${baseUrl}/api/health`);
  if (!healthResponse.ok()) throw new Error(`Health failed: ${healthResponse.status()}`);
  const health = await healthResponse.json();
  session.health = health;
  privateWrite(resolve(output, `health-${sessionId}.json`), health);
  if (health.version === "demo" || health.commit === "demo" || health.model?.id === "demo-no-model")
    throw new Error(
      "Demo/fixture server is forbidden for real promo capture; use the separate selector-development check",
    );
  if (health.commit !== commit || health.sourceDirty === true)
    throw new Error("Health SHA must match --commit and source must not be dirty");
  if (health.requiresAccessCode && !health.accessGranted)
    throw new Error(
      "Server requires access. Supply an already authorized browser storage file using --storage-state; no access secrets are exported.",
    );
  if (
    mode === "live" &&
    !health.model?.providers?.some((p) => p.provider === "deepseek" && p.configured)
  )
    throw new Error("Real server must report a configured DeepSeek provider");
  if (mode === "live" && manifest.arenaId)
    throw new Error("A new live capture cannot attach an existing arena");
  if (manifest.arenaId) {
    await fetchSnapshot();
    const active = latest.versions.find((v) => v.id === latest.activeVersionId);
    if (!active || ["ready", "running"].includes(active.status))
      throw new Error(
        "Read-only pickup requires a terminal active version; no advancing will be attempted",
      );
    await context.addInitScript(
      (id) => localStorage.setItem("strategy-arena:last-id", id),
      manifest.arenaId,
    );
  } else {
    // A fresh live session starts from an empty page, never a storage state's previous arena.
    await context.addInitScript(() => localStorage.removeItem("strategy-arena:last-id"));
  }
  recordingStarted = Date.now();
  session.recordingStartedAt = new Date(recordingStarted).toISOString();
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  session.status = "recording";
  save();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "方案擂台首页" }).waitFor();
  if (mode === "read-only") await page.getByRole("combobox", { name: "选择推演版本" }).waitFor();
  else await page.getByRole("button", { name: "试填一个视频任务" }).waitFor();
  await saveAuth();
  if (mode === "live") {
    await shot("intro", () => wait(9000), { source: "actual home before paid actions" });
    await shot("input", () => fillVideoSample(page), {
      source: "existing animated sample fill; manually selected DeepSeek",
    });
    let first;
    await shot(
      "initial-live-run",
      async () => {
        allowedOperation = "create";
        await cinematicClick(page, page.getByRole("button", { name: "让方案上场", exact: true }));
        first = await waitCompleted();
        allowedOperation = null;
      },
      { source: "continuous actual first run, including all model waiting" },
    );
    await shot("first-result-before-rematch", () => wait(5000), {
      versionId: first.id,
      preferred: first.verdict?.preferred ?? null,
      source: "actual completed first run before conditions change",
    });
    let second;
    await shot(
      "rematch-input-and-live-run",
      async () => {
        const dialog = await openRematch(page);
        allowedOperation = "rematch";
        await cinematicClick(page, dialog.getByRole("button", { name: "按新条件重新推演" }));
        // Wait for the server's second version identity before checking terminal status.
        const deadline = Date.now() + 60000;
        while (manifest.versionIds.length < 2 && Date.now() < deadline) await wait(300);
        if (manifest.versionIds.length < 2)
          throw new Error("Rematch response not observed; refusing another submission");
        second = await waitCompleted();
        allowedOperation = null;
      },
      { source: "continuous actual changed-condition run; manual DeepSeek" },
    );
    blockMutations = true;
    await page.getByRole("combobox", { name: "选择推演版本" }).selectOption(first.id);
    await wait(2000);
    await finishedShots(page, first, shot);
    await page.getByRole("combobox", { name: "选择推演版本" }).selectOption(second.id);
    await wait(2000);
    await finishedShots(page, second, shot);
  } else {
    // Terminal snapshots may contain useful partial results. Do not present these as complete.
    const completed = latest.versions.filter(
      (v) =>
        (!options["--version-id"] || v.id === options["--version-id"]) &&
        (v.status === "completed" || (v.status === "superseded" && v.verdict)),
    );
    if (!completed.length)
      throw new Error(
        "No completed version available; partial raw remains saved, no new calls are permitted",
      );
    for (const version of completed) {
      await page.getByRole("combobox", { name: "选择推演版本" }).selectOption(version.id);
      await wait(2000);
      await finishedShots(page, version, shot);
    }
  }
  blockMutations = true;
  await shot(
    "history",
    async () => {
      for (const version of latest.versions) {
        await page.getByRole("combobox", { name: "选择推演版本" }).selectOption(version.id);
        await wait(4500);
      }
    },
    { source: "version selector reading stored real results" },
  );
  if (mode === "live" && !options["--skip-samples"]) await otherCaseShots(page, shot);
  await shot(
    "outro",
    async () => {
      await page.getByRole("button", { name: "方案擂台首页" }).scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
      await wait(7000);
    },
    {
      source:
        mode === "live" && !options["--skip-samples"]
          ? "actual home; sample inputs only"
          : "actual completed arena UI",
    },
  );
  await saveAuth();
  session.status = "completed";
} catch (error) {
  failure = error;
  session.error = error.message;
  if (session.status !== "interrupted") session.status = "failed";
} finally {
  blockMutations = true;
  allowedOperation = null;
  session.endedAt = new Date().toISOString();
  session.recordingSeconds = elapsed();
  save();
  if (context) {
    await saveAuth().catch(() => {});
    const video = page?.video();
    await context.close().catch(() => {});
    await Promise.allSettled([...responseTasks]);
    if (video) {
      const videoPath = await video.path().catch(() => null);
      if (videoPath) {
        session.rawFile = relative(output, videoPath);
        chmodSync(videoPath, 0o600);
        for (const clip of manifest.clips.filter((c) => c.sessionId === sessionId))
          clip.rawFile = session.rawFile;
      }
    }
  }
  await browser?.close().catch(() => {});
  save();
  process.removeListener("SIGINT", closeOnSignal);
  process.removeListener("SIGTERM", closeOnSignal);
  captureLock.release();
  process.removeListener("exit", releaseLockAtExit);
}
console.log(
  JSON.stringify(
    {
      status: session.status,
      manifest: manifestFile,
      arenaId: manifest.arenaId,
      versionIds: manifest.versionIds,
      rawFile: session.rawFile,
      error: session.error,
    },
    null,
    2,
  ),
);
if (failure) process.exitCode = 1;
