import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { RECORDED_EXAMPLES, type RecordedExamplePayload } from "../../src/lib/recorded-examples";
import { buildClarificationReplay } from "../../src/lib/replay";

// Saved real-model results with explicitly simulated answers. These tests make no model calls.
function recorded(slug: string) {
  const payload = JSON.parse(
    readFileSync(`public/recorded-examples/${slug}.json`, "utf8"),
  ) as RecordedExamplePayload;
  const version = payload.arena.versions.find(
    (entry) => entry.id === payload.arena.activeVersionId,
  )!;
  return { payload, version, steps: buildClarificationReplay(version, payload.replayActions) };
}

async function openReplay(page: Page, slug: string) {
  const forbidden: string[] = [];
  await page.route("**/api/**", (route) => {
    forbidden.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.abort();
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`/examples/${slug}`);
  await page.getByRole("button", { name: "暂停自动开始", exact: true }).click();
  await page.getByRole("button", { name: "开始回看", exact: true }).click();
  await expect(page.getByRole("button", { name: "第 1 步", exact: true })).toHaveAttribute(
    "aria-current",
    "step",
  );
  return forbidden;
}

async function go(page: Page, index: number) {
  await page.getByRole("button", { name: `第 ${index + 1} 步`, exact: true }).click();
}

const metric = (page: Page, label: string) =>
  page
    .locator(".c-metrics > div")
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator("dd");

for (const example of RECORDED_EXAMPLES) {
  for (const width of [1440, 390]) {
    test(`normal animation: ${example.slug} shows choices before answers and confirms only at its own step at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const { steps } = recorded(example.slug);
      const forbidden = await openReplay(page, example.slug);
      await expect(metric(page, "已确认")).toHaveText("0");
      const questionIndex = steps.findIndex((step) => step.replayAction?.kind === "questions");
      const action = steps[questionIndex].replayAction!;
      await go(page, questionIndex);
      const scene = page.getByRole("region", { name: "补问过程回放", exact: true });
      await expect(scene).toBeVisible();
      for (const question of action.questions!) {
        const field = scene.locator(`[data-question-id="${question.id}"]`);
        await expect(field).toContainText(question.title);
        for (const option of question.options)
          await expect(field.getByLabel(option, { exact: true })).not.toBeChecked();
      }
      await expect(scene).toContainText("按保存记录重建");
      await expect(scene.locator('[data-confirmation="confirmed"]')).toHaveCount(0);
      const callsBefore = String(
        new Set(
          steps.slice(0, questionIndex + 1).flatMap((step) => step.clarificationRun?.callIds ?? []),
        ).size,
      );
      await expect(metric(page, "模型调用")).toHaveText(callsBefore);
      const answerIndex = steps.findIndex((step) => step.replayAction?.kind === "answer");
      await go(page, answerIndex);
      await expect(scene).toContainText("待确认");
      await expect(metric(page, "已确认")).toHaveText("0");
      await expect(metric(page, "模型调用")).toHaveText(callsBefore);
      const confirmationIndex = steps.findIndex(
        (step) => step.replayAction?.kind === "round_confirm",
      );
      await go(page, confirmationIndex);
      const confirmed = steps[confirmationIndex].replayAction!.answers!.filter(
        (answer) =>
          answer.state === "answered" &&
          answer.confirmation === "confirmed" &&
          !answer.needsReconfirmation,
      ).length;
      await expect(metric(page, "已确认")).toHaveText(String(confirmed));
      await expect(scene).toContainText("本次确认已记录");
      await expect(page.locator(".c-result-region")).toHaveAttribute("aria-hidden", "true");
      await expect(page.locator(".c-time [aria-current=step]")).toBeInViewport();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      expect(forbidden).toEqual([]);
    });
  }
}

test("normal animation: pausing a newly entered B card leaves its text readable", async ({
  page,
}) => {
  const forbidden = await openReplay(page, "personal-website");
  await page.waitForSelector(".c-board-B.speaking");
  await page.evaluate(() =>
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "暂停放映")
      ?.click(),
  );
  const text = page.locator(".c-board-B .c-board-body");
  const firstB = recorded("personal-website").steps.find(
    (step) => step.clarificationRun?.role === "B",
  )!.clarificationRun!;
  await expect(text).toContainText(firstB.summary);
  const state = async () =>
    text.evaluate((element) =>
      [...element.children].map((child) => ({
        opacity: Number(getComputedStyle(child).opacity),
        text: child.textContent,
      })),
    );
  expect((await state()).every((child) => child.opacity > 0)).toBe(true);
  const current = await page.locator(".c-time [aria-current=step]").getAttribute("aria-label");
  await page.waitForTimeout(700);
  expect((await state()).every((child) => child.opacity > 0)).toBe(true);
  await expect(page.locator(".c-time [aria-current=step]")).toHaveAttribute("aria-label", current!);
  expect(forbidden).toEqual([]);
});

test("normal animation: selection, pause, modal, speed and resume share the same action clock", async ({
  page,
}) => {
  const { steps } = recorded("personal-website");
  const forbidden = await openReplay(page, "personal-website");
  const questionIndex = steps.findIndex((step) => step.replayAction?.kind === "questions");
  const answerIndex = steps.findIndex((step) => step.replayAction?.kind === "answer");
  await go(page, questionIndex);
  await page.getByRole("button", { name: "继续放映", exact: true }).click();
  const root = page.locator(".c-root");
  await expect(root).toHaveAttribute("data-replay-kind", "answer", { timeout: 12000 });
  await page.waitForFunction(
    () => Number(document.querySelector(".c-root")?.getAttribute("data-replay-progress")) >= 0.5,
  );
  await page.getByRole("button", { name: "暂停放映", exact: true }).click();
  const progress = await root.getAttribute("data-replay-progress");
  const selected = steps[answerIndex].replayAction!.answers![0];
  const scene = page.getByRole("region", { name: "补问过程回放" });
  await expect(scene.getByLabel(String(selected.value), { exact: true })).toBeChecked();
  await expect(metric(page, "已确认")).toHaveText("0");
  for (let index = 0; index < 3; index++)
    await page.getByRole("button", { name: "放映速度", exact: true }).click();
  await page.waitForTimeout(600);
  await expect(root).toHaveAttribute("data-replay-progress", progress!);
  await page.getByRole("button", { name: "查看 A 需求拆解 的详情", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.waitForTimeout(400);
  await expect(root).toHaveAttribute("data-replay-progress", progress!);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(scene.getByLabel(String(selected.value), { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "继续放映", exact: true }).click();
  await expect(root).toHaveAttribute("data-replay-kind", "round_confirm", { timeout: 6000 });
  await page.waitForFunction(
    () => Number(document.querySelector(".c-root")?.getAttribute("data-replay-progress")) >= 0.84,
  );
  await expect(metric(page, "已确认")).toHaveText("1");
  expect(forbidden).toEqual([]);
});
