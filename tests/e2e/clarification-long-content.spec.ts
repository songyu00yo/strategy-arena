// Explicit synthetic browser records. All API requests are intercepted, with no model calls.
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type {
  ClarificationRun,
  ClarificationState,
  DecisionItem,
} from "../../src/lib/clarification-contracts";
import type { IntakeQuestion, RecordedAnswer } from "../../src/lib/intake-contracts";
import { buildClarificationReplay, projectReplay } from "../../src/lib/replay";
import { configureFixtureModels } from "./intake.fixture";
import { fixtureSnapshot } from "./ui.fixture";

const date = "2026-11-15T00:00:00.000Z";
const specification = `【测试替身】长需求报告\n${"已确认内容包含范围、流程、材料与验收方式。\n".repeat(400)}${"unbrokenspecification".repeat(40)}`;
const executionPrompt = `【测试替身】长执行提示词\n${"按本人已确认内容执行，遇到未知事项继续询问。\n".repeat(180)}${"unbrokenprompt".repeat(40)}`;

function longSnapshot() {
  const snapshot = configureFixtureModels(fixtureSnapshot());
  const version = snapshot.versions[0];
  const challenge = {
    ...version.challenge,
    goal: `【测试替身】长标题${"UnbrokenGoal".repeat(100)}`,
    constraints: `【测试替身】${"UnbrokenConstraint".repeat(140)}`,
    preferences: "【测试替身】" + "优先保持报告完整和三张角色卡片可见。".repeat(40),
  };
  const questions: IntakeQuestion[] = [1, 2, 3].map((round) => ({
    id: `scope_${round}`,
    decisionId: `scope_${round}`,
    title: `【测试替身】第 ${round} 轮范围确认`,
    reason: "这是预设的多轮浏览器测试记录。",
    type: "text",
    options: [],
    placeholder: "",
    unit: "",
  }));
  const items: DecisionItem[] = questions.map((question) => ({
    id: question.id,
    title: question.title,
    topic: "scope",
    description: question.reason,
    dependsOn: [],
    required: true,
    acceptance: [],
    sourceRefs: [],
  }));
  const answers: RecordedAnswer[] = questions.map((question) => ({
    questionId: question.id,
    question,
    state: "answered",
    value: "【测试替身】" + "已确认的范围与流程。".repeat(180),
    confirmation: "confirmed",
    confirmedAt: date,
    confirmedRevision: 3,
  }));
  const roundQuestions = [[questions[0]], questions.slice(1), []];
  const runs: ClarificationRun[] = [1, 2, 3].flatMap((round) =>
    (["A", "B", "C"] as const).map((role) => ({
      id: `synthetic-${round}-${role}`,
      operationId: `synthetic-operation-${round}-${role}`,
      role,
      round,
      basedOnRevision: round - 1,
      status: "completed",
      summary: `【测试替身】第 ${round} 轮 ${role} 记录`,
      output:
        role === "A"
          ? { summary: "【测试替身】拆解", items, retired: [], suggestions: [] }
          : role === "B"
            ? {
                summary: "【测试替身】补问",
                questions: roundQuestions[round - 1].map((question) => ({
                  ...question,
                  decisionId: question.id,
                })),
                conflicts: [],
              }
            : {
                summary: "【测试替身】查漏",
                ready: round === 3,
                coverage: [],
                gaps: [],
                conflicts: [],
              },
      usage: [],
      createdAt: date,
    })),
  );
  const clarification: ClarificationState = {
    protocol: "clarification-1",
    items,
    retiredIds: [],
    runs,
    rounds: roundQuestions.map((questions, index) => ({
      round: index + 1,
      revision: index,
      questions: questions.map((question) => ({ ...question, decisionId: question.id })),
      answers: index === 0 ? [] : index === 1 ? [answers[0]] : answers,
      changes: { added: [], retired: [], changed: [], triggerAnswerIds: [] },
      runIds: runs.filter((run) => run.round === index + 1).map((run) => run.id),
      createdAt: date,
    })),
    suggestions: ["【测试替身】建议仍待确认。"],
    conflicts: [],
    review: {
      summary: "【测试替身】三轮回答与摘要已确认，可以交接。",
      ready: true,
      coverage: [
        {
          topic: "scope",
          applicable: true,
          reason: "预设确认记录完整。",
          decisionIds: items.map((item) => item.id),
        },
      ],
      gaps: [],
      conflicts: [],
      fingerprint: "synthetic-long-report-fingerprint",
      basedOnRevision: 2,
    },
    next: "completed",
    draftOnly: false,
    specification,
    executionPrompt,
  };
  Object.assign(version, {
    workflow: "clarification",
    status: "completed",
    stage: "judge",
    clarification,
    challenge,
    intake: {
      id: "synthetic-long-intake",
      originalGoal: challenge.goal,
      answers,
      assumptions: [],
      usedSources: [],
      usage: [],
      confirmation: {
        summary: { revision: 3, confirmedAt: date, challenge: structuredClone(challenge) },
        pendingSummaryFields: [],
        history: [],
      },
    },
    requirements: {
      confirmed: answers.map((answer) => String(answer.value)),
      unresolved: [],
      suggestions: clarification.suggestions,
      missingMaterials: [],
      executionPrompt,
    },
  });
  return snapshot;
}

async function restoreLongReport(page: Page) {
  const snapshot = longSnapshot();
  const version = snapshot.versions[0];
  const replay = buildClarificationReplay(version);
  expect(replay.at(-1)?.replayAction?.kind).toBe("handoff");
  expect(projectReplay(version, replay, replay.length - 1).handoffComplete).toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health")
      return route.fulfill({ json: { status: "ok", accessGranted: true, model: snapshot.model } });
    if (path === "/api/identity")
      return route.fulfill({ json: { identityTag: "d".repeat(64), hasRecoveryCode: false } });
    if (path.endsWith("/events"))
      return route.fulfill({ contentType: "text/event-stream", body: "" });
    if (path === `/api/arenas/${snapshot.id}` && route.request().method() === "GET")
      return route.fulfill({ json: snapshot });
    return route.fulfill({ status: 500, json: { error: "Unexpected synthetic fixture request" } });
  });
  await page.goto(`/?arena=${snapshot.id}`);
  await expect(page.locator(".c-root")).toHaveClass(/at-result/);
  const result = page.getByRole("region", { name: "结论", exact: true });
  await result.getByRole("button", { name: "看完整结论", exact: true }).click();
  await expect(result.locator(".lead > p")).toHaveText(specification);
  await expect(result.locator(".first strong")).toHaveText(executionPrompt);
  for (const [selector, expected] of [
    [".lead > p", specification],
    [".first strong", executionPrompt],
  ]) {
    const selected = await result.locator(selector).evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const text = selection.toString();
      selection.removeAllRanges();
      return text;
    });
    expect(selected).toBe(expected);
  }
  return result;
}

for (const height of [900, 720]) {
  test(`explicit UI fixture: long multiround report preserves desktop stage and lower panels at 1440x${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height });
    const result = await restoreLongReport(page);
    await expect(page.locator(".c-board")).toHaveCount(3);
    await expect
      .poll(() =>
        page.locator(".c-stage3").evaluate((element) => element.getBoundingClientRect().height),
      )
      .toBeGreaterThan(180);
    for (const board of await page.locator(".c-board").all())
      expect((await board.boundingBox())!.height).toBeGreaterThan(100);
    const region = page.locator(".c-result-region");
    await expect
      .poll(() => region.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true);
    await region.focus();
    await expect(region).toBeFocused();
    const bottom = (await page.locator(".c-bottom").boundingBox())!;
    expect(bottom.height).toBeGreaterThan(100);
    expect(bottom.y + bottom.height).toBeLessThanOrEqual(height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      result
        .getByRole("button", { name: "导出完整规划与执行提示词（Markdown）", exact: true })
        .click(),
    ]);
    expect(await readFile((await download.path())!, "utf8")).toBe(
      `${specification}\n\n---\n\n# 执行提示词\n\n${executionPrompt}`,
    );
  });
}

test("explicit UI fixture: mobile long report follows document scrolling and wraps unbroken content", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await restoreLongReport(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(844);
  expect((await page.locator(".c-stage3").boundingBox())!.height).toBeGreaterThan(0);
  for (const selector of [".c-result-region", ".c-result.whole", ".c-conditions"]) {
    const dimensions = await page.locator(selector).evaluate((element) => ({
      client: element.clientHeight,
      scroll: element.scrollHeight,
      horizontal: element.scrollWidth > element.clientWidth,
    }));
    expect(dimensions.scroll - dimensions.client, selector).toBeLessThanOrEqual(1);
    expect(dimensions.horizontal, selector).toBe(false);
  }
  await expect(page.locator(".c-time [data-round]")).toHaveCount(3);
  await page.getByRole("button", { name: "从头放映", exact: true }).click();
  const closedResult = page.locator(".c-result-region");
  await expect(closedResult).toHaveAttribute("aria-hidden", "true");
  await expect(closedResult).toHaveAttribute("inert", "");
  await expect(closedResult).toHaveAttribute("tabindex", "-1");
  await expect
    .poll(() => closedResult.evaluate((element) => element.getBoundingClientRect().height))
    .toBe(0);
});
