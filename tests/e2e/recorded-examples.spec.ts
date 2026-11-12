import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { RECORDED_EXAMPLES, type RecordedExamplePayload } from "../../src/lib/recorded-examples";

// Saved real-provider outputs with explicitly simulated inputs and Codex answers.
function recording(slug: string): RecordedExamplePayload {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), "public/recorded-examples", `${slug}.json`), "utf8"),
  );
}

async function watchReadOnlyRequests(page: Page, origin: string, homepage = false) {
  const forbidden: string[] = [];
  const apiReads: string[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const api = url.pathname.startsWith("/api/");
    const allowedHealth = homepage && url.pathname === "/api/health" && request.method() === "GET";
    if (api) apiReads.push(`${request.method()} ${url.pathname}`);
    if (url.origin !== origin || request.method() !== "GET" || (api && !allowedHealth)) {
      forbidden.push(`${request.method()} ${url.href}`);
      return route.abort();
    }
    return route.continue();
  });
  return { forbidden, apiReads };
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
}

for (const example of RECORDED_EXAMPLES) {
  for (const width of [1440, 390]) {
    test(`saved real-model simulation: ${example.slug} replays questions, answers and final handoff at ${width}px with zero model calls`, async ({
      page,
      baseURL,
    }) => {
      const payload = recording(example.slug);
      const version = payload.arena.versions.at(-1)!;
      const state = version.clarification!;
      const calls = await watchReadOnlyRequests(page, new URL(baseURL!).origin);
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`/examples/${example.slug}`);
      await expect(page.getByRole("heading", { name: example.title, exact: true })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "你想做什么", exact: true })).toHaveValue(
        version.intake!.originalGoal,
      );
      if (version.challenge.preferences)
        await expect(page.locator(".recorded-entry-form")).not.toContainText(
          version.challenge.preferences,
        );
      await expect(
        page.getByText("真实模型运行的模拟案例 · 回看新增调用为 0", { exact: true }),
      ).toBeVisible();
      await noOverflow(page);
      await page.getByRole("button", { name: "暂停自动开始", exact: true }).click();
      await page.getByRole("button", { name: "开始回看", exact: true }).click();
      await expect(page.getByRole("button", { name: "第 1 步", exact: true })).toHaveAttribute(
        "aria-current",
        "step",
      );

      const bIndex = state.runs.findIndex(
        (run) => run.role === "B" && "questions" in run.output && run.output.questions.length > 0,
      );
      const b = state.runs[bIndex];
      const questions = "questions" in b.output ? b.output.questions : [];
      await page.getByRole("button", { name: `第 ${bIndex + 1} 步`, exact: true }).click();
      await page.getByRole("button", { name: `查看第 ${bIndex + 1} 步`, exact: true }).click();
      const card = page.getByRole("dialog", { name: new RegExp(`^第 ${bIndex + 1} 步 ·`) });
      await expect(card).toBeVisible();
      for (const question of questions) {
        await expect(card).toContainText(question.title);
        for (const option of question.options) await expect(card).toContainText(option);
      }
      await expect(card).toContainText("已记录回答");
      const sourceRound = state.rounds.findIndex((round) => round.runIds.includes(b.id));
      const nextAnswers = state.rounds.slice(sourceRound + 1).flatMap((round) => round.answers);
      const firstAnswer = nextAnswers.find((answer) => answer.questionId === questions[0].id)!;
      await expect(card).toContainText(
        Array.isArray(firstAnswer.value) ? firstAnswer.value.join("、") : firstAnswer.value,
      );
      await page.keyboard.press("Escape");
      await expect(card).toBeHidden();

      const sourceButton = page.getByRole("button", { name: "原题与记录", exact: true });
      await sourceButton.click();
      const source = page.getByRole("dialog", { name: "原始目标与需求梳理记录", exact: true });
      await expect(source).toContainText("Codex");
      await expect(source).toContainText(example.sourceCommit);
      await expect(source).toContainText(version.intake!.originalGoal);
      await expect(source).toContainText("没有真实执行反馈");
      await page.keyboard.press("Escape");
      await expect(source).toBeHidden();
      await page.keyboard.press("End");
      await expect(
        page.getByRole("heading", { name: "需求说明与执行提示词", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "看完整结论", exact: true }).click();
      await expect(page.locator(".c-result .lead > p")).toHaveText(state.specification);
      await expect(page.locator(".c-result .first strong")).toHaveText(state.executionPrompt);
      expect(await page.locator(".c-result .lead > p").textContent()).toBe(state.specification);
      expect(await page.locator(".c-result .first strong").textContent()).toBe(
        state.executionPrompt,
      );
      await expect(page.locator(".c-result .lead > p")).toHaveCSS("white-space", "pre-wrap");
      await noOverflow(page);
      const output = path.join(process.cwd(), "work/new-clarification-examples/screenshots");
      mkdirSync(output, { recursive: true });
      await page.screenshot({
        path: path.join(output, `${example.slug}-${width}.png`),
        fullPage: true,
      });
      expect(calls.forbidden).toEqual([]);
      expect(calls.apiReads).toEqual([]);
    });
  }
}

test("homepage offers exactly the three new clarification examples and the exact new prompt", async ({
  page,
  baseURL,
}) => {
  const calls = await watchReadOnlyRequests(page, new URL(baseURL!).origin, true);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "你想做什么", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "你想做什么", exact: true })).toHaveAttribute(
    "placeholder",
    "先说说你想做的东西，没想清楚也没关系。可以添加文件或直接粘贴材料。",
  );
  await page.getByRole("button", { name: "先看需求梳理示例", exact: true }).click();
  const gallery = page.getByRole("dialog", { name: "先看需求梳理示例", exact: true });
  await expect(gallery.getByRole("link")).toHaveCount(3);
  for (const example of RECORDED_EXAMPLES)
    await expect(gallery.getByRole("heading", { name: example.title, exact: true })).toBeVisible();
  await expect(gallery).toContainText("真实模型运行的模拟案例");
  await expect(gallery).not.toContainText("三条路线如何提案");
  await noOverflow(page);
  expect(calls.forbidden).toEqual([]);
});

test("retired case pages and public recording URLs return 404", async ({ request }) => {
  for (const slug of ["learning", "career", "creation", "course-site"]) {
    expect((await request.get(`/examples/${slug}`)).status()).toBe(404);
    expect((await request.get(`/recorded-examples/${slug}.json`)).status()).toBe(404);
  }
});
