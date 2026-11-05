import { expect, test } from "@playwright/test";
import { fixtureChallenge, fixtureSnapshot, fixtureVersion } from "./ui.fixture";
import { e2eAddress } from "../../scripts/test-address.mjs";
import { routeModel } from "../../src/lib/model-routing";
import type { Challenge, ModelMode } from "../../src/lib/contracts";

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

test("explicit UI fixture: choose model, see auto reason and preserve model on rematch", async ({
  page,
}, testInfo) => {
  const snapshot = fixtureSnapshot();
  snapshot.model.providers = [
    { provider: "deepseek", id: "deepseek-flash", configured: true, currency: "CNY" },
    { provider: "openai", id: "gpt-6.1-terra", configured: true, currency: "USD" },
  ];
  const requests: { modelMode: ModelMode }[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health")
      return route.fulfill({ json: { status: "ok", model: snapshot.model } });
    if (path.endsWith("/events"))
      return route.fulfill({ contentType: "text/event-stream", body: ": explicit UI fixture\n\n" });
    if (path === "/api/arenas" || path.endsWith("/versions")) {
      const body = route.request().postDataJSON();
      requests.push(body);
      const challenge = (body.challenge ?? body) as Challenge;
      const next = path.endsWith("/versions") ? fixtureVersion(2, challenge) : snapshot.versions[0];
      next.status = "paused";
      const selection = routeModel(challenge, body.modelMode);
      next.modelSelection = {
        ...selection,
        requestedMode: body.modelMode,
        modelId: selection.provider === "openai" ? "gpt-6.1-terra" : "deepseek-flash",
        currency: selection.provider === "openai" ? "USD" : "CNY",
      };
      if (path.endsWith("/versions")) snapshot.versions.push(next);
      snapshot.activeVersionId = next.id;
    }
    return route.fulfill({ json: snapshot });
  });
  await page.goto("/");
  await expect(page.getByRole("radio", { name: "自动 费用优先" })).toBeChecked();
  await page.getByLabel("你的目标、备选方案或想法").fill("测试：一个月内完成一门课程并做出小项目");
  await page
    .getByLabel("硬性限制", { exact: false })
    .fill("本地完成；只用现有设备；每天一小时；周末休息");
  await expect(page.getByText(/自动选择 GPT：按换行或分号分隔/)).toBeVisible();
  await page.getByRole("radio", { name: "DeepSeek 手动指定" }).check();
  await page.getByRole("button", { name: "让方案上场" }).click();
  expect(requests[0].modelMode).toBe("deepseek");
  await page.getByRole("button", { name: "修改条件再开局" }).click();
  const dialog = page.getByRole("dialog", { name: "修改条件，重新开局" });
  await expect(dialog.getByRole("radio", { name: "DeepSeek 手动指定" })).toBeChecked();
  await dialog.getByRole("radio", { name: "GPT 6.1 Terra" }).check();
  await dialog.getByLabel("这次为什么修改？", { exact: false }).fill("测试：手动切换 GPT");
  await dialog.getByRole("button", { name: "按新条件重新推演" }).click();
  expect(requests[1].modelMode).toBe("gpt");
  await expect(page.getByText("gpt-6.1-terra", { exact: false }).first()).toBeVisible();
  await page.getByRole("combobox", { name: "选择推演版本" }).selectOption("fixture-version-1");
  await expect(page.getByText("deepseek-flash", { exact: false }).first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "修改条件再开局" }).click();
  await page.screenshot({
    path: testInfo.outputPath("explicit-model-selector-mobile.png"),
    fullPage: true,
  });
});

test("explicit UI fixture: unavailable selected provider blocks submit without changing the choice", async ({
  page,
}) => {
  await page.route("**/api/health", (route) =>
    route.fulfill({
      json: {
        status: "ok",
        model: {
          id: "deepseek-flash",
          configured: true,
          providers: [
            { provider: "deepseek", id: "deepseek-flash", configured: true, currency: "CNY" },
            { provider: "openai", id: "gpt-6.1-terra", configured: false, currency: "USD" },
          ],
        },
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("radio", { name: "GPT 6.1 Terra" }).check();
  await expect(page.getByRole("button", { name: "让方案上场" })).toBeDisabled();
  await expect(page.getByText(/所选模型尚未配置/)).toBeVisible();
  await expect(page.getByRole("radio", { name: "GPT 6.1 Terra" })).toBeChecked();
  await page.getByRole("radio", { name: "DeepSeek 手动指定" }).check();
  await expect(page.getByRole("button", { name: "让方案上场" })).toBeEnabled();
});
