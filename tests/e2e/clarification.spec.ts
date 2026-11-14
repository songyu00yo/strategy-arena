// Explicit synthetic browser fixtures. Every API request is intercepted, with no model calls.
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type {
  ClarificationRun,
  ClarificationState,
  DecisionItem,
} from "../../src/lib/clarification-contracts";
import type {
  IntakeAnswer,
  IntakeDraft,
  IntakeQuestion,
  RecordedAnswer,
} from "../../src/lib/intake-contracts";
import { configureFixtureModels, fixtureIntake } from "./intake.fixture";
import { fixtureSnapshot, fixtureChallenge } from "./ui.fixture";
import { ANSWER_JOURNAL_KEY } from "../../src/components/intake-answer-journal";

const date = "2026-11-12T00:00:00.000Z";
const goal = "【演示数据】明确校园活动报名成果的范围、内容、流程和风格。";
const scopeQuestion: IntakeQuestion = {
  id: "scope",
  decisionId: "scope",
  title: "这次需要真实报名，还是界面演示？",
  reason: "演示数据，用途由本人决定。",
  type: "single",
  options: ["真实报名", "界面演示"],
  placeholder: "",
  unit: "",
};
const styleQuestion: IntakeQuestion = {
  id: "style",
  decisionId: "style",
  title: "本次希望采用什么风格？",
  reason: "演示数据，风格由本人确认。",
  type: "single",
  options: ["简洁正式", "活泼插画"],
  placeholder: "",
  unit: "",
};
const acceptanceQuestion: IntakeQuestion = {
  id: "acceptance",
  decisionId: "acceptance",
  title: "怎样判断演示成果已经完成？",
  reason: "演示数据，C 的查漏发现验收方式尚待本人决定。",
  type: "text",
  options: [],
  placeholder: "请填写验收条件",
  unit: "",
};
const items: DecisionItem[] = [scopeQuestion, styleQuestion, acceptanceQuestion].map(
  (question) => ({
    id: question.decisionId!,
    topic: question.id === "scope" ? "scope" : question.id === "style" ? "style" : "acceptance",
    title: question.title,
    description: question.reason,
    dependsOn: question.id === "scope" ? [] : ["scope"],
    required: true,
    acceptance: [],
    sourceRefs: [],
  }),
);

for (const width of [1440, 390]) {
  test(`explicit UI fixture: new clarification continues after review and restores original cards at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const snapshot = configureFixtureModels(fixtureSnapshot());
    const runs: ClarificationRun[] = [];
    let analyses = 0;
    let submissions = 0;
    let advances = 0;
    let created = 0;
    let draft: IntakeDraft = fixtureIntake({ workflow: "clarification", goal });
    const state = (next: ClarificationState["next"]): ClarificationState => ({
      protocol: "clarification-1",
      items: structuredClone(items),
      retiredIds: [],
      runs: structuredClone(runs),
      rounds: Array.from({ length: analyses }, (_, index) => ({
        round: index + 1,
        revision: index,
        questions: [],
        answers: [],
        changes: { added: [], retired: [], changed: [], triggerAnswerIds: [] },
        runIds: runs.filter((run) => run.round === index + 1).map((run) => run.id),
        createdAt: date,
      })),
      suggestions: ["演示数据：AI 建议增加邮箱通知，尚未确认。"],
      conflicts: [],
      review: null,
      next,
      draftOnly: next !== "completed",
      specification:
        "【演示数据】已确认需求\n范围为界面演示，采用简洁正式风格。\n正式发布的品牌标识需另行提供。",
      executionPrompt: [
        "【演示数据】依据本人确认制作报名界面演示。",
        "- 采用简洁正式风格。",
        "- 提交后显示演示成功，不收集真实个人资料。",
        "遇到未确认的要求，请先询问本人。",
      ].join("\n"),
    });
    const addRun = (role: ClarificationRun["role"], ready = false) => {
      const summary = `【演示数据】${role} 本次独立审查记录`;
      const output: ClarificationRun["output"] =
        role === "A"
          ? { summary, items: structuredClone(items), retired: [], suggestions: [] }
          : role === "B"
            ? { summary, questions: [], conflicts: [] }
            : { summary, ready, coverage: [], gaps: ready ? [] : [items[2]], conflicts: [] };
      runs.push({
        id: `fixture-${role}-${runs.length}`,
        operationId: `fixture-operation-${runs.length}`,
        role,
        round: analyses,
        basedOnRevision: draft.revision,
        status: "completed",
        summary,
        output,
        usage: [
          {
            inputTokens: 10,
            outputTokens: 20,
            cachedInputTokens: 0,
            estimatedCny: 0,
            estimatedUsd: 0,
            provider: "openai",
            currency: "USD",
            model: "synthetic-fixture-no-model-call",
            responseId: `fixture-response-${runs.length}`,
            durationMs: 1,
          },
        ],
        callIds: [`fixture-call-${runs.length}`],
        createdAt: date,
      });
    };
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (path === "/api/health")
        return route.fulfill({
          json: { status: "ok", model: snapshot.model, accessGranted: true },
        });
      if (path === "/api/identity")
        return route.fulfill({ json: { identityTag: "b".repeat(64), hasRecoveryCode: false } });
      if (path.endsWith("/events"))
        return route.fulfill({ contentType: "text/event-stream", body: "" });
      if (path.endsWith("/advance")) {
        advances++;
        return route.fulfill({
          status: 500,
          json: { error: "The clarification fixture must not start legacy strategy execution." },
        });
      }
      if (path === "/api/intakes" && method === "POST") {
        created++;
        expect(route.request().postDataJSON()).toMatchObject({ goal, workflow: "clarification" });
        draft = { ...draft, clarification: state("questions") };
        return route.fulfill({ status: 201, json: draft });
      }
      if (path === `/api/intakes/${draft.id}` && method === "PATCH") {
        const body = route.request().postDataJSON();
        expect(body.revision).toBe(draft.revision);
        if (body.answers) {
          expect(body.answerMode).toBe("complete");
          const accepted: RecordedAnswer[] = body.answers.map((answer: IntakeAnswer) => ({
            ...answer,
            question: draft.questions.find((question) => question.id === answer.questionId)!,
            confirmation: answer.state === "answered" ? "confirmed" : "pending",
            confirmedRevision: draft.revision + 1,
            confirmedAt: date,
          }));
          draft = {
            ...draft,
            revision: draft.revision + 1,
            answers: [
              ...draft.answers.filter(
                (answer) => !accepted.some((item) => item.questionId === answer.questionId),
              ),
              ...accepted,
            ],
          };
        } else if (body.summary) {
          draft = {
            ...draft,
            revision: draft.revision + 1,
            challenge: body.summary.challenge,
            assumptions: body.summary.assumptions,
          };
        }
        return route.fulfill({ json: draft });
      }
      if (path === `/api/intakes/${draft.id}/analyze`) {
        analyses++;
        addRun("A");
        addRun("B");
        draft =
          analyses === 1
            ? {
                ...draft,
                revision: draft.revision + 1,
                status: "questions",
                round: analyses,
                questions: [scopeQuestion, styleQuestion],
                clarification: state("questions"),
              }
            : {
                ...draft,
                revision: draft.revision + 1,
                status: "summary",
                round: analyses,
                questions: [],
                challenge: {
                  ...structuredClone(snapshot.versions[0].challenge),
                  goal,
                  preferences: "简洁正式",
                },
                clarification: state("summary"),
              };
        return route.fulfill({ json: draft });
      }
      if (path === `/api/intakes/${draft.id}/submit`) {
        submissions++;
        addRun("C", submissions > 1);
        if (submissions === 1) {
          draft = {
            ...draft,
            revision: draft.revision + 1,
            status: "questions",
            questions: [acceptanceQuestion],
            clarification: state("questions"),
          };
          return route.fulfill({ json: draft });
        }
        const finalState = state("completed");
        finalState.review = {
          summary: "【演示数据】查漏已完成",
          ready: true,
          coverage: [],
          gaps: [],
          conflicts: [],
          fingerprint: "fixture",
          basedOnRevision: draft.revision,
        };
        Object.assign(snapshot.versions[0], {
          workflow: "clarification",
          clarification: finalState,
          status: "completed",
          stage: "judge",
          challenge: draft.challenge,
          intake: {
            id: draft.id,
            originalGoal: goal,
            answers: draft.answers,
            assumptions: [],
            usedSources: [],
            usage: runs.flatMap((run) => run.usage),
            confirmation: {
              summary: {
                revision: draft.revision,
                confirmedAt: date,
                challenge: structuredClone(draft.challenge!),
              },
              history: [],
            },
          },
          requirements: {
            confirmed: [
              "范围 — 界面演示",
              "风格 — 简洁正式",
              "验收 — 显示演示成功且不收集真实资料",
            ],
            unresolved: ["真实上线时间未确定，本轮只做界面演示。"],
            suggestions: finalState.suggestions,
            missingMaterials: ["正式发布的品牌标识需另行提供。"],
            executionPrompt: finalState.executionPrompt,
          },
        });
        expect(snapshot.versions[0].strategies).toEqual([]);
        expect(snapshot.versions[0].attacks).toEqual([]);
        expect(snapshot.versions[0].revisions).toEqual([]);
        expect(snapshot.versions[0].verdict).toBeNull();
        draft = {
          ...draft,
          status: "submitted",
          arenaId: snapshot.id,
          revision: draft.revision + 1,
        };
        return route.fulfill({ status: 201, json: snapshot });
      }
      if (path === `/api/intakes/${draft.id}`) return route.fulfill({ json: draft });
      if (path === `/api/arenas/${snapshot.id}`) return route.fulfill({ json: snapshot });
      return route.fulfill({ status: 404, json: { error: "Explicit fixture boundary" } });
    });

    await page.goto("/");
    await page.getByLabel("你想做什么", { exact: true }).fill(goal);
    await page.getByRole("button", { name: "开始梳理", exact: true }).click();
    const intakeDialog = page.getByRole("dialog", { name: "需求梳理", exact: true });
    await expect(intakeDialog).toBeVisible();
    await expect(intakeDialog.locator(".gi-question")).toHaveCount(1);
    await intakeDialog.evaluate((element) => element.setAttribute("data-fixture-paper", "same"));
    await expect(page.getByRole("radio", { name: "真实报名", exact: true })).not.toBeChecked();
    await page.getByRole("radio", { name: "界面演示", exact: true }).check();
    await intakeDialog.getByRole("button", { name: "下一题", exact: true }).click();
    await page.getByRole("radio", { name: "简洁正式", exact: true }).check();
    await intakeDialog.getByRole("button", { name: "上一题", exact: true }).click();
    await expect(page.getByRole("radio", { name: "界面演示", exact: true })).toBeChecked();
    expect(analyses).toBe(1);
    await intakeDialog.getByRole("button", { name: "暂存并退出", exact: true }).click();
    await expect(intakeDialog).toBeHidden();
    await page.getByRole("button", { name: "继续回答", exact: true }).click();
    await expect(page.getByRole("radio", { name: "界面演示", exact: true })).toBeChecked();
    expect(analyses).toBe(1);
    await intakeDialog.evaluate((element) => element.setAttribute("data-fixture-paper", "same"));
    await intakeDialog.getByRole("button", { name: "下一题", exact: true }).click();
    await expect(page.getByRole("radio", { name: "简洁正式", exact: true })).toBeChecked();
    await page.getByRole("button", { name: "确认本轮回答并继续", exact: true }).click();
    const handoff = page.getByRole("button", { name: "确认要求并查漏交接", exact: true });
    await expect(handoff).toBeVisible();
    await expect(intakeDialog).toHaveAttribute("data-fixture-paper", "same");
    const preview = intakeDialog.getByRole("region", { name: "规划报告预览", exact: true });
    await expect(preview.getByText("详细规划报告 · 预览版", { exact: true })).toBeVisible();
    await preview.getByRole("button", { name: "查看完整预览", exact: true }).click();
    await expect(preview.locator("pre").nth(0)).toHaveText(draft.clarification!.specification);
    await expect(preview.locator("pre").nth(1)).toHaveText(draft.clarification!.executionPrompt);
    const [previewDownload] = await Promise.all([
      page.waitForEvent("download"),
      preview.getByRole("button", { name: "导出 Markdown 预览", exact: true }).click(),
    ]);
    expect(previewDownload.suggestedFilename()).toContain("预览");
    expect(await readFile((await previewDownload.path())!, "utf8")).toBe(
      `${draft.clarification!.specification}\n\n---\n\n# 执行提示词（预览）\n\n${draft.clarification!.executionPrompt}`,
    );
    expect(submissions).toBe(0);
    expect(analyses).toBe(2);
    await handoff.click();
    await expect(
      page.getByRole("textbox", { name: acceptanceQuestion.title, exact: true }),
    ).toBeVisible();
    await expect(page.locator(".c-root")).toHaveCount(0);
    await expect(intakeDialog).toHaveAttribute("data-fixture-paper", "same");
    await page.reload();
    await expect(
      page.getByRole("textbox", { name: acceptanceQuestion.title, exact: true }),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: acceptanceQuestion.title, exact: true })
      .fill("提交后显示演示成功，并且不收集真实个人资料。");
    await page.getByRole("button", { name: "确认本轮回答并继续", exact: true }).click();
    await handoff.click();
    const result = page.getByRole("region", { name: "结论", exact: true });
    await expect(
      result.getByRole("heading", { name: "需求说明与执行提示词", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".c-board")).toHaveCount(3);
    for (const [role, label] of [
      ["A", "需求拆解"],
      ["B", "选项与执行审查"],
      ["C", "验收与遗漏审查"],
    ])
      await expect(page.locator(`[data-board="${role}"] h3`)).toHaveText(label);
    await expect(page.locator(".c-claim")).toHaveCount(0);
    await expect(page.locator(".c-result .tag b")).toHaveText("已确认");
    await expect(page.getByRole("region", { name: "角色审查记录", exact: true })).toBeVisible();
    await page.screenshot({
      path: `test-results/clarification-${width}-cards.png`,
      fullPage: true,
    });
    await result.getByRole("button", { name: "看完整结论", exact: true }).click();
    await expect(result.locator(".lead > p")).toContainText("已确认需求");
    const exportButton = result.getByRole("button", {
      name: "导出完整规划与执行提示词（Markdown）",
      exact: true,
    });
    const collapseButton = result.getByRole("button", { name: "收起结论", exact: true });
    await expect(exportButton).toBeVisible();
    await expect(collapseButton).toBeVisible();
    await expect
      .poll(async () => {
        const exported = await exportButton.boundingBox();
        const collapsed = await collapseButton.boundingBox();
        if (!exported || !collapsed) return false;
        return (
          exported.x + exported.width <= collapsed.x ||
          collapsed.x + collapsed.width <= exported.x ||
          exported.y + exported.height <= collapsed.y ||
          collapsed.y + collapsed.height <= exported.y
        );
      })
      .toBe(true);
    for (const hovered of [false, true]) {
      if (hovered) await exportButton.hover();
      else await page.mouse.move(0, 0);
      const contrast = await exportButton.evaluate((element) => {
        const channels = (color: string) => color.match(/[\d.]+/g)!.map(Number);
        const foreground = channels(getComputedStyle(element).color);
        const background = channels(
          getComputedStyle(element.closest(".c-result")!).backgroundColor,
        );
        const alpha = foreground[3] ?? 1;
        const displayed = foreground
          .slice(0, 3)
          .map((channel, index) => channel * alpha + background[index] * (1 - alpha));
        const luminance = (rgb: number[]) => {
          const linear = rgb.slice(0, 3).map((channel) => {
            const srgb = channel / 255;
            return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
          });
          return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
        };
        const text = luminance(displayed);
        const plate = luminance(background);
        return (Math.max(text, plate) + 0.05) / (Math.min(text, plate) + 0.05);
      });
      expect(
        contrast,
        `Export text contrast at ${width}px, hover=${hovered}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    const [reportDownload] = await Promise.all([
      page.waitForEvent("download"),
      result
        .getByRole("button", { name: "导出完整规划与执行提示词（Markdown）", exact: true })
        .click(),
    ]);
    expect(reportDownload.suggestedFilename()).toContain("正式需求");
    expect(await readFile((await reportDownload.path())!, "utf8")).toBe(
      `${snapshot.versions[0].clarification!.specification}\n\n---\n\n# 执行提示词\n\n${snapshot.versions[0].clarification!.executionPrompt}`,
    );
    await expect(result.locator(".first strong")).toHaveText(
      snapshot.versions[0].clarification!.executionPrompt,
    );
    await expect(result.locator(".first strong")).not.toContainText("邮箱通知");
    await expect(result.locator("dd").nth(0)).toContainText("AI 建议增加邮箱通知");
    await expect(result.locator("dd").nth(1)).toContainText("真实上线时间未确定");
    await expect(result.locator("dd").nth(2)).toContainText("品牌标识需另行提供");
    for (const [selector, expected] of [
      [".lead > p", snapshot.versions[0].clarification!.specification],
      [".first strong", snapshot.versions[0].clarification!.executionPrompt],
    ]) {
      const selectedText = await result.locator(selector).evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        const text = selection.toString();
        selection.removeAllRanges();
        return text;
      });
      expect(selectedText).toBe(expected);
    }
    await page.screenshot({
      path: `test-results/clarification-${width}-report.png`,
      fullPage: true,
    });
    await result.getByRole("button", { name: "收起结论", exact: true }).click();
    await page.getByRole("button", { name: "查看 A 需求拆解 的详情", exact: true }).click();
    const step = page.getByRole("dialog", { name: /^第 \d+ 步 · 需求拆解$/ });
    await expect(step).toBeVisible();
    await expect(step.getByText("实际调用记录", { exact: true })).toBeVisible();
    await step.getByRole("button", { name: "补充或质疑", exact: true }).click();
    const feedback = page.getByRole("dialog", { name: "补充这一步", exact: true });
    await expect(feedback).toBeVisible();
    await feedback
      .getByRole("textbox")
      .fill("【演示数据】执行者询问是否需要英文版本，请等本人决定。");
    await feedback.getByRole("button", { name: "取消", exact: true }).click();
    await page.reload();
    await expect(
      result.getByRole("heading", { name: "需求说明与执行提示词", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".c-board")).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    expect(created).toBe(1);
    expect(submissions).toBe(2);
    expect(advances).toBe(0);
  });
}

test("explicit UI fixture: historical answer editing restores locally, cancels, preserves conflicts and retries analysis without repeating PATCH", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const snapshot = configureFixtureModels(fixtureSnapshot());
  const question = { ...scopeQuestion, type: "text" as const, options: [] };
  const dependent = {
    ...styleQuestion,
    type: "text" as const,
    options: [],
    dependsOn: [question.id],
  };
  const records: RecordedAnswer[] = [question, dependent, acceptanceQuestion].map(
    (item, index) => ({
      questionId: item.id,
      question: item,
      state: "answered",
      value: ["原范围", "原风格", "原验收条件"][index],
      confirmation: "confirmed",
      confirmedRevision: 2,
      confirmedAt: date,
    }),
  );
  let draft = fixtureIntake({
    workflow: "clarification",
    revision: 3,
    status: "summary",
    round: 3,
    challenge: structuredClone(fixtureChallenge),
    answers: records,
    confirmation: { history: [] },
    clarification: {
      protocol: "clarification-1",
      items,
      retiredIds: [],
      runs: [],
      rounds: [],
      suggestions: [],
      conflicts: [],
      review: null,
      next: "summary",
      draftOnly: true,
      specification: "【演示数据】旧规划报告",
      executionPrompt: "【演示数据】旧执行提示词",
    },
  });
  let patches = 0;
  let analyses = 0;
  await page.addInitScript((id) => localStorage.setItem("strategy-arena:intake-id", id), draft.id);
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health")
      return route.fulfill({ json: { status: "ok", model: snapshot.model, accessGranted: true } });
    if (path === "/api/identity")
      return route.fulfill({ json: { identityTag: "a".repeat(64), hasRecoveryCode: false } });
    if (path === `/api/intakes/${draft.id}` && route.request().method() === "PATCH") {
      const body = route.request().postDataJSON();
      expect(body.revision).toBe(draft.revision);
      expect(body.answerMode).toBe("draft");
      expect(body.answers).toEqual([
        { questionId: question.id, state: "answered", value: "仅用于课堂演示的新范围" },
      ]);
      patches++;
      if (patches === 1)
        return route.fulfill({ status: 503, json: { error: "演示：历史修改暂未同步" } });
      draft = {
        ...draft,
        revision: draft.revision + 1,
        status: "input",
        questions: [],
        challenge: null,
        answers: draft.answers.map((answer) =>
          answer.questionId === question.id
            ? {
                ...answer,
                value: body.answers[0].value,
                confirmation: "pending",
                needsReconfirmation: true,
              }
            : answer.questionId === dependent.id
              ? { ...answer, confirmation: "pending", needsReconfirmation: true }
              : answer,
        ),
        confirmation: {
          history: [{ revision: draft.revision, answers: structuredClone(draft.answers) }],
        },
        clarification: {
          ...draft.clarification!,
          next: "questions",
          review: null,
          specification: "",
          executionPrompt: "",
        },
      };
      return route.fulfill({ json: draft });
    }
    if (path === `/api/intakes/${draft.id}/analyze`) {
      expect(route.request().postDataJSON().revision).toBe(draft.revision);
      analyses++;
      if (analyses === 1)
        return route.fulfill({ status: 503, json: { error: "演示：重新分析暂时失败" } });
      draft = {
        ...draft,
        revision: draft.revision + 1,
        status: "questions",
        round: 4,
        questions: [dependent],
      };
      return route.fulfill({ json: draft });
    }
    if (path === `/api/intakes/${draft.id}`) return route.fulfill({ json: draft });
    return route.fulfill({
      status: 404,
      json: { error: "Explicit historical answer fixture boundary" },
    });
  });
  await page.goto("/");
  const paper = page.getByRole("dialog", { name: "需求梳理", exact: true });
  const openEdit = () =>
    paper.getByRole("button", { name: `修改回答：${question.title}`, exact: true }).click();
  const field = paper.getByRole("textbox", { name: question.title, exact: true });
  await openEdit();
  await field.fill("仅用于课堂演示的新范围");
  await paper.getByRole("button", { name: "暂存并退出", exact: true }).click();
  await page.reload();
  await expect(field).toHaveValue("仅用于课堂演示的新范围");
  expect(patches).toBe(0);
  expect(analyses).toBe(0);
  await paper.getByRole("button", { name: "取消修改", exact: true }).click();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), ANSWER_JOURNAL_KEY)).toBeNull();
  expect(draft.answers[0].value).toBe("原范围");
  await openEdit();
  await field.fill("仅用于课堂演示的新范围");
  await paper.getByRole("button", { name: "保存修改并重新梳理", exact: true }).click();
  await expect(paper.getByRole("alert")).toContainText("历史修改暂未同步");
  expect(analyses).toBe(0);
  const oldRevision = draft.revision;
  draft = {
    ...draft,
    revision: draft.revision + 1,
    answers: draft.answers.map((answer) =>
      answer.questionId === question.id ? { ...answer, value: "另一标签页的新范围" } : answer,
    ),
  };
  await page.reload();
  await expect(paper.getByRole("alert")).toContainText("之前的修改没有自动覆盖");
  await expect(paper).toContainText("另一标签页的新范围");
  await expect(paper).toContainText("仅用于课堂演示的新范围");
  expect(
    JSON.parse((await page.evaluate((key) => sessionStorage.getItem(key), ANSWER_JOURNAL_KEY))!)
      .historicalRevision,
  ).toBe(oldRevision);
  expect(patches).toBe(1);
  await paper.getByRole("button", { name: "恢复本机修改并重新核对", exact: true }).click();
  await paper.evaluate((element) => element.setAttribute("data-fixture-paper", "history-edit"));
  await paper.getByRole("button", { name: "保存修改并重新梳理", exact: true }).click();
  await expect(paper.getByRole("alert")).toContainText("重新分析暂时失败");
  expect(patches).toBe(2);
  expect(draft.confirmation?.history).toHaveLength(1);
  expect(
    draft.answers
      .slice(0, 2)
      .every((answer) => answer.confirmation === "pending" && answer.needsReconfirmation),
  ).toBe(true);
  await expect(paper.getByRole("button", { name: "导出 Markdown 预览", exact: true })).toHaveCount(
    0,
  );
  await expect(paper).not.toContainText("旧规划报告");
  await paper.getByRole("button", { name: "重新分析", exact: true }).click();
  await expect(paper.getByRole("textbox", { name: dependent.title, exact: true })).toBeVisible();
  await expect(paper).toHaveAttribute("data-fixture-paper", "history-edit");
  expect(analyses).toBe(2);
  expect(patches).toBe(2);
});

test("explicit UI fixture: local summary edits disable old report preview and export before autosave finishes", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const snapshot = configureFixtureModels(fixtureSnapshot());
  const draft = fixtureIntake({
    workflow: "clarification",
    revision: 3,
    status: "summary",
    challenge: structuredClone(fixtureChallenge),
    clarification: {
      protocol: "clarification-1",
      items,
      retiredIds: [],
      runs: [],
      rounds: [],
      suggestions: [],
      conflicts: [],
      review: null,
      next: "summary",
      draftOnly: true,
      specification: "【演示数据】编辑前报告",
      executionPrompt: "【演示数据】编辑前提示词",
    },
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.addInitScript((id) => localStorage.setItem("strategy-arena:intake-id", id), draft.id);
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health")
      return route.fulfill({ json: { status: "ok", model: snapshot.model, accessGranted: true } });
    if (path === "/api/identity")
      return route.fulfill({ json: { identityTag: "b".repeat(64), hasRecoveryCode: false } });
    if (path === `/api/intakes/${draft.id}` && route.request().method() === "PATCH") {
      await gate;
      return route
        .fulfill({
          json: {
            ...draft,
            revision: 4,
            challenge: route.request().postDataJSON().summary.challenge,
            clarification: { ...draft.clarification, specification: "", executionPrompt: "" },
          },
        })
        .catch(() => {});
    }
    if (path === `/api/intakes/${draft.id}`) return route.fulfill({ json: draft });
    return route.fulfill({
      status: 404,
      json: { error: "Explicit local summary fixture boundary" },
    });
  });
  try {
    await page.goto("/");
    const paper = page.getByRole("dialog", { name: "需求梳理", exact: true });
    const preview = paper.getByRole("region", { name: "规划报告预览", exact: true });
    await preview.getByRole("button", { name: "查看完整预览", exact: true }).click();
    await expect(
      preview.getByRole("button", { name: "导出 Markdown 预览", exact: true }),
    ).toBeEnabled();
    await paper
      .getByRole("textbox", { name: "必须满足的限制", exact: true })
      .fill("【演示数据】刚输入的新限制，服务器尚未保存。");
    await expect(preview.getByRole("button", { name: "查看完整预览", exact: true })).toBeDisabled();
    await expect(
      preview.getByRole("button", { name: "导出 Markdown 预览", exact: true }),
    ).toHaveCount(0);
    await expect(preview).not.toContainText("编辑前报告");
    await expect(
      paper.getByRole("button", { name: "确认要求并查漏交接", exact: true }),
    ).toBeDisabled();
    expect(draft.revision).toBe(3);
  } finally {
    release();
  }
});

test("explicit UI fixture: historical memory-only edits survive revision conflicts when session storage throws", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const snapshot = configureFixtureModels(fixtureSnapshot());
  const question = { ...scopeQuestion, type: "text" as const, options: [] };
  let draft = fixtureIntake({
    workflow: "clarification",
    revision: 3,
    status: "summary",
    round: 3,
    challenge: structuredClone(fixtureChallenge),
    answers: [
      {
        questionId: question.id,
        question,
        state: "answered",
        value: "服务器原范围",
        confirmation: "confirmed",
      },
    ],
    clarification: {
      protocol: "clarification-1",
      items,
      retiredIds: [],
      runs: [],
      rounds: [],
      suggestions: [],
      conflicts: [],
      review: null,
      next: "summary",
      draftOnly: true,
      specification: "【演示数据】原报告",
      executionPrompt: "【演示数据】原提示词",
    },
  });
  let patches = 0;
  let analyses = 0;
  await page.addInitScript(
    ({ id, answerKey }) => {
      localStorage.setItem("strategy-arena:intake-id", id);
      const getItem = Storage.prototype.getItem;
      const setItem = Storage.prototype.setItem;
      Storage.prototype.getItem = function (key) {
        if (key === answerKey)
          throw new DOMException("Explicit fixture: storage read denied", "SecurityError");
        return getItem.call(this, key);
      };
      Storage.prototype.setItem = function (key, value) {
        if (key === answerKey)
          throw new DOMException("Explicit fixture: storage write denied", "SecurityError");
        return setItem.call(this, key, value);
      };
    },
    { id: draft.id, answerKey: ANSWER_JOURNAL_KEY },
  );
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health")
      return route.fulfill({ json: { status: "ok", model: snapshot.model, accessGranted: true } });
    if (path === "/api/identity")
      return route.fulfill({ json: { identityTag: "c".repeat(64), hasRecoveryCode: false } });
    if (path === `/api/intakes/${draft.id}` && route.request().method() === "PATCH") {
      const body = route.request().postDataJSON();
      patches++;
      if (patches === 1) {
        expect(body.revision).toBe(3);
        return route.fulfill({
          status: 409,
          json: { error: "演示：另一标签页已更新草稿", code: "STALE_INTAKE" },
        });
      }
      expect(body.revision).toBe(draft.revision);
      expect(body.answerMode).toBe("draft");
      expect(body.answers).toEqual([
        { questionId: question.id, state: "answered", value: "仅存在内存的新范围" },
      ]);
      draft = {
        ...draft,
        revision: draft.revision + 1,
        status: "input",
        challenge: null,
        answers: [
          {
            ...draft.answers[0],
            value: body.answers[0].value,
            confirmation: "pending",
            needsReconfirmation: true,
          },
        ],
        clarification: { ...draft.clarification!, specification: "", executionPrompt: "" },
      };
      return route.fulfill({ json: draft });
    }
    if (path === `/api/intakes/${draft.id}/analyze`) {
      analyses++;
      draft = {
        ...draft,
        revision: draft.revision + 1,
        status: "questions",
        round: 4,
        questions: [styleQuestion],
      };
      return route.fulfill({ json: draft });
    }
    if (path === `/api/intakes/${draft.id}`) return route.fulfill({ json: draft });
    return route.fulfill({ status: 404, json: { error: "Explicit memory-only fixture boundary" } });
  });
  await page.goto("/");
  const paper = page.getByRole("dialog", { name: "需求梳理", exact: true });
  await paper.getByRole("button", { name: `修改回答：${question.title}`, exact: true }).click();
  const field = paper.getByRole("textbox", { name: question.title, exact: true });
  await field.fill("仅存在内存的新范围");
  await expect(
    paper.getByRole("status").filter({ hasText: "历史回答修改暂存在内存" }),
  ).toBeVisible();
  draft = {
    ...draft,
    revision: 4,
    answers: [{ ...draft.answers[0], value: "另一标签页的服务器新范围" }],
  };
  await paper.getByRole("button", { name: "保存修改并重新梳理", exact: true }).click();
  const conflict = paper.getByRole("alert").filter({ hasText: "之前的修改没有自动覆盖" });
  await expect(conflict).toContainText("仅存在内存的新范围");
  await expect(conflict).toContainText("另一标签页的服务器新范围");
  expect(patches).toBe(1);
  expect(analyses).toBe(0);
  await paper.getByRole("button", { name: "暂存并退出", exact: true }).click();
  await page.getByRole("button", { name: "查看并确认摘要", exact: true }).click();
  await expect(conflict).toContainText("仅存在内存的新范围");
  expect(patches).toBe(1);
  await conflict.getByRole("button", { name: "恢复本机修改并重新核对", exact: true }).click();
  await expect(field).toHaveValue("仅存在内存的新范围");
  await paper.getByRole("button", { name: "保存修改并重新梳理", exact: true }).click();
  await expect(paper.getByRole("radio", { name: "简洁正式", exact: true })).toBeVisible();
  expect(patches).toBe(2);
  expect(analyses).toBe(1);
  expect(draft.answers[0].value).toBe("仅存在内存的新范围");
});
