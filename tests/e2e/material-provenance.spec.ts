import { expect, test } from "@playwright/test";
import { fixtureIntake, fixtureModels, intakeStorageKey } from "./intake.fixture";

// Explicit UI fixtures, including intentionally mixed model transcription content. No model calls.
test("explicit UI fixture: material labels and previews distinguish local text, model transcription, interpretation and legacy unknown provenance", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const draft = fixtureIntake({
    sources: [
      {
        id: "local",
        attachmentId: "document",
        filename: "local.xlsx",
        location: "图像转录（需核对）!A1",
        text: "测试真正的文档单元格原文。",
        interpretation: false,
        origin: "document",
      },
      {
        id: "transcript",
        attachmentId: "scan",
        filename: "scan.pdf",
        location: "第 1 页",
        text: "测试转录：预算300元。这里还有一句模型混入的图片描述。",
        interpretation: false,
        origin: "model_transcription",
      },
      {
        id: "interpretation",
        attachmentId: "image",
        filename: "chart.png",
        location: "图片 1",
        text: "测试解释：图表可能在比较成本。",
        interpretation: true,
        origin: "model_interpretation",
      },
      {
        id: "legacy",
        attachmentId: "legacy",
        filename: "legacy.pdf",
        location: "第 1 页 · 图像转录（需核对）",
        text: "测试旧记录，没有结构化来源字段。",
        interpretation: false,
      },
    ],
  });
  await page.addInitScript(({ key, id }) => localStorage.setItem(key, id), {
    key: intakeStorageKey,
    id: draft.id,
  });
  await page.route("**/api/**", (route) => {
    if (new URL(route.request().url()).pathname === "/api/health")
      return route.fulfill({
        json: {
          status: "ok",
          version: "explicit-provenance-fixture",
          accessGranted: true,
          requiresAccessCode: false,
          model: {
            id: "gpt-6.1-terra",
            configured: true,
            models: fixtureModels,
            providers: fixtureModels,
          },
        },
      });
    return route.fulfill({ json: draft });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /查看材料原文与位置/ }).click();
  const local = page.getByRole("button", { name: /local.xlsx/ });
  await expect(local).toContainText("· 原文");
  await expect(local).not.toContainText("模型转录，需核对原图");
  await local.click();
  const preview = page.locator(".gi-source-preview");
  await expect(preview).toContainText("测试真正的文档单元格原文。");
  await expect(preview.locator(".gi-file-warning")).toHaveCount(0);
  const transcription = page.getByRole("button", { name: /scan.pdf/ });
  await expect(transcription).toContainText("模型转录，需核对原图");
  await expect(transcription).not.toContainText("· 原文");
  await transcription.click();
  await expect(preview).toContainText(
    "这是模型对图片或扫描页的转录，可能混入描述或推测，请核对原图。",
  );
  await expect(preview).toContainText("这里还有一句模型混入的图片描述。");
  const interpretation = page.getByRole("button", { name: /chart.png/ });
  await expect(interpretation).toContainText("· 模型解读");
  await interpretation.click();
  await expect(preview).toContainText("这是模型对图片或扫描页的解读");
  const legacy = page.getByRole("button", { name: /legacy.pdf/ });
  await expect(legacy).toContainText("· 来源待核对");
  await expect(legacy).not.toContainText("· 原文");
  await expect(legacy).not.toContainText("模型转录，需核对原图");
  await legacy.click();
  await expect(preview).toContainText("这段内容缺少明确的来源记录，请与原材料核对");
});
