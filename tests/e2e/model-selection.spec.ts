import { expect, test } from "@playwright/test";
import { fixtureChallenge, fixtureSnapshot, fixtureVersion } from "./ui.fixture";
import { e2eAddress } from "../../scripts/test-address.mjs";
import { routeModel } from "../../src/lib/model-routing";
import type { Challenge, ModelMode } from "../../src/lib/contracts";
import {
  configureFixtureModels,
  confirmFixtureIntake,
  fixtureModels,
  fixtureIntake,
  installQuickIntakeFixture,
} from "./intake.fixture";
import { MODEL_CATALOG } from "../../src/lib/model-catalog";

test("real unconfigured API saves GPT selection, rejects invalid mode and never falls back", async ({
  request,
}) => {
  const headers = { Origin: e2eAddress().origin };
  await request.post("/api/access", { headers, data: { code: "e2e-only-access-code" } });
  const invalid = await request.post("/api/arenas", {
    headers,
    data: { ...fixtureChallenge, modelMode: "other" },
  });
  expect(invalid.status()).toBe(400);
  const created = await request.post("/api/arenas", {
    headers,
    data: { ...fixtureChallenge, modelMode: "gpt" },
  });
  expect(created.status()).toBe(201);
  const snapshot = await created.json();
  expect(snapshot.versions[0].modelSelection).toMatchObject({
    requestedMode: "gpt",
    provider: "openai",
    currency: "USD",
    modelId: "gpt-6.1-terra",
  });
  expect(snapshot.versions[0].challenge).not.toHaveProperty("modelMode");
  const advance = await request.post(`/api/arenas/${snapshot.id}/advance`, {
    headers,
    data: { versionId: snapshot.activeVersionId },
  });
  expect(advance.status()).toBe(503);
  expect((await advance.json()).code).toBe("MODEL_NOT_CONFIGURED");
  const rematch = await request.post(`/api/arenas/${snapshot.id}/versions`, {
    headers,
    data: { challenge: fixtureChallenge, changeReason: "测试：沿用模型选择" },
  });
  expect((await rematch.json()).versions[1].modelSelection.requestedMode).toBe("gpt");
});

test("explicit UI fixture: choose a concrete model, inspect its reason and preserve model history", async ({
  page,
}, testInfo) => {
  const snapshot = configureFixtureModels(fixtureSnapshot());
  const requests: { modelMode: ModelMode; challenge: Challenge }[] = [];
  const select = (challenge: Challenge, modelMode: ModelMode, rematch: boolean) => {
    requests.push({ challenge, modelMode });
    const next = rematch ? fixtureVersion(2, challenge) : snapshot.versions[0];
    next.status = "paused";
    const selection = routeModel(challenge, modelMode);
    next.modelSelection = {
      ...selection,
      requestedMode: modelMode,
      currency: selection.provider === "openai" ? "USD" : "CNY",
    };
    next.costCny = selection.provider === "deepseek" ? 0.12 : 0;
    next.reservedCny = selection.provider === "deepseek" ? 0.03 : 0;
    next.costUsd = selection.provider === "openai" ? 0.24 : 0;
    next.reservedUsd = selection.provider === "openai" ? 0.06 : 0;
    if (rematch) snapshot.versions.push(next);
    snapshot.activeVersionId = next.id;
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health")
      return route.fulfill({ json: { status: "ok", model: snapshot.model } });
    if (path.endsWith("/events"))
      return route.fulfill({ contentType: "text/event-stream", body: ": explicit UI fixture\n\n" });
    if (path.endsWith("/versions")) {
      const body = route.request().postDataJSON();
      select(body.challenge, body.modelMode, true);
    }
    return route.fulfill({ json: snapshot });
  });
  await installQuickIntakeFixture(page, snapshot, (draft, body) =>
    select(body.challenge, draft.modelMode, false),
  );
  await page.goto("/");
  // Tools appear once there is text; one character does not start a draft.
  await page.getByLabel("你想解决什么问题？", { exact: true }).fill("测");
  await page.getByRole("button", { name: /^选择模型，当前/ }).click();
  await expect(page.getByRole("option", { name: "GPT 6.1 Terra", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("option")).toHaveCount(5);
  await page.getByRole("option", { name: "DeepSeek V4.1 Flash", exact: true }).click();
  await page.getByRole("button", { name: /^选择模型，当前/ }).click();
  await page.getByRole("button", { name: "查看选择依据", exact: true }).click();
  await expect(
    page.getByText("按你的选择使用 DeepSeek V4.1 Flash。", { exact: false }),
  ).toBeVisible();
  await confirmFixtureIntake(page, "测试：一个月内完成一门课程并做出小项目");
  expect(requests[0].modelMode).toBe("deepseek-flash");
  await expect(page.locator(".arena-cost")).toContainText("¥0.12");
  await expect(page.locator(".arena-cost")).toContainText("¥0.03");
  await page.getByRole("button", { name: "调整条件" }).click();
  const dialog = page.getByRole("dialog", { name: "调整条件" });
  await dialog.getByRole("button", { name: /^完整编辑/ }).click();
  await dialog.getByRole("button", { name: /^选择模型，当前/ }).click();
  await expect(
    dialog.getByRole("option", { name: "DeepSeek V4.1 Flash", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await dialog.getByRole("option", { name: "GPT 6.1 Terra", exact: true }).click();
  await dialog.getByRole("button", { name: /^补充说明/ }).click();
  await dialog.getByLabel("补充说明", { exact: false }).fill("测试：手动切换 GPT");
  await dialog.getByRole("button", { name: "按新条件重新推演" }).click();
  expect(requests[1].modelMode).toBe("gpt-6.1-terra");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("combobox", { name: "选择推演版本" })).toHaveValue(
    "fixture-version-2",
  );
  await expect(page.getByText("gpt-6.1-terra", { exact: false }).first()).toBeVisible();
  await expect(page.locator(".arena-cost")).toContainText("$0.24");
  await expect(page.locator(".arena-cost")).toContainText("$0.06");
  await page.getByRole("combobox", { name: "选择推演版本" }).selectOption("fixture-version-1");
  await expect(page.getByRole("combobox", { name: "选择推演版本" })).toHaveValue(
    "fixture-version-1",
  );
  await expect(page.getByText("deepseek-flash", { exact: false }).first()).toBeVisible();
  await expect(page.locator(".arena-cost")).toContainText("¥0.12");
  await expect(page.locator(".arena-cost")).not.toContainText("$0.24");
  await expect(page.getByRole("combobox", { name: "选择推演版本" })).toBeFocused();
  await page.getByRole("button", { name: "真实模型推演", exact: true }).click();
  const information = page.getByRole("dialog", { name: "模型与运行信息" });
  await expect(information).toContainText("deepseek-flash");
  await expect(information).not.toContainText("gpt-6.1-terra");
  await page.keyboard.press("Escape");
  await expect(information).not.toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "调整条件", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "回到当前版本", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "选择推演版本" })).toHaveValue(
    "fixture-version-2",
  );
  await page.getByRole("button", { name: "调整条件" }).click();
  await dialog.getByRole("button", { name: /^完整编辑/ }).click();
  await dialog.getByRole("button", { name: /^选择模型，当前/ }).click();
  await expect(dialog.getByRole("option", { name: "GPT 6.1 Terra", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.screenshot({
    path: testInfo.outputPath("explicit-model-selector-mobile.png"),
    fullPage: true,
  });
});

test("explicit UI fixture: all five model choices remain selectable and unavailable exact model blocks analysis", async ({
  page,
}) => {
  const models = fixtureModels.map((model) => ({
    ...model,
    configured: model.id === "deepseek-flash" || model.id === "gpt-6.1-terra",
  }));
  let paidRequests = 0;
  let draft = fixtureIntake();
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health")
      return route.fulfill({
        json: {
          status: "ok",
          model: { id: "gpt-6.1-terra", configured: true, providers: models, models },
        },
      });
    if (path.endsWith("/analyze") || path.endsWith("/submit")) {
      paidRequests++;
      return route.fulfill({ status: 500, json: { error: "Unexpected paid fixture mutation" } });
    }
    if (route.request().method() === "POST") draft = fixtureIntake(route.request().postDataJSON());
    if (route.request().method() === "PATCH")
      draft = { ...draft, ...route.request().postDataJSON(), revision: draft.revision + 1 };
    return route.fulfill({ json: draft });
  });
  await page.goto("/");
  await page
    .getByLabel("你想解决什么问题？", { exact: true })
    .fill("测试：需要选择一个适合学习任务的具体模型");
  await page.getByRole("button", { name: /^选择模型，当前/ }).click();
  await expect(page.getByRole("option")).toHaveCount(5);
  for (const [index, model] of MODEL_CATALOG.entries()) {
    const trigger = page.getByRole("button", { name: /^选择模型，当前/ });
    if (index > 0) await trigger.click();
    const option = page.getByRole("option", { name: model.label, exact: true });
    await option.click();
    await expect(trigger).toHaveAccessibleName(`选择模型，当前${model.label}`);
    await expect(trigger).toBeEnabled();
    if (model.id === "deepseek-flash" || model.id === "gpt-6.1-terra")
      await expect(page.getByRole("button", { name: "开始分析", exact: true })).toBeEnabled();
    else {
      await expect(page.getByRole("button", { name: "开始分析", exact: true })).toBeDisabled();
      await expect(page.getByText(/所选模型尚未配置/).first()).toBeVisible();
    }
  }
  expect(paidRequests).toBe(0);
});
