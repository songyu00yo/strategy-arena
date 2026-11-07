import { expect, test, type Page } from "@playwright/test";
import type { ArenaSnapshot } from "../../src/lib/contracts";
import type { DecisionReview } from "../../src/lib/decision-review";
import { configureFixtureModels } from "./intake.fixture";
import { advanceFixture, fixtureSnapshot, fixtureVersion } from "./ui.fixture";

// Explicit synthetic Decisions records. All review endpoints are intercepted; no paid model calls.
function completedSnapshot() {
  const snapshot = configureFixtureModels(fixtureSnapshot());
  for (let stage = 0; stage < 5; stage++) advanceFixture(snapshot);
  snapshot.versions[0].modelSelection = {
    requestedMode: "gpt-6.1-terra",
    provider: "openai",
    modelId: "gpt-6.1-terra",
    currency: "USD",
    policyVersion: "explicit-fixture",
    reason: "测试主推演固定为 Terra。",
  };
  return snapshot;
}
function fixtureReview(
  snapshot: ArenaSnapshot,
  versionId: string,
  overrides: Partial<DecisionReview> = {},
): DecisionReview {
  return {
    id: `fixture-review-${versionId}`,
    arenaId: snapshot.id,
    versionId,
    operationId: "00000000-0000-4000-8000-000000000001",
    model: "gpt-6-luna",
    status: "completed",
    inputHash: "1".repeat(64),
    configurationHash: "2".repeat(64),
    stale: false,
    answers: [
      {
        name: "route_a",
        type: "choice",
        choice: "conditional",
        confidence: 0.7,
        probabilities: [
          { value: "conditional", probability: 0.7 },
          { value: "violates", probability: 0.1 },
          { value: "unknown", probability: 0.2 },
        ],
      },
      {
        name: "route_b",
        type: "choice",
        choice: "conditional",
        confidence: 0.8,
        probabilities: [
          { value: "conditional", probability: 0.8 },
          { value: "violates", probability: 0.1 },
          { value: "unknown", probability: 0.1 },
        ],
      },
      {
        name: "route_c",
        type: "choice",
        choice: "unknown",
        confidence: 0.6,
        probabilities: [
          { value: "conditional", probability: 0.3 },
          { value: "violates", probability: 0.1 },
          { value: "unknown", probability: 0.6 },
        ],
      },
      {
        name: "preference",
        type: "choice",
        choice: "B",
        confidence: 0.5,
        probabilities: [
          { value: "A", probability: 0.1 },
          { value: "B", probability: 0.5 },
          { value: "C", probability: 0.1 },
          { value: "tie", probability: 0.1 },
          { value: "insufficient", probability: 0.1 },
          { value: "infeasible", probability: 0.1 },
        ],
      },
    ],
    usage: {
      inputTokens: 1000,
      outputTokens: 20,
      cachedInputTokens: 0,
      estimatedCny: 0,
      estimatedUsd: 0.00011,
      currency: "USD",
      provider: "openai",
      model: "gpt-6-luna",
      responseId: "explicit-fixture-response",
      durationMs: 120,
    },
    responseIdSource: "local-call-id",
    reservedUsd: 0,
    error: null,
    errorCode: null,
    canRetry: false,
    createdAt: "2026-11-06T00:00:00.000Z",
    updatedAt: "2026-11-06T00:00:00.000Z",
    ...overrides,
  };
}
async function restoreArena(
  page: Page,
  snapshot: ArenaSnapshot,
  reviewRoute: (route: import("@playwright/test").Route) => Promise<void>,
) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(
    (arenaId) => localStorage.setItem("strategy-arena:last-id", arenaId),
    snapshot.id,
  );
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/decision-review")) return reviewRoute(route);
    if (path === "/api/health")
      return route.fulfill({
        json: {
          status: "ok",
          version: "explicit-ui-fixture",
          commit: "fixture",
          accessGranted: true,
          requiresAccessCode: false,
          model: snapshot.model,
        },
      });
    if (path.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: ": explicit Decisions fixture\n\n",
      });
    if (path === `/api/arenas/${snapshot.id}` && route.request().method() === "GET")
      return route.fulfill({ json: snapshot });
    return route.fulfill({ status: 500, json: { error: "Unexpected fixture mutation" } });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "快速复核", exact: true })).toBeVisible();
}

test("explicit UI fixture: Luna review sends one POST, reopens from GET cache and preserves the Terra verdict", async ({
  page,
}) => {
  const snapshot = completedSnapshot();
  const original = structuredClone(snapshot.versions[0].verdict);
  let saved: DecisionReview | null = null;
  let posts = 0;
  let reads = 0;
  await restoreArena(page, snapshot, async (route) => {
    if (route.request().method() === "POST") {
      posts++;
      const input = route.request().postDataJSON();
      expect(input.versionId).toBe(snapshot.activeVersionId);
      expect(input.operationId).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
      saved = fixtureReview(snapshot, input.versionId, { operationId: input.operationId });
    } else {
      reads++;
      expect(new URL(route.request().url()).searchParams.get("versionId")).toBe(
        snapshot.activeVersionId,
      );
    }
    await route.fulfill({ json: saved });
  });
  await expect(page.getByText("gpt-6.1-terra", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "快速复核", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "快速复核 · Decisions", exact: true });
  await expect(dialog).toContainText("使用 GPT 6 Luna");
  await expect(dialog).toContainText(original!.headline);
  expect(posts).toBe(0);
  await dialog.getByRole("button", { name: "用 Luna 快速复核", exact: true }).click();
  await expect(
    dialog.locator(".decision-review-answer").getByText("倾向路线 B", { exact: true }),
  ).toBeVisible();
  await expect(dialog).toContainText("本轮建议 A，复核倾向 B");
  await dialog.getByRole("button", { name: "展开判断分布", exact: true }).click();
  await expect(
    dialog.getByText("选择倾向 · 模型对判断的信心 50.0%", { exact: true }),
  ).toBeVisible();
  await expect(dialog).toContainText("分值反映 Luna 对本次输入的判断");
  await expect(dialog).toContainText("本次复核约 $0.000110");
  for (let reopen = 0; reopen < 2; reopen++) {
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await page.getByRole("button", { name: "快速复核", exact: true }).click();
    await expect(
      dialog.locator(".decision-review-answer").getByText("倾向路线 B", { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "用 Luna 快速复核", exact: true })).toHaveCount(
      0,
    );
    await expect(dialog.getByRole("button", { name: "重新复核", exact: true })).toHaveCount(0);
  }
  expect(posts).toBe(1);
  await expect.poll(() => reads).toBeGreaterThanOrEqual(3);
  expect(snapshot.versions[0].verdict).toEqual(original);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: original!.headline, exact: true })).toBeVisible();
});

test("explicit UI fixture: uncertain review blocks repeats and historical unknown or refusal answers stay in their own version", async ({
  page,
}) => {
  const snapshot = completedSnapshot();
  const first = snapshot.versions[0];
  first.status = "superseded";
  first.verdict!.headline = "测试旧版裁决：先补充制作条件";
  const next = fixtureVersion(2, {
    ...first.challenge,
    goal: "测试当前目标：在更短期限内制作一支视频并保留旧版本",
  });
  snapshot.versions.push(next);
  snapshot.activeVersionId = next.id;
  for (let stage = 0; stage < 5; stage++) advanceFixture(snapshot);
  next.verdict!.headline = "测试当前裁决：先完成最小样片";
  let current: DecisionReview | null = null;
  const old = fixtureReview(snapshot, first.id, {
    answers: [
      {
        name: "route_a",
        type: "choice",
        choice: "unknown",
        confidence: 0.7,
        probabilities: [
          { value: "conditional", probability: 0.2 },
          { value: "violates", probability: 0.1 },
          { value: "unknown", probability: 0.7 },
        ],
      },
      { name: "route_b", type: "refusal" },
      { name: "route_c", type: "refusal" },
      { name: "preference", type: "refusal" },
    ],
  });
  const postedVersions: string[] = [];
  const readVersions: string[] = [];
  await restoreArena(page, snapshot, async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      postedVersions.push(body.versionId);
      current = fixtureReview(snapshot, next.id, {
        status: "uncertain",
        operationId: body.operationId,
        answers: [],
        usage: null,
        reservedUsd: 0.00011,
        error: "测试：响应未完整收到，无法确认费用。",
        errorCode: "DECISIONS_UNCERTAIN",
        canRetry: false,
      });
      return route.fulfill({ json: current });
    }
    const versionId = new URL(route.request().url()).searchParams.get("versionId")!;
    readVersions.push(versionId);
    return route.fulfill({ json: versionId === first.id ? old : current });
  });
  await page.getByRole("button", { name: "快速复核", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "快速复核 · Decisions", exact: true });
  await dialog.getByRole("button", { name: "用 Luna 快速复核", exact: true }).click();
  await expect(dialog).toContainText(
    "调用结果和费用还未确认，预留费用暂不释放，也暂不允许再次发起复核。",
  );
  await expect(dialog.getByRole("button", { name: /用 Luna 快速复核|重新复核/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("combobox", { name: "选择推演版本" }).selectOption(first.id);
  await page.getByRole("button", { name: "快速复核", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "快速复核 · Decisions", exact: true });
  await expect(dialog).toContainText(first.verdict!.headline);
  await expect(
    dialog.locator(".decision-review-answer").getByText("关键条件待确认", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("本项未作判断", { exact: true })).toHaveCount(3);
  await expect(dialog).not.toContainText("测试：响应未完整收到");
  await expect(dialog.getByRole("button", { name: /用 Luna 快速复核|重新复核/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("combobox", { name: "选择推演版本" }).selectOption(next.id);
  await page.getByRole("button", { name: "快速复核", exact: true }).click();
  await expect(dialog).toContainText(next.verdict!.headline);
  await expect(dialog).toContainText("调用结果和费用还未确认");
  await expect(dialog.getByRole("button", { name: /用 Luna 快速复核|重新复核/ })).toHaveCount(0);
  expect(postedVersions).toEqual([next.id]);
  expect(readVersions).toContain(first.id);
  expect(readVersions).toContain(next.id);
});
