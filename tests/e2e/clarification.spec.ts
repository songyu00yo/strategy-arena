// Explicit synthetic browser fixtures. Every API request is intercepted, with no model calls.
import { expect, test } from "@playwright/test";
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
import { fixtureSnapshot } from "./ui.fixture";

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
    await expect(page.locator(".gi-questions")).toBeVisible();
    await expect(page.getByRole("radio", { name: "真实报名", exact: true })).not.toBeChecked();
    await page.getByRole("radio", { name: "界面演示", exact: true }).check();
    await page.getByRole("radio", { name: "简洁正式", exact: true }).check();
    await page.getByRole("button", { name: "确认本轮回答并继续", exact: true }).click();
    const handoff = page.getByRole("button", { name: "确认要求并查漏交接", exact: true });
    await expect(handoff).toBeVisible();
    await handoff.click();
    await expect(
      page.getByRole("textbox", { name: acceptanceQuestion.title, exact: true }),
    ).toBeVisible();
    await expect(page.locator(".c-root")).toHaveCount(0);
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
