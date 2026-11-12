import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { ModelMode } from "../../src/lib/contracts";
import { RECORDED_EXAMPLES, type RecordedExamplePayload } from "../../src/lib/recorded-examples";
import { advanceFixture, fixtureSnapshot, fixtureVersion } from "./ui.fixture";
import { configureFixtureModels, fixtureIntake, intakeStorageKey } from "./intake.fixture";

// Explicit API fixtures validate entry consent and data transfer, never provider quality.
function completedSnapshot(id: string) {
  const snapshot = configureFixtureModels(fixtureSnapshot());
  snapshot.id = id;
  for (let stage = 0; stage < 5; stage++) advanceFixture(snapshot);
  return snapshot;
}

test("explicit UI fixture: a recorded clarification prepares the original intake only after confirmation", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const metadata = RECORDED_EXAMPLES[0];
  const payload = JSON.parse(
    readFileSync(`public/recorded-examples/${metadata.slug}.json`, "utf8"),
  ) as RecordedExamplePayload;
  const version = payload.arena.versions.at(-1)!;
  const previousDraft = "fixture-previous-paused-draft";
  await page.addInitScript(
    ({ key, previous }) => {
      if (!sessionStorage.getItem("fixture-initial-draft-pointer")) {
        localStorage.setItem(key, previous);
        sessionStorage.setItem("fixture-initial-draft-pointer", "1");
      }
    },
    { key: intakeStorageKey, previous: previousDraft },
  );
  const fresh = completedSnapshot("fixture-recorded-intake");
  const calls: string[] = [];
  let posted: { workflow: string; goal: string; modelMode: ModelMode } | null = null;
  let uploaded = "";
  let draft = fixtureIntake({ id: "fixture-from-recording", workflow: "clarification" });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    calls.push(`${method} ${path}`);
    if (path === "/api/health") {
      const model = structuredClone(fresh.model);
      model.configured = false;
      for (const option of [...(model.models ?? []), ...(model.providers ?? [])])
        option.configured = false;
      return route.fulfill({
        json: { status: "ok", model, requiresAccessCode: false, accessGranted: true },
      });
    }
    if (path === "/api/intakes" && method === "POST") {
      posted = route.request().postDataJSON();
      draft = { ...draft, goal: posted!.goal, modelMode: posted!.modelMode };
      return route.fulfill({ status: 201, json: draft });
    }
    if (path === `/api/intakes/${draft.id}/attachments` && method === "POST") {
      uploaded = route.request().postDataBuffer()?.toString("utf8") ?? "";
      draft = {
        ...draft,
        revision: draft.revision + 1,
        attachments: [
          {
            id: "fixture-recording-source",
            name: "历史需求讨论.md",
            size: uploaded.length,
            state: "ready",
            imageCount: 0,
            interpreted: false,
            locations: ["文字材料"],
            warnings: [],
          },
        ],
      };
      return route.fulfill({ status: 201, json: draft });
    }
    if (path === `/api/intakes/${draft.id}` && method === "GET")
      return route.fulfill({ json: draft });
    if (path === "/api/identity")
      return route.fulfill({ json: { identityTag: "a".repeat(64), hasRecoveryCode: false } });
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected explicit recording-to-intake fixture request" },
    });
  });
  await page.goto(`/examples/${metadata.slug}`);
  await page.getByRole("button", { name: "开始回看", exact: true }).click();
  await page.keyboard.press("End");
  const openSupplement = async () => {
    await page.getByRole("button", { name: "查看第 1 步", exact: true }).focus();
    await page.keyboard.press("Enter");
    const card = page.getByRole("dialog", { name: /^第 1 步 ·/ });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "补充或质疑", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "补充这一步", exact: true });
    await expect(dialog).toBeVisible();
    return dialog;
  };
  let dialog = await openSupplement();
  const goal = "【明确标注的界面测试替身输入】我想补充这个需求，请先重新询问目标和范围。";
  await dialog.getByLabel("你想补充或询问什么？", { exact: true }).fill(goal);
  expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
  expect(await page.evaluate((key) => localStorage.getItem(key), intakeStorageKey)).toBe(
    previousDraft,
  );
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
  dialog = await openSupplement();
  await dialog.getByLabel("你想补充或询问什么？", { exact: true }).fill(goal);
  await expect(
    dialog.getByRole("button", { name: "确认并准备需求草稿", exact: true }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "确认并准备需求草稿", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByLabel("你想做什么", { exact: true })).toHaveValue(goal);
  expect(posted).toMatchObject({ workflow: "clarification", goal });
  expect(uploaded).toContain(metadata.sourceCommit);
  expect(uploaded).toContain(version.id);
  expect(calls.filter((call) => call.startsWith("POST"))).toEqual([
    "POST /api/intakes",
    `POST /api/intakes/${draft.id}/attachments`,
  ]);
  expect(calls.some((call) => /\/(analyze|advance|submit)$/.test(call))).toBe(false);
  expect(await page.evaluate((key) => localStorage.getItem(key), intakeStorageKey)).toBe(draft.id);
});

test("explicit UI fixture: a challenge in a live discussion calls interventions and opens its new version", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const snapshot = completedSnapshot("fixture-live-challenge");
  let submitted: {
    targetStrategyId: string;
    targetClaimId: string;
    text: string;
    baseVersionId: string;
    quote: string;
  } | null = null;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health")
      return route.fulfill({
        json: {
          status: "ok",
          version: "fixture",
          model: snapshot.model,
          requiresAccessCode: false,
          accessGranted: true,
        },
      });
    if (path.endsWith("/events"))
      return route.fulfill({ contentType: "text/event-stream", body: ": explicit UI fixture\n\n" });
    if (path.endsWith("/interventions")) {
      submitted = route.request().postDataJSON();
      const parent = snapshot.versions[0];
      parent.status = "superseded";
      const next = fixtureVersion(2, parent.challenge);
      next.parentVersionId = parent.id;
      next.status = "completed";
      next.stage = "judge";
      next.strategies = structuredClone(parent.strategies);
      next.attacks = structuredClone(parent.attacks);
      next.evidence = structuredClone(parent.evidence);
      next.revisions = structuredClone(parent.revisions);
      next.verdict = structuredClone(parent.verdict);
      next.verdict!.headline = "测试：挑战已进入第二版";
      snapshot.versions.push(next);
      snapshot.activeVersionId = next.id;
    }
    return route.fulfill({ json: snapshot });
  });
  await page.goto(`/?arena=${snapshot.id}`);
  const current = snapshot.versions[0].revisions.find(
    (revision) => revision.strategyId === "A",
  )!.strategy;
  const target = current.claims[0];
  const trigger = page
    .getByRole("region", { name: "路线 A", exact: true })
    .getByRole("button")
    .filter({ hasText: target.text });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "质疑这条判断", exact: true });
  const critique = "测试：请复核准备和等待时间。";
  await dialog.getByRole("textbox").fill(critique);
  await dialog.getByRole("button", { name: "提交质疑", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "测试：挑战已进入第二版", exact: true }),
  ).toBeVisible();
  expect(submitted).toEqual({
    targetStrategyId: "A",
    targetClaimId: target.id,
    text: critique,
    baseVersionId: snapshot.versions[0].id,
    quote: target.text,
  });
  expect(snapshot.versions).toHaveLength(2);
  expect(snapshot.versions[1].parentVersionId).toBe(snapshot.versions[0].id);
});
