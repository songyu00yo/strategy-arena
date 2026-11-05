// Explicit synthetic UI fixture. Every string below is test data, not model output or evaluation
// evidence. All /api/** traffic is intercepted, so these checks cannot reach a model or a database.
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type {
  ArenaSnapshot,
  ArenaStep,
  ArenaVersion,
  Attack,
  Challenge,
  Evidence,
  Revision,
  Stage,
  Strategy,
} from "../../src/lib/contracts";

const at = "2026-11-05T00:00:00.000Z";
const challenge: Challenge = {
  goal: "测试任务：七天内由一人完成一支五分钟知识视频，比较三条可执行路线。",
  constraints: "只有一人执行；不购买新设备；不使用 AI 生成镜头。",
  preferences: "优先准确，其次才是画面。",
  options: [],
  materials: "测试材料：每天可投入 1 小时；音乐预算最多 50 元。",
  domain: "creation",
  budget: 300,
  timeHours: 7,
};

function route(
  id: "A" | "B" | "C",
  title: string,
  thesis: string,
  hours: number,
  claims: Strategy["claims"],
): Strategy {
  return {
    id,
    title,
    thesis,
    steps: ["测试步骤：写一页大纲", "测试步骤：录制一分钟样片", "测试步骤：按样片结果决定是否扩展"],
    claims,
    resources: "测试资源：自有电脑与手机，音乐库预算 50 元。",
    firstAction: `测试第一步：为路线 ${id} 写一页大纲。`,
    failureCondition: "测试失效条件：第三天仍没有可播放样片。",
    estimatedCost: 50,
    estimatedHours: hours,
  };
}

const strategies: Strategy[] = [
  route("A", "测试路线 A：先做最小样片", "用一分钟样片换取真实工时数据，再决定是否扩展。", 6, [
    { id: "A1", text: "测试判断 A1：样片只需 2 小时。", status: "estimate", sourceIds: [] },
    { id: "A2", text: "测试判断 A2：每天 1 小时足够。", status: "user", sourceIds: [] },
  ]),
  route("B", "测试路线 B：一次写完整脚本", "先把完整脚本写透，减少后期返工。", 9, [
    { id: "B1", text: "测试判断 B1：脚本写透后返工会很少。", status: "unknown", sourceIds: [] },
    { id: "B2", text: "测试判断 B2：音乐预算 50 元够用。", status: "supported", sourceIds: ["m1"] },
  ]),
  route("C", "测试路线 C：图文转视频", "复用已有图文，用录屏和旁白降低制作成本。", 5, [
    { id: "C1", text: "测试判断 C1：已有图文可以直接复用。", status: "unknown", sourceIds: [] },
  ]),
];

const attacks: Attack[] = [
  {
    id: "atk-1",
    from: "B",
    targetStrategyId: "A",
    targetClaimId: "A1",
    claimQuote: strategies[0].claims[0].text,
    reason: "测试质疑：样片 2 小时没有算上录制后的返工。",
    impact: "若返工翻倍，第三天前可能拿不出样片。",
    verification: "把写稿、录制和返工时间相加。",
    requests: [{ tool: "calculate", expression: "1+1+1.5", assumptions: "测试假设" }],
    status: "supported",
  },
  {
    id: "atk-2",
    from: "C",
    targetStrategyId: "B",
    targetClaimId: "B1",
    claimQuote: strategies[1].claims[0].text,
    reason: "测试质疑：材料里没有任何返工数据能支持这句话。",
    impact: "完整脚本可能占满全部 7 小时。",
    verification: "在用户材料中检索返工记录。",
    requests: [{ tool: "search_materials", query: "返工" }],
    status: "unresolved",
  },
  {
    id: "atk-3",
    from: "A",
    targetStrategyId: "B",
    targetClaimId: "B2",
    claimQuote: strategies[1].claims[1].text,
    reason: "测试质疑：音乐授权费用可能超过 50 元。",
    impact: "若超出预算，这条路线触及硬性限制。",
    verification: "核对材料中的音乐预算。",
    requests: [{ tool: "search_materials", query: "音乐预算" }],
    status: "refuted",
  },
  {
    id: "atk-4",
    from: "A",
    targetStrategyId: "C",
    targetClaimId: "C1",
    claimQuote: strategies[2].claims[0].text,
    reason: "测试质疑：图文素材的版权状态没有确认。",
    impact: "若素材不能复用，节省的工时就不存在。",
    verification: "核验工具调用失败时必须如实显示。",
    requests: [{ tool: "search_materials", query: "版权" }],
    status: "pending",
  },
];

const evidence: Evidence[] = [
  {
    id: "ev-calc",
    attackId: "atk-1",
    tool: "calculate",
    status: "calculated",
    title: "测试计算：样片总工时",
    content: "1 + 1 + 1.5 = 3.5 小时；这是合成测试证据。",
    source: "fixture calculator",
    sourceIds: [],
    expression: "1+1+1.5",
    result: 3.5,
    assumptions: "测试假设：写稿 1 小时，录制 1 小时，返工 1.5 小时。",
    createdAt: at,
  },
  {
    id: "ev-none",
    attackId: "atk-2",
    tool: "search_materials",
    status: "unavailable",
    title: "测试检索：未找到返工记录",
    content: "",
    source: "用户材料",
    sourceIds: [],
    expression: null,
    result: null,
    assumptions: "",
    createdAt: at,
  },
  {
    id: "ev-found",
    attackId: "atk-3",
    tool: "search_materials",
    status: "found",
    title: "测试检索：音乐预算",
    content: "测试材料：音乐预算最多 50 元。",
    source: "用户材料",
    sourceIds: ["m1"],
    expression: null,
    result: null,
    assumptions: "",
    createdAt: at,
  },
  {
    id: "ev-error",
    attackId: "atk-4",
    tool: "search_materials",
    status: "error",
    title: "测试检索：工具返回错误",
    content: "",
    source: "用户材料",
    sourceIds: [],
    expression: null,
    result: null,
    assumptions: "",
    createdAt: at,
  },
];

const revisions: Revision[] = [
  {
    strategyId: "A",
    strategy: {
      ...strategies[0],
      thesis: "用一分钟样片换取真实工时数据，并预留返工时间后再决定是否扩展。",
      steps: [
        "测试步骤：写一页大纲",
        "测试步骤：录制一分钟样片",
        "测试步骤：预留 1.5 小时返工",
        "测试步骤：按样片结果决定是否扩展",
      ],
      claims: [
        {
          id: "A1",
          text: "测试判断 A1：样片连返工共需 3.5 小时。",
          status: "supported",
          sourceIds: [],
        },
        strategies[0].claims[1],
      ],
      estimatedHours: 7,
    },
    responses: [
      {
        attackId: "atk-1",
        decision: "accept",
        reason: "测试回应：依据计算补上返工时间。",
        evidenceIds: ["ev-calc"],
        change: "把样片工时从 2 小时改为 3.5 小时，总工时改为 7 小时。",
      },
    ],
    summary: "测试修订：补上返工时间，总工时升到 7 小时。",
    changed: true,
  },
  {
    strategyId: "B",
    strategy: strategies[1],
    responses: [
      {
        attackId: "atk-2",
        decision: "unresolved",
        reason: "测试回应：材料确实没有返工数据，保留未知。",
        evidenceIds: ["ev-none"],
        change: "",
      },
      {
        attackId: "atk-3",
        decision: "reject",
        reason: "测试回应：材料写明音乐预算 50 元，足够覆盖。",
        evidenceIds: ["ev-found"],
        change: "",
      },
    ],
    summary: "测试修订：复核后保留路线，返工风险仍然未知。",
    changed: false,
  },
  {
    strategyId: "C",
    strategy: {
      ...strategies[2],
      // The disputed claim is withdrawn, so its dispute must still be findable on the route.
      claims: [
        { id: "C2", text: "测试判断 C2：只使用自己撰写的图文。", status: "user", sourceIds: [] },
      ],
      firstAction: "测试第一步：先列出自己撰写的图文清单。",
    },
    responses: [],
    summary: "测试修订：撤回复用判断，改用自己撰写的图文。",
    changed: true,
  },
];

function step(versionId: string, stage: Stage, status: ArenaStep["status"]): ArenaStep {
  return {
    id: `${versionId}-${stage}`,
    versionId,
    stage,
    role: "fixture",
    status,
    error: null,
    startedAt: at,
    finishedAt: at,
  };
}

const verdict: NonNullable<ArenaVersion["verdict"]> = {
  outcome: "recommendation",
  preferred: "A",
  headline: "测试裁决：先做带返工预留的最小样片",
  rationale: "此结论仅用于界面测试，不代表任何模型输出。",
  conditions: ["测试条件：总工时不超过 7 小时。"],
  uncertainties: ["测试未知：真实返工比例待验证。"],
  nextActions: ["测试行动：写一页大纲。"],
  exitCondition: "测试退出：第三天仍无样片则缩减范围。",
  evidenceIds: ["ev-calc"],
  comparisons: [
    { strategyId: "A", status: "eligible", reason: "测试比较：工时刚好在上限内。" },
    { strategyId: "B", status: "unknown", reason: "测试比较：返工风险未知。" },
    { strategyId: "C", status: "violates", reason: "测试比较：素材版权未确认。" },
  ],
  attackFindings: [
    {
      attackId: "atk-1",
      status: "supported",
      reason: "测试回应：计算支持这条质疑。",
      evidenceIds: ["ev-calc"],
    },
    {
      attackId: "atk-2",
      status: "unresolved",
      reason: "测试回应：缺少返工数据。",
      evidenceIds: ["ev-none"],
    },
    {
      attackId: "atk-3",
      status: "refuted",
      reason: "测试回应：材料写明预算足够。",
      evidenceIds: ["ev-found"],
    },
  ],
};

function version(number: number, overrides: Partial<ArenaVersion> = {}): ArenaVersion {
  return {
    id: `fixture-v${number}`,
    number,
    challenge,
    status: "completed",
    stage: "judge",
    strategies,
    attacks,
    evidence,
    revisions,
    verdict,
    costCny: 0.123,
    reservedCny: 0,
    createdAt: at,
    changeReason: "",
    parentVersionId: null,
    error: null,
    ...overrides,
  };
}

function snapshotOf(
  versions: ArenaVersion[],
  stepStatus?: Partial<Record<Stage, ArenaStep["status"]>>,
): ArenaSnapshot {
  const stages: Stage[] = ["propose", "attack", "verify", "revise", "judge"];
  return {
    id: "fixture-arena",
    activeVersionId: versions[versions.length - 1].id,
    createdAt: at,
    versions,
    steps: versions.flatMap((v) =>
      stages.map((s) => step(v.id, s, stepStatus?.[s] ?? "completed")),
    ),
    events: [
      {
        seq: 1,
        arenaId: "fixture-arena",
        versionId: versions[versions.length - 1].id,
        type: "stage_completed",
        stage: "propose",
        actor: "fixture",
        message: "测试事件：提案完成",
        data: null,
        createdAt: at,
      },
    ],
    model: {
      id: "fixture-not-a-model",
      configured: true,
      promptVersion: "test-fixture",
      schemaVersion: "1.0.0",
    },
  };
}

/** Serves one fixed snapshot. Fresh Playwright contexts start without any stored arena. */
async function mountFixture(page: Page, snapshot: ArenaSnapshot) {
  await page.route("**/api/**", async (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === "/api/health")
      return r.fulfill({
        json: {
          status: "ok",
          version: "fixture",
          commit: "fixture",
          model: snapshot.model,
          requiresAccessCode: false,
          accessGranted: true,
        },
      });
    if (path.endsWith("/events"))
      return r.fulfill({ contentType: "text/event-stream", body: ": explicit fixture\n\n" });
    return r.fulfill({ json: snapshot });
  });
}

async function openArena(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "试填一个视频任务" }).click();
  await page.getByRole("button", { name: "让方案上场" }).click();
  await expect(page.getByRole("combobox", { name: "选择推演版本" })).toBeVisible();
  // Entering an arena moves focus to its goal; wait so later focus changes are not overridden.
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
}

/** Every saved image carries this ribbon, so it cannot pass as a real model run. */
async function capture(page: Page, testInfo: TestInfo, name: string, fullPage = true) {
  await page.evaluate(() => {
    if (document.getElementById("fixture-ribbon")) return;
    const ribbon = document.createElement("div");
    ribbon.id = "fixture-ribbon";
    ribbon.textContent = "测试替身画面 · 非模型输出 · explicit UI fixture";
    ribbon.style.cssText =
      "position:fixed;left:0;top:0;z-index:99999;padding:4px 10px;background:#111;color:#fff;font:12px sans-serif;pointer-events:none";
    document.body.appendChild(ribbon);
  });
  // A drawer caught mid-animation looks see-through, so only capture settled frames.
  await page.evaluate(() => Promise.allSettled(document.getAnimations().map((a) => a.finished)));
  // Fixed elements land mid-image when a full-page capture starts from a scrolled position.
  if (fullPage) await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  const file = `explicit-ui-fixture-${name}.png`;
  const dir = process.env.VISUAL_SHOTS_DIR;
  await page.screenshot({
    path: dir ? `${dir}/${file}` : testInfo.outputPath(file),
    fullPage,
  });
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

const disputes = (page: Page) => page.getByRole("region", { name: "三路对照与争议" });
const completed = () => snapshotOf([version(1)]);

test.describe("explicit UI fixture: desktop 1440x900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("arrives at the goal, ranks open disputes first and keeps tracks aligned", async ({
    page,
  }, testInfo) => {
    await mountFixture(page, completed());
    await openArena(page);
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await capture(page, testInfo, "desktop-fold", false);
    await capture(page, testInfo, "desktop-full");
    await expectNoHorizontalOverflow(page);

    const board = disputes(page);
    await expect(board.getByText("4 条争议，2 条未决")).toBeVisible();
    const rows = board.locator(".dispute-row");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText("尚无定论");
    await expect(rows.nth(1)).toContainText("待核验");
    await expect(rows.nth(3)).toContainText("质疑已反驳");

    const lanes = board.locator(".route-lane");
    await expect(lanes.nth(0)).toContainText("6 小时 → 7 小时");
    await expect(lanes.nth(0)).toContainText("当前建议");
    await expect(lanes.nth(1)).toContainText("复核未变");
    await expect(lanes.nth(2)).toContainText("触及限制");

    for (const selector of [".strategy-steps", ".claim-list", ".resource-block", ".first-action"]) {
      const tops = await page
        .locator(`.strategy-card ${selector}`)
        .evaluateAll((nodes) => nodes.map((n) => Math.round(n.getBoundingClientRect().top)));
      expect(tops, `${selector} lines up across routes`).toHaveLength(3);
      expect(new Set(tops).size, `${selector} lines up across routes`).toBe(1);
    }
  });

  test("claim, dispute, evidence and response stay connected", async ({ page }, testInfo) => {
    await mountFixture(page, completed());
    await openArena(page);
    await disputes(page)
      .getByRole("button", { name: /样片 2 小时没有算上录制后的返工/ })
      .click();
    const drawer = page.getByRole("dialog", { name: "这一条，站得住吗？" });
    await expect(drawer.getByText("质疑成立", { exact: true })).toBeVisible();
    await expect(drawer.getByRole("heading", { name: "测试计算：样片总工时" })).toBeVisible();
    await expect(drawer.getByText("接受质疑")).toBeVisible();
    await expect(drawer.getByText("引用证据：测试计算：样片总工时", { exact: true })).toBeVisible();
    await expect(drawer.getByText("ev-calc")).toHaveCount(0);
    await capture(page, testInfo, "desktop-evidence", false);

    await drawer.getByRole("button", { name: "在路线 A 中定位" }).click();
    await expect(drawer).toBeHidden();
    const thread = page.locator("#dispute-atk-1");
    await expect(thread).toBeInViewport();
    await expect(thread).toBeFocused();
    await expect(thread).toHaveClass(/selected/);
    // The claim was reworded by the revision, so the original words stay beside the dispute.
    await expect(thread.getByText("测试判断 A1：样片只需 2 小时。")).toBeVisible();
    await expect(thread).toContainText("把样片工时从 2 小时改为 3.5 小时");

    // The withdrawn claim's dispute remains reachable on its route.
    const withdrawn = page.locator(".strategy-C .claim-withdrawn");
    await expect(withdrawn).toContainText("已在修订中撤回或改写");
    await expect(withdrawn).toContainText("图文素材的版权状态没有确认");
    await withdrawn.getByRole("button", { name: /查看证据与回应/ }).click();
    await expect(drawer.getByText("核验失败")).toBeVisible();
    await expect(drawer.getByText("等待策略修订阶段回应。")).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("a revision shows removed and added text, including claims", async ({ page }, testInfo) => {
    await mountFixture(page, completed());
    await openArena(page);
    const card = page.locator(".strategy-A");
    await expect(card.locator(".revision-fields")).toContainText("关键判断");
    await card.getByText("查看修订前后").click();
    const claims = card.locator(".diff-item", { hasText: "关键判断" });
    await expect(claims.locator("ins").first()).toBeVisible();
    await expect(claims.locator("del").first()).toBeVisible();
    await expect(card.locator(".diff-item", { hasText: "时间估算" }).locator("ins")).toHaveText(
      "7",
    );
    await card.scrollIntoViewIfNeeded();
    await capture(page, testInfo, "desktop-revision-diff");
    await expect(page.locator(".strategy-B .revision-badge")).toHaveText("已复核");
    await expect(page.locator(".strategy-B .revision-diff summary")).toContainText("行动内容未变");
  });

  test("condition versions show what changed and history stays readable", async ({
    page,
  }, testInfo) => {
    const v1 = version(1, { status: "superseded" });
    const v2 = version(2, {
      challenge: { ...challenge, budget: 150 },
      changeReason: "测试：预算减少到 150 元。",
      parentVersionId: v1.id,
    });
    await mountFixture(page, snapshotOf([v1, v2]));
    await openArena(page);
    await expect(page.locator(".condition-delta")).toContainText("相比 V01");
    await expect(page.locator(".condition-delta")).toContainText("¥300 → ¥150");
    await capture(page, testInfo, "desktop-condition-version", false);

    await page.getByRole("combobox", { name: "选择推演版本" }).selectOption(v1.id);
    await expect(page.getByText("你正在查看历史版本。", { exact: false })).toBeVisible();
    await expect(page.locator(".condition-delta")).toHaveCount(0);
    await expect(page.locator(".strategy-A .claim").first()).toBeDisabled();
    await expect(page.locator(".strategy-A .section-caption").nth(1)).toContainText("历史版本只读");
    await disputes(page)
      .getByRole("button", { name: /样片 2 小时/ })
      .click();
    await expect(page.getByRole("dialog", { name: "这一条，站得住吗？" })).toBeVisible();
    await capture(page, testInfo, "desktop-history", false);
  });
});

test.describe("explicit UI fixture: phone 390x844", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("finds a dispute across routes and reads at a usable size", async ({ page }, testInfo) => {
    await mountFixture(page, completed());
    await openArena(page);
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expectNoHorizontalOverflow(page);
    await capture(page, testInfo, "mobile-fold", false);
    await capture(page, testInfo, "mobile-full");

    await expect(page.locator(".strategy-A")).toBeVisible();
    await expect(page.locator(".strategy-C")).toBeHidden();
    await page.getByRole("button", { name: "在路线 C 中定位 A 提出的这条质疑" }).click();
    await expect(page.getByRole("tab", { name: /C/ })).toHaveAttribute("aria-selected", "true");
    const thread = page.locator("#dispute-atk-4");
    await expect(thread).toBeInViewport();
    await capture(page, testInfo, "mobile-located", false);
    await expectNoHorizontalOverflow(page);

    await thread.getByRole("button", { name: /查看证据与回应/ }).click();
    const drawer = page.getByRole("dialog", { name: "这一条，站得住吗？" });
    await expect(drawer.getByText("核验失败")).toBeVisible();
    await capture(page, testInfo, "mobile-evidence", false);
    await page.getByRole("button", { name: "关闭证据详情" }).click();
    await expect(drawer).toBeHidden();

    const tooSmall = await page
      .locator(
        ".strategy-column.mobile-active :is(.strategy-thesis, .strategy-steps li, .claim, .thread-reason, .first-action > p), .dispute-text strong",
      )
      .evaluateAll((nodes) =>
        nodes
          .filter((n) => parseFloat(getComputedStyle(n).fontSize) < 13)
          .map((n) => n.textContent),
      );
    expect(tooSmall).toEqual([]);
    const smallTargets = await page
      .locator(".dispute-locate, .dispute-open, .lane-route, .mobile-route-tabs button")
      .evaluateAll((nodes) =>
        nodes.filter((n) => n.getBoundingClientRect().height < 44).map((n) => n.textContent),
      );
    expect(smallTargets).toEqual([]);
  });

  test("failed run keeps results and offers a refresh without overflow", async ({
    page,
  }, testInfo) => {
    await mountFixture(
      page,
      snapshotOf(
        [
          version(1, {
            status: "failed",
            stage: "verify",
            verdict: null,
            revisions: [],
            error: "测试错误：工具返回失败。",
          }),
        ],
        { verify: "failed", revise: "pending", judge: "pending" },
      ),
    );
    await openArena(page);
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "测试错误：工具返回失败。",
    );
    await expectNoHorizontalOverflow(page);
    await capture(page, testInfo, "mobile-failed", false);
  });
});

test.describe("explicit UI fixture: keyboard", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("disputes, drawer and locate work without a pointer", async ({ page }) => {
    await mountFixture(page, completed());
    await openArena(page);
    const open = disputes(page).locator(".dispute-open").first();
    await open.focus();
    const outline = await open.evaluate((n) => getComputedStyle(n).outlineStyle);
    await page.keyboard.press("Tab");
    const locate = disputes(page).locator(".dispute-locate").first();
    await expect(locate).toBeFocused();
    expect(await locate.evaluate((n) => getComputedStyle(n).outlineStyle)).toBe("solid");
    expect(outline).not.toBe("");

    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("dialog", { name: "这一条，站得住吗？" });
    await expect(page.getByRole("button", { name: "关闭证据详情" })).toBeFocused();
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(
        () => !!document.activeElement?.closest(".evidence-drawer"),
      );
      expect(inside, "focus stays inside the drawer").toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(open).toBeFocused();

    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    const located = page.locator(".dispute-thread.selected");
    await expect(located).toBeFocused();
    await expect(located).toBeInViewport();
  });

  test("skip link appears on focus and challenge dialog closes with Escape", async ({ page }) => {
    await mountFixture(page, completed());
    await page.goto("/");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "跳转到主要内容" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.getByRole("button", { name: "试填一个视频任务" }).click();
    await page.getByRole("button", { name: "让方案上场" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    const claim = page.locator(".strategy-A .claim").first();
    await claim.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "向这条判断发起挑战" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(claim).toBeFocused();
  });

  test("route tabs follow arrow keys on a narrow screen", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mountFixture(page, completed());
    await openArena(page);
    const tabA = page.locator("#tab-A");
    await tabA.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#tab-B")).toBeFocused();
    await expect(page.locator(".strategy-B")).toBeVisible();
    await page.keyboard.press("End");
    await expect(page.locator("#tab-C")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(tabA).toBeFocused();
  });
});

test.describe("explicit UI fixture: states", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("running state shows only real progress and respects reduced motion", async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mountFixture(
      page,
      snapshotOf(
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
        {
          propose: "running",
          attack: "pending",
          verify: "pending",
          revise: "pending",
          judge: "pending",
        },
      ),
    );
    await openArena(page);
    await expect(page.locator(".pending-card")).toHaveCount(2);
    await expect(disputes(page)).toContainText("交叉质疑尚未开始");
    await expect(disputes(page).locator(".route-lane").nth(1)).toContainText("等待提案");
    await expect(disputes(page).getByRole("link", { name: "跳到裁决" })).toHaveCount(0);
    const motion = await page
      .locator(".working-dot")
      .first()
      .evaluate((n) => getComputedStyle(n).animationName);
    expect(motion).toBe("none");
    expect(
      await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior),
    ).toBe("auto");
    await capture(page, testInfo, "desktop-running", false);
  });

  test("uncertain and paused runs say what is safe to do next", async ({ page }, testInfo) => {
    await mountFixture(
      page,
      snapshotOf(
        [
          version(1, {
            status: "uncertain",
            stage: "revise",
            verdict: null,
            revisions: [],
            reservedCny: 0.05,
            error: "测试错误：响应未完整收到。",
          }),
        ],
        { revise: "uncertain", judge: "pending" },
      ),
    );
    await openArena(page);
    const notice = page.getByRole("main").getByRole("alert");
    await expect(notice).toContainText("无法判断请求是否完成或已计费");
    await expect(notice).toContainText("预留不会释放");
    await expect(notice.getByRole("button", { name: "刷新状态" })).toBeVisible();
    await expect(page.locator(".stage.unknown")).toContainText("待确认");
    await expect(page.getByText("尚未形成最终裁决")).toBeVisible();
    await capture(page, testInfo, "desktop-uncertain", false);
  });

  test("paused run is a status, not an alert", async ({ page }) => {
    await mountFixture(
      page,
      snapshotOf([version(1, { status: "paused", stage: "verify", verdict: null, revisions: [] })]),
    );
    await openArena(page);
    await expect(page.getByText("本轮已停止")).toBeVisible();
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    await expect(page.getByText("已发出的请求仍可能返回并计费", { exact: false })).toBeVisible();
  });

  test("a rejected create shows the server's reason and keeps the form", async ({
    page,
  }, testInfo) => {
    const snapshot = completed();
    await mountFixture(page, snapshot);
    await page.route("**/api/arenas", (r) =>
      r.fulfill({
        status: 429,
        json: { error: "测试错误：今日次数已用完。", code: "DAILY_LIMIT" },
      }),
    );
    await page.goto("/");
    await page.getByRole("button", { name: "试填一个视频任务" }).click();
    await page.getByRole("button", { name: "让方案上场" }).click();
    const alert = page.getByRole("main").getByRole("alert");
    await expect(alert).toContainText("测试错误：今日次数已用完。");
    await expect(page.getByLabel("你的目标、备选方案或想法")).not.toHaveValue("");
    await capture(page, testInfo, "desktop-create-error", false);
    await alert.getByRole("button", { name: "关闭错误提示" }).click();
    await expect(alert).toBeHidden();
  });

  test("access code gate blocks the form until it is unlocked", async ({ page }, testInfo) => {
    await page.route("**/api/health", (r) =>
      r.fulfill({
        json: {
          status: "ok",
          version: "fixture",
          commit: "fixture",
          model: completed().model,
          requiresAccessCode: true,
          accessGranted: false,
        },
      }),
    );
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "凭访问码入场" })).toBeVisible();
    await expect(page.getByRole("button", { name: "让方案上场" })).toBeDisabled();
    await capture(page, testInfo, "desktop-access", false);
  });

  test("health failure explains itself and keeps start disabled", async ({ page }) => {
    await page.route("**/api/health", (r) =>
      r.fulfill({ status: 500, json: { error: "测试错误：服务不可用。", code: "INTERNAL_ERROR" } }),
    );
    await page.goto("/");
    await expect(page.getByText("连接恢复后刷新页面即可继续。")).toBeVisible();
    await expect(page.getByRole("button", { name: "让方案上场" })).toBeDisabled();
  });
});

test.describe("explicit UI fixture: home", () => {
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ] as const)
    test.describe(name, () => {
      test.use({ viewport });
      test("home reads clearly with no fake results", async ({ page }, testInfo) => {
        await mountFixture(page, completed());
        await page.goto("/");
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("让好想法，打过一场。");
        await expectNoHorizontalOverflow(page);
        await capture(page, testInfo, `${name}-home`);
      });
    });
});
