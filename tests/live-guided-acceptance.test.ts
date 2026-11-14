/** Runner planning and local synthetic files only; these tests do not invoke the model/runtime. */
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntakeQuestion } from "../src/lib/intake-contracts";
import {
  answerFrozenQuestion,
  guidedAssets,
  guidedDraftDecision,
  GuidedFixtureSchema,
  guidedMain,
  guidedOptions,
  guidedPlan,
} from "../scripts/live-guided-acceptance";
import {
  assertBillingAttemptsReviewed,
  heldAcknowledgement,
} from "../scripts/live-acceptance-plan";
const fixture = GuidedFixtureSchema.parse(
  JSON.parse(readFileSync(new URL("../evals/guided-input.json", import.meta.url), "utf8")),
);
function question(
  title: string,
  type: IntakeQuestion["type"] = "text",
  options: string[] = [],
  unit = "",
): IntakeQuestion {
  return {
    id: "frozen_question",
    title,
    reason: "synthetic test",
    placeholder: "",
    type,
    options,
    unit,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe("frozen guided acceptance inputs and answers", () => {
  it("compares five models on the exact same initial goal and facts, with two vision previews", () => {
    const plan = guidedPlan(fixture),
      full = plan.filter((item) => item.scope === "full-flow");
    expect(full.map((item) => item.modelId)).toEqual([
      "gpt-6.1-terra",
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-luna",
      "deepseek-flash",
    ]);
    expect(new Set(full.map((item) => item.goal)).size).toBe(1);
    expect(full.every((item) => JSON.stringify(item.facts) === JSON.stringify(fixture.facts))).toBe(
      true,
    );
    expect(
      plan.filter((item) => item.scope === "vision-summary").map((item) => item.modelId),
    ).toEqual(["gpt-6.1-terra", "deepseek-flash"]);
    expect(plan.find((item) => item.scope === "questions-summary")?.facts).toEqual([]);
    expect(fixture.requestLimit).toBe(70);
  });
  it("answers only predeclared facts and does not invent profile information or choice options", () => {
    expect(answerFrozenQuestion(question("预算上限是多少？"), fixture.facts)).toMatchObject({
      state: "answered",
      value: "总预算上限300元，不能购买服务器或使用收费平台。",
    });
    expect(
      answerFrozenQuestion(question("预算是多少？", "number", [], "元"), fixture.facts),
    ).toMatchObject({ state: "answered", value: "300" });
    expect(
      answerFrozenQuestion(question("预算是多少？", "single", ["300元", "500元"]), fixture.facts),
    ).toMatchObject({ state: "answered", value: "300元" });
    expect(
      answerFrozenQuestion(question("预算是多少？", "single", ["500元", "1000元"]), fixture.facts)
        .state,
    ).toBe("unknown");
    expect(
      answerFrozenQuestion(
        question("预算是多少？", "single", ["300元", "不超过300元"]),
        fixture.facts,
      ).state,
    ).toBe("unknown");
    expect(answerFrozenQuestion(question("你是什么性格？"), fixture.facts).state).toBe("unknown");
  });
  it("does not turn a total into a weekly value or silently convert incompatible units", () => {
    expect(
      answerFrozenQuestion(question("每周总工时是多少小时？", "number", [], "小时"), fixture.facts)
        .state,
    ).toBe("unknown");
    expect(
      answerFrozenQuestion(question("预算是多少万元？", "number", [], "万元"), fixture.facts).state,
    ).toBe("unknown");
    expect(
      answerFrozenQuestion(question("期限是多少天？", "number", [], "天"), fixture.facts).state,
    ).toBe("unknown");
    expect(
      answerFrozenQuestion(question("总工时是多少？", "number", [], "小时"), fixture.facts),
    ).toMatchObject({ state: "answered", value: "12" });
    expect(answerFrozenQuestion(question("预算是多少？", "number"), fixture.facts).state).toBe(
      "unknown",
    );
  });
  it("rejects unknown selections and unreviewed schema changes", () => {
    expect(() => guidedPlan(fixture, ["teraa-full"])).toThrow("Unknown guided case");
    expect(() => GuidedFixtureSchema.parse({ ...fixture, requestLimit: 71 })).toThrow();
    expect(() =>
      GuidedFixtureSchema.parse({ ...fixture, cases: [fixture.cases[0], fixture.cases[0]] }),
    ).toThrow();
  });
});
describe("free runner defaults and paid request guards", () => {
  it("defaults to no paid execution and refuses contradictory flags", () => {
    expect(guidedOptions([]).run).toBe(false);
    expect(() => guidedOptions(["--run", "--dry-run"])).toThrow();
    expect(() =>
      guidedOptions(["--resume", "artifacts/old.json", "--cases", "terra-full"]),
    ).toThrow("retains");
  });
  it("dry-runs without importing a runtime, creating either database or contacting a provider", async () => {
    const folder = mkdtempSync(join(tmpdir(), "guided-dryrun-"));
    try {
      const arenaPath = join(folder, "arena.sqlite"),
        billingPath = join(folder, "billing.sqlite");
      vi.stubEnv("ARENA_DATABASE_PATH", arenaPath);
      vi.stubEnv("ARENA_BILLING_DATABASE_PATH", billingPath);
      vi.stubEnv("OPENAI_API_KEY", "SYNTHETIC_KEY_MUST_NOT_BE_PRINTED");
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      await guidedMain(["--dry-run", "--cases", "terra-full"]);
      expect(fetch).not.toHaveBeenCalled();
      expect(existsSync(arenaPath)).toBe(false);
      expect(existsSync(billingPath)).toBe(false);
      const text = output.mock.calls.flat().join(" ");
      expect(JSON.parse(text)).toMatchObject({
        dryRun: true,
        providerRequests: 0,
        maxNewRequests: 70,
      });
      expect(text).not.toContain("SYNTHETIC_KEY_MUST_NOT_BE_PRINTED");
    } finally {
      vi.unstubAllGlobals();
      rmSync(folder, { recursive: true, force: true });
    }
  });
  it("refuses a run before runtime imports when explicit database paths are missing", async () => {
    vi.stubEnv("ARENA_DATABASE_PATH", undefined);
    vi.stubEnv("ARENA_BILLING_DATABASE_PATH", undefined);
    await expect(
      guidedMain(["--run", "--out", "artifacts/no-fee-test.json"]),
    ).rejects.toMatchObject({ code: "EXPLICIT_DATABASE_PATH_REQUIRED" });
  });
  it("requires a reason for the one known old hold and stops a newly unknown identity", () => {
    const attempt = {
      attemptId: "9879b849-6352-48a3-a771-9fca26e716fb",
      state: "held" as const,
      reservedUsdMicros: 1,
    };
    expect(() => assertBillingAttemptsReviewed([attempt], undefined, true)).toThrow();
    expect(() => heldAcknowledgement([attempt.attemptId])).toThrow();
    const reviewed = heldAcknowledgement(
      [attempt.attemptId],
      "Existing hold reviewed without releasing it",
    );
    expect(() => assertBillingAttemptsReviewed([attempt], reviewed, true)).not.toThrow();
    expect(() =>
      assertBillingAttemptsReviewed(
        [attempt, { ...attempt, attemptId: "new-unresolved-request" }],
        reviewed,
      ),
    ).toThrow();
    expect(guidedDraftDecision("analyzing")).toBe("stop-unknown");
    expect(guidedDraftDecision("uncertain")).toBe("stop-unknown");
    expect(guidedDraftDecision("failed")).toBe("terminal-failure");
  });
});
it("builds readable synthetic PNG, scanned PDF, CSV and DOCX without any model call", async () => {
  const { parseAttachment } = await import("../src/lib/server/attachment-parser");
  const assets = await guidedAssets(fixture);
  expect(assets.map((asset) => asset.name.split(".").at(-1))).toEqual([
    "png",
    "pdf",
    "csv",
    "docx",
  ]);
  const parsed = await Promise.all(assets.map((asset) => parseAttachment(asset.bytes, asset.name)));
  expect(parsed[0].images).toHaveLength(1);
  expect(parsed[1].images).toHaveLength(1);
  expect(parsed[1].chunks).toEqual([]);
  expect(parsed[2].chunks.some((chunk) => chunk.location.startsWith("CSV!"))).toBe(true);
  expect(parsed[3].chunks.map((chunk) => chunk.text).join(" ")).toContain(
    "Two current team members",
  );
});
