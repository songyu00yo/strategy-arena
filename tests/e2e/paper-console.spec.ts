// Explicit synthetic UI fixture for the paper console layout. Never contacts a model.
import { expect, test, type Page } from "@playwright/test";
import type { ArenaSnapshot } from "../../src/lib/contracts";
import { advanceFixture, fixtureSnapshot } from "./ui.fixture";

const LONG_DRAFT = [
  "测试草稿：若目标岗位从研究生学习中明显受益，且能承担备考和读研投入及落榜风险，可考虑考研。",
  "测试草稿：先问倾向什么岗位或研究方向，是否需要尽早获得收入，数学、英语和专业课基础如何。",
  "测试草稿：查看目标岗位学历要求，与本科直接就业路径比较；选择候选院校，查当年招生要求。",
  "测试草稿：结合课程记录评估备考基础，估算备考和读研时间、必要费用及放弃就业的机会成本。",
  "测试草稿：若考研对目标有价值、准备和投入可承受，可选报考；若就业更符合目标与现实条件，可选就业。",
  "测试草稿：两者均有条件时按收益、投入和风险取舍；关键条件不明则暂缓。",
];

/** The running state from the reported screenshot: revise stage, a 13-step agent chain and a long live draft. */
function runningSnapshot(): ArenaSnapshot {
  const snapshot = fixtureSnapshot();
  for (let i = 0; i < 3; i++) advanceFixture(snapshot);
  const version = snapshot.versions[0];
  version.status = "running";
  const action = (kind: string, role: string, round: number, status: string) => ({
    id: `${kind}-${role}-${round}`,
    kind,
    role,
    round,
    dependencies: [],
    status,
  });
  version.agent = {
    protocol: "bounded-agent-1.3",
    limits: { modelRequests: 20, tools: 12, externalTools: 6, plans: 3, rounds: 2 },
    plans: [
      {
        summary:
          "测试规划：现有材料确认这是一位大三学生，愿意继续学习，但职业目标、备考基础和现实限制仍不明确。可以先比较两条路径的适用条件，不必等所有信息齐全才给建议。",
        questions: ["目标岗位是否看重研究生学历？", "备考期间是否需要收入？"],
        directions: [],
        tools: [],
        next: "discuss",
        reviseRoles: ["A", "B", "C"],
        stopCondition: "测试停止条件。",
        checkpoint: 1,
        evidenceHash: "fixture",
      },
    ],
    actions: [
      action("plan", "agent", 1, "completed"),
      action("propose", "A", 1, "completed"),
      action("propose", "B", 1, "completed"),
      action("propose", "C", 1, "completed"),
      action("attack", "A", 1, "completed"),
      action("attack", "B", 1, "completed"),
      action("attack", "C", 1, "completed"),
      action("tools", "agent", 1, "completed"),
      { ...action("plan", "agent", 1, "completed"), id: "plan-agent-1-second" },
      action("revise", "A", 1, "running"),
      action("revise", "B", 1, "pending"),
      action("revise", "C", 1, "pending"),
      action("judge", "agent", 2, "pending"),
    ],
    toolsUsed: 3,
    externalToolsUsed: 0,
  } as ArenaSnapshot["versions"][number]["agent"];
  return snapshot;
}

async function serve(page: Page, snapshot: ArenaSnapshot, draftText: string[]) {
  const draft = {
    stepId: "paper-draft",
    versionId: snapshot.activeVersionId,
    stage: "revise",
    role: "A",
    revision: 1,
    fields: Object.fromEntries(draftText.map((text, index) => [`f${index}`, text])),
    status: "generating",
  };
  await page.addInitScript(() => sessionStorage.setItem("arena-intro", "1"));
  page.on("pageerror", (error) => console.log("PAGEERROR", error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.log("CONSOLE", message.text().slice(0, 300));
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/health")
      return route.fulfill({ json: { status: "ok", model: snapshot.model, accessGranted: true } });
    if (url.pathname.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: `id: 21\nevent: arena\ndata: ${JSON.stringify({ events: [{ seq: 21, arenaId: snapshot.id, versionId: snapshot.activeVersionId, type: "draft_updated", stage: "revise", actor: "A", message: "生成中", data: draft, createdAt: snapshot.createdAt }] })}\n\n`,
      });
    if (url.pathname.endsWith("/advance")) return new Promise<void>(() => {});
    if (url.pathname === `/api/arenas/${snapshot.id}`) return route.fulfill({ json: snapshot });
    return route.fulfill({ status: 404, json: { error: "explicit fixture boundary" } });
  });
  await page.goto(`/?arena=${snapshot.id}`);
  await expect(page.getByLabel("实时生成文字")).toContainText("尚未核验");
}

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 760 },
]) {
  test(`agent progress stays fully visible beside the stage at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await serve(page, runningSnapshot(), LONG_DRAFT);
    const progress = page.locator(".agent-progress");
    await expect(progress).toBeVisible();
    const box = (await progress.boundingBox())!;
    for (const selector of [".c-main", ".c-track", ".c-metrics", ".c-bottom"]) {
      const other = page.locator(selector).first();
      if (!(await other.count()) || !(await other.isVisible())) continue;
      const otherBox = (await other.boundingBox())!;
      expect(overlaps(box, otherBox), `${selector} overlaps agent progress`).toBe(false);
    }
    // Whatever is on top at the panel's centre is the panel itself.
    const owner = await page.evaluate(
      ({ x, y }) => {
        const hit = document.elementFromPoint(x, y);
        return !!hit?.closest(".agent-progress");
      },
      { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 40) },
    );
    expect(owner).toBe(true);
    await page.waitForTimeout(2600);
    await page.screenshot({
      path: `test-results/paper-console-${viewport.width}.png`,
      animations: "disabled",
    });
  });
}

test("agent progress stays readable on a phone viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await serve(page, runningSnapshot(), LONG_DRAFT);
  await page.waitForTimeout(2600);
  for (const panelSelector of [".agent-progress", ".agent-drafts"]) {
    const panel = page.locator(panelSelector);
    await expect(panel).toBeVisible();
    const panelBox = (await panel.boundingBox())!;
    for (const selector of [".c-stage3", ".c-track", ".c-metrics", ".c-bottom"]) {
      const other = page.locator(selector).first();
      await expect(other).toBeVisible();
      const otherBox = (await other.boundingBox())!;
      expect(overlaps(panelBox, otherBox), `${selector} overlaps ${panelSelector}`).toBe(false);
    }
  }
  // Hit-test real rendered panels and content after bringing each into the viewport.
  for (const selector of [".agent-progress", ".agent-draft.live", ".c-metrics", ".c-board"]) {
    const target = page.locator(selector).first();
    await target.scrollIntoViewIfNeeded();
    await expect(target).toBeInViewport();
    const ownsVisibleCentre = await target.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const left = Math.max(0, box.left);
      const right = Math.min(innerWidth, box.right);
      const top = Math.max(0, box.top);
      const bottom = Math.min(innerHeight, box.bottom);
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      return !!hit && element.contains(hit);
    });
    expect(ownsVisibleCentre, `${selector} is covered at its visible centre`).toBe(true);
  }
  await page.screenshot({ path: "test-results/paper-console-390.png", fullPage: true });
});

test("revised hours label unknown values and preserve zero in the synthetic result", async ({
  page,
}) => {
  const snapshot = fixtureSnapshot();
  for (let i = 0; i < 5; i++) advanceFixture(snapshot);
  const version = snapshot.versions[0];
  const cases = [
    { id: "A", before: 768, after: null, expected: "768 → 待核实 小时" },
    { id: "B", before: null, after: 0, expected: "待核实 → 0 小时" },
    { id: "C", before: null, after: null, expected: "待核实 小时" },
  ];
  for (const entry of cases) {
    version.strategies.find((strategy) => strategy.id === entry.id)!.estimatedHours = entry.before;
    version.revisions.find(
      (revision) => revision.strategyId === entry.id,
    )!.strategy.estimatedHours = entry.after;
  }
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/health")
      return route.fulfill({ json: { status: "ok", model: snapshot.model, accessGranted: true } });
    if (url.pathname.endsWith("/events"))
      return route.fulfill({ contentType: "text/event-stream", body: "" });
    if (url.pathname === `/api/arenas/${snapshot.id}`) return route.fulfill({ json: snapshot });
    return route.fulfill({ status: 404, json: { error: "explicit fixture boundary" } });
  });
  await page.goto(`/?arena=${snapshot.id}`);
  for (const entry of cases) {
    const estimate = page.locator(`[data-board="${entry.id}"] .est`);
    await expect(estimate).toBeVisible();
    await expect(estimate).toContainText(entry.expected);
    await expect(estimate).not.toContainText(/null|undefined/);
  }
});

test("the opening never covers the whole page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const snapshot = fixtureSnapshot();
  advanceFixture(snapshot);
  snapshot.versions[0].status = "running";
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/health")
      return route.fulfill({ json: { status: "ok", model: snapshot.model, accessGranted: true } });
    if (url.pathname.endsWith("/events"))
      return route.fulfill({ contentType: "text/event-stream", body: "" });
    if (url.pathname.endsWith("/advance")) return new Promise<void>(() => {});
    if (url.pathname === `/api/arenas/${snapshot.id}`) return route.fulfill({ json: snapshot });
    return route.fulfill({ status: 404, json: { error: "explicit fixture boundary" } });
  });
  await page.goto(`/?arena=${snapshot.id}`);
  await expect(page.locator(".c-board").first()).toBeVisible();
  for (let i = 0; i < 20; i++) {
    const covering = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("body *")]
        .filter((node) => {
          const style = getComputedStyle(node);
          if (
            style.position !== "fixed" ||
            (style.pointerEvents === "none" && Number(style.opacity) === 0)
          )
            return false;
          if (node.matches("canvas, .c-wall, .c-wall *, dialog, .c-fx")) return false;
          if (Number(style.opacity) < 0.05 || style.visibility === "hidden") return false;
          const box = node.getBoundingClientRect();
          return box.width * box.height > innerWidth * innerHeight * 0.6;
        })
        .map((node) => node.className),
    );
    expect(covering, "full-screen layer during playback").toEqual([]);
    await page.waitForTimeout(200);
  }
});
