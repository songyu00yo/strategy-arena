// Explicit synthetic UI fixture. Every string below is test data, not model output or evaluation
// evidence. All /api/** traffic is intercepted, so these checks cannot reach a model or a database.
import { expect, type Page, type TestInfo } from "@playwright/test";
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

export const at = "2026-11-05T00:00:00.000Z";
export const challenge: Challenge = {
  goal: "测试任务：七天内由一人完成一支五分钟知识视频，比较三条可执行路线。",
  constraints: "只有一人执行；不购买新设备；不使用 AI 生成镜头。",
  preferences: "优先准确，其次才是画面。",
  options: [],
  materials: "测试材料：每天可投入 1 小时；音乐预算最多 50 元。",
  domain: "creation",
  budget: 300,
  timeHours: 7,
};

export function route(
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

export const strategies: Strategy[] = [
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

export const attacks: Attack[] = [
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

export const evidence: Evidence[] = [
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

export const revisions: Revision[] = [
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

export function step(versionId: string, stage: Stage, status: ArenaStep["status"]): ArenaStep {
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

export const verdict: NonNullable<ArenaVersion["verdict"]> = {
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

export function version(number: number, overrides: Partial<ArenaVersion> = {}): ArenaVersion {
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

export function snapshotOf(
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
export async function mountFixture(page: Page, snapshot: ArenaSnapshot) {
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

export async function openArena(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "试填一个视频任务" }).click();
  await page.getByRole("button", { name: "让方案上场" }).click();
  await expect(page.getByRole("combobox", { name: "选择推演版本" })).toBeVisible();
  // Entering an arena moves focus to its goal; wait so later focus changes are not overridden.
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
}

/** Every saved image carries this ribbon, so it cannot pass as a real model run. */
export async function capture(page: Page, testInfo: TestInfo, name: string, fullPage = true) {
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
  await page.evaluate(() =>
    Promise.allSettled(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished),
    ),
  );
  // Fixed elements land mid-image when a full-page capture starts from a scrolled position.
  if (fullPage) await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  const file = `explicit-ui-fixture-${name}.png`;
  const dir = process.env.VISUAL_SHOTS_DIR;
  await page.screenshot({
    path: dir ? `${dir}/${file}` : testInfo.outputPath(file),
    fullPage,
  });
}

export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}
