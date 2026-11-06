/** Decisions adapter integration with explicit HTTP/ledger test doubles; no paid model calls. */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChallengeSchema, type Strategy, type Verdict } from "../src/lib/contracts";
import { DECISION_PREFERENCE_CHOICES, DECISION_ROUTE_CHOICES } from "../src/lib/decision-review";
const billing = vi.hoisted(() => ({
  reserveBilling: vi.fn(),
  settleBilling: vi.fn(),
  holdBilling: vi.fn(),
}));
vi.mock("../src/lib/server/billing", async (original) => ({
  ...(await original<typeof import("../src/lib/server/billing")>()),
  ...billing,
}));
import { closeDb, db, getVersion, saveVersion } from "../src/lib/server/db";
import { createArena } from "../src/lib/server/runtime";
import {
  getDecisionReview,
  parseDecisionAnswers,
  runDecisionReview,
} from "../src/lib/server/decision-review";
import { GET, POST } from "../src/app/api/arenas/[id]/decision-review/route";
import { ensureOwner } from "../src/lib/server/auth";
const owner = "synthetic-owner";
function primary(selectedOwner = owner) {
  const arena = createArena(
    ChallengeSchema.parse({
      goal: "在现有条件内比较三条课程学习路线",
      constraints: "当前两名成员，不可增人",
      budget: 100,
      timeHours: 8,
    }),
    selectedOwner,
    "gpt-6.1-terra",
  );
  const version = getVersion(arena.activeVersionId);
  version.status = "completed";
  version.strategies = (["A", "B", "C"] as const).map(
    (id): Strategy => ({
      id,
      title: `合成路线${id}`,
      thesis: "仅供接口测试",
      steps: ["先核实必要条件"],
      claims: [{ id: `${id}-1`, text: "尚未完成外部核实", status: "unknown", sourceIds: [] }],
      resources: "现有设备",
      firstAction: "检查设备",
      failureCondition: "关键条件不成立",
      estimatedCost: 60,
      estimatedHours: 4,
    }),
  );
  version.verdict = {
    outcome: "recommendation",
    preferred: "A",
    headline: "合成主裁决",
    rationale: "只为接口边界提供数据",
    conditions: ["先核实条件"],
    uncertainties: ["外部事实仍未知"],
    nextActions: ["先核实条件"],
    exitCondition: "不满足硬限制就停止",
    evidenceIds: [],
    comparisons: version.strategies.map((route) => ({
      strategyId: route.id,
      status: "unknown",
      reason: "待核实",
    })),
    attackFindings: [],
  } as Verdict;
  version.costUsd = 0.123;
  version.costCny = 0;
  saveVersion(version);
  return { arenaId: arena.id, versionId: version.id };
}
function choice(name: string, values: readonly string[], selected = values[0]) {
  return {
    type: "choice",
    name,
    choice: selected,
    confidence: 0.6,
    probabilities: values.map((value) => ({
      value,
      probability: value === selected ? 0.6 : 0.4 / (values.length - 1),
    })),
  };
}
function answers() {
  return [
    choice("route_a", DECISION_ROUTE_CHOICES),
    choice("route_b", DECISION_ROUTE_CHOICES),
    choice("route_c", DECISION_ROUTE_CHOICES),
    choice("preference", DECISION_PREFERENCE_CHOICES, "A"),
  ];
}
function response(
  options: {
    answers?: unknown;
    usage?: unknown;
    headers?: Record<string, string>;
    model?: string;
  } = {},
) {
  return Response.json(
    {
      model: options.model ?? "gpt-6-luna",
      answers: options.answers ?? answers(),
      usage: options.usage ?? {
        input_tokens: 1000,
        input_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 },
        output_tokens: 80,
        total_tokens: 1080,
      },
    },
    { headers: options.headers ?? { "x-request-id": "req_synthetic_decisions" } },
  );
}
beforeEach(() => {
  closeDb();
  vi.resetAllMocks();
  for (const [name, value] of Object.entries({
    ARENA_DATABASE_PATH: ":memory:",
    OPENAI_API_KEY: "SYNTHETIC_KEY_NOT_FOR_OUTPUT",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    OPENAI_MODEL_ID: "gpt-6.1-terra",
    OPENAI_INPUT_PRICE_PER_MILLION: "1",
    OPENAI_OUTPUT_PRICE_PER_MILLION: "5",
    OPENAI_TIMEOUT_MS: "60000",
    ARENA_DAILY_VISITOR_LIMIT: "30",
    ARENA_SESSION_SECRET: "synthetic-session-only-not-a-secret-0123456789",
  }))
    vi.stubEnv(name, value);
  vi.stubEnv("ARENA_ACCESS_TOKEN", undefined);
});
afterEach(() => {
  closeDb();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("optional Decisions review with separate billing and immutable primary result", () => {
  it("uses the official Luna Decisions shape, separate pricing, and never edits the primary version", async () => {
    const ids = primary(),
      before = structuredClone(getVersion(ids.versionId));
    const fetch = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetch);
    const review = await runDecisionReview(ids.arenaId, ids.versionId, owner, randomUUID());
    expect(review).toMatchObject({
      status: "completed",
      model: "gpt-6-luna",
      canRetry: false,
      reservedUsd: 0,
      responseIdSource: "x-request-id",
      usage: {
        cacheWriteInputTokens: 100,
        estimatedUsd: 0.000085,
        estimatedCny: 0,
        outputTokens: 80,
        responseId: "req_synthetic_decisions",
      },
    });
    const [url, init] = fetch.mock.calls[0],
      body = JSON.parse(init.body);
    expect(url).toBe("https://api.openai.com/v1/decisions");
    expect(init.redirect).toBe("error");
    expect(body).toMatchObject({ model: "gpt-6-luna", prompt_cache_options: { mode: "explicit" } });
    expect(body.prompt_cache_options).not.toHaveProperty("breakpoints");
    expect(body.questions.map((question: { name: string }) => question.name)).toEqual([
      "route_a",
      "route_b",
      "route_c",
      "preference",
    ]);
    expect(JSON.parse(body.input).data.challenge.constraints).toContain("两名成员");
    expect(billing.reserveBilling).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", currency: "USD", attemptId: review.id }),
    );
    expect(billing.settleBilling).toHaveBeenCalledWith(
      review.id,
      expect.objectContaining({ amount: 85, outputTokens: 80, cachedInputTokens: 200 }),
    );
    expect(getVersion(ids.versionId)).toEqual(before);
    expect(JSON.stringify(review)).not.toContain("SYNTHETIC_KEY_NOT_FOR_OUTPUT");
    expect(getDecisionReview(ids.arenaId, ids.versionId, owner)?.id).toBe(review.id);
    expect(review.usage?.cacheWriteInputTokens).toBe(100);
    const reservation = billing.reserveBilling.mock.calls[0][0];
    expect(reservation.maxTokens).toBe(
      (Buffer.byteLength(JSON.stringify(body), "utf8") + 4096) * 4 + 4096,
    );
    const event = db()
      .prepare("SELECT data FROM events WHERE type='review_completed' AND version_id=?")
      .get(ids.versionId) as { data: string };
    expect(JSON.parse(event.data)).toMatchObject({
      kind: "decision-review",
      usage: { model: "gpt-6-luna" },
    });
  });
  it("deduplicates in-flight, completed, and repeated-click requests without a second reservation", async () => {
    const ids = primary();
    let finish!: (value: Response) => void;
    const fetch = vi.fn().mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const operationId = randomUUID(),
      first = runDecisionReview(ids.arenaId, ids.versionId, owner, operationId);
    expect(getDecisionReview(ids.arenaId, ids.versionId, owner)?.status).toBe("pending");
    const repeated = await runDecisionReview(ids.arenaId, ids.versionId, owner, randomUUID());
    expect(repeated.status).toBe("pending");
    expect(fetch).toHaveBeenCalledTimes(1);
    finish(response());
    const completed = await first;
    expect((await runDecisionReview(ids.arenaId, ids.versionId, owner, operationId)).id).toBe(
      completed.id,
    );
    expect((await runDecisionReview(ids.arenaId, ids.versionId, owner, randomUUID())).id).toBe(
      completed.id,
    );
    expect(billing.reserveBilling).toHaveBeenCalledTimes(1);
  });
  it("stores refusal answers separately and explicitly labels a local response identity", async () => {
    const ids = primary(),
      values = answers();
    values[1] = { type: "refusal", name: "route_b" } as unknown as ReturnType<
      typeof answers
    >[number];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ answers: values, headers: {} })));
    const review = await runDecisionReview(ids.arenaId, ids.versionId, owner, randomUUID());
    expect(review.answers[1]).toEqual({ type: "refusal", name: "route_b" });
    expect(review.responseIdSource).toBe("local-call-id");
    expect(review.usage?.responseId).toBe(review.id);
  });
  it("settles malformed answers, and retries a known failure only after a new explicit operation", async () => {
    const ids = primary(),
      operationId = randomUUID();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({ answers: [{ type: "choice", name: "route_a", choice: "invented" }] }),
      )
      .mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetch);
    const failed = await runDecisionReview(ids.arenaId, ids.versionId, owner, operationId);
    expect(failed).toMatchObject({
      status: "failed",
      canRetry: true,
      errorCode: "DECISIONS_INVALID_ANSWERS",
      usage: { estimatedUsd: 0.000085 },
    });
    expect((await runDecisionReview(ids.arenaId, ids.versionId, owner, operationId)).id).toBe(
      failed.id,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await runDecisionReview(ids.arenaId, ids.versionId, owner, randomUUID())).status).toBe(
      "completed",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("holds uncertain network requests and refuses a new request even after configuration changes", async () => {
    const ids = primary(),
      fetch = vi.fn().mockRejectedValue(new Error("PRIVATE_PROVIDER_BODY"));
    vi.stubGlobal("fetch", fetch);
    const failed = await runDecisionReview(ids.arenaId, ids.versionId, owner, randomUUID());
    expect(failed).toMatchObject({ status: "uncertain", canRetry: false });
    expect(failed.reservedUsd).toBeGreaterThan(0);
    expect(failed.error).not.toContain("PRIVATE_PROVIDER_BODY");
    expect(billing.holdBilling).toHaveBeenCalledWith(failed.id);
    vi.stubEnv("OPENAI_TIMEOUT_MS", "65000");
    expect((await runDecisionReview(ids.arenaId, ids.versionId, owner, randomUUID())).id).toBe(
      failed.id,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("recovers an expired pending review into unknown and never re-dispatches it", async () => {
    const ids = primary();
    let finish!: (value: Response) => void;
    const fetch = vi.fn().mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const pending = runDecisionReview(ids.arenaId, ids.versionId, owner, randomUUID());
    const first = getDecisionReview(ids.arenaId, ids.versionId, owner)!;
    db()
      .prepare("UPDATE decision_reviews SET lease_until=? WHERE id=?")
      .run(Date.now() - 1, first.id);
    expect(getDecisionReview(ids.arenaId, ids.versionId, owner)).toMatchObject({
      status: "uncertain",
      canRetry: false,
    });
    expect((await runDecisionReview(ids.arenaId, ids.versionId, owner, randomUUID())).id).toBe(
      first.id,
    );
    finish(response());
    await pending;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(billing.settleBilling).toHaveBeenCalledTimes(1);
  });
  it("preserves unknown usage and settles a reservation overrun before stopping", async () => {
    const ids = primary(),
      fetch = vi
        .fn()
        .mockResolvedValueOnce(
          response({ usage: { input_tokens: 5, output_tokens: 2, total_tokens: 9 } }),
        );
    vi.stubGlobal("fetch", fetch);
    expect(await runDecisionReview(ids.arenaId, ids.versionId, owner, randomUUID())).toMatchObject({
      status: "uncertain",
      usage: null,
    });
    expect(billing.settleBilling).not.toHaveBeenCalled();
    const other = primary("other-owner");
    fetch.mockResolvedValueOnce(
      response({ usage: { input_tokens: 1000000, output_tokens: 0, total_tokens: 1000000 } }),
    );
    const overrun = await runDecisionReview(
      other.arenaId,
      other.versionId,
      "other-owner",
      randomUUID(),
    );
    expect(overrun).toMatchObject({
      status: "failed",
      canRetry: false,
      errorCode: "DECISIONS_RESERVATION_EXCEEDED",
      usage: { inputTokens: 1000000, estimatedUsd: 0.2 },
    });
    expect(billing.settleBilling).toHaveBeenCalledWith(
      overrun.id,
      expect.objectContaining({ amount: 200000 }),
    );
  });
  it("refuses missing keys, hostile hosts, nonterminal versions, missing routes and cross-arena IDs", async () => {
    const ids = primary(),
      fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(await runDecisionReview(ids.arenaId, ids.versionId, owner, randomUUID())).toMatchObject({
      status: "failed",
      errorCode: "DECISIONS_NOT_CONFIGURED",
    });
    expect(billing.reserveBilling).not.toHaveBeenCalled();
    vi.stubEnv("OPENAI_API_KEY", "synthetic");
    vi.stubEnv("OPENAI_BASE_URL", "https://evil.example/v1");
    await expect(
      runDecisionReview(ids.arenaId, ids.versionId, owner, randomUUID()),
    ).rejects.toMatchObject({ code: "DECISIONS_INVALID_ENDPOINT" });
    vi.stubEnv("OPENAI_BASE_URL", "https://api.openai.com/v1");
    await expect(
      runDecisionReview(ids.arenaId, ids.versionId, "wrong-owner", randomUUID()),
    ).rejects.toMatchObject({ status: 404 });
    const version = getVersion(ids.versionId);
    version.status = "ready";
    saveVersion(version);
    await expect(
      runDecisionReview(ids.arenaId, ids.versionId, owner, randomUUID()),
    ).rejects.toMatchObject({ code: "REVIEW_VERSION_NOT_TERMINAL" });
    version.status = "completed";
    version.strategies.pop();
    saveVersion(version);
    await expect(
      runDecisionReview(ids.arenaId, ids.versionId, owner, randomUUID()),
    ).rejects.toMatchObject({ code: "REVIEW_ROUTES_REQUIRED" });
    const other = primary(owner);
    await expect(
      runDecisionReview(other.arenaId, ids.versionId, owner, randomUUID()),
    ).rejects.toMatchObject({ status: 404 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects application-size overflow without truncating source data or reserving money", async () => {
    const ids = primary(),
      version = getVersion(ids.versionId);
    version.challenge.materials = "原".repeat(20000);
    version.evidence = Array.from({ length: 9 }, (_, index) => ({
      id: `E-${index}`,
      attackId: "attack-A",
      tool: "search_materials" as const,
      status: "found" as const,
      title: "合成边界证据",
      content: "文".repeat(6000),
      source: "synthetic",
      sourceIds: [],
      expression: null,
      result: null,
      assumptions: "",
      createdAt: new Date().toISOString(),
    }));
    saveVersion(version);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      runDecisionReview(ids.arenaId, ids.versionId, owner, randomUUID()),
    ).rejects.toMatchObject({ code: "DECISIONS_INPUT_TOO_LARGE", status: 413 });
    expect(fetch).not.toHaveBeenCalled();
    expect(billing.reserveBilling).not.toHaveBeenCalled();
    expect(getVersion(ids.versionId)).toEqual(version);
  });
  it("keeps saved reviews readable if current dispatch settings become invalid", async () => {
    const ids = primary();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
    const completed = await runDecisionReview(ids.arenaId, ids.versionId, owner, randomUUID());
    vi.stubEnv("OPENAI_BASE_URL", "https://not-official.example/v1");
    expect(getDecisionReview(ids.arenaId, ids.versionId, owner)).toMatchObject({
      id: completed.id,
      stale: true,
      status: "completed",
    });
  });
  it("preserves reported usage if settlement fails and keeps the reservation unknown", async () => {
    const ids = primary();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
    billing.settleBilling.mockImplementationOnce(() => {
      throw new Error("synthetic ledger failure");
    });
    const review = await runDecisionReview(ids.arenaId, ids.versionId, owner, randomUUID());
    expect(review).toMatchObject({
      status: "uncertain",
      canRetry: false,
      usage: { inputTokens: 1000, cacheWriteInputTokens: 100, estimatedUsd: 0.000085 },
    });
    expect(review.reservedUsd).toBeGreaterThan(0);
  });
  it("labels stale archived results without changing their source hash or the primary version", async () => {
    const ids = primary();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
    const first = await runDecisionReview(ids.arenaId, ids.versionId, owner, randomUUID());
    const version = getVersion(ids.versionId);
    version.challenge.constraints = "当前一名成员，不可增人";
    saveVersion(version);
    const archived = getDecisionReview(ids.arenaId, ids.versionId, owner)!;
    expect(archived).toMatchObject({ id: first.id, inputHash: first.inputHash, stale: true });
  });
});
describe("strict finite Decisions answers", () => {
  it.each([
    "duplicate-name",
    "wrong-order",
    "unknown-choice",
    "NaN",
    "negative-probability",
    "duplicate-probability",
    "wrong-sum",
  ])("rejects %s before exposing a result", (kind) => {
    const values = answers();
    if (kind === "duplicate-name") values[1].name = "route_a";
    if (kind === "wrong-order") [values[0], values[1]] = [values[1], values[0]];
    if (kind === "unknown-choice") values[0].choice = "guaranteed";
    if (kind === "NaN") values[0].confidence = NaN;
    if (kind === "negative-probability") values[0].probabilities[0].probability = -0.1;
    if (kind === "duplicate-probability")
      values[0].probabilities[1].value = values[0].probabilities[0].value;
    if (kind === "wrong-sum")
      values[0].probabilities.forEach((item) => {
        item.probability = 0.9;
      });
    expect(() => parseDecisionAnswers(values)).toThrow();
  });
});
describe("Decisions GET/POST ownership and request boundaries", () => {
  it("checks origin, cookie ownership and UUID input, returning pending/completed via the same API", async () => {
    const session = ensureOwner(new Request("http://127.0.0.1:3350/")),
      ids = primary(session.owner);
    const cookie = session.cookie!.split(";")[0],
      context = { params: Promise.resolve({ id: ids.arenaId }) };
    const fetch = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetch);
    const post = (origin: string) =>
      new Request(`http://127.0.0.1:3350/api/arenas/${ids.arenaId}/decision-review`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie },
        body: JSON.stringify({ versionId: ids.versionId, operationId: randomUUID() }),
      });
    expect((await POST(post("http://evil.example"), context)).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    const completed = await POST(post("http://127.0.0.1:3350"), context);
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({ status: "completed", model: "gpt-6-luna" });
    const get = await GET(
      new Request(
        `http://127.0.0.1:3350/api/arenas/${ids.arenaId}/decision-review?versionId=${ids.versionId}`,
        { headers: { cookie } },
      ),
      context,
    );
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ status: "completed" });
    expect(
      (
        await GET(
          new Request(
            `http://127.0.0.1:3350/api/arenas/${ids.arenaId}/decision-review?versionId=bad`,
            { headers: { cookie } },
          ),
          context,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await GET(
          new Request(
            `http://127.0.0.1:3350/api/arenas/${ids.arenaId}/decision-review?versionId=${ids.versionId}`,
          ),
          context,
        )
      ).status,
    ).toBe(404);
  });
});
