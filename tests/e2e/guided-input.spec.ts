import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { e2eAddress } from "../../scripts/test-address.mjs";
import type { IntakeAnswer, IntakeQuestion } from "../../src/lib/intake-contracts";
import type { Challenge } from "../../src/lib/contracts";
import { configureFixtureModels, fixtureIntake, intakeStorageKey } from "./intake.fixture";
import { fixtureChallenge, fixtureSnapshot } from "./ui.fixture";
import { pdfFixture } from "../fixtures/attachments/generate";

// Every intercepted draft, question, source and response below is an explicit UI fixture.
// These tests never call a model and do not claim to validate model comprehension.
const questions: IntakeQuestion[] = [
  {
    id: "direction",
    title: "你最希望完成什么？",
    reason: "测试问题：明确任务的成功标准。",
    placeholder: "",
    type: "single",
    options: ["学会基础", "完成作品"],
    unit: "",
  },
  {
    id: "limits",
    title: "哪些条件必须保留？",
    reason: "测试问题：保留硬性限制。",
    placeholder: "",
    type: "multiple",
    options: ["不买设备", "周末休息", "独立完成"],
    unit: "",
  },
  {
    id: "hours",
    title: "每周能投入几小时？",
    reason: "测试问题：未知时间不能被猜成事实。",
    placeholder: "请输入小时数",
    type: "number",
    options: [],
    unit: "小时",
  },
];

async function healthFixture(page: Page) {
  const snapshot = configureFixtureModels(fixtureSnapshot());
  await page.route("**/api/health", (route) =>
    route.fulfill({
      json: {
        status: "ok",
        version: "explicit-ui-fixture",
        commit: "fixture",
        accessGranted: true,
        requiresAccessCode: false,
        model: snapshot.model,
      },
    }),
  );
  await page.route("**/api/arenas/**", (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/events"))
      return route.fulfill({ contentType: "text/event-stream", body: ": explicit fixture\n\n" });
    return route.fulfill({ json: snapshot });
  });
  return snapshot;
}

test("real unconfigured intake API: local attachment parsing and downloads enforce browser ownership without model calls", async ({
  request,
  playwright,
}) => {
  const { origin } = e2eAddress();
  const headers = { Origin: origin };
  expect(
    (
      await request.post("/api/intakes", {
        headers,
        data: { goal: "测试：本地解析附件并验证浏览器隔离" },
      })
    ).status(),
  ).toBe(401);
  expect(
    (
      await request.post("/api/access", { headers, data: { code: "e2e-only-access-code" } })
    ).status(),
  ).toBe(200);
  const created = await request.post("/api/intakes", {
    headers,
    data: { goal: "测试：本地解析附件并验证浏览器隔离", modelMode: "gpt-6.1-terra" },
  });
  expect(created.status()).toBe(201);
  let draft = await created.json();
  const path = `/api/intakes/${draft.id}`;
  const original = Buffer.from("测试原文：材料预算为三百元。\n原文件只属于上传它的浏览器。");
  const uploaded = await request.post(`${path}/attachments`, {
    headers,
    multipart: { file: { name: "synthetic-owner.txt", mimeType: "text/plain", buffer: original } },
  });
  expect(uploaded.status()).toBe(201);
  draft = await uploaded.json();
  const fileId = draft.attachments[0].id;
  expect(draft.attachments[0]).toMatchObject({ state: "ready", interpreted: false, imageCount: 0 });
  expect(draft.sources[0]).toMatchObject({
    filename: "synthetic-owner.txt",
    location: "第 1–2 行",
    interpretation: false,
  });
  expect(draft.sources[0].text).toBe(original.toString());
  expect(draft.attachments[0]).not.toHaveProperty("bytes");
  expect(draft.attachments[0]).not.toHaveProperty("parsed");
  const download = await request.get(`${path}/attachments/${fileId}`);
  expect(download.status()).toBe(200);
  expect(download.headers()["content-type"]).toBe("application/octet-stream");
  expect(download.headers()["cache-control"]).toBe("no-store");
  expect(await download.body()).toEqual(original);
  const foreign = await playwright.request.newContext({ baseURL: origin });
  try {
    expect(
      (
        await foreign.post("/api/access", { headers, data: { code: "e2e-only-access-code" } })
      ).status(),
    ).toBe(200);
    expect((await foreign.get(path)).status()).toBe(404);
    expect((await foreign.get(`${path}/attachments/${fileId}`)).status()).toBe(404);
    expect((await foreign.delete(`${path}/attachments/${fileId}`, { headers })).status()).toBe(404);
    expect(
      (
        await foreign.post(`${path}/attachments`, {
          headers,
          multipart: {
            file: {
              name: "foreign.txt",
              mimeType: "text/plain",
              buffer: Buffer.from("synthetic foreign upload"),
            },
          },
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await foreign.post(`${path}/attachments/${fileId}/pages`, { headers, data: { pages: [1] } })
      ).status(),
    ).toBe(404);
  } finally {
    await foreign.dispose();
  }
  const longPdf = await request.post(`${path}/attachments`, {
    headers,
    multipart: {
      file: { name: "synthetic-long.pdf", mimeType: "application/pdf", buffer: pdfFixture(21) },
    },
  });
  expect(longPdf.status()).toBe(201);
  draft = await longPdf.json();
  const pdf = draft.attachments.find(
    (file: { name: string }) => file.name === "synthetic-long.pdf",
  );
  expect(pdf).toMatchObject({ state: "needs_pages", pageCount: 21 });
  const selected = await request.post(`${path}/attachments/${pdf.id}/pages`, {
    headers,
    data: { pages: [21] },
  });
  expect(selected.status()).toBe(200);
  draft = await selected.json();
  expect(draft.attachments.find((file: { id: string }) => file.id === pdf.id)).toMatchObject({
    state: "ready",
    pageCount: 21,
  });
  expect(
    draft.sources.some(
      (source: { text: string; location: string }) =>
        source.location === "第 21 页" && source.text.includes("Example page 21"),
    ),
  ).toBe(true);
  // A graphical page exercises the packaged PDF worker, native canvas and image encoder for free.
  const graphic = await request.post(`${path}/attachments`, {
    headers,
    multipart: {
      file: {
        name: "synthetic-graphic.pdf",
        mimeType: "application/pdf",
        buffer: pdfFixture(1, false, true),
      },
    },
  });
  expect(graphic.status()).toBe(201);
  draft = await graphic.json();
  expect(
    draft.attachments.find((file: { name: string }) => file.name === "synthetic-graphic.pdf"),
  ).toMatchObject({ state: "ready", imageCount: 1, interpreted: false });
  const blocked = await request.post(`${path}/analyze`, {
    headers,
    data: { revision: draft.revision, operationId: randomUUID(), finish: false },
  });
  expect(blocked.status()).toBe(503);
  expect((await blocked.json()).code).toBe("MODEL_NOT_CONFIGURED");
  const restored = await (await request.get(path)).json();
  expect(restored.usage).toEqual([]);
  expect(restored.status).toBe("input");
  expect((await request.delete(`${path}/attachments/${fileId}`, { headers })).status()).toBe(200);
  expect((await request.get(`${path}/attachments/${fileId}`)).status()).toBe(404);
});

test("explicit UI fixture: goal only, three adaptive questions, skipped follow-up and confirmed editable summary", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const snapshot = await healthFixture(page);
  snapshot.versions[0].status = "paused";
  let draft = fixtureIntake();
  const analysis: { finish: boolean; operationId: string }[] = [];
  const answers: IntakeAnswer[][] = [];
  let submitted: { challenge: Challenge; assumptions: string[] } | undefined;
  await page.route(/\/api\/intakes(?:\/.*)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === "/api/intakes" && method === "POST") {
      const body = route.request().postDataJSON();
      expect(body).toEqual({
        goal: "测试：我想在一个月内学会剪辑并完成自己的第一支视频",
        modelMode: "gpt-6.1-terra",
      });
      draft = fixtureIntake(body);
    } else if (method === "PATCH") {
      const body = route.request().postDataJSON();
      if (body.answers) answers.push(body.answers);
      draft = {
        ...draft,
        revision: draft.revision + 1,
        ...(body.summary
          ? { challenge: body.summary.challenge, assumptions: body.summary.assumptions }
          : {}),
        answers: body.answers
          ? body.answers.map((answer: IntakeAnswer) => ({
              ...answer,
              question: draft.questions.find((question) => question.id === answer.questionId)!,
            }))
          : draft.answers,
      };
    } else if (path.endsWith("/analyze")) {
      const body = route.request().postDataJSON();
      analysis.push(body);
      draft =
        analysis.length < 3
          ? {
              ...draft,
              revision: draft.revision + 1,
              status: "questions",
              round: analysis.length,
              questions:
                analysis.length === 1
                  ? questions
                  : questions.map((question) => ({
                      ...question,
                      id: `${question.id}_followup`,
                      title: `后续：${question.title}`,
                    })),
            }
          : {
              ...draft,
              revision: draft.revision + 1,
              status: "summary",
              questions: [],
              challenge: { ...structuredClone(fixtureChallenge), goal: draft.goal },
              assumptions: ["测试假设：只使用现有设备，尚未得到原文确认。"],
            };
    } else if (path.endsWith("/submit")) {
      submitted = route.request().postDataJSON();
      snapshot.versions[0].challenge = submitted!.challenge;
      return route.fulfill({ status: 201, json: snapshot });
    }
    return route.fulfill({ json: draft });
  });
  await page.goto("/");
  // The home tools stay hidden until the visitor writes something.
  await expect(page.getByRole("button", { name: "开始分析", exact: true })).toBeHidden();
  await expect(page.getByRole("textbox", { name: "必须满足的限制", exact: true })).toBeHidden();
  await page
    .getByLabel("你想解决什么问题？", { exact: true })
    .fill("测试：我想在一个月内学会剪辑并完成自己的第一支视频");
  await page.getByRole("button", { name: "开始分析", exact: true }).click();
  await expect(page.locator(".gi-question")).toHaveCount(3);
  await page
    .getByRole("group", { name: questions[0].title, exact: true })
    .getByRole("radio", { name: "完成作品", exact: true })
    .check();
  const multiple = page.getByRole("group", { name: questions[1].title, exact: true });
  await multiple.getByRole("checkbox", { name: "不买设备" }).check();
  await multiple.getByRole("checkbox", { name: "独立完成" }).check();
  await multiple.getByRole("button", { name: "暂时不知道", exact: true }).click();
  await expect(multiple.getByRole("checkbox", { name: "不买设备" })).toBeHidden();
  await multiple.getByRole("button", { name: "我来补充", exact: true }).click();
  await expect(multiple.getByRole("checkbox", { name: "不买设备" })).toBeChecked();
  await page
    .getByRole("group", { name: questions[2].title, exact: true })
    .getByRole("button", { name: "跳过", exact: true })
    .click();
  await page.getByRole("button", { name: "继续梳理", exact: true }).click();
  await expect(page.getByText("第 2 / 2 轮 · 可以说不知道")).toBeVisible();
  expect(answers[0]).toEqual([
    { questionId: "direction", state: "answered", value: "完成作品" },
    { questionId: "limits", state: "answered", value: ["不买设备", "独立完成"] },
    { questionId: "hours", state: "skipped", value: "" },
  ]);
  await page.getByRole("button", { name: "跳过本轮，整理摘要", exact: true }).click();
  await expect(page.getByRole("heading", { name: "这是我们理解的任务。" })).toBeVisible();
  expect(analysis.map((call) => call.finish)).toEqual([false, false, true]);
  expect(new Set(analysis.map((call) => call.operationId)).size).toBe(3);
  await expect(page.getByText("暂定假设 · 请逐条核对")).toBeVisible();
  const submit = page.getByRole("button", { name: "开始推演", exact: true });
  await expect(submit).toBeEnabled();
  await page
    .getByRole("textbox", { name: "必须满足的限制", exact: true })
    .fill("测试确认：独立完成且不购买新设备。");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByRole("heading", { name: draft.goal, exact: true })).toBeVisible();
  expect(submitted?.challenge.constraints).toBe("测试确认：独立完成且不购买新设备。");
  expect(submitted?.assumptions).toHaveLength(1);
  expect(await page.evaluate((key) => localStorage.getItem(key), intakeStorageKey)).toBeNull();
});

test("explicit UI fixture: refresh restores questions and a late pre-refresh response cannot replace the current summary", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await healthFixture(page);
  let draft = fixtureIntake({ revision: 4, status: "questions", round: 1, questions });
  await page.addInitScript(({ key, id }) => localStorage.setItem(key, id), {
    key: intakeStorageKey,
    id: draft.id,
  });
  let analyzeStarted!: () => void;
  let releaseOld!: () => void;
  const started = new Promise<void>((resolve) => {
    analyzeStarted = resolve;
  });
  const oldGate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let analyses = 0;
  await page.route(/\/api\/intakes(?:\/.*)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "PATCH") draft = { ...draft, revision: 5 };
    if (path.endsWith("/analyze")) {
      analyses++;
      const stale = structuredClone(draft);
      draft = {
        ...draft,
        revision: 7,
        status: "summary",
        questions: [],
        challenge: fixtureChallenge,
        assumptions: ["测试：刷新后读取服务端已保存摘要。"],
      };
      analyzeStarted();
      await oldGate;
      return route.fulfill({ json: stale }).catch(() => {});
    }
    return route.fulfill({ json: draft });
  });
  try {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "再了解你一点。" })).toBeVisible();
    await page
      .getByRole("group", { name: questions[0].title, exact: true })
      .getByRole("radio", { name: "学会基础" })
      .check();
    await page.getByRole("button", { name: "继续梳理", exact: true }).click();
    await started;
    await page.reload();
    await expect(page.getByRole("heading", { name: "这是我们理解的任务。" })).toBeVisible();
    releaseOld();
    await expect(page.getByRole("textbox", { name: "要达到的目标", exact: true })).toHaveValue(
      fixtureChallenge.goal,
    );
    await expect(page.getByRole("heading", { name: "再了解你一点。" })).toBeHidden();
    await expect(page.getByRole("button", { name: "开始推演", exact: true })).toBeEnabled();
    expect(analyses).toBe(1);
  } finally {
    releaseOld();
  }
});

test("explicit UI fixture: rapid repeated confirmation starts exactly one submission", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const snapshot = await healthFixture(page);
  snapshot.versions[0].status = "paused";
  const draft = fixtureIntake({ status: "summary", revision: 5, challenge: fixtureChallenge });
  await page.addInitScript(({ key, id }) => localStorage.setItem(key, id), {
    key: intakeStorageKey,
    id: draft.id,
  });
  let submissions = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/intakes(?:\/.*)?$/, async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/submit")) {
      submissions++;
      await gate;
      return route.fulfill({ status: 201, json: snapshot });
    }
    return route.fulfill({ json: draft });
  });
  try {
    await page.goto("/");
    const submit = page.getByRole("button", { name: "开始推演", exact: true });
    await submit.evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await expect(submit).toBeDisabled();
    await expect.poll(() => submissions).toBe(1);
    release();
    await expect(
      page.getByRole("heading", { name: fixtureChallenge.goal, exact: true }),
    ).toBeVisible();
    expect(submissions).toBe(1);
  } finally {
    release();
  }
});

test("explicit UI fixture: PDF page selection, failed attachment and source disclosure work while the story clock is paused", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await healthFixture(page);
  let draft = fixtureIntake();
  const selections: number[][] = [];
  await page.route(/\/api\/intakes(?:\/.*)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/intakes" && route.request().method() === "POST")
      draft = fixtureIntake(route.request().postDataJSON());
    if (path.endsWith("/attachments")) {
      draft = {
        ...draft,
        revision: draft.revision + 1,
        attachments: [
          ...draft.attachments,
          draft.attachments.length === 0
            ? {
                id: "pdf-fixture",
                name: "fixture-long.pdf",
                size: 1000,
                state: "needs_pages",
                pageCount: 21,
                imageCount: 0,
                interpreted: false,
                locations: [],
                warnings: [],
              }
            : {
                id: "broken-fixture",
                name: "fixture-broken.pdf",
                size: 15,
                state: "failed",
                imageCount: 0,
                interpreted: false,
                locations: [],
                warnings: [],
                error: "测试替身：PDF 已损坏，请重新导出。",
              },
        ],
      };
    }
    if (path.endsWith("/pages")) {
      selections.push(route.request().postDataJSON().pages);
      draft = {
        ...draft,
        revision: draft.revision + 1,
        attachments: draft.attachments.map((file) =>
          file.id === "pdf-fixture"
            ? {
                ...file,
                state: "ready",
                locations: ["第 1 页", "第 2 页", "第 8 页"],
                warnings: ["仅读取所选页：1、2、8；其余页面未读取。"],
              }
            : file,
        ),
        sources: [
          {
            id: "source-fixture",
            attachmentId: "pdf-fixture",
            filename: "fixture-long.pdf",
            location: "第 8 页",
            text: "测试原文：每天可投入一小时。",
            interpretation: false,
          },
        ],
      };
    }
    if (path.endsWith("/analyze"))
      draft = {
        ...draft,
        revision: draft.revision + 1,
        status: "summary",
        challenge: fixtureChallenge,
        usedSourceIds: ["source-fixture"],
      };
    return route.fulfill({ json: draft });
  });
  await page.goto("/");
  await page.getByLabel("你想解决什么问题？", { exact: true }).fill(fixtureChallenge.goal);
  await page.getByLabel("选择参考材料", { exact: true }).setInputFiles({
    name: "fixture-long.pdf",
    mimeType: "application/pdf",
    buffer: pdfFixture(21),
  });
  await expect(page.getByText("共 21 页，请先选择最多 20 页")).toBeVisible();
  await page.getByLabel("fixture-long.pdf 的页码", { exact: true }).fill("1-21");
  await page.getByRole("button", { name: "读取所选页", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "准备一场推演", exact: true }).getByRole("alert"),
  ).toContainText("一次最多选择 20 页");
  expect(selections).toEqual([]);
  await page.getByLabel("fixture-long.pdf 的页码", { exact: true }).fill("1-2, 8");
  await page.getByRole("button", { name: "读取所选页", exact: true }).click();
  await expect(page.getByText("仅读取所选页：1、2、8；其余页面未读取。")).toBeVisible();
  expect(selections).toEqual([[1, 2, 8]]);
  await page.getByLabel("选择参考材料", { exact: true }).setInputFiles({
    name: "fixture-broken.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 broken"),
  });
  await expect(page.getByText("测试替身：PDF 已损坏，请重新导出。")).toBeVisible();
  await page.getByRole("button", { name: "开始分析", exact: true }).click();
  await expect(page.getByRole("heading", { name: "这是我们理解的任务。" })).toBeVisible();
  // Explicit browser-state fixture: the story clock sees a hidden document; interaction animation remains live.
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const advanced = page.getByRole("button", { name: "预算、时间与备选方案", exact: true });
  await advanced.click();
  await expect(advanced).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByLabel("可投入金额（人民币）", { exact: true })).toBeVisible();
  await page.getByLabel("可投入金额（人民币）", { exact: true }).fill("120");
  await page.getByRole("button", { name: /查看材料原文与位置/ }).click();
  await page.getByRole("button", { name: /fixture-long.pdf 第 8 页/ }).click();
  await expect(page.getByText("测试原文：每天可投入一小时。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "收起材料预览", exact: true }).click();
  await expect(page.getByText("测试原文：每天可投入一小时。", { exact: true })).toBeHidden();
});
