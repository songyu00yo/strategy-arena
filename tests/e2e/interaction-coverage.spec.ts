// Explicit synthetic API fixtures and saved real-model simulation records.
// Runtime discovery describes rendered controls. These functional checks do not certify frame pacing.
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { ArenaSnapshot } from "../../src/lib/contracts";
import type { DecisionReview } from "../../src/lib/decision-review";
import type { IntakeDraft, IntakeQuestion } from "../../src/lib/intake-contracts";
import { configureFixtureModels, fixtureIntake } from "./intake.fixture";
import { advanceFixture, fixtureChallenge, fixtureSnapshot } from "./ui.fixture";

function completedSnapshot() {
  const snapshot = configureFixtureModels(fixtureSnapshot());
  for (let stage = 0; stage < 5; stage++) advanceFixture(snapshot);
  snapshot.versions[0].modelSelection = {
    requestedMode: "gpt-6.1-terra",
    provider: "openai",
    modelId: "gpt-6.1-terra",
    currency: "USD",
    policyVersion: "explicit-interaction-fixture",
    reason: "Explicit synthetic model availability, no provider calls.",
  };
  return snapshot;
}

const dispatchedInputs = new WeakMap<
  Page,
  Array<{ name: string; tag: string; method: "mouse" | "keyboard" }>
>();

type NativeInputRecord = {
  type: string;
  trusted: boolean;
  key: string | null;
  tag: string;
  role: string | null;
  name: string;
  inputType: string | null;
  dialog: string | null;
  question: string | null;
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const records: NativeInputRecord[] = [];
    Object.assign(window, { __interactionInputLog: records });
    for (const type of [
      "click",
      "input",
      "change",
      "keydown",
      "focusin",
      "focusout",
      "pointerover",
      "pointerout",
      "drop",
    ]) {
      document.addEventListener(
        type,
        (event) => {
          if (!(event.target instanceof Element)) return;
          const target = event.target.closest<HTMLElement>(
            'button,a[href],input,textarea,select,summary,[role="button"],[role="option"],[role="tab"],[role="menuitem"],[tabindex]',
          );
          if (!target || target.closest('[inert],[aria-hidden="true"]')) return;
          const labelled = (target.getAttribute("aria-labelledby") ?? "")
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ");
          const labels =
            "labels" in target
              ? [...((target as HTMLInputElement).labels ?? [])]
                  .map((label) => label.textContent ?? "")
                  .join(" ")
              : "";
          const name =
            target.getAttribute("aria-label") ||
            labelled.trim() ||
            labels.trim() ||
            target.getAttribute("title") ||
            target.getAttribute("placeholder") ||
            target.textContent ||
            "";
          const dialog = target.closest('dialog,[role="dialog"]');
          records.push({
            type: event.type,
            trusted: event.isTrusted,
            key: event instanceof KeyboardEvent ? event.key : null,
            tag: target.tagName.toLowerCase(),
            role: target.getAttribute("role"),
            name: name.replace(/\s+/g, " ").trim().slice(0, 240),
            inputType: target.getAttribute("type"),
            dialog:
              dialog?.getAttribute("aria-label") ||
              (dialog?.getAttribute("aria-labelledby") ?? "")
                .split(/\s+/)
                .map((id) => document.getElementById(id)?.textContent ?? "")
                .join(" ") ||
              null,
            question:
              target.closest("[data-question-id]")?.getAttribute("data-question-id") ?? null,
          });
        },
        true,
      );
    }
  });
});

test.afterEach(async ({ page }, testInfo) => {
  const nativeInputs = page.isClosed()
    ? []
    : await page.evaluate(
        () =>
          (window as unknown as { __interactionInputLog?: NativeInputRecord[] })
            .__interactionInputLog ?? [],
      );
  await testInfo.attach("executed-inputs", {
    body: JSON.stringify({
      scenarioStatus: testInfo.status,
      verification: "input-events-with-scenario-assertions",
      dispatchedInputs: dispatchedInputs.get(page) ?? [],
      nativeInputs,
    }),
    contentType: "application/json",
  });
});

async function runtimeCheckpoint(page: Page, testInfo: TestInfo, state: string) {
  const inventory = await page.evaluate(() => {
    const selector =
      'a[href],button,input:not([type="hidden"]),textarea,select,summary,[role="button"],[role="option"],[role="tab"],[role="menuitem"],[tabindex]';
    return [...document.querySelectorAll<HTMLElement>(selector)].flatMap((element) => {
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height || element.closest('[inert],[aria-hidden="true"]')) return [];
      for (let node: HTMLElement | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number(style.opacity) < 0.01
        )
          return [];
      }
      const labelled = (element.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      const labels =
        "labels" in element
          ? [...((element as HTMLInputElement).labels ?? [])]
              .map((label) => label.textContent ?? "")
              .join(" ")
          : "";
      const name =
        element.getAttribute("aria-label") ||
        labelled.trim() ||
        labels.trim() ||
        element.getAttribute("title") ||
        element.getAttribute("placeholder") ||
        element.textContent ||
        "";
      const inViewport =
        box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight;
      const x = Math.max(0, Math.min(innerWidth - 1, box.left + box.width / 2));
      const y = Math.max(0, Math.min(innerHeight - 1, box.top + box.height / 2));
      const hit = inViewport ? document.elementFromPoint(x, y) : null;
      const dialog = element.closest('dialog,[role="dialog"]');
      return [
        {
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role"),
          name: name.replace(/\s+/g, " ").trim().slice(0, 240),
          type: element.getAttribute("type"),
          href: element.getAttribute("href"),
          disabled:
            element.matches(":disabled") || element.getAttribute("aria-disabled") === "true",
          expanded: element.getAttribute("aria-expanded"),
          selected: element.getAttribute("aria-selected"),
          checked: "checked" in element ? (element as HTMLInputElement).checked : null,
          inViewport,
          centreHit: !!hit && (hit === element || element.contains(hit)),
          dialog:
            dialog?.getAttribute("aria-label") ||
            (dialog?.getAttribute("aria-labelledby") ?? "")
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent ?? "")
              .join(" ") ||
            null,
          box: { x: box.x, y: box.y, width: box.width, height: box.height },
        },
      ];
    });
  });
  const nativeInputs = await page.evaluate(
    () =>
      (window as unknown as { __interactionInputLog?: NativeInputRecord[] })
        .__interactionInputLog ?? [],
  );
  await testInfo.attach(`runtime-controls-${state}`, {
    body: JSON.stringify({
      state,
      viewport: page.viewportSize(),
      verification: "runtime-discovery-only",
      dispatchedInputs: dispatchedInputs.get(page) ?? [],
      nativeInputs,
      controls: inventory,
    }),
    contentType: "application/json",
  });
  await page.screenshot({ path: testInfo.outputPath(`${state}.png`) });
  return inventory;
}

async function activate(control: Locator, keyboard = false) {
  await expect(control).toBeVisible();
  await expect(control).toBeEnabled();
  const identity = await control.evaluate((element) => ({
    name:
      element.getAttribute("aria-label") ||
      element.textContent?.replace(/\s+/g, " ").trim().slice(0, 160) ||
      element.tagName,
    tag: element.tagName.toLowerCase(),
  }));
  await test.step(`${keyboard ? "Keyboard" : "Mouse"} activates ${identity.name}`, async () => {
    if (keyboard) {
      await control.focus();
      await control.press("Enter");
    } else await control.click();
  });
  const page = control.page();
  const previous = dispatchedInputs.get(page) ?? [];
  previous.push({ ...identity, method: keyboard ? "keyboard" : "mouse" });
  dispatchedInputs.set(page, previous);
}

async function fixtureApis(
  page: Page,
  initialDraft?: IntakeDraft,
  initialSnapshot?: ArenaSnapshot,
) {
  const snapshot = initialSnapshot ?? completedSnapshot();
  let recoveryEnabled = false;
  let review: DecisionReview | null = null;
  let draft = initialDraft ?? fixtureIntake({ goal: "【测试替身】登记需求输入和补问控件" });
  const unexpected: string[] = [];
  const calls: string[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    calls.push(`${method} ${path}`);
    if (path === "/api/health")
      return route.fulfill({
        json: {
          status: "ok",
          version: "explicit-interaction-fixture",
          model: snapshot.model,
          accessGranted: true,
          requiresAccessCode: false,
        },
      });
    if (path === "/api/identity")
      return route.fulfill({
        json: { identityTag: "a".repeat(64), hasRecoveryCode: recoveryEnabled },
      });
    if (path === "/api/identity/recovery-code" && method === "POST")
      return route.fulfill({
        json: {
          identityTag: "a".repeat(64),
          recoveryCode: "explicit-synthetic-recovery-code-for-ui-only",
        },
      });
    if (path === "/api/identity/recovery-code/activate") {
      recoveryEnabled = true;
      return route.fulfill({ json: { identityTag: "a".repeat(64), hasRecoveryCode: true } });
    }
    if (path === "/api/identity/recover")
      return route.fulfill({ status: 400, json: { error: "明确测试替身：恢复码无效，请核对。" } });
    if (path.endsWith("/decision-review")) {
      if (method === "POST") {
        review = {
          id: "explicit-interaction-review",
          arenaId: snapshot.id,
          versionId: snapshot.activeVersionId,
          operationId: "00000000-0000-4000-8000-000000000001",
          model: "gpt-6-luna",
          status: "completed",
          inputHash: "a".repeat(64),
          configurationHash: "b".repeat(64),
          stale: false,
          answers: [
            {
              name: "preference",
              type: "choice",
              choice: "B",
              confidence: 0.5,
              probabilities: [
                { value: "B", probability: 0.5 },
                { value: "tie", probability: 0.5 },
              ],
            },
          ],
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cachedInputTokens: 0,
            estimatedCny: 0,
            estimatedUsd: 0,
            currency: "USD",
            provider: "openai",
            model: "gpt-6-luna",
            responseId: "explicit-interaction-response",
            durationMs: 1,
          },
          responseIdSource: "local-call-id",
          reservedUsd: 0,
          error: null,
          errorCode: null,
          canRetry: false,
          createdAt: snapshot.createdAt,
          updatedAt: snapshot.createdAt,
        };
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return route.fulfill({ json: review });
    }
    if (path === "/api/arenas")
      return route.fulfill({
        json: {
          items: [
            {
              id: snapshot.id,
              goal: snapshot.versions[0].challenge.goal,
              createdAt: snapshot.createdAt,
              activeVersionId: snapshot.activeVersionId,
              status: "completed",
              stage: "judge",
              versionCount: snapshot.versions.length,
            },
          ],
          nextCursor: null,
        },
      });
    if (path === "/api/intakes" && method === "GET")
      return route.fulfill({
        json: {
          items: [
            { id: draft.id, goal: draft.goal, updatedAt: draft.updatedAt, status: draft.status },
          ],
          nextCursor: null,
        },
      });
    if (path === "/api/intakes" && method === "POST") {
      const body = request.postDataJSON();
      draft = { ...draft, goal: body.goal, modelMode: body.modelMode ?? draft.modelMode };
      return route.fulfill({ status: 201, json: draft });
    }
    if (path.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: ": explicit interaction fixture\n\n",
      });
    if (path === `/api/arenas/${snapshot.id}`) return route.fulfill({ json: snapshot });
    if (path === `/api/intakes/${draft.id}/attachments` && method === "POST") {
      draft = {
        ...draft,
        revision: draft.revision + 1,
        attachments: [
          ...draft.attachments,
          {
            id: "synthetic-file",
            name: "explicit-material.txt",
            size: 18,
            state: "ready",
            imageCount: 0,
            interpreted: false,
            locations: ["第 1 行"],
            warnings: [],
          },
        ],
      };
      return route.fulfill({ status: 201, json: draft });
    }
    if (path === `/api/intakes/${draft.id}/attachments/synthetic-file` && method === "DELETE") {
      draft = {
        ...draft,
        revision: draft.revision + 1,
        attachments: draft.attachments.filter((file) => file.id !== "synthetic-file"),
      };
      return route.fulfill({ json: draft });
    }
    if (path.endsWith("/pages")) {
      draft = {
        ...draft,
        revision: draft.revision + 1,
        attachments: draft.attachments.map((file) => ({
          ...file,
          state: "ready",
          locations: ["第 1 页"],
        })),
        sources: [
          ...draft.sources,
          {
            id: "parsed-page",
            attachmentId: "page-file",
            filename: "explicit-page.pdf",
            location: "第 1 页",
            text: "明确测试替身：所选页原文。",
            interpretation: false,
            origin: "document",
          },
        ],
      };
      return route.fulfill({ json: draft });
    }
    if (path === `/api/intakes/${draft.id}` && method === "PATCH") {
      const body = request.postDataJSON();
      const { summary, ...fields } = body;
      draft = {
        ...draft,
        ...fields,
        ...(summary ? { challenge: summary.challenge, assumptions: summary.assumptions } : {}),
        revision: draft.revision + 1,
        answers: body.answers
          ? body.answers.map((answer: { questionId: string }) => ({
              ...answer,
              question: draft.questions.find((question) => question.id === answer.questionId),
            }))
          : draft.answers,
      };
      return route.fulfill({ json: draft });
    }
    if (path === `/api/intakes/${draft.id}`) return route.fulfill({ json: draft });
    if (path.endsWith("/analyze")) {
      draft = {
        ...draft,
        revision: draft.revision + 1,
        status: "summary",
        questions: [],
        challenge: structuredClone(fixtureChallenge),
      };
      return route.fulfill({ json: draft });
    }
    unexpected.push(`${method} ${path}`);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected request blocked by the explicit interaction fixture." },
    });
  });
  return { snapshot, calls, unexpected };
}

for (const width of [1440, 390]) {
  test(`explicit UI fixture: home, model, history and example entry inventory at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const api = await fixtureApis(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "你想做什么", exact: true })).toBeVisible();
    await runtimeCheckpoint(page, testInfo, "home-empty");
    const goal = page.getByRole("textbox", { name: "你想做什么", exact: true });
    await goal.click();
    await goal.pressSequentially("测");
    const model = page.getByRole("button", { name: /^选择模型，当前/ });
    await activate(model);
    await expect(page.getByRole("listbox", { name: "本轮使用的模型" })).toBeVisible();
    await runtimeCheckpoint(page, testInfo, "model-open");
    await activate(page.getByRole("button", { name: "查看选择依据", exact: true }));
    await runtimeCheckpoint(page, testInfo, "model-reason");
    await page.keyboard.press("Escape");
    await expect(model).toHaveAttribute("aria-expanded", "false");
    await activate(model, true);
    await page.keyboard.press("End");
    await page.keyboard.press("Space");
    await expect(model).toHaveAttribute("aria-expanded", "false");
    await activate(page.getByRole("button", { name: "我的历史", exact: true }));
    const history = page.getByRole("dialog", { name: "我的历史与恢复码", exact: true });
    await expect(history.getByRole("heading", { name: "已创建的讨论", exact: true })).toBeVisible();
    await runtimeCheckpoint(page, testInfo, "history-records");
    await activate(history.getByRole("button", { name: "刷新", exact: true }));
    await expect(history.getByRole("button", { name: "生成恢复码", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(history).toBeHidden();
    await activate(page.getByRole("button", { name: "先看需求梳理示例", exact: true }), true);
    const examples = page.getByRole("dialog", { name: "先看需求梳理示例", exact: true });
    await expect(examples.locator(".recorded-example-card")).toHaveCount(4);
    await runtimeCheckpoint(page, testInfo, "examples-open");
    await activate(examples.getByRole("button", { name: "关闭弹窗", exact: true }));
    await expect(examples).toBeHidden();
    expect(api.unexpected).toEqual([]);
  });

  test(`saved simulation: actual detail, supplement and condition entry inventory at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const api = await fixtureApis(page);
    await page.goto("/examples/personal-website");
    await activate(page.getByRole("button", { name: "暂停自动开始", exact: true }));
    await runtimeCheckpoint(page, testInfo, "example-original");
    await activate(page.getByRole("button", { name: "开始回看", exact: true }));
    await expect(page.locator(".initial-paper-transfer")).toHaveCount(0);
    const pause = page.getByRole("button", { name: "暂停放映", exact: true });
    if (await pause.count()) await activate(pause);
    await activate(page.getByRole("button", { name: "第 1 步", exact: true }));
    await activate(page.getByRole("button", { name: "查看第 1 步", exact: true }), true);
    const detail = page.getByRole("dialog", { name: /^第 1 步 ·/ });
    await expect(detail).toBeVisible();
    await runtimeCheckpoint(page, testInfo, "step-detail");
    await activate(detail.getByRole("button", { name: "补充或质疑", exact: true }));
    const supplement = page
      .getByRole("dialog")
      .filter({ has: page.getByRole("textbox", { name: "你想补充或询问什么？", exact: true }) });
    await expect(supplement).toBeVisible();
    await runtimeCheckpoint(page, testInfo, "saved-supplement");
    await supplement
      .getByRole("textbox", { name: "你想补充或询问什么？", exact: true })
      .fill("【测试替身】保留已写文字，检查补充窗口交接。");
    await activate(supplement.getByRole("button", { name: "查看原文", exact: true }));
    await runtimeCheckpoint(page, testInfo, "supplement-original");
    await activate(supplement.getByRole("button", { name: "调整条件", exact: true }));
    const conditions = page.getByRole("dialog", { name: "调整条件", exact: true });
    await expect(conditions).toBeVisible();
    await runtimeCheckpoint(page, testInfo, "conditions-quick");
    await activate(conditions.getByRole("button", { name: /^完整编辑/ }));
    await runtimeCheckpoint(page, testInfo, "conditions-complete");
    await activate(conditions.getByRole("button", { name: "取消", exact: true }));
    await expect(conditions).toBeHidden();
    expect(api.calls.filter((call) => call.startsWith("POST"))).toEqual([]);
    expect(api.unexpected).toEqual([]);
  });

  test(`explicit UI fixture: question controls and summary expansion inventory at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const questions: IntakeQuestion[] = [
      {
        id: "purpose",
        title: "测试用途",
        reason: "明确标注的测试问题。",
        type: "single",
        options: ["展示作品", "介绍服务"],
        unit: "",
        placeholder: "",
      },
      {
        id: "content",
        title: "测试内容",
        reason: "明确标注的测试问题。",
        type: "multiple",
        options: ["项目", "文章", "联系方式"],
        unit: "",
        placeholder: "",
      },
      {
        id: "time",
        title: "测试时间",
        reason: "明确标注的测试问题。",
        type: "number",
        options: [],
        unit: "小时",
        placeholder: "填写数字",
      },
    ];
    const api = await fixtureApis(
      page,
      fixtureIntake({ status: "questions", round: 3, questions }),
    );
    await page.addInitScript(() =>
      localStorage.setItem("strategy-arena:intake-id", "fixture-intake"),
    );
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "再了解你一点。", exact: true })).toBeVisible();
    await runtimeCheckpoint(page, testInfo, "questions-unanswered");
    await activate(page.getByRole("radio", { name: "展示作品", exact: true }));
    await activate(page.getByRole("button", { name: "下一题", exact: true }));
    await activate(page.getByRole("checkbox", { name: "项目", exact: true }));
    await activate(page.getByRole("checkbox", { name: "文章", exact: true }));
    await activate(page.getByRole("button", { name: "下一题", exact: true }));
    await page.getByRole("spinbutton", { name: "测试时间", exact: false }).fill("3");
    await runtimeCheckpoint(page, testInfo, "questions-filled");
    await activate(page.getByRole("button", { name: "确认本轮回答并继续", exact: true }));
    await expect(
      page.getByRole("heading", { name: "这是我们理解的任务。", exact: true }),
    ).toBeVisible();
    await runtimeCheckpoint(page, testInfo, "summary");
    await activate(page.getByRole("button", { name: "预算、时间与备选方案", exact: true }));
    await expect(
      page.getByRole("spinbutton", { name: "可投入金额（人民币）", exact: true }),
    ).toBeVisible();
    await runtimeCheckpoint(page, testInfo, "summary-extra");
    await activate(page.getByRole("button", { name: "预算、时间与备选方案", exact: true }));
    expect(api.unexpected).toEqual([]);
  });
}

for (const width of [1440, 390]) {
  test(`explicit UI fixture: material pages, source previews and removal inventory at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const draft = fixtureIntake({
      attachments: [
        {
          id: "page-file",
          name: "explicit-page.pdf",
          size: 100,
          state: "needs_pages",
          pageCount: 21,
          imageCount: 0,
          interpreted: false,
          locations: [],
          warnings: [],
        },
        {
          id: "failed-file",
          name: "explicit-broken.pdf",
          size: 5,
          state: "failed",
          imageCount: 0,
          interpreted: false,
          locations: [],
          warnings: [],
          error: "明确测试替身：附件读取失败。",
        },
      ],
      sources: [
        {
          id: "local",
          attachmentId: "document",
          filename: "explicit-local.txt",
          location: "第 1 行",
          text: "明确测试替身：文档原文。",
          interpretation: false,
          origin: "document",
        },
        {
          id: "transcription",
          attachmentId: "scan",
          filename: "explicit-scan.pdf",
          location: "第 1 页",
          text: "明确测试替身：模型转录。",
          interpretation: false,
          origin: "model_transcription",
        },
        {
          id: "interpretation",
          attachmentId: "image",
          filename: "explicit-chart.png",
          location: "图片 1",
          text: "明确测试替身：模型解读。",
          interpretation: true,
          origin: "model_interpretation",
        },
      ],
    });
    const api = await fixtureApis(page, draft);
    await page.addInitScript(() =>
      localStorage.setItem("strategy-arena:intake-id", "fixture-intake"),
    );
    await page.goto("/");
    await expect(page.getByText("明确测试替身：附件读取失败。", { exact: false })).toBeVisible();
    await runtimeCheckpoint(page, testInfo, "attachments-pending-failed");
    await page.getByRole("textbox", { name: "explicit-page.pdf 的页码", exact: true }).fill("1");
    await activate(page.getByRole("button", { name: "读取所选页", exact: true }));
    await expect(page.getByRole("button", { name: "读取所选页", exact: true })).toHaveCount(0);
    await activate(page.getByRole("button", { name: /查看材料原文与位置/ }));
    await runtimeCheckpoint(page, testInfo, "sources-list");
    for (const [filename, text] of [
      ["explicit-local.txt", "明确测试替身：文档原文。"],
      ["explicit-scan.pdf", "明确测试替身：模型转录。"],
      ["explicit-chart.png", "明确测试替身：模型解读。"],
    ]) {
      await activate(page.getByRole("button", { name: new RegExp(filename) }));
      await expect(page.locator(".gi-source-preview")).toContainText(text);
      await runtimeCheckpoint(page, testInfo, `source-${filename.replaceAll(".", "-")}`);
    }
    await activate(page.getByRole("button", { name: "收起材料预览", exact: true }));
    await activate(page.getByRole("button", { name: "上传参考材料", exact: true }));
    await runtimeCheckpoint(page, testInfo, "attachment-file-picker-expanded");
    const choosingFile = page.waitForEvent("filechooser");
    await activate(page.getByRole("button", { name: "选择文件", exact: true }));
    const fileChooser = await choosingFile;
    await fileChooser.setFiles({
      name: "explicit-material.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("EXPLICIT TEST FILE"),
    });
    await expect(
      page.getByRole("button", { name: "移除 explicit-material.txt", exact: true }),
    ).toBeVisible();
    await runtimeCheckpoint(page, testInfo, "attachment-uploaded");
    await activate(page.getByRole("button", { name: "移除 explicit-material.txt", exact: true }));
    await expect(
      page.getByRole("button", { name: "移除 explicit-material.txt", exact: true }),
    ).toHaveCount(0);
    expect(api.unexpected).toEqual([]);
  });

  test(`explicit UI fixture: verification, version comparison and saved feedback inventory at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const snapshot = completedSnapshot();
    const parent = snapshot.versions[0];
    const next = {
      ...structuredClone(parent),
      id: "fixture-version-2",
      number: 2,
      parentVersionId: parent.id,
      challenge: { ...parent.challenge, budget: 150 },
      followUp: {
        sourceVersionId: parent.id,
        stepId: "fixture-step",
        quote: "明确测试替身：旧版原文。",
        text: "明确测试替身：用户补充。",
      },
    };
    snapshot.versions.push(next);
    snapshot.activeVersionId = next.id;
    const api = await fixtureApis(page, undefined, snapshot);
    await page.goto(`/?arena=${snapshot.id}`);
    await expect(
      page.getByRole("heading", { name: "测试裁决：先做最小样片", exact: true }),
    ).toBeVisible();
    await runtimeCheckpoint(page, testInfo, "legacy-result");
    await activate(page.getByRole("button", { name: "看完整结论", exact: true }));
    await runtimeCheckpoint(page, testInfo, "legacy-result-expanded");
    await activate(page.getByRole("button", { name: "收起结论", exact: true }));
    await activate(page.getByRole("button", { name: /测试质疑：尚未核算总投入/ }));
    const evidence = page.getByRole("dialog", { name: "这一条，站得住吗？", exact: true });
    await expect(evidence).toBeVisible();
    await runtimeCheckpoint(page, testInfo, "evidence-drawer");
    await activate(evidence.getByRole("button", { name: "关闭证据详情", exact: true }));
    await expect(evidence).toBeHidden();
    await activate(page.getByRole("button", { name: "快速复核", exact: true }));
    const review = page.getByRole("dialog", { name: "快速复核 · Decisions", exact: true });
    await activate(review.getByRole("button", { name: "用 Luna 快速复核", exact: true }));
    await expect(review.getByRole("button", { name: "展开判断分布", exact: true })).toBeVisible();
    await runtimeCheckpoint(page, testInfo, "review-result");
    await activate(review.getByRole("button", { name: "展开判断分布", exact: true }));
    await runtimeCheckpoint(page, testInfo, "review-distribution");
    await page.keyboard.press("Escape");
    await expect(review).toBeHidden();
    await activate(page.getByRole("button", { name: /对比上一版 V1 → V2/ }));
    const comparison = page.getByRole("dialog", { name: "版本变化 · V1 → V2", exact: true });
    await expect(comparison).toContainText("150");
    await runtimeCheckpoint(page, testInfo, "version-comparison");
    await page.keyboard.press("Escape");
    await expect(comparison).toBeHidden();
    await activate(page.getByRole("button", { name: "本次补充 · 查看原文与意见", exact: true }));
    const feedback = page.getByRole("dialog", { name: "本次补充", exact: true });
    await expect(feedback).toContainText("明确测试替身：用户补充。");
    await runtimeCheckpoint(page, testInfo, "version-feedback");
    await page.keyboard.press("Escape");
    await expect(feedback).toBeHidden();
    await page.getByLabel("选择推演版本", { exact: true }).selectOption(parent.id);
    await expect(page.getByRole("button", { name: /回到当前版本/ })).toBeVisible();
    await runtimeCheckpoint(page, testInfo, "historical-version");
    await activate(page.getByRole("button", { name: /回到当前版本/ }));
    await expect(page.getByLabel("选择推演版本", { exact: true })).toHaveValue(next.id);
    expect(api.unexpected).toEqual([]);
  });

  test(`explicit UI fixture: identity code, download, activation and failure feedback inventory at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const api = await fixtureApis(page);
    await page.goto("/");
    await activate(page.getByRole("button", { name: "我的历史", exact: true }));
    const history = page.getByRole("dialog", { name: "我的历史与恢复码", exact: true });
    await activate(history.getByRole("button", { name: "生成恢复码", exact: true }));
    await expect(history.getByLabel("本次新生成的恢复码", { exact: true })).toHaveValue(
      "explicit-synthetic-recovery-code-for-ui-only",
    );
    await runtimeCheckpoint(page, testInfo, "identity-code-generated");
    const downloading = page.waitForEvent("download");
    await activate(history.getByRole("button", { name: "下载保存", exact: true }));
    const download = await downloading;
    expect(download.suggestedFilename()).toContain("恢复码");
    await activate(history.getByRole("checkbox", { name: /我已保存新码/ }));
    await activate(history.getByRole("button", { name: "已保存，启用新码", exact: true }));
    await expect(
      history.getByText("新恢复码已启用。旧恢复码与其他设备的访问已失效。", { exact: true }),
    ).toBeVisible();
    await runtimeCheckpoint(page, testInfo, "identity-code-activated");
    await history
      .getByLabel("输入已保存的完整恢复码", { exact: true })
      .fill("explicit-invalid-recovery-fixture");
    await activate(history.getByRole("checkbox", { name: /我已保存当前身份的恢复码/ }));
    await activate(history.getByRole("button", { name: "恢复历史", exact: true }));
    await expect(history.getByRole("alert")).toContainText("明确测试替身：恢复码无效");
    await runtimeCheckpoint(page, testInfo, "identity-recovery-failed");
    await page.keyboard.press("Escape");
    await expect(history).toBeHidden();
    expect(api.unexpected).toEqual([]);
  });

  test(`normal interaction: physical press preserves the real control hit box at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const api = await fixtureApis(page);
    await page.goto("/");
    const button = page.getByRole("button", { name: "先看需求梳理示例", exact: true });
    await button.hover();
    await page.waitForTimeout(220);
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    const collecting = button.evaluate(
      (element) =>
        new Promise<
          Array<{ x: number; y: number; width: number; height: number; pressed: boolean }>
        >((resolve) => {
          const samples: Array<{
            x: number;
            y: number;
            width: number;
            height: number;
            pressed: boolean;
          }> = [];
          const began = performance.now();
          const tick = () => {
            const rect = element.getBoundingClientRect();
            samples.push({
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              pressed: (element as HTMLElement).dataset.motionPressed === "true",
            });
            if (performance.now() - began < 180) requestAnimationFrame(tick);
            else resolve(samples);
          };
          requestAnimationFrame(tick);
        }),
    );
    await page.mouse.down();
    await page.waitForTimeout(45);
    await page.mouse.up();
    const samples = await collecting;
    await testInfo.attach("physical-press-hit-box", {
      body: JSON.stringify({ box, samples }),
      contentType: "application/json",
    });
    expect(samples.some((sample) => sample.pressed)).toBe(true);
    for (const sample of samples) {
      expect(Math.abs(sample.x - box!.x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(sample.y - box!.y)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(sample.width - box!.width)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(sample.height - box!.height)).toBeLessThanOrEqual(0.5);
    }
    await expect(page.getByRole("dialog", { name: "先看需求梳理示例", exact: true })).toBeVisible();
    expect(api.unexpected).toEqual([]);
  });
}

for (const width of [1440, 390]) {
  test(`explicit UI fixture: legacy demo form disclosures and reversible options inventory at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const api = await fixtureApis(page);
    await page.route("**/api/health", (route) =>
      route.fulfill({
        json: {
          status: "ok",
          version: "demo",
          model: api.snapshot.model,
          accessGranted: true,
          requiresAccessCode: false,
        },
      }),
    );
    await page.goto("/");
    const form = page.locator("form.challenge-form");
    await expect(form).toBeVisible();
    await form
      .getByRole("textbox", { name: "你的目标、备选方案或想法", exact: true })
      .fill("【测试替身】仅登记兼容演示表单，不提交模型。");
    await activate(form.getByRole("button", { name: "内容创作", exact: true }));
    await activate(form.getByRole("button", { name: /说说你现在的处境/ }));
    await form
      .getByRole("textbox", { name: /^你现在的处境/ })
      .fill("【测试替身】材料仅用于表单交互。");
    await runtimeCheckpoint(page, testInfo, "legacy-situation-expanded");
    await activate(form.getByRole("button", { name: /说说你现在的处境/ }));
    await expect(form.getByRole("textbox", { name: /^你现在的处境/ })).toBeHidden();
    await activate(form.getByRole("button", { name: "添加备选方案、材料或预算", exact: false }));
    await activate(form.getByRole("button", { name: "添加一个选项", exact: true }));
    await activate(form.getByRole("button", { name: "添加一个选项", exact: true }));
    await form.getByRole("textbox", { name: "备选方案 1", exact: true }).fill("【测试替身】选项甲");
    await form.getByRole("textbox", { name: "备选方案 2", exact: true }).fill("【测试替身】选项乙");
    await activate(form.getByRole("button", { name: "删除备选方案 1", exact: true }));
    await expect(form.getByRole("textbox", { name: "备选方案 1", exact: true })).toHaveValue(
      "【测试替身】选项乙",
    );
    await form.getByRole("textbox", { name: /^参考材料/ }).fill("【测试替身】原始材料。");
    await form.getByRole("spinbutton", { name: /^预算上限/ }).fill("100");
    await form.getByRole("spinbutton", { name: /^可投入时间/ }).fill("2");
    await runtimeCheckpoint(page, testInfo, "legacy-details-expanded");
    await activate(form.getByRole("button", { name: "收起补充信息", exact: false }));
    await activate(form.getByRole("button", { name: "添加备选方案、材料或预算", exact: false }));
    await expect(form.getByRole("textbox", { name: "备选方案 1", exact: true })).toHaveValue(
      "【测试替身】选项乙",
    );
    await runtimeCheckpoint(page, testInfo, "legacy-details-reopened");
    expect(api.calls.filter((call) => call.startsWith("POST"))).toEqual([]);
    expect(api.unexpected).toEqual([]);
  });

  test(`explicit UI fixture: history pagination and actual saved record openings inventory at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const draft = fixtureIntake({ goal: "【测试替身】可恢复的分页草稿" });
    const api = await fixtureApis(page, draft);
    const arenaHistory = {
      id: api.snapshot.id,
      goal: "【测试替身】分页中的原讨论",
      createdAt: api.snapshot.createdAt,
      activeVersionId: api.snapshot.activeVersionId,
      status: "completed",
      stage: "judge",
      versionCount: 1,
    };
    const paginatedReads: string[] = [];
    for (const kind of ["arenas", "intakes"] as const) {
      await page.route(new RegExp(`/api/${kind}\\?`), (route) => {
        const cursor = new URL(route.request().url()).searchParams.get("cursor");
        paginatedReads.push(`${kind}:${cursor ?? "first"}`);
        const item =
          kind === "arenas"
            ? arenaHistory
            : { id: draft.id, goal: draft.goal, updatedAt: draft.updatedAt, status: draft.status };
        return route.fulfill({
          json: cursor
            ? { items: [item], nextCursor: null }
            : { items: [], nextCursor: `explicit-${kind}-cursor` },
        });
      });
    }
    await page.goto("/");
    await activate(page.getByRole("button", { name: "我的历史", exact: true }));
    const history = page.getByRole("dialog", { name: "我的历史与恢复码", exact: true });
    await activate(history.getByRole("button", { name: "更多讨论", exact: true }));
    await activate(history.getByRole("button", { name: "更多草稿", exact: true }));
    await expect(history.getByRole("button", { name: "更多讨论", exact: true })).toHaveCount(0);
    await expect(history.getByRole("button", { name: "更多草稿", exact: true })).toHaveCount(0);
    await runtimeCheckpoint(page, testInfo, "history-pages-loaded");
    await activate(history.getByRole("button", { name: /【测试替身】分页中的原讨论/ }));
    await expect(history).toBeHidden();
    await expect(
      page.getByRole("button", { name: "查看路线 A 的详情", exact: true }),
    ).toBeVisible();
    await runtimeCheckpoint(page, testInfo, "history-arena-opened");
    await activate(page.getByRole("button", { name: "我的历史", exact: true }));
    await activate(history.getByRole("button", { name: "更多草稿", exact: true }));
    await activate(history.getByRole("button", { name: /【测试替身】可恢复的分页草稿/ }));
    await expect(history).toBeHidden();
    await expect(page.getByRole("textbox", { name: "你想做什么", exact: true })).toHaveValue(
      draft.goal,
    );
    await runtimeCheckpoint(page, testInfo, "history-intake-opened");
    expect(paginatedReads).toContain("arenas:explicit-arenas-cursor");
    expect(paginatedReads).toContain("intakes:explicit-intakes-cursor");
    expect(api.calls).toContain(`GET /api/arenas/${api.snapshot.id}`);
    expect(api.calls).toContain(`GET /api/intakes/${draft.id}`);
    expect(api.unexpected).toEqual([]);
  });

  test(`explicit UI fixture: summary conflict choices and failed save retry inventory at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    let draft = fixtureIntake({
      status: "summary",
      revision: 5,
      challenge: { ...structuredClone(fixtureChallenge), constraints: "【测试替身】服务器限制。" },
      assumptions: ["【测试替身】保留的假设。"],
    });
    const api = await fixtureApis(page, draft);
    let rejectNextSave = false;
    let failedSaves = 0;
    let successfulSaves = 0;
    await page.route(`**/api/intakes/${draft.id}`, async (route) => {
      if (route.request().method() === "PATCH") {
        if (rejectNextSave) {
          rejectNextSave = false;
          failedSaves++;
          return route.fulfill({
            status: 503,
            json: { error: "明确测试替身：摘要保存暂时失败。" },
          });
        }
        const { summary } = route.request().postDataJSON();
        expect(summary).toBeDefined();
        successfulSaves++;
        draft = { ...draft, revision: draft.revision + 1, ...summary };
      }
      return route.fulfill({ json: draft });
    });
    const local = {
      draftId: draft.id,
      baseRevision: 4,
      challenge: { ...draft.challenge!, constraints: "【测试替身】本机待恢复限制。" },
      assumptions: draft.assumptions,
      updatedAt: "2026-11-14T00:00:00.000Z",
    };
    await page.addInitScript(
      ({ id, journal }) => {
        localStorage.setItem("strategy-arena:intake-id", id);
        if (!sessionStorage.getItem("explicit-summary-conflict-seeded")) {
          sessionStorage.setItem("explicit-summary-conflict-seeded", "true");
          sessionStorage.setItem("strategy-arena:intake-tab-summary", JSON.stringify(journal));
        }
      },
      { id: draft.id, journal: local },
    );
    await page.goto("/");
    const conflict = page.getByRole("alert").filter({ hasText: "本机还有尚未保存的摘要修改。" });
    await expect(conflict).toBeVisible();
    await expect(page.getByLabel("摘要修改差异", { exact: true })).toContainText(
      "【测试替身】本机待恢复限制。",
    );
    await expect(page.getByLabel("摘要修改差异", { exact: true })).toContainText(
      "【测试替身】服务器限制。",
    );
    await runtimeCheckpoint(page, testInfo, "summary-conflict-compared");
    await activate(page.getByRole("button", { name: "恢复本机未保存的修改", exact: true }));
    await expect(
      page.getByRole("status").filter({ hasText: "摘要草稿已保存，提交后确认" }),
    ).toBeVisible();
    expect(draft.challenge?.constraints).toBe(local.challenge.constraints);
    await runtimeCheckpoint(page, testInfo, "summary-local-restored");
    draft = {
      ...draft,
      revision: draft.revision + 1,
      challenge: { ...draft.challenge!, constraints: "【测试替身】更新后的服务器限制。" },
    };
    await page.evaluate(
      (journal) => {
        sessionStorage.setItem("strategy-arena:intake-tab-summary", JSON.stringify(journal));
      },
      { ...local, baseRevision: draft.revision - 1 },
    );
    await page.reload();
    await expect(conflict).toBeVisible();
    await activate(page.getByRole("button", { name: "保留服务器版本", exact: true }));
    await expect(conflict).toBeHidden();
    const constraints = page.getByRole("textbox", { name: "必须满足的限制", exact: true });
    await expect(constraints).toHaveValue("【测试替身】更新后的服务器限制。");
    await runtimeCheckpoint(page, testInfo, "summary-server-retained");
    rejectNextSave = true;
    await constraints.fill("【测试替身】失败后仍需保留的编辑。");
    await expect(page.getByRole("button", { name: "重试保存摘要", exact: true })).toBeVisible();
    await expect(constraints).toHaveValue("【测试替身】失败后仍需保留的编辑。");
    await runtimeCheckpoint(page, testInfo, "summary-save-failed");
    await activate(page.getByRole("button", { name: "重试保存摘要", exact: true }));
    await expect(
      page.getByRole("status").filter({ hasText: "摘要草稿已保存，提交后确认" }),
    ).toBeVisible();
    expect(draft.challenge?.constraints).toBe("【测试替身】失败后仍需保留的编辑。");
    expect(failedSaves).toBe(1);
    expect(successfulSaves).toBe(2);
    await runtimeCheckpoint(page, testInfo, "summary-save-retried");
    expect(api.unexpected).toEqual([]);
  });

  test(`explicit UI fixture: live conditions, editable ideas and submit failure inventory at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const api = await fixtureApis(page);
    await page.route("**/api/arenas/*/versions", (route) =>
      route.fulfill({ status: 503, json: { error: "明确测试替身：提交暂时失败，输入继续保留。" } }),
    );
    await page.goto(`/?arena=${api.snapshot.id}`);
    await activate(page.getByRole("button", { name: "调整条件", exact: true }));
    const dialog = page.getByRole("dialog", { name: "调整条件", exact: true });
    await dialog.getByRole("spinbutton", { name: "预算上限", exact: false }).fill("150");
    for (const [button, role, label, value] of [
      ["时间", "spinbutton", "可投入时间", "3"],
      ["限制", "textbox", "硬性限制", "【测试替身】保留现有前端"],
      ["偏好", "textbox", "更看重什么", "【测试替身】清晰易读"],
    ] as const) {
      await activate(dialog.getByRole("button", { name: button, exact: true }));
      await dialog.getByRole(role, { name: label, exact: false }).fill(value);
      await runtimeCheckpoint(page, testInfo, `condition-${button}`);
    }
    await activate(dialog.getByRole("button", { name: /^完整编辑/ }));
    await activate(dialog.getByRole("button", { name: "添加一个选项", exact: true }));
    await activate(dialog.getByRole("button", { name: "添加一个选项", exact: true }));
    await dialog
      .getByRole("textbox", { name: "备选方案 1", exact: true })
      .fill("【测试替身】已有想法一");
    await activate(dialog.getByRole("button", { name: "删除备选方案 2", exact: true }));
    await activate(dialog.getByRole("button", { name: "添加一个选项", exact: true }));
    await dialog
      .getByRole("textbox", { name: "备选方案 2", exact: true })
      .fill("【测试替身】已有想法二");
    await activate(dialog.getByRole("button", { name: "不限领域", exact: true }));
    await activate(dialog.getByRole("button", { name: /^补充说明/ }));
    await dialog
      .getByRole("textbox", { name: "补充说明", exact: false })
      .fill("【测试替身】仅检查交互状态。");
    await activate(dialog.getByRole("button", { name: "展开改动", exact: true }));
    await runtimeCheckpoint(page, testInfo, "condition-changes");
    await activate(dialog.getByRole("button", { name: "按新条件重新推演", exact: true }));
    await expect(dialog.getByRole("alert")).toContainText(
      "明确测试替身：提交暂时失败，输入继续保留。",
    );
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "备选方案 1", exact: true })).toHaveValue(
      "【测试替身】已有想法一",
    );
    await runtimeCheckpoint(page, testInfo, "condition-submit-failed");
    await activate(dialog.getByRole("button", { name: "取消", exact: true }));
    await expect(dialog).toBeHidden();
    expect(api.unexpected).toEqual([]);
  });

  test(`explicit UI fixture: claim challenge and model information inventory at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const api = await fixtureApis(page);
    await page.goto(`/?arena=${api.snapshot.id}`);
    await activate(page.getByRole("button", { name: "查看路线 A 的详情", exact: true }));
    const detail = page.getByRole("dialog", { name: /^第 \d+ 步 ·/ });
    await expect(detail).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(detail).toBeHidden();
    await activate(page.locator('[data-board="A"] button[title="质疑这条判断"]').first());
    const challenge = page.getByRole("dialog", { name: "质疑这条判断", exact: true });
    await expect(challenge).toBeVisible();
    await runtimeCheckpoint(page, testInfo, "claim-challenge");
    await activate(challenge.getByRole("button", { name: "查看原文", exact: true }));
    await challenge
      .getByRole("textbox", { name: "你认为哪里有问题？", exact: true })
      .fill("【测试替身】暂存质疑文字，保留原始判断。");
    await runtimeCheckpoint(page, testInfo, "claim-original");
    await page.keyboard.press("Escape");
    await expect(challenge).toBeHidden();
    await activate(page.getByRole("button", { name: "真实模型推演", exact: true }));
    const info = page.getByRole("dialog", { name: "模型与运行信息", exact: true });
    await expect(info).toBeVisible();
    await runtimeCheckpoint(page, testInfo, "model-information");
    await page.keyboard.press("Escape");
    await expect(info).toBeHidden();
    expect(api.unexpected).toEqual([]);
  });

  test(`explicit UI fixture: authorization, unknown, skip and restored answer inventory at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const questions: IntakeQuestion[] = [
      {
        id: "authorization",
        title: "测试单项授权",
        reason: "明确标注的测试问题。",
        authorization: "仅本轮的公开资料整理",
        type: "single",
        options: ["授权这一项", "本人决定"],
        unit: "",
        placeholder: "",
      },
      {
        id: "content-text",
        title: "测试文字内容",
        reason: "明确标注的测试问题。",
        type: "text",
        options: [],
        unit: "",
        placeholder: "请填写内容",
      },
      {
        id: "time-skip",
        title: "测试未知时间",
        reason: "明确标注的测试问题。",
        type: "number",
        options: [],
        unit: "小时",
        placeholder: "填写数字",
      },
    ];
    const api = await fixtureApis(
      page,
      fixtureIntake({ status: "questions", round: 4, questions }),
    );
    await page.addInitScript(() =>
      localStorage.setItem("strategy-arena:intake-id", "fixture-intake"),
    );
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "再了解你一点。", exact: true })).toBeVisible();
    await activate(page.getByRole("radio", { name: "授权这一项", exact: true }));
    await activate(page.getByRole("button", { name: "下一题", exact: true }));
    const text = page.locator('[data-question-id="content-text"]');
    await text
      .getByRole("textbox", { name: "测试文字内容", exact: true })
      .fill("【测试替身】先填写再暂缓，检查可逆展开。");
    await activate(text.getByRole("button", { name: "暂时不知道", exact: true }));
    await expect(text.getByRole("button", { name: "暂时不知道", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await runtimeCheckpoint(page, testInfo, "question-unknown");
    await activate(text.getByRole("button", { name: "我来补充", exact: true }));
    await expect(text.getByRole("textbox", { name: "测试文字内容", exact: true })).toHaveValue(
      "【测试替身】先填写再暂缓，检查可逆展开。",
    );
    await activate(page.getByRole("button", { name: "下一题", exact: true }));
    await activate(
      page
        .locator('[data-question-id="time-skip"]')
        .getByRole("button", { name: "跳过", exact: true }),
    );
    await runtimeCheckpoint(page, testInfo, "question-skipped");
    await page.reload();
    await expect(page.getByRole("radio", { name: "授权这一项", exact: true })).toBeChecked();
    await activate(page.getByRole("button", { name: "下一题", exact: true }));
    await activate(page.getByRole("button", { name: "下一题", exact: true }));
    await expect(
      page
        .locator('[data-question-id="time-skip"]')
        .getByRole("button", { name: "跳过", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await runtimeCheckpoint(page, testInfo, "question-refreshed");
    expect(api.unexpected).toEqual([]);
  });

  test(`explicit UI fixture: paused uncertain draft and retained materials inventory at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const draft = fixtureIntake({
      status: "uncertain",
      revision: 5,
      reservedUsd: 0.07,
      error: "明确测试替身：调用完成状态待核对。",
      sources: [
        {
          id: "retained",
          attachmentId: "retained-file",
          filename: "explicit-retained.txt",
          location: "第 1 行",
          text: "明确测试替身：已保存材料。",
          interpretation: false,
          origin: "document",
        },
      ],
    });
    const api = await fixtureApis(page, draft);
    await page.addInitScript(() =>
      localStorage.setItem("strategy-arena:intake-id", "fixture-intake"),
    );
    await page.goto("/");
    const recovery = page.getByRole("region", { name: "分析暂停", exact: true });
    await expect(recovery).toBeVisible();
    await activate(recovery.getByRole("button", { name: "查看调用与费用说明", exact: true }));
    await runtimeCheckpoint(page, testInfo, "uncertain-call-details");
    await expect(page.getByRole("button", { name: "开始梳理", exact: true })).toBeDisabled();
    await activate(page.getByRole("button", { name: /查看材料原文与位置/ }));
    await activate(page.getByRole("button", { name: /explicit-retained.txt/ }));
    await expect(page.locator(".gi-source-preview")).toContainText("明确测试替身：已保存材料。");
    await runtimeCheckpoint(page, testInfo, "uncertain-retained-material");
    await activate(recovery.getByRole("button", { name: "收起调用与费用说明", exact: true }));
    expect(api.calls.filter((call) => call.startsWith("POST"))).toEqual([]);
    expect(api.unexpected).toEqual([]);
  });

  test(`explicit UI fixture: access gate failure and successful admission inventory at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const api = await fixtureApis(page);
    let admitted = false;
    await page.route("**/api/health", (route) =>
      route.fulfill({
        json: {
          status: "ok",
          version: "explicit-access-fixture",
          requiresAccessCode: true,
          accessGranted: admitted,
          model: api.snapshot.model,
        },
      }),
    );
    await page.route("**/api/access", (route) => {
      admitted = route.request().postDataJSON().code === "explicit-good-fixture-code";
      return route.fulfill({
        status: admitted ? 200 : 401,
        json: admitted ? { ok: true } : { error: "明确测试替身：访问码无效。" },
      });
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "凭码入场", exact: true })).toBeVisible();
    await runtimeCheckpoint(page, testInfo, "access-ticket");
    await page.getByLabel("访问码", { exact: true }).fill("explicit-bad-fixture-code");
    await activate(page.getByRole("button", { name: "验证访问码", exact: true }));
    await expect(page.locator(".access-gate-error")).toContainText("明确测试替身：访问码无效。");
    await runtimeCheckpoint(page, testInfo, "access-failed");
    await page.getByLabel("访问码", { exact: true }).fill("explicit-good-fixture-code");
    await activate(page.getByRole("button", { name: "验证访问码", exact: true }));
    await expect(page.locator(".access-gate")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "你想做什么", exact: true })).toBeEnabled();
    await runtimeCheckpoint(page, testInfo, "access-admitted");
    expect(api.unexpected).toEqual([]);
  });

  test(`explicit UI fixture: interrupted running request, refresh and stop confirmation inventory at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const snapshot = completedSnapshot();
    const version = snapshot.versions[0];
    version.status = "running";
    version.stage = "revise";
    version.verdict = null;
    const api = await fixtureApis(page, undefined, snapshot);
    await page.route("**/api/arenas/*/advance", (route) =>
      route.fulfill({ status: 503, json: { error: "明确测试替身：推进请求暂时失败。" } }),
    );
    await page.route("**/api/arenas/*/stop", (route) => {
      version.status = "paused";
      return route.fulfill({ json: snapshot });
    });
    await page.goto(`/?arena=${snapshot.id}`);
    await expect(page.getByRole("button", { name: "继续推进", exact: true })).toBeVisible();
    await runtimeCheckpoint(page, testInfo, "advance-failed");
    await activate(page.getByRole("button", { name: "关闭错误提示", exact: true }));
    await activate(page.getByRole("button", { name: "继续推进", exact: true }));
    await expect(page.getByRole("button", { name: "关闭错误提示", exact: true })).toBeVisible();
    await activate(page.getByRole("button", { name: "刷新状态", exact: true }).first());
    await activate(page.getByRole("button", { name: "现在收束", exact: true }));
    const stop = page.getByRole("dialog", { name: "停止本轮推演？", exact: true });
    await expect(stop).toBeVisible();
    await runtimeCheckpoint(page, testInfo, "stop-confirmation");
    await activate(stop.getByRole("button", { name: "继续推演", exact: true }));
    await expect(stop).toBeHidden();
    await activate(page.getByRole("button", { name: "现在收束", exact: true }));
    await activate(stop.getByRole("button", { name: "确认停止", exact: true }));
    await expect(stop).toBeHidden();
    await expect(page.getByText("本轮已停止", { exact: true })).toBeVisible();
    await runtimeCheckpoint(page, testInfo, "run-paused");
    expect(api.unexpected).toEqual([]);
  });
}
