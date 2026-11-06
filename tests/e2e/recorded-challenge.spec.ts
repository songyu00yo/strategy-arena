import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Challenge, ModelMode } from "../../src/lib/contracts";
import type { RecordedExamplePayload } from "../../src/lib/recorded-examples";
import { advanceFixture, fixtureSnapshot, fixtureVersion } from "./ui.fixture";
import { configureFixtureModels, intakeStorageKey } from "./intake.fixture";

// Explicit API fixtures validate paid-entry consent and data transfer, never provider quality.
const payload = JSON.parse(
  readFileSync("public/recorded-examples/career.json", "utf8"),
) as RecordedExamplePayload;
const original = payload.arena.versions[0];
const strategy =
  original.revisions.find((revision) => revision.strategyId === "A")?.strategy ??
  original.strategies[0];
const claim = strategy.claims[0];
function completedSnapshot(id: string) {
  const snapshot = configureFixtureModels(fixtureSnapshot());
  snapshot.id = id;
  for (let stage = 0; stage < 5; stage++) advanceFixture(snapshot);
  return snapshot;
}

test("explicit UI fixture: editing a recorded challenge is free and only confirmed entry creates a new real task", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(
    (key) => localStorage.setItem(key, "fixture-previous-paused-draft"),
    intakeStorageKey,
  );
  const fresh = completedSnapshot("fixture-recorded-challenge");
  let configured = true;
  const calls: string[] = [];
  let posted: (Challenge & { modelMode: ModelMode }) | null = null;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    calls.push(`${method} ${path}`);
    if (path === "/api/health") {
      const model = structuredClone(fresh.model);
      model.configured = configured;
      for (const option of [...(model.models ?? []), ...(model.providers ?? [])])
        option.configured = configured;
      return route.fulfill({
        json: {
          status: "ok",
          version: "fixture",
          model,
          requiresAccessCode: false,
          accessGranted: true,
        },
      });
    }
    if (path === "/api/arenas" && method === "POST") {
      posted = route.request().postDataJSON();
      fresh.versions[0].challenge = posted!;
      return route.fulfill({ json: fresh });
    }
    if (path === `/api/arenas/${fresh.id}` && method === "GET")
      return route.fulfill({ json: fresh });
    if (path.endsWith("/events"))
      return route.fulfill({ contentType: "text/event-stream", body: ": explicit UI fixture\n\n" });
    return route.fulfill({ status: 500, json: { error: "Unexpected fixture request" } });
  });
  await page.goto("/examples/career");
  await page.getByRole("button", { name: "开始分析", exact: true }).click();
  await page.keyboard.press("End");
  const trigger = page
    .getByRole("region", { name: "路线 A", exact: true })
    .getByRole("button")
    .filter({ hasText: claim.id });
  await expect(trigger).toBeEnabled();
  await expect(trigger).toContainText("挑战");
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "挑战这条判断", exact: true });
  await expect(dialog).toContainText(claim.text);
  await dialog.getByRole("textbox").fill("测试：这个判断缺少新的照护条件，请重新核验。");
  expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  configured = false;
  await trigger.click();
  await dialog.getByRole("textbox").fill("测试：缺配置时不得开始真实调用。");
  await expect(dialog.getByRole("alert")).toContainText("尚未配置");
  await expect(dialog.getByRole("button", { name: "开始真实挑战", exact: true })).toBeDisabled();
  expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  configured = true;
  await trigger.click();
  const critique = "测试：现有租金差不能证明实际可支配收入，请把照护条件一起核验。";
  await dialog.getByRole("textbox").fill(critique);
  await expect(dialog).toContainText("计费");
  await expect(dialog.getByRole("button", { name: "开始真实挑战", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "开始真实挑战", exact: true }).click();
  await expect(page).toHaveURL(/\/\?arena=fixture-recorded-challenge$/);
  await expect(
    page.getByRole("heading", { name: original.challenge.goal, exact: true }),
  ).toBeVisible();
  expect(calls.filter((call) => call.startsWith("POST"))).toEqual(["POST /api/arenas"]);
  expect(calls.some((call) => call.includes("/api/intakes/"))).toBe(false);
  const body = posted! as Challenge & { modelMode: ModelMode };
  for (const key of [
    "goal",
    "constraints",
    "preferences",
    "options",
    "domain",
    "budget",
    "timeHours",
  ] as const)
    expect(body[key]).toEqual(original.challenge[key]);
  expect(body.materials).toContain(original.challenge.materials);
  expect(body.materials).toContain(claim.text);
  expect(body.materials).toContain(critique);
  expect(body.materials).toContain("待复核");
  expect(body.materials).toContain(payload.metadata.sourceCommit);
  expect(body.modelMode).toBe("gpt-6.1-terra");
  expect(await page.evaluate((key) => localStorage.getItem(key), intakeStorageKey)).toBe(
    "fixture-previous-paused-draft",
  );
});

test("explicit UI fixture: a challenge in a live discussion calls interventions and opens its new version", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const snapshot = completedSnapshot("fixture-live-challenge");
  let submitted: { targetStrategyId: string; targetClaimId: string; text: string } | null = null;
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
    .filter({ hasText: target.id });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "质疑这条判断", exact: true });
  const critique = "测试：请复核准备和等待时间。";
  await dialog.getByRole("textbox").fill(critique);
  await dialog.getByRole("button", { name: "提交质疑", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "测试：挑战已进入第二版", exact: true }),
  ).toBeVisible();
  expect(submitted).toEqual({ targetStrategyId: "A", targetClaimId: target.id, text: critique });
  expect(snapshot.versions).toHaveLength(2);
  expect(snapshot.versions[1].parentVersionId).toBe(snapshot.versions[0].id);
});
