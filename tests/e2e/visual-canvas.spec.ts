// Explicit synthetic UI fixture: the multiplayer canvas. All API traffic is intercepted.
import { expect, test } from "@playwright/test";
import type { ArenaEvent, ArenaSnapshot, ArenaStep, Attack } from "../../src/lib/contracts";
import {
  capture,
  mountFixture,
  openArena,
  snapshotOf,
  strategies,
  version,
} from "./visual.fixture";

test.use({ video: process.env.VISUAL_VIDEO ? "on" : "off" });

/** Fixture steps and events shaped like the runtime's records. All numbers are synthetic. */
function recorded(base: ArenaSnapshot): ArenaSnapshot {
  const v = base.versions[0];
  const plan: [ArenaStep["stage"], string][] = [
    ["propose", "A"],
    ["propose", "B"],
    ["propose", "C"],
    ["attack", "A"],
    ["attack", "B"],
    ["attack", "C"],
    ["attack", "C:repair"],
    ["verify", "verifier"],
    ["revise", "A"],
    ["revise", "B"],
    ["revise", "C"],
    ["judge", "judge"],
  ];
  const at = (s: number) => new Date(Date.UTC(2026, 10, 5, 2, 0, s)).toISOString();
  const steps: ArenaStep[] = plan.map(([stage, role], i) => ({
    id: `step-${i}`,
    versionId: v.id,
    stage,
    role,
    status: "completed",
    error: null,
    startedAt: at(i * 9),
    finishedAt: at(i * 9 + 8),
  }));
  const usage = (i: number) => ({
    inputTokens: 3100 + i * 120,
    outputTokens: 540 + i * 30,
    cachedInputTokens: 900,
    estimatedCny: 0.0034,
    model: "fixture",
    responseId: `r${i}`,
    durationMs: 7200 + i * 110,
  });
  const events: ArenaEvent[] = plan.flatMap(([stage, role], i): ArenaEvent[] => {
    const shared = { arenaId: base.id, versionId: v.id, stage, actor: role };
    const started = {
      ...shared,
      seq: i * 2 + 1,
      type: "step_started",
      message: `${role} 开始执行。`,
      data: null,
      createdAt: at(i * 9),
    };
    const done = { ...shared, seq: i * 2 + 2, createdAt: at(i * 9 + 8) };
    if (role === "verifier")
      return [
        started,
        {
          ...done,
          type: "step_completed",
          message: "工具核验完成（本地工具，无模型调用）。",
          data: { usage: null },
        },
      ];
    if (role === "C:repair")
      return [
        started,
        {
          ...done,
          type: "step_failed",
          message: "测试记录：引用的原话不在目标路线中，触发一次修复。",
          data: { usage: usage(i) },
        },
      ];
    return [
      started,
      {
        ...done,
        type: "step_completed",
        message: `${role} 已完成。`,
        data: {
          usage: usage(i),
          modelOutput: { fixture: "测试替身，不是模型输出", stage, role },
        },
      },
    ];
  });
  return { ...base, steps, events };
}
const snapshot = (attacks?: Attack[]): ArenaSnapshot =>
  recorded({
    id: "fixture-arena",
    activeVersionId: "fixture-v1",
    createdAt: "2026-11-05T02:00:00.000Z",
    versions: [version(1, attacks ? { attacks } : {})],
    steps: [],
    events: [],
    model: {
      id: "fixture-not-a-model",
      configured: true,
      promptVersion: "test-fixture",
      schemaVersion: "1.0.0",
    },
  });

const screens = [
  { name: "mbp14", width: 1512, height: 860 },
  { name: "mbp16", width: 1728, height: 1000 },
  { name: "fhd", width: 1920, height: 970 },
];

for (const screen of screens) {
  test.describe(`${screen.name} ${screen.width}x${screen.height}`, () => {
    test.use({ viewport: { width: screen.width, height: screen.height } });

    test("the canvas, panels and all five agents fit one screen", async ({ page }, testInfo) => {
      await mountFixture(page, snapshot());
      await openArena(page);
      await expect(page.getByRole("heading", { name: /先做带返工预留/ })).toBeVisible();
      await page.waitForTimeout(1300);
      await capture(page, testInfo, `canvas-${screen.name}`, false);
      const fit = await page.evaluate(() => {
        const root = document.documentElement;
        const canvas = document.querySelector(".canvas")!.getBoundingClientRect();
        const cursors = [...document.querySelectorAll(".cursor")].map((n) =>
          n.getBoundingClientRect(),
        );
        return {
          x: root.scrollWidth - root.clientWidth,
          y: root.scrollHeight - root.clientHeight,
          frames: document.querySelectorAll(".frame").length,
          links: document.querySelectorAll(".link").length,
          onCanvas: cursors.every(
            (c) => c.left >= canvas.left && c.right <= canvas.right + 100 && c.top >= canvas.top,
          ),
        };
      });
      expect(fit.x).toBeLessThanOrEqual(0);
      expect(fit.y).toBeLessThanOrEqual(0);
      expect(fit.frames).toBe(5);
      expect(fit.links).toBe(4);
      expect(fit.onCanvas).toBe(true);
    });
  });
}

test.describe("behaviour", () => {
  test.use({ viewport: { width: 1512, height: 860 } });
  test.setTimeout(120_000);

  test("the debate plays as threads pinned to claims", async ({ page }, testInfo) => {
    await mountFixture(page, snapshot());
    await openArena(page);
    const frameA = page.getByRole("region", { name: "方案 A", exact: true });
    const thread = frameA.locator(".thread", { hasText: "样片 2 小时没有算上" });
    await expect(thread).toContainText("质疑成立");
    await expect(thread).toContainText("1+1+1.5 = 3.5");
    await expect(thread).toContainText("接受质疑");
    await expect(frameA.locator(".claim-card .struck").first()).toContainText("样片只需 2 小时");

    // Stepping back hides what had not happened yet.
    await page.getByRole("button", { name: /第 4 步/ }).click();
    await page.waitForTimeout(1200);
    await expect(thread).not.toContainText("质疑成立");
    await expect(page.locator(".cursor.busy")).toContainText("方案 B");
    await expect(page.getByRole("complementary", { name: "当前步骤详情" })).toContainText(
      "样片只需 2 小时",
    );
    // Evidence must not appear before the check has happened.
    await expect(page.getByRole("complementary", { name: "当前步骤详情" })).toContainText(
      "核验还没进行到这一条",
    );
    await capture(page, testInfo, "canvas-step", false);

    await page.getByRole("button", { name: "从头放映" }).click();
    await page.waitForTimeout(3000);
    await capture(page, testInfo, "canvas-playing", false);
    await expect(page.getByRole("heading", { name: /先做带返工预留/ })).toBeVisible({
      timeout: 40_000,
    });

    await thread.getByRole("button", { name: /样片 2 小时没有算上/ }).click();
    await expect(page.getByRole("dialog", { name: "这一条，站得住吗？" })).toBeVisible();
    await page.waitForTimeout(350);
    await capture(page, testInfo, "canvas-evidence", false);
    await page.keyboard.press("Escape");
    await frameA.locator(".claim-card", { hasText: "A2" }).click();
    await expect(page.getByRole("dialog", { name: "向这条判断发起挑战" })).toBeVisible();
  });

  test("long threads scroll inside their frame, never the page", async ({ page }, testInfo) => {
    const long =
      "这是一条较长的测试文本，长度接近真实模型输出，用来检查评论串变多后，整页依然不滚动，光标和连线也不会跑出画布。";
    const attacks: Attack[] = [
      ["A", "B", "B1"],
      ["A", "C", "C1"],
      ["B", "A", "A1"],
      ["B", "C", "C1"],
      ["C", "A", "A1"],
      ["C", "B", "B1"],
    ].map(([from, to, claim], i) => ({
      id: `long-${i}`,
      from,
      targetStrategyId: to as Attack["targetStrategyId"],
      targetClaimId: claim,
      claimQuote: long,
      reason: long,
      impact: long,
      verification: long,
      requests: [],
      status: (["supported", "refuted", "unresolved"] as const)[i % 3],
    }));
    await mountFixture(page, snapshot(attacks));
    await openArena(page);
    await page.waitForTimeout(1300);
    await capture(page, testInfo, "canvas-long", false);
    const y = await page.evaluate(
      () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
    );
    expect(y).toBeLessThanOrEqual(0);
  });
});

const noScroll = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const root = document.documentElement;
    return Math.max(root.scrollWidth - root.clientWidth, root.scrollHeight - root.clientHeight);
  });

test.describe("states", () => {
  test.use({ viewport: { width: 1512, height: 860 } });

  test("running shows only recorded work, and who is working now", async ({ page }, testInfo) => {
    const snap = snapshotOf(
      [
        version(1, {
          status: "running",
          stage: "propose",
          strategies: [strategies[0]],
          attacks: [],
          evidence: [],
          revisions: [],
          verdict: null,
        }),
      ],
      { attack: "pending", verify: "pending", revise: "pending", judge: "pending" },
    );
    snap.steps[0] = { ...snap.steps[0], role: "B", status: "running" };
    await mountFixture(page, snap);
    await openArena(page);
    await expect(page.getByRole("region", { name: "方案 C", exact: true })).toContainText(
      "等待提案",
    );
    await expect(page.getByRole("region", { name: "裁判" })).toContainText("裁决尚未产生");
    await expect(page.locator(".cursor.working")).toContainText("方案 B");
    await expect(page.locator(".link")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "现在收束" })).toBeVisible();
    await page.waitForTimeout(1000);
    await capture(page, testInfo, "canvas-running", false);
    expect(await noScroll(page)).toBeLessThanOrEqual(0);
  });

  for (const [status, text, step] of [
    ["failed", "本轮未完成", "failed"],
    ["uncertain", "无法判断请求是否完成或已计费", "uncertain"],
  ] as const)
    test(`${status} run says so and keeps the record`, async ({ page }, testInfo) => {
      await mountFixture(
        page,
        snapshotOf(
          [
            version(1, {
              status,
              stage: "revise",
              verdict: null,
              revisions: [],
              error: "测试错误：请求未完成。",
            }),
          ],
          { revise: step, judge: "pending" },
        ),
      );
      await openArena(page);
      const notice = page.getByRole("main").getByRole("alert");
      await expect(notice).toContainText(text);
      await expect(notice.getByRole("button", { name: "刷新状态" })).toBeVisible();
      await expect(page.getByRole("region", { name: "方案 A", exact: true })).toContainText(
        "样片 2 小时没有算上",
      );
      await page.waitForTimeout(800);
      await capture(page, testInfo, `canvas-${status}`, false);
      expect(await noScroll(page)).toBeLessThanOrEqual(0);
    });

  test("paused run is a status, not an alert", async ({ page }) => {
    await mountFixture(
      page,
      snapshotOf([version(1, { status: "paused", stage: "verify", verdict: null, revisions: [] })]),
    );
    await openArena(page);
    await expect(page.getByText("本轮已停止")).toBeVisible();
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  });

  test("condition versions show what changed, and history is read only", async ({
    page,
  }, testInfo) => {
    const v1 = version(1, { status: "superseded" });
    const v2 = version(2, {
      challenge: { ...v1.challenge, budget: 150 },
      changeReason: "测试：预算减少到 150 元。",
      parentVersionId: v1.id,
    });
    await mountFixture(page, snapshotOf([v1, v2]));
    await openArena(page);
    await expect(page.locator(".condition-delta")).toContainText("¥300 → ¥150");
    await page.getByRole("combobox", { name: "选择推演版本" }).selectOption(v1.id);
    await expect(page.getByText("你正在查看历史版本。", { exact: false })).toBeVisible();
    const frameA = page.getByRole("region", { name: "方案 A", exact: true });
    await expect(frameA.locator(".claim-card").first()).toBeDisabled();
    await frameA.getByRole("button", { name: /样片 2 小时/ }).click();
    await expect(page.getByRole("dialog", { name: "这一条，站得住吗？" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
    await capture(page, testInfo, "canvas-history", false);
    expect(await noScroll(page)).toBeLessThanOrEqual(0);
  });

  test("keyboard reaches the chain and the debate, and focus comes back", async ({ page }) => {
    await mountFixture(page, snapshotOf([version(1)]));
    await openArena(page);
    const step = page.getByRole("button", { name: /第 4 步/ });
    await step.focus();
    await page.keyboard.press("Enter");
    await expect(step).toHaveAttribute("aria-current", "step");
    expect(await step.evaluate((n) => getComputedStyle(n).outlineStyle)).toBe("solid");
    const reason = page.getByRole("button", { name: /样片 2 小时没有算上/ });
    await reason.focus();
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("dialog", { name: "这一条，站得住吗？" });
    await expect(page.getByRole("button", { name: "关闭证据详情" })).toBeFocused();
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest(".evidence-drawer"))).toBe(
        true,
      );
    }
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(reason).toBeFocused();
  });

  test("reduced motion stops drift and cursors keep their place", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mountFixture(page, snapshotOf([version(1)]));
    await openArena(page);
    const motion = await page
      .locator(".cursor-inner")
      .first()
      .evaluate((n) => getComputedStyle(n).animationName);
    expect(motion).toBe("none");
    expect(
      await page
        .locator(".cursor")
        .first()
        .evaluate((n) => getComputedStyle(n).transitionDuration),
    ).toMatch(/^0s/);
  });
});

test.describe("home", () => {
  for (const screen of screens)
    test.describe(screen.name, () => {
      test.use({ viewport: { width: screen.width, height: screen.height } });

      test("the same canvas waits for a question", async ({ page }, testInfo) => {
        await mountFixture(page, snapshotOf([version(1)]));
        await page.goto("/");
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("让好想法，打过一场。");
        await expect(page.locator(".home-cursors .cursor")).toHaveCount(5);
        await page.waitForTimeout(400);
        await capture(page, testInfo, `home-${screen.name}`, false);
        expect(await noScroll(page)).toBeLessThanOrEqual(0);
      });
    });

  test.describe("errors", () => {
    test.use({ viewport: { width: 1512, height: 860 } });

    test("a rejected create shows the reason and keeps the form", async ({ page }) => {
      await mountFixture(page, snapshotOf([version(1)]));
      await page.route("**/api/arenas", (r) =>
        r.fulfill({
          status: 429,
          json: { error: "测试错误：今日次数已用完。", code: "DAILY_LIMIT" },
        }),
      );
      await page.goto("/");
      await page.getByRole("button", { name: "试填一个视频任务" }).click();
      await page.getByRole("button", { name: "让方案上场" }).click();
      await expect(page.getByRole("main").getByRole("alert")).toContainText("今日次数已用完");
      await expect(page.getByLabel("你的目标、备选方案或想法")).not.toHaveValue("");
    });

    test("access gate and health failure keep start disabled", async ({ page }, testInfo) => {
      const model = snapshotOf([version(1)]).model;
      await page.route("**/api/health", (r) =>
        r.fulfill({
          json: {
            status: "ok",
            version: "fixture",
            commit: "fixture",
            model,
            requiresAccessCode: true,
            accessGranted: false,
          },
        }),
      );
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "凭访问码入场" })).toBeVisible();
      await expect(page.getByRole("button", { name: "让方案上场" })).toBeDisabled();
      await page.waitForTimeout(300);
      await capture(page, testInfo, "home-access", false);
      await page.unroute("**/api/health");
      await page.route("**/api/health", (r) =>
        r.fulfill({ status: 500, json: { error: "测试错误", code: "INTERNAL_ERROR" } }),
      );
      await page.reload();
      await expect(page.getByText("连接恢复后刷新页面即可继续。")).toBeVisible();
      await expect(page.getByRole("button", { name: "让方案上场" })).toBeDisabled();
    });
  });
});
