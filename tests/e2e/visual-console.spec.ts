// Explicit synthetic UI fixture: the arena console. All API traffic is intercepted.
import { expect, test, type Page } from "@playwright/test";
import type { ArenaEvent, ArenaSnapshot, ArenaStep, Attack } from "../../src/lib/contracts";
import {
  attacks as fixtureAttacks,
  capture,
  mountFixture,
  openArena,
  snapshotOf,
  strategies as fixtureStrategies,
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
  { name: "laptop", width: 1366, height: 768 },
  { name: "qhd", width: 2560, height: 1440 },
];
const homeScreens = screens.slice(0, 3);
const noScroll = (page: Page) =>
  page.evaluate(() => {
    const root = document.documentElement;
    return Math.max(root.scrollWidth - root.clientWidth, root.scrollHeight - root.clientHeight);
  });
// The opening titles get their own test; everything else starts past them.
const skipIntro = (page: Page) =>
  page.addInitScript(() => sessionStorage.setItem("arena-intro", "1"));

for (const screen of screens) {
  test.describe(`${screen.name} ${screen.width}x${screen.height}`, () => {
    test.use({ viewport: { width: screen.width, height: screen.height } });

    test("the whole console fits one screen", async ({ page }, testInfo) => {
      await skipIntro(page);
      await mountFixture(page, snapshot());
      await openArena(page);
      await expect(page.getByRole("heading", { name: /先做带返工预留/ })).toBeVisible();
      await page.waitForTimeout(1200);
      await capture(page, testInfo, `console-${screen.name}-verdict`, false);
      await page.keyboard.press("Home");
      await page.getByRole("button", { name: "从头放映" }).click();
      await page.waitForTimeout(1600 * 3 + 560 + 800);
      await capture(page, testInfo, `console-${screen.name}-challenge`, false);
      expect(await noScroll(page)).toBeLessThanOrEqual(0);
      await expect(page.locator(".c-board")).toHaveCount(3);
      await expect(page.locator(".c-float-card")).toBeVisible();
      const fits = await page.evaluate(() => {
        const box = document.querySelector(".c-float-card")!.getBoundingClientRect();
        return box.bottom <= innerHeight && box.right <= innerWidth && box.left >= 0;
      });
      expect(fits).toBe(true);
    });
  });
}

for (const screen of homeScreens) {
  test(`home fits ${screen.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: screen.width, height: screen.height });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "先让三个方案互相挑错，再决定。" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "试填一个视频任务" })).toBeVisible();
    expect(await noScroll(page)).toBeLessThanOrEqual(0);
    await page.waitForTimeout(700);
    await capture(page, testInfo, `home-${screen.name}`, false);
  });
}

test("phone width never scrolls sideways", async ({ page }, testInfo) => {
  await skipIntro(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const sideways = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
  expect(await sideways()).toBeLessThanOrEqual(0);
  await mountFixture(page, snapshot());
  await openArena(page);
  await page.waitForTimeout(500);
  expect(await sideways()).toBeLessThanOrEqual(0);
  await capture(page, testInfo, "console-phone", false);
});

test.describe("behaviour", () => {
  test.use({ viewport: { width: 1512, height: 860 } });
  test.setTimeout(120_000);

  test("opening titles report real counts and any key skips them", async ({ page }, testInfo) => {
    await mountFixture(page, snapshotOf([version(1, { status: "running" })]));
    await openArena(page);
    await expect(page.locator(".c-intro")).toContainText("七天内");
    await page.waitForTimeout(900);
    await capture(page, testInfo, "console-intro", false);
    await page.keyboard.press("x");
    await expect(page.locator(".c-intro")).toHaveCount(0);
  });

  test("stepping walks the record and hides what has not happened", async ({ page }, testInfo) => {
    await skipIntro(page);
    await mountFixture(page, snapshot());
    await openArena(page);
    for (let i = 0; i < 11; i++) await page.keyboard.press("ArrowLeft");
    const now = page.getByRole("region", { name: "正在发生" });
    await expect(now).toContainText("方案 B → 方案 A");
    await expect(now).toContainText("样片 2 小时没有算上录制后的返工");
    await expect(page.locator(".c-board.speaking")).toHaveCount(1);
    await expect(page.locator(".c-board.target")).toHaveCount(1);
    await expect(page.locator(".c-thread.on")).toHaveCount(1);
    await expect(page.locator(".c-packet")).toHaveText("质疑 A1");
    await expect(page.getByRole("heading", { name: /先做带返工预留/ })).toHaveCount(0);
    await expect(page.locator(".c-float-card")).toContainText("等待");
    await expect(page.locator(".c-claim.hot")).toContainText("A1");
    await page.waitForTimeout(800);
    await capture(page, testInfo, "console-step", false);

    await page.keyboard.press("G");
    await expect(page.getByRole("heading", { name: /先做带返工预留/ })).toBeVisible();
    await expect(page.locator(".c-float-card")).toHaveCount(0);
    for (const word of ["命中", "守住", "相持", "出击", "受击", "战线"])
      await expect(page.locator(".c-root").getByText(word)).toHaveCount(0);

    const challenges = page.getByRole("region", { name: "全部质疑" });
    await challenges.getByRole("button", { name: /样片 2 小时没有算上/ }).click();
    await expect(page.getByRole("dialog", { name: "这一条，站得住吗？" })).toBeVisible();
    await page.waitForTimeout(400);
    await capture(page, testInfo, "console-evidence", false);
    await page.keyboard.press("Escape");
    // Every board must take clicks, including the parts tilted away from the viewer.
    for (const claim of ["A2", "B2", "C2"]) {
      await page.locator(".c-claim", { hasText: claim }).click();
      const dialog = page.getByRole("dialog", { name: "向这条判断发起挑战" });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "关闭弹窗" }).click();
      await expect(dialog).toHaveCount(0);
    }
  });

  test("long records stay inside their panels", async ({ page }, testInfo) => {
    await skipIntro(page);
    const long =
      "这是一条较长的测试文本，长度接近真实模型输出，用来检查内容变多之后，控制台依然不滚动，面板和浮动窗也不会超出屏幕。";
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
    for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".c-float-card")).toBeVisible();
    await page.waitForTimeout(900);
    await capture(page, testInfo, "console-long", false);
    expect(await noScroll(page)).toBeLessThanOrEqual(0);
    const fits = await page.evaluate(() => {
      const card = document.querySelector(".c-float-card")!;
      const body = card.querySelector(".body")!;
      return (
        card.getBoundingClientRect().bottom <= innerHeight &&
        body.scrollHeight <= body.clientHeight + 1
      );
    });
    expect(fits).toBe(true);
  });

  test("history and dialogs stay usable", async ({ page }, testInfo) => {
    await skipIntro(page);
    await mountFixture(
      page,
      snapshotOf([
        version(1, { status: "superseded" }),
        version(2, { parentVersionId: "fixture-v1", changeReason: "测试：预算减少。" }),
      ]),
    );
    await openArena(page);
    await page.getByRole("combobox", { name: "选择推演版本" }).selectOption("fixture-v1");
    await expect(page.getByText("你正在查看历史版本。")).toBeVisible();
    await page.waitForTimeout(500);
    await capture(page, testInfo, "console-history", false);
    expect(await noScroll(page)).toBeLessThanOrEqual(0);
    await page.getByRole("button", { name: "修改条件再开局" }).first().click();
    await expect(page.getByRole("button", { name: "按新条件重新推演" })).toBeVisible();
    await page.waitForTimeout(400);
    await capture(page, testInfo, "console-edit", false);
  });

  test("a finished game opens on its result with its panels ready", async ({ page }) => {
    await mountFixture(page, snapshot());
    await openArena(page);
    await expect(page.locator(".c-intro")).toHaveCount(0);
    await expect(page.locator(".c-root.theater")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /先做带返工预留/ })).toBeVisible();
    await page
      .getByRole("region", { name: "全部质疑" })
      .getByRole("button", { name: /样片 2 小时没有算上/ })
      .click();
    await expect(page.getByRole("dialog", { name: "这一条，站得住吗？" })).toBeVisible();
  });

  test("a game in progress plays from its first step, and the viewer can take over", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await mountFixture(page, snapshotOf([version(1, { status: "running" })]));
    await openArena(page);
    // Taking over with a key must stop on the first step, not on the result.
    await page.locator(".c-intro").waitFor();
    await page.keyboard.press("x");
    await expect(page.locator(".c-root.theater")).toBeVisible();
    await expect(page.getByRole("heading", { name: /先做带返工预留/ })).toHaveCount(0);
    await page.getByRole("button", { name: "暂停放映" }).click();
    await expect(page.locator(".c-root.theater")).toHaveCount(0);
    await page.keyboard.press("End");
    await expect(page.getByRole("heading", { name: /先做带返工预留/ })).toBeVisible();
    await expect(page.locator(".c-film")).toHaveCount(0);
  });

  test("results arriving faster than the film never stall it or make it jump", async ({ page }) => {
    test.setTimeout(120_000);
    await skipIntro(page);
    const full = version(1);
    const plan = [
      ...full.strategies.map(() => "propose"),
      ...full.attacks.map(() => "attack"),
      "verify",
      ...full.revisions.map(() => "revise"),
      "judge",
    ];
    let done = 0;
    const current = () => {
      const count = (stage: string) => plan.slice(0, done).filter((s) => s === stage).length;
      const verified = count("verify") > 0;
      const finished = done >= plan.length;
      return snapshotOf([
        version(1, {
          status: finished ? "completed" : "ready",
          stage: (plan[done] ?? "judge") as ArenaStep["stage"],
          strategies: full.strategies.slice(0, count("propose")),
          attacks: full.attacks
            .slice(0, count("attack"))
            .map((a) => (verified ? a : { ...a, status: "pending" as const })),
          evidence: verified ? full.evidence : [],
          revisions: full.revisions.slice(0, count("revise")),
          verdict: finished ? full.verdict : null,
        }),
      ]);
    };
    await mountFixture(page, current());
    // Each result lands 1.5 s after the last, quicker than any shot in the film.
    await page.route("**/api/arenas**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/events"))
        return route.fulfill({ contentType: "text/event-stream", body: ": explicit fixture\n\n" });
      if (path.endsWith("/advance")) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        done = Math.min(done + 1, plan.length);
      }
      await route.fulfill({ json: current() });
    });
    await openArena(page);

    const counter = page.locator(".c-now .fl span");
    const seen: { step: number; total: number; arrived: number }[] = [];
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const text = await counter.textContent().catch(() => null);
      const parts = text?.match(/(\d+)\/(\d+)/);
      if (parts) seen.push({ step: +parts[1], total: +parts[2], arrived: done });
      if (seen.at(-1)?.step === 15 && (await page.locator(".c-root.theater").count()) === 0) break;
      await page.waitForTimeout(100);
    }

    // It moves while results are still arriving, instead of waiting for the game to finish.
    const midGame = seen.filter((s) => s.arrived < plan.length).map((s) => s.step);
    expect(Math.max(...midGame)).toBeGreaterThanOrEqual(4);
    // Every recorded step gets shown; none is skipped by jumping ahead.
    for (let i = 1; i < seen.length; i++)
      expect(seen[i].step - seen[i - 1].step).toBeLessThanOrEqual(1);
    expect(seen.at(-1)?.step).toBe(15);
    await expect(page.getByRole("heading", { name: /先做带返工预留/ })).toBeVisible();
  });

  test("stepping onto the verdict plays it full screen and folds into the panel", async ({
    page,
  }, testInfo) => {
    await skipIntro(page);
    await mountFixture(page, snapshot());
    await openArena(page);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".c-film")).toBeVisible();
    await page.waitForTimeout(1600);
    await capture(page, testInfo, "console-film", false);
    await expect(page.locator(".c-film")).toHaveCount(0, { timeout: 8000 });
    await expect(page.getByRole("heading", { name: /先做带返工预留/ })).toBeVisible();
  });

  test.describe("reduced motion", () => {
    test.use({ reducedMotion: "reduce" });
    test("skips the film and the camera", async ({ page }) => {
      await mountFixture(page, snapshot());
      await openArena(page);
      await expect(page.locator(".c-intro")).toHaveCount(0);
      await page.keyboard.press("End");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowRight");
      await expect(page.locator(".c-film")).toHaveCount(0);
      expect(await page.locator(".c-world").evaluate((el) => el.style.transform)).toBe("none");
    });
  });

  test("the camera never crops the board in shot", async ({ page }) => {
    await skipIntro(page);
    await mountFixture(page, snapshot());
    await openArena(page);
    for (let step = 0; step < 11; step++) {
      await page.keyboard.press("ArrowLeft");
      await page.waitForTimeout(1150);
      const cropped = await page.evaluate(() => {
        const stage = document.querySelector(".c-stage3")!.getBoundingClientRect();
        return [...document.querySelectorAll(".c-board.target, .c-board.speaking")].some((node) => {
          const box = node.getBoundingClientRect();
          return (
            box.top < stage.top - 1 || box.left < stage.left - 1 || box.right > stage.right + 1
          );
        });
      });
      expect(cropped).toBe(false);
    }
  });

  test("the verdict always hands back, even while the record keeps refreshing", async ({
    page,
  }) => {
    await skipIntro(page);
    await mountFixture(page, snapshotOf([version(1, { status: "running" })]));
    await openArena(page);
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".c-film")).toBeVisible();
    await expect(page.locator(".c-film")).toHaveCount(0, { timeout: 7000 });
    await expect(page.getByRole("heading", { name: /先做带返工预留/ })).toBeVisible();
  });

  test("results arriving steadily play step by step, without stalling then jumping", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.addInitScript(() => sessionStorage.setItem("arena-intro", "1"));
    const partial = (n: number) =>
      snapshotOf([
        version(1, {
          status: "ready",
          strategies: fixtureStrategies.slice(0, n),
          attacks: fixtureAttacks.slice(0, Math.max(0, n - 3)),
          evidence: [],
          revisions: [],
          verdict: null,
        }),
      ]);
    await mountFixture(page, partial(0));
    let arrived = 0;
    const total = 3 + fixtureAttacks.length;
    // Arrivals come faster than a single step plays, as they did in the reported stall.
    await page.route("**/api/arenas/*/advance", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      arrived += 1;
      await route.fulfill({
        json: arrived > total ? snapshotOf([version(1)]) : partial(arrived),
      });
    });
    await openArena(page);
    const seen: number[] = [];
    for (let i = 0; i < 80; i++) {
      await page.waitForTimeout(300);
      const label = await page.locator(".c-now .fl span").textContent();
      seen.push(Number(label?.split("/")[0] ?? 0));
      if (seen.at(-1) === 15) break;
    }
    // It moved while results were still arriving, not only after the last one.
    expect(seen[Math.min(19, seen.length - 1)]).toBeGreaterThanOrEqual(3);
    // It reached the end by walking there, never by a sudden leap.
    expect(seen.at(-1)).toBe(15);
    const leaps = seen.slice(1).map((n, i) => n - seen[i]);
    expect(Math.max(...leaps)).toBeLessThanOrEqual(1);
  });

  test("every clickable control answers hover and press", async ({ page }, testInfo) => {
    await page.addInitScript(() => sessionStorage.setItem("arena-intro", "1"));
    await mountFixture(page, snapshot());
    const audit = () =>
      page.evaluate(() => {
        const dead: string[] = [];
        document
          .querySelectorAll<HTMLElement>("button, a[href], select, summary, input, textarea")
          .forEach((el) => {
            const style = getComputedStyle(el);
            if (style.display === "none" || el.matches(":disabled")) return;
            const moves = style.transitionDuration.split(",").some((t) => parseFloat(t) > 0);
            if (!moves) dead.push(`${el.tagName}.${el.className}`);
          });
        return dead;
      });
    const ring = page.locator(".c-press-ring");
    await page.goto("/");
    expect(await audit()).toEqual([]);
    await page.getByRole("button", { name: "试填一个视频任务" }).click();
    await expect(ring).toHaveCount(1);
    await page.getByRole("button", { name: "工作业务" }).click();
    expect(await audit()).toEqual([]);
    await openArena(page);
    expect(await audit()).toEqual([]);
    // A hovered challenge lights its thread and claim.
    const row = page.getByRole("region", { name: "全部质疑" }).getByRole("button").first();
    await row.hover();
    await expect(page.locator(".c-thread.lit")).toHaveCount(1);
    await expect(page.locator(".c-claim.lit")).toHaveCount(1);
    await page.waitForTimeout(400);
    await capture(page, testInfo, "console-hover-row", false);
    // Finding a challenge from its evidence really shows it on the boards.
    await row.click();
    await expect(ring.first()).toBeAttached();
    const drawer = page.getByRole("dialog", { name: "这一条，站得住吗？" });
    expect(await audit()).toEqual([]);
    await drawer.getByRole("button", { name: /中定位/ }).click();
    await expect(drawer).toHaveCount(0);
    await expect(page.locator(".c-claim.located")).toHaveCount(1);
    await expect(page.locator(".c-row.located")).toBeFocused();
    await page.locator(".c-claim", { hasText: "A2" }).hover();
    await page.waitForTimeout(350);
    await capture(page, testInfo, "console-hover-claim", false);
    await page.locator(".c-claim", { hasText: "A2" }).click();
    const dialog = page.getByRole("dialog", { name: "向这条判断发起挑战" });
    await expect(dialog).toBeVisible();
    expect(await audit()).toEqual([]);
  });

  test("failed run says so and keeps the record", async ({ page }, testInfo) => {
    await skipIntro(page);
    await mountFixture(
      page,
      snapshotOf(
        [
          version(1, {
            status: "uncertain",
            stage: "revise",
            verdict: null,
            revisions: [],
            error: "测试错误：请求未完成。",
          }),
        ],
        { revise: "uncertain", judge: "pending" },
      ),
    );
    await openArena(page);
    const notice = page.getByRole("main").getByRole("alert");
    await expect(notice).toContainText("无法判断请求是否完成或已计费");
    await expect(notice.getByRole("button", { name: "刷新状态" })).toBeVisible();
    await page.waitForTimeout(800);
    await capture(page, testInfo, "console-uncertain", false);
    expect(await noScroll(page)).toBeLessThanOrEqual(0);
  });

  test("an empty game shows no records and an empty wall", async ({ page }, testInfo) => {
    await skipIntro(page);
    await mountFixture(
      page,
      snapshotOf(
        [
          version(1, {
            status: "running",
            stage: "propose",
            strategies: [],
            attacks: [],
            evidence: [],
            revisions: [],
            verdict: null,
          }),
        ],
        {
          propose: "running",
          attack: "pending",
          verify: "pending",
          revise: "pending",
          judge: "pending",
        },
      ),
    );
    await page.goto("/");
    await page.getByRole("button", { name: "试填一个视频任务" }).click();
    await page.getByRole("button", { name: "让方案上场" }).click();
    await expect(page.locator(".c-root")).toBeVisible();
    await expect(page.getByRole("region", { name: "正在发生" })).toContainText("等待第一步");
    await page.waitForTimeout(600);
    await capture(page, testInfo, "console-empty", false);
    await expect(page.locator(".c-cw")).toHaveCount(0);
  });
});
