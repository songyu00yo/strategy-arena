// Provider APIs use explicit fixtures and source-link navigation is intercepted.
// The attachment scenario uploads and downloads marked test material in the isolated acceptance database.
// Trusted mouse/keyboard records establish operated entries, separately from motion acceptance.
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { ArenaVersion } from "../../src/lib/contracts";
import type { IntakeDraft } from "../../src/lib/intake-contracts";
import { configureFixtureModels, fixtureIntake } from "./intake.fixture";
import { advanceFixture, fixtureChallenge, fixtureSnapshot } from "./ui.fixture";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    const records: unknown[] = [];
    Object.assign(window, { __remainingInteractionLog: records });
    const textWithoutValues = (element: Element) => {
      const copy = element.cloneNode(true) as Element;
      copy.querySelectorAll("input,textarea,select").forEach((node) => node.remove());
      return copy.textContent ?? "";
    };
    for (const type of ["click", "input", "change", "keydown", "focusin", "drop"]) {
      document.addEventListener(
        type,
        (event) => {
          if (!(event.target instanceof Element)) return;
          const target = event.target.closest<HTMLElement>(
            'button,a[href],input,textarea,select,summary,[role="button"],[role="option"],[tabindex]',
          );
          if (!target || target.closest('[inert],[aria-hidden="true"]')) return;
          const labels =
            "labels" in target
              ? [...((target as HTMLInputElement).labels ?? [])].map(textWithoutValues).join(" ")
              : "";
          const labelled = (target.getAttribute("aria-labelledby") ?? "")
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ");
          const name =
            target.getAttribute("aria-label") ||
            labelled.trim() ||
            labels.trim() ||
            target.getAttribute("title") ||
            target.getAttribute("placeholder") ||
            textWithoutValues(target);
          const dialog = target.closest('[role="dialog"],dialog');
          const ancestry: string[] = [];
          for (
            let node: Element | null = target;
            node && ancestry.length < 5;
            node = node.parentElement
          ) {
            ancestry.push(`${node.tagName.toLowerCase()}.${[...node.classList].join(".")}`);
          }
          records.push({
            type,
            trusted: event.isTrusted,
            key: event instanceof KeyboardEvent ? event.key : null,
            tag: target.tagName.toLowerCase(),
            name: name.replace(/\s+/g, " ").trim().slice(0, 240),
            dialog:
              dialog?.getAttribute("aria-label") ||
              (dialog?.getAttribute("aria-labelledby") ?? "")
                .split(/\s+/)
                .map((id) => document.getElementById(id)?.textContent ?? "")
                .join(" ") ||
              null,
            ancestry,
          });
        },
        true,
      );
    }
  });
});

test.afterEach(async ({ page }, testInfo) => {
  if (page.isClosed()) return;
  await testInfo.attach("executed-inputs", {
    body: JSON.stringify({
      scenarioStatus: testInfo.status,
      verification: "trusted-inputs-with-passing-scenario-required",
      nativeInputs: await page.evaluate(
        () =>
          (window as unknown as { __remainingInteractionLog: unknown[] })
            .__remainingInteractionLog ?? [],
      ),
    }),
    contentType: "application/json",
  });
});

async function click(control: Locator, keyboard = false) {
  await expect(control).toBeVisible();
  await expect(control).toBeEnabled();
  if (keyboard) {
    await control.focus();
    await control.press("Enter");
  } else await control.click();
}

async function checkpoint(page: Page, info: TestInfo, state: string) {
  const controls = await page
    .locator('button,a[href],input,textarea,select,summary,[role="button"]')
    .evaluateAll((elements) =>
      elements.flatMap((element) => {
        const box = element.getBoundingClientRect();
        if (!box.width || !box.height || element.closest('[inert],[aria-hidden="true"]')) return [];
        return [
          {
            tag: element.tagName.toLowerCase(),
            name:
              element.getAttribute("aria-label") ||
              element.getAttribute("title") ||
              element.textContent?.replace(/\s+/g, " ").slice(0, 160),
            disabled: element.matches(":disabled"),
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
          },
        ];
      }),
    );
  const nativeInputs = await page.evaluate(
    () =>
      (window as unknown as { __remainingInteractionLog: unknown[] }).__remainingInteractionLog ??
      [],
  );
  await info.attach(`runtime-controls-${state}`, {
    body: JSON.stringify({ state, controls, nativeInputs, verification: "runtime-discovery-only" }),
    contentType: "application/json",
  });
  await page.screenshot({ path: info.outputPath(`${state}.png`) });
}

function completed() {
  const snapshot = configureFixtureModels(fixtureSnapshot());
  for (let index = 0; index < 5; index++) advanceFixture(snapshot);
  return snapshot;
}

async function fixtures(page: Page, snapshot = completed(), initialDraft = fixtureIntake()) {
  const state = {
    snapshot,
    draft: initialDraft,
    calls: [] as string[],
    unexpected: [] as string[],
  };
  const addVersion = (body: Record<string, unknown>) => {
    const parent = state.snapshot.versions.at(-1)!;
    const next: ArenaVersion = {
      ...structuredClone(parent),
      id: `fixture-version-${parent.number + 1}`,
      number: parent.number + 1,
      parentVersionId: parent.id,
      status: "completed",
      stage: "judge",
      challenge: (body.challenge as ArenaVersion["challenge"]) ?? parent.challenge,
      changeReason: (body.changeReason as string) || "【测试替身】收到用户补充。",
      ...(body.followUp
        ? {
            followUp: {
              ...(body.followUp as NonNullable<ArenaVersion["followUp"]>),
              sourceVersionId: parent.id,
            },
          }
        : {}),
    };
    if (next.verdict) next.verdict.headline = `【测试替身】第 ${next.number} 版已保存`;
    parent.status = "superseded";
    state.snapshot.versions.push(next);
    state.snapshot.activeVersionId = next.id;
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    state.calls.push(`${method} ${path}`);
    if (path === "/api/health")
      return route.fulfill({
        json: {
          status: "ok",
          version: "explicit-remaining-fixture",
          model: state.snapshot.model,
          accessGranted: true,
          requiresAccessCode: false,
        },
      });
    if (path === "/api/identity")
      return route.fulfill({ json: { identityTag: "c".repeat(64), hasRecoveryCode: false } });
    if (path.endsWith("/events"))
      return route.fulfill({ contentType: "text/event-stream", body: ": explicit fixture\n\n" });
    if (path === "/api/arenas" && method === "GET")
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === "/api/arenas" && method === "POST")
      return route.fulfill({ status: 201, json: state.snapshot });
    if (path === `/api/arenas/${state.snapshot.id}`) return route.fulfill({ json: state.snapshot });
    if (path.endsWith("/versions") || path.endsWith("/interventions")) {
      addVersion(request.postDataJSON());
      return route.fulfill({ status: 201, json: state.snapshot });
    }
    if (path.endsWith("/advance")) return route.fulfill({ json: state.snapshot });
    if (path === "/api/intakes" && method === "GET")
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === "/api/intakes" && method === "POST") {
      state.draft = fixtureIntake({ id: state.draft.id, goal: request.postDataJSON().goal });
      return route.fulfill({ status: 201, json: state.draft });
    }
    if (path === `/api/intakes/${state.draft.id}`) {
      if (method === "PATCH") {
        const { summary, ...fields } = request.postDataJSON();
        state.draft = { ...state.draft, ...fields, ...summary, revision: state.draft.revision + 1 };
      }
      return route.fulfill({ json: state.draft });
    }
    if (path.endsWith("/analyze")) {
      state.draft = {
        ...state.draft,
        status: "summary",
        questions: [],
        revision: state.draft.revision + 1,
        challenge: { ...fixtureChallenge, goal: state.draft.goal },
      };
      return route.fulfill({ json: state.draft });
    }
    if (path.endsWith("/submit")) {
      const body = request.postDataJSON();
      state.snapshot.versions[0].challenge = body.challenge;
      state.snapshot.versions[0].intake = {
        id: state.draft.id,
        originalGoal: state.draft.goal,
        answers: [],
        assumptions: body.assumptions,
        usedSources: state.draft.sources,
        usage: [],
      };
      state.draft = { ...state.draft, status: "submitted", arenaId: state.snapshot.id };
      return route.fulfill({ status: 201, json: state.snapshot });
    }
    if (method === "GET" && path.startsWith(`/api/intakes/${state.draft.id}/attachments/`))
      return route.continue();
    state.unexpected.push(`${method} ${path}`);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected API blocked by explicit fixture." },
    });
  });
  return state;
}

for (const width of [1440, 390]) {
  test(`explicit remaining fixture: four condition shortcuts, field edits and version selection at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const snapshot = completed();
    const next = {
      ...structuredClone(snapshot.versions[0]),
      id: "fixture-version-2",
      number: 2,
      parentVersionId: snapshot.versions[0].id,
    };
    snapshot.versions.push(next);
    snapshot.activeVersionId = next.id;
    const api = await fixtures(page, snapshot);
    await page.goto(`/?arena=${snapshot.id}`);
    for (const name of [/^硬性限制 /, /^偏好 /, /^预算上限 /, /^可用时间 /]) {
      await click(page.getByRole("button", { name }));
      const dialog = page.getByRole("dialog", { name: "调整条件", exact: true });
      await expect(dialog).toBeVisible();
      await checkpoint(
        page,
        info,
        `condition-shortcut-${String(name).replace(/[^a-z\u4e00-\u9fff]/g, "")}`,
      );
      await click(dialog.getByRole("button", { name: "取消", exact: true }));
      await expect(dialog).toBeHidden();
    }
    await click(page.getByRole("button", { name: "调整条件", exact: true }));
    const dialog = page.getByRole("dialog", { name: "调整条件", exact: true });
    await click(dialog.getByRole("button", { name: "预算", exact: true }));
    await click(dialog.getByRole("button", { name: /^完整编辑/ }));
    await dialog
      .getByRole("textbox", { name: "目标", exact: true })
      .fill("【测试替身】编辑完整目标并保留条件。");
    await dialog.getByRole("textbox", { name: /^参考材料/ }).fill("【测试替身】编辑后的原文材料。");
    await click(dialog.getByRole("button", { name: "展开改动", exact: true }));
    await click(dialog.getByRole("button", { name: "收起改动", exact: true }));
    await click(dialog.getByRole("button", { name: "取消", exact: true }));
    await expect(dialog).toBeHidden();
    const select = page.getByRole("combobox", { name: "选择推演版本", exact: true });
    await click(select);
    await select.press("ArrowUp");
    await select.press("Enter");
    // macOS headless Chromium also ignores these native-select keys on a standalone static page.
    // Keep trusted key delivery evidence and mark native menu selection for headed verification.
    await select.selectOption(snapshot.versions[0].id);
    await expect(select).toHaveValue(snapshot.versions[0].id);
    await click(select);
    await select.press("ArrowDown");
    await select.press("Enter");
    await select.selectOption(next.id);
    await expect(select).toHaveValue(next.id);
    await info.attach("native-selection-limitation", {
      body: JSON.stringify({
        nativeKeyDelivery: "observed",
        nativeMenuOutcome: "pending-headed-chrome",
        businessSelectionMethod: "Playwright selectOption",
        countedAsNativeSelectionPass: false,
      }),
      contentType: "application/json",
    });
    await checkpoint(page, info, "version-selection-business-binding");
    expect(api.unexpected).toEqual([]);
  });

  test(`explicit remaining fixture: original material download, evidence source and locate return at ${width}px`, async ({
    page,
    context,
    baseURL,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const origin = new URL(baseURL!).origin;
    const headers = { Origin: origin };
    // Only the isolated acceptance server uses this standard test access code. No model operation follows.
    const access = await page.request.post("/api/access", {
      headers,
      data: { code: "e2e-only-access-code" },
    });
    expect(access.ok()).toBe(true);
    const created = await page.request.post("/api/intakes", {
      headers,
      data: { goal: "【测试替身】隔离附件下载验收材料", modelMode: "gpt-6.1-terra" },
    });
    expect(created.status()).toBe(201);
    const createdDraft = (await created.json()) as IntakeDraft;
    const uploaded = await page.request.post(`/api/intakes/${createdDraft.id}/attachments`, {
      headers,
      multipart: {
        file: {
          name: "explicit-source.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("EXPLICIT SYNTHETIC DOWNLOAD"),
        },
      },
    });
    expect(uploaded.status()).toBe(201);
    const downloadedDraft = (await uploaded.json()) as IntakeDraft;
    const file = downloadedDraft.attachments[0];
    const snapshot = completed();
    const version = snapshot.versions[0];
    version.intake = {
      id: downloadedDraft.id,
      originalGoal: version.challenge.goal,
      answers: [],
      assumptions: [],
      usage: [],
      usedSources: [
        {
          id: "source",
          attachmentId: file.id,
          filename: "explicit-source.txt",
          location: "第 1 行",
          text: "【测试替身】仅验证材料展开和附件下载。",
          interpretation: false,
          origin: "document",
        },
      ],
    };
    version.evidence[0].source = "https://example.test/explicit-evidence";
    const api = await fixtures(page, snapshot, downloadedDraft);
    await context.route("https://example.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<title>Explicit fixture source</title><p>EXPLICIT TEST SOURCE</p>",
      }),
    );
    await page.goto(`/?arena=${snapshot.id}`);
    await click(page.getByRole("button", { name: "查看补充回答与材料", exact: true }));
    await click(page.getByRole("button", { name: "explicit-source.txt · 第 1 行", exact: true }));
    const downloading = page.waitForEvent("download");
    await click(page.getByRole("link", { name: "下载原附件", exact: true }));
    const download = await downloading;
    const downloadedPath = info.outputPath("downloaded-explicit-source.txt");
    await download.saveAs(downloadedPath);
    expect(download.suggestedFilename()).toBe("explicit-source.txt");
    expect(await readFile(downloadedPath, "utf8")).toBe("EXPLICIT SYNTHETIC DOWNLOAD");
    await info.attach("isolated-attachment-provenance", {
      body: JSON.stringify({
        draftId: downloadedDraft.id,
        attachmentId: file.id,
        classification: "explicit-test-material-in-isolated-sqlite",
        modelCalls: 0,
      }),
      contentType: "application/json",
    });
    await checkpoint(page, info, "material-original-downloaded");
    await click(page.getByRole("button", { name: "explicit-source.txt · 第 1 行", exact: true }));
    await click(page.getByRole("button", { name: "收起补充回答与材料", exact: true }));
    await click(page.locator('button[title="查看这条质疑的证据"]').first());
    const evidence = page.getByRole("dialog", { name: "这一条，站得住吗？", exact: true });
    const popup = page.waitForEvent("popup");
    await click(
      evidence.getByRole("link", { name: "https://example.test/explicit-evidence", exact: true }),
    );
    const source = await popup;
    await expect(source).toHaveTitle("Explicit fixture source");
    await source.close();
    await click(evidence.getByRole("button", { name: "在路线 A 中定位", exact: true }));
    await expect(evidence).toBeHidden();
    await expect(page.locator('[data-board="A"] .c-claim').first()).toHaveClass(/located/);
    await checkpoint(page, info, "evidence-located-back-in-role");
    expect(api.unexpected).toEqual([]);
  });

  test(`explicit remaining fixture: agent archived records and live supplement and claim submissions at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const snapshot = completed();
    snapshot.versions[0].agent = {
      protocol: "bounded-agent-1.3",
      limits: { modelRequests: 20, tools: 12, externalTools: 6, plans: 3, rounds: 2 },
      plans: [
        {
          summary: "【测试替身】可展开的原审查记录。",
          questions: ["【测试替身】未决项。"],
          directions: [],
          tools: [],
          next: "judge",
          reviseRoles: [],
          stopCondition: "【测试替身】保持人工确认。",
          checkpoint: 1,
          evidenceHash: "explicit-fixture",
        },
      ],
      actions: [
        {
          id: "explicit-action",
          kind: "plan",
          role: "agent",
          round: 1,
          dependencies: [],
          status: "completed",
        },
      ],
      toolsUsed: 0,
      externalToolsUsed: 0,
    };
    snapshot.drafts = [
      {
        stepId: "explicit-interrupted",
        versionId: snapshot.activeVersionId,
        stage: "propose",
        role: "A",
        revision: 1,
        status: "interrupted",
        fields: { summary: "【测试替身】生成中断保留的文字。" },
      },
    ];
    const api = await fixtures(page, snapshot);
    await page.goto(`/?arena=${snapshot.id}`);
    await click(page.getByRole("button", { name: "看规划", exact: true }));
    await expect(page.locator(".agent-progress")).toContainText("【测试替身】可展开的原审查记录。");
    await click(page.getByRole("button", { name: "收起规划", exact: true }));
    await click(page.locator(".agent-drafts summary"));
    await expect(page.locator(".agent-drafts details")).toHaveAttribute("open", "");
    await checkpoint(page, info, "agent-interrupted-record-expanded");
    await click(page.locator(".agent-drafts summary"));
    await expect(page.locator(".agent-drafts details")).not.toHaveAttribute("open");
    await click(page.getByRole("button", { name: "查看路线 A 的详情", exact: true }));
    const detail = page.getByRole("dialog", { name: /^第 \d+ 步 ·/ });
    await click(detail.getByRole("button", { name: "上一步", exact: true }));
    await click(detail.getByRole("button", { name: "下一步", exact: true }));
    await click(detail.getByRole("button", { name: "补充或质疑", exact: true }));
    const follow = page.getByRole("dialog", { name: "补充这一步", exact: true });
    await click(follow.getByRole("button", { name: "查看原文", exact: true }));
    await click(follow.getByRole("button", { name: "收起原文", exact: true }));
    await follow
      .getByRole("textbox", { name: "补充或质疑", exact: true })
      .fill("【测试替身】请补充已有材料中的执行限制。");
    await checkpoint(page, info, "live-supplement-ready");
    await click(follow.getByRole("button", { name: "补充后重新推演", exact: true }));
    await expect(follow).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "【测试替身】第 2 版已保存", exact: true }),
    ).toBeVisible();
    await click(page.locator('[data-board="A"] button[title="质疑这条判断"]').first());
    const claim = page.getByRole("dialog", { name: "质疑这条判断", exact: true });
    await claim
      .getByRole("textbox", { name: "你认为哪里有问题？", exact: true })
      .fill("【测试替身】请核对原文与最终要求的一致性。");
    await click(claim.getByRole("button", { name: "提交质疑", exact: true }));
    await expect(claim).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "【测试替身】第 3 版已保存", exact: true }),
    ).toBeVisible();
    await checkpoint(page, info, "live-submissions-new-versions");
    expect(
      api.calls.filter((call) => /POST .*\/(versions|interventions)$/.test(call)),
    ).toHaveLength(2);
    expect(api.unexpected).toEqual([]);
  });

  test(`explicit remaining fixture: all summary fields, assumption edits, confirmation and new goal return at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const draft = fixtureIntake({
      status: "summary",
      revision: 3,
      challenge: structuredClone(fixtureChallenge),
      assumptions: ["【测试替身】可修改的假设。", "【测试替身】可移除的假设。"],
    });
    const api = await fixtures(page, completed(), draft);
    await page.addInitScript(() =>
      localStorage.setItem("strategy-arena:intake-id", "fixture-intake"),
    );
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "这是我们理解的任务。", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: "要达到的目标", exact: true })
      .fill("【测试替身】完成可核对的需求说明与执行提示词。");
    await page
      .getByRole("textbox", { name: "必须满足的限制", exact: true })
      .fill("【测试替身】使用已保存材料。");
    await page
      .getByRole("textbox", { name: "你更在意的事", exact: true })
      .fill("【测试替身】保留现有视觉。");
    await page
      .locator(".gi-assumptions textarea")
      .first()
      .fill("【测试替身】修改后仍待用户核对的假设。");
    await click(page.getByRole("button", { name: "移除第 2 条假设", exact: true }));
    await click(page.getByRole("button", { name: "预算、时间与备选方案", exact: true }));
    await page.getByRole("spinbutton", { name: "可投入金额（人民币）", exact: true }).fill("123");
    await page.getByRole("spinbutton", { name: "可投入时间（小时）", exact: true }).fill("4");
    await page
      .getByRole("textbox", { name: "已有备选方案（每行一个，最多三个）", exact: true })
      .fill("【测试替身】想法甲\n【测试替身】想法乙");
    await click(page.getByRole("button", { name: "预算、时间与备选方案", exact: true }));
    await checkpoint(page, info, "summary-all-fields-edited");
    await click(page.getByRole("button", { name: "确认摘要并开始推演", exact: true }));
    await expect(
      page.getByRole("heading", { name: "测试裁决：先做最小样片", exact: true }),
    ).toBeVisible();
    expect(api.snapshot.versions[0].challenge.budget).toBe(123);
    expect(api.snapshot.versions[0].intake?.assumptions).toEqual([
      "【测试替身】修改后仍待用户核对的假设。",
    ]);
    await click(page.getByRole("button", { name: "新问题", exact: true }));
    await expect(page.getByRole("heading", { name: "你想做什么", exact: true })).toBeVisible();
    await page
      .getByRole("textbox", { name: "你想做什么", exact: true })
      .fill("【测试替身】另一个目标。");
    await click(page.getByRole("button", { name: "开始梳理", exact: true }));
    await expect(
      page.getByRole("heading", { name: "这是我们理解的任务。", exact: true }),
    ).toBeVisible();
    await click(page.getByRole("button", { name: "准备新问题", exact: true }).first());
    await expect(page.getByRole("textbox", { name: "你想做什么", exact: true })).toHaveValue("");
    await checkpoint(page, info, "summary-new-goal-reset");
    expect(api.unexpected).toEqual([]);
  });
}
