// Explicit synthetic UI journey. Every API response is intercepted; no model or billing calls.
import { expect, test, type Page } from "@playwright/test";
import type { Challenge, ModelMode } from "../../src/lib/contracts";
import type { IntakeAnswer, IntakeQuestion, MaterialSource } from "../../src/lib/intake-contracts";
import { stepContext } from "../../src/lib/step-context";
import { configureFixtureModels, fixtureIntake, intakeStorageKey } from "./intake.fixture";
import { advanceFixture, fixtureChallenge, fixtureSnapshot, fixtureVersion } from "./ui.fixture";

type VersionBody = {
  challenge: Challenge;
  changeReason: string;
  modelMode: ModelMode;
  baseVersionId: string;
  followUp?: { stepId: string; quote: string; text: string };
};
const question: IntakeQuestion = {
  id: "limits",
  title: "哪些条件必须一直保留？",
  reason: "UI fixture：确定本次旅程的硬性限制。",
  placeholder: "",
  type: "single",
  options: ["独立完成，不买设备", "可以购买设备"],
  unit: "",
};
const source: MaterialSource = {
  id: "journey-source",
  attachmentId: "journey-attachment",
  filename: "explicit-journey.txt",
  location: "第 1 行",
  text: "UI fixture 原文：独立完成，不购买新设备；七天共投入七小时，预算三百元。",
  interpretation: false,
  origin: "document",
};

async function readSavedMaterial(page: Page, intakeId: string) {
  const context = page.locator(".intake-context");
  const disclosure = context.getByRole("button", { name: /^(查看|收起)补充回答与材料$/ });
  if ((await disclosure.getAttribute("aria-expanded")) === "false") await disclosure.click();
  await expect(context).toContainText(question.title);
  await expect(context).toContainText("独立完成，不买设备");
  const citation = context.getByRole("button", {
    name: `${source.filename} · ${source.location}`,
    exact: true,
  });
  if ((await citation.getAttribute("aria-expanded")) === "false") await citation.click();
  await expect(context.locator("blockquote")).toHaveText(source.text);
  await expect(context.getByRole("link", { name: "下载原附件", exact: true })).toHaveAttribute(
    "href",
    `/api/intakes/${intakeId}/attachments/${source.attachmentId}`,
  );
}

test("explicit UI fixture: confirmed goal and cited summary survive all five follow-up types, condition adjustment and history comparison", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const goal = "UI fixture 旅程：七天内独立完成第一支知识视频，比较三条可执行路线。";
  const constraints = "UI fixture 用户确认：仅一人执行，不购买新设备，保留现有收入。";
  const snapshot = configureFixtureModels(fixtureSnapshot());
  snapshot.id = "explicit-product-journey";
  const selection = {
    requestedMode: "gpt-6.1-terra" as const,
    provider: "openai" as const,
    modelId: "gpt-6.1-terra",
    currency: "USD" as const,
    policyVersion: "explicit-journey-ui-fixture",
    reason: "UI fixture：保留用户明确选择的 GPT 6.1 Terra。",
  };
  snapshot.versions[0].modelSelection = selection;
  let draft = fixtureIntake({ id: "explicit-journey-intake", goal: "" });
  const submitted: { challenge: Challenge; assumptions: string[] }[] = [];
  const versions: VersionBody[] = [];
  const advances: string[] = [];
  const analyses: string[] = [];
  const unexpected: string[] = [];
  // A strict allowlist also blocks external traffic and unexpected API paths from reaching a server.
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (url.origin === new URL(baseURL!).origin && !path.startsWith("/api/"))
      return route.continue();
    if (url.origin === new URL(baseURL!).origin) {
      if (path === "/api/health" && method === "GET")
        return route.fulfill({
          json: {
            status: "ok",
            version: "explicit-journey-ui-fixture",
            accessGranted: true,
            requiresAccessCode: false,
            model: snapshot.model,
          },
        });
      if (path === "/api/intakes" && method === "POST") {
        const body = request.postDataJSON();
        expect(body).toEqual({ goal, modelMode: "gpt-6.1-terra" });
        draft = fixtureIntake({ ...body, id: draft.id });
        return route.fulfill({ status: 201, json: draft });
      }
      if (path === `/api/intakes/${draft.id}/attachments` && method === "POST") {
        draft = {
          ...draft,
          revision: draft.revision + 1,
          attachments: [
            {
              id: source.attachmentId,
              name: source.filename,
              size: Buffer.byteLength(source.text),
              state: "ready",
              imageCount: 0,
              interpreted: false,
              locations: [source.location],
              warnings: [],
            },
          ],
          sources: [source],
        };
        return route.fulfill({ status: 201, json: draft });
      }
      if (path === `/api/intakes/${draft.id}` && method === "PATCH") {
        const body = request.postDataJSON();
        expect(body.revision).toBe(draft.revision);
        draft = {
          ...draft,
          revision: draft.revision + 1,
          ...(body.answers
            ? {
                answers: body.answers.map((answer: IntakeAnswer) => ({ ...answer, question })),
              }
            : {}),
          ...(body.summary
            ? {
                challenge: body.summary.challenge,
                assumptions: body.summary.assumptions,
              }
            : {}),
        };
        return route.fulfill({ json: draft });
      }
      if (path === `/api/intakes/${draft.id}/analyze` && method === "POST") {
        expect(request.postDataJSON().revision).toBe(draft.revision);
        analyses.push(path);
        draft = {
          ...draft,
          revision: draft.revision + 1,
          status: analyses.length === 1 ? "questions" : "summary",
          round: 1,
          questions: analyses.length === 1 ? [question] : [],
          challenge:
            analyses.length === 1
              ? null
              : {
                  ...structuredClone(fixtureChallenge),
                  goal,
                  materials: source.text,
                },
          usedSourceIds: [source.id],
          assumptions: ["UI fixture 暂定假设：现有设备可用，仍需用户核对。"],
        };
        return route.fulfill({ json: draft });
      }
      if (path === `/api/intakes/${draft.id}/submit` && method === "POST") {
        const body = request.postDataJSON();
        expect(body.revision).toBe(draft.revision);
        submitted.push(body);
        snapshot.versions[0].challenge = structuredClone(body.challenge);
        snapshot.versions[0].intake = {
          id: draft.id,
          originalGoal: goal,
          answers: structuredClone(draft.answers),
          assumptions: body.assumptions,
          usedSources: [structuredClone(source)],
          usage: [],
        };
        draft = { ...draft, status: "submitted", arenaId: snapshot.id };
        return route.fulfill({ status: 201, json: snapshot });
      }
      if (path === `/api/arenas/${snapshot.id}/versions` && method === "POST") {
        const body = request.postDataJSON() as VersionBody;
        versions.push(body);
        const parent = snapshot.versions.at(-1)!;
        expect(body.baseVersionId).toBe(parent.id);
        const next = fixtureVersion(parent.number + 1, structuredClone(body.challenge));
        Object.assign(next, {
          parentVersionId: parent.id,
          changeReason: body.changeReason,
          modelSelection: structuredClone(parent.modelSelection),
          intake: structuredClone(parent.intake),
          ...(body.followUp
            ? {
                followUp: { ...body.followUp, sourceVersionId: parent.id },
              }
            : {}),
        });
        snapshot.versions.push(next);
        snapshot.activeVersionId = next.id;
        return route.fulfill({ status: 201, json: snapshot });
      }
      if (path === `/api/arenas/${snapshot.id}/advance` && method === "POST") {
        expect(request.postDataJSON()).toEqual({ versionId: snapshot.activeVersionId });
        advances.push(snapshot.activeVersionId);
        advanceFixture(snapshot);
        return route.fulfill({ json: snapshot });
      }
      if (path === `/api/arenas/${snapshot.id}` && method === "GET")
        return route.fulfill({ json: snapshot });
      if (path === `/api/arenas/${snapshot.id}/events` && method === "GET")
        return route.fulfill({
          contentType: "text/event-stream",
          body: ": explicit UI fixture\n\n",
        });
    }
    unexpected.push(`${method} ${url.href}`);
    return route.abort();
  });

  await page.goto("/");
  await page.getByRole("textbox", { name: "你想解决什么问题？", exact: true }).fill(goal);
  await page.getByLabel("选择参考材料", { exact: true }).setInputFiles({
    name: source.filename,
    mimeType: "text/plain",
    buffer: Buffer.from(source.text),
  });
  await expect(page.getByText("文字已提取", { exact: true })).toBeVisible();
  expect(analyses).toEqual([]);
  expect(submitted).toEqual([]);
  await page.getByRole("button", { name: "开始分析", exact: true }).click();
  await page
    .getByRole("group", { name: question.title, exact: true })
    .getByRole("radio", { name: "独立完成，不买设备", exact: true })
    .check();
  await page.getByRole("button", { name: "继续梳理", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "这是我们理解的任务。", exact: true }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "必须满足的限制", exact: true }).fill(constraints);
  expect(submitted).toEqual([]);
  expect(versions).toEqual([]);
  expect(advances).toEqual([]);
  await page.getByRole("button", { name: "开始推演", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "测试裁决：先做最小样片", exact: true }),
  ).toBeVisible();
  expect(submitted).toHaveLength(1);
  expect(submitted[0].challenge).toEqual({
    ...fixtureChallenge,
    goal,
    constraints,
    materials: source.text,
  });
  expect(await page.evaluate((key) => localStorage.getItem(key), intakeStorageKey)).toBeNull();
  const initial = structuredClone(snapshot.versions[0]);
  const versionSelect = page.getByRole("combobox", { name: "选择推演版本", exact: true });
  await readSavedMaterial(page, draft.id);

  // Each source type is now exercised against a real preceding UI-created version, rather than
  // resetting to the same initial snapshot between follow-ups. All records remain synthetic.
  for (const [stepId, number] of [
    ["p:A", 1],
    ["a:attack-fixture", 4],
    ["v:attack-fixture", 5],
    ["r:A", 6],
    ["judge", 9],
  ] as const) {
    const parent = structuredClone(snapshot.versions.at(-1)!);
    const context = stepContext(parent, stepId)!;
    const text = `UI fixture V${parent.number} 补充：请保留原限制，并重新核对这一步的准备时间。`;
    await page.keyboard.press("End");
    if ((page.viewportSize()?.width ?? 1440) < 650)
      await page.getByRole("button", { name: `第 ${number} 步`, exact: true }).click();
    await page.getByRole("button", { name: `查看第 ${number} 步`, exact: true }).focus();
    await page.keyboard.press("Enter");
    const card = page.getByRole("dialog", { name: new RegExp(`^第 ${number} 步 ·`) });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "补充或质疑", exact: true }).click();
    const supplement = page.getByRole("dialog", { name: "补充这一步", exact: true });
    await supplement.getByRole("button", { name: "查看原文", exact: true }).click();
    await expect(supplement.locator("blockquote")).toHaveText(context.quote);
    await supplement.getByRole("textbox").fill(text);
    expect(versions).toHaveLength(parent.number - 1);
    await supplement.getByRole("button", { name: "补充后重新推演", exact: true }).click();
    await expect(supplement).toBeHidden();
    await expect(versionSelect).toHaveValue(`fixture-version-${parent.number + 1}`);
    await expect.poll(() => snapshot.versions.at(-1)!.status).toBe("completed");
    expect(versions).toHaveLength(parent.number);
    expect(versions.at(-1)).toMatchObject({
      baseVersionId: parent.id,
      challenge: initial.challenge,
      modelMode: "gpt-6.1-terra",
      followUp: { stepId, quote: context.quote, text },
    });
    expect(snapshot.versions[parent.number - 1]).toEqual(parent);
    await page.getByRole("button", { name: "本次补充 · 查看原文与意见", exact: true }).click();
    const savedSource = page.getByRole("dialog", { name: "本次补充", exact: true });
    await expect(savedSource).toContainText(`来源：V${parent.number} · 步骤 ${stepId}`);
    await expect(savedSource.locator("blockquote")).toHaveText(context.quote);
    await expect(savedSource.getByText(text, { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(savedSource).toBeHidden();
  }

  await readSavedMaterial(page, draft.id);
  await page.getByRole("button", { name: "调整条件", exact: true }).click();
  const conditions = page.getByRole("dialog", { name: "调整条件", exact: true });
  await conditions.getByLabel("预算上限", { exact: false }).fill("150");
  expect(versions).toHaveLength(5);
  await conditions.getByRole("button", { name: "取消", exact: true }).click();
  await expect(conditions).toBeHidden();
  expect(versions).toHaveLength(5);
  await page.getByRole("button", { name: "调整条件", exact: true }).click();
  await expect(conditions.getByLabel("预算上限", { exact: false })).toHaveValue("300");
  await conditions.getByLabel("预算上限", { exact: false }).fill("150");
  await conditions.getByRole("button", { name: "按新条件重新推演", exact: true }).click();
  await expect(conditions).toBeHidden();
  await expect(versionSelect).toHaveValue("fixture-version-7");
  await expect.poll(() => snapshot.versions.at(-1)!.status).toBe("completed");
  expect(versions).toHaveLength(6);
  expect(versions.at(-1)).toMatchObject({
    baseVersionId: "fixture-version-6",
    modelMode: "gpt-6.1-terra",
    challenge: { ...initial.challenge, budget: 150 },
  });
  expect(versions.at(-1)!.followUp).toBeUndefined();
  await page.getByRole("button", { name: "对比上一版 V6 → V7", exact: true }).click();
  const comparison = page.getByRole("dialog", { name: "版本变化 · V6 → V7", exact: true });
  await expect(comparison.getByRole("heading", { name: "预算上限", exact: true })).toBeVisible();
  await expect(comparison.getByText("上一版300 元", { exact: true })).toBeVisible();
  await expect(comparison.getByText("本版150 元", { exact: true })).toBeVisible();
  await expect(comparison).toContainText("两版记录的建议路线均为 A");
  await page.keyboard.press("Escape");
  await expect(comparison).toBeHidden();
  await readSavedMaterial(page, draft.id);

  // Reading history and reopening comparisons must not create another run or advance old versions.
  const advanceCount = advances.length;
  await versionSelect.selectOption(initial.id);
  await expect(page.getByText("你正在查看历史版本。", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /^预算上限\s*¥300$/ })).toBeDisabled();
  await readSavedMaterial(page, draft.id);
  await expect(page.locator(".arena-cost")).toContainText("gpt-6.1-terra");
  await versionSelect.selectOption("fixture-version-7");
  await expect(page.getByRole("button", { name: /^预算上限\s*¥150$/ })).toBeEnabled();
  expect(snapshot.versions[0]).toEqual(initial);
  for (const version of snapshot.versions) {
    expect(version.challenge).toEqual({
      ...initial.challenge,
      budget: version.number === 7 ? 150 : 300,
    });
    expect(version.intake).toEqual(initial.intake);
    expect(version.modelSelection).toEqual(selection);
    expect(version.strategies.map((strategy) => strategy.id)).toEqual(["A", "B", "C"]);
    expect(advances.filter((id) => id === version.id)).toHaveLength(5);
  }
  expect(advances).toHaveLength(advanceCount);
  expect(advances).toHaveLength(35);
  expect(analyses).toHaveLength(2);
  expect(submitted).toHaveLength(1);
  expect(versions).toHaveLength(6);
  expect(unexpected).toEqual([]);
});
