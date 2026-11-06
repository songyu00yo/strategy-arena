import { expect, test } from "@playwright/test";
import { fixtureChallenge } from "./ui.fixture";
import { fixtureIntake, fixtureModels, intakeStorageKey } from "./intake.fixture";
import type { IntakeDraft } from "../../src/lib/intake-contracts";

// Explicit UI fixtures only. No model dispatch or real billing occurs in these checks.
const health = {
  status: "ok",
  version: "explicit-uncertain-ui-fixture",
  commit: "fixture",
  accessGranted: true,
  requiresAccessCode: false,
  model: { id: "gpt-6.1-terra", configured: true, providers: fixtureModels, models: fixtureModels },
};
const unknownDraft = () =>
  fixtureIntake({
    id: "fixture-uncertain-intake",
    revision: 5,
    status: "uncertain",
    reservedUsd: 0.07,
    error: "测试：上次调用的完成与费用尚未确认。",
    attachments: [
      {
        id: "uncertain-material",
        name: "retained.txt",
        size: 40,
        state: "ready",
        imageCount: 0,
        interpreted: false,
        locations: ["第 1 行"],
        warnings: [],
      },
    ],
    sources: [
      {
        id: "retained-source",
        attachmentId: "uncertain-material",
        filename: "retained.txt",
        location: "第 1 行",
        text: "测试已保存原文：保留现有收入。",
        interpretation: false,
      },
    ],
  });

test("explicit UI fixture: restored uncertain draft blocks mutations and model changes while keeping materials readable and new drafts separate", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const old = unknownDraft();
  let next = fixtureIntake({ id: "fixture-new-after-uncertain", goal: "" });
  const mutations: { path: string; method: string }[] = [];
  const analyses: string[] = [];
  await page.addInitScript(({ key, id }) => localStorage.setItem(key, id), {
    key: intakeStorageKey,
    id: old.id,
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === "/api/health") return route.fulfill({ json: health });
    if (method !== "GET") mutations.push({ path, method });
    if (path === `/api/intakes/${old.id}` && method === "GET") return route.fulfill({ json: old });
    if (path.startsWith(`/api/intakes/${old.id}`))
      return route.fulfill({
        status: 409,
        json: { code: "INTAKE_UNCERTAIN", error: "测试服务保护：未知草稿不能再次发起模型请求。" },
      });
    if (path === "/api/intakes" && method === "POST")
      next = fixtureIntake({ ...route.request().postDataJSON(), id: next.id });
    else if (method === "PATCH")
      next = { ...next, ...route.request().postDataJSON(), revision: next.revision + 1 };
    if (path.endsWith("/analyze")) {
      analyses.push(path);
      next = {
        ...next,
        revision: next.revision + 1,
        status: "summary",
        challenge: { ...fixtureChallenge, goal: next.goal },
      };
    }
    return route.fulfill({ json: next });
  });
  await page.goto("/");
  const intake = page.getByRole("region", { name: "准备一场推演", exact: true });
  await expect(intake.getByRole("alert")).toContainText("此草稿已暂停模型请求，等待核账。");
  await expect(intake.getByRole("alert")).toContainText("切换模型不能解除暂停");
  await expect(intake.getByRole("alert")).toContainText("原来的调用记录和预留额度仍会保留");
  await expect(page.getByRole("button", { name: "开始分析", exact: true })).toBeDisabled();
  await expect(
    page.getByRole("textbox", { name: "你想解决什么问题？", exact: true }),
  ).toHaveJSProperty("readOnly", true);
  await expect(
    page.getByRole("textbox", { name: "你想解决什么问题？", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("button", { name: "上传参考材料", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "移除 retained.txt", exact: true })).toBeDisabled();
  await expect(intake).toContainText("USD $0.0700");
  // Browsing model information remains usable, but changing the same frozen draft is blocked.
  const model = page.getByRole("button", { name: "选择模型，当前GPT 6.1 Terra", exact: true });
  await model.click();
  const sol = page.getByRole("option", { name: "GPT 6.1 Sol", exact: true });
  await expect(sol).toHaveAttribute("aria-disabled", "true");
  await sol.focus();
  await page.keyboard.press("Enter");
  await expect(model).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("option", { name: "GPT 6.1 Terra", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("button", { name: "查看选择依据", exact: true }).click();
  await expect(
    page.getByText("使用 GPT 6.1 Terra，这是当前默认模型。", { exact: false }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /查看材料原文与位置/ }).click();
  await page.getByRole("button", { name: /retained.txt 第 1 行/ }).click();
  await expect(page.getByText("测试已保存原文：保留现有收入。", { exact: true })).toBeVisible();
  // A programmatic submit event must not bypass the disabled analyze button.
  await page.locator(".gi-composer").dispatchEvent("submit");
  await page.waitForTimeout(1200);
  expect(mutations).toEqual([]);
  expect(analyses).toEqual([]);
  expect(await page.evaluate((key) => localStorage.getItem(key), intakeStorageKey)).toBe(old.id);
  await page.getByRole("button", { name: "准备新问题", exact: true }).click();
  await page
    .getByRole("textbox", { name: "你想解决什么问题？", exact: true })
    .fill("测试：另建一个独立草稿，不重放上一份未知请求");
  await page.getByRole("button", { name: "开始分析", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "这是我们理解的任务。", exact: true }),
  ).toBeVisible();
  expect(analyses).toEqual([`/api/intakes/${next.id}/analyze`]);
  expect(mutations.some((request) => request.path.startsWith(`/api/intakes/${old.id}`))).toBe(
    false,
  );
  expect(old.reservedUsd).toBe(0.07);
});

test("explicit UI fixture: a newly uncertain analysis cannot be replayed after response or refresh", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  let draft: IntakeDraft = fixtureIntake({ goal: "" });
  let analyzes = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === "/api/health") return route.fulfill({ json: health });
    if (path === "/api/intakes" && method === "POST")
      draft = fixtureIntake(route.request().postDataJSON());
    if (path.endsWith("/analyze")) {
      analyzes++;
      draft = {
        ...draft,
        revision: draft.revision + 1,
        status: "uncertain",
        error: "测试：连接中断，调用费用待确认。",
        reservedUsd: 0.08,
      };
    }
    return route.fulfill({ json: draft });
  });
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "你想解决什么问题？", exact: true })
    .fill("测试：分析返回未知状态后等待核账，禁止重复模型调用");
  await page.getByRole("button", { name: "开始分析", exact: true }).click();
  await expect(page.getByRole("region", { name: "准备一场推演" }).getByRole("alert")).toContainText(
    "等待核账",
  );
  await expect(page.getByRole("button", { name: "开始分析", exact: true })).toBeDisabled();
  expect(analyzes).toBe(1);
  await page.locator(".gi-composer").dispatchEvent("submit");
  await page.reload();
  await expect(page.getByRole("button", { name: "开始分析", exact: true })).toBeDisabled();
  await expect(page.getByRole("region", { name: "准备一场推演" })).toContainText("USD $0.0800");
  await page.locator(".gi-composer").dispatchEvent("submit");
  await page.waitForTimeout(1200);
  expect(analyzes).toBe(1);
});
