import { expect, it } from "vitest";
import { DecompositionSchema } from "../src/lib/clarification-contracts";
import { FollowUpSchema } from "../src/lib/contracts";
import { stepContext } from "../src/lib/step-context";
import { fixtureVersion } from "./e2e/ui.fixture";

it("keeps a large clarification output linked through its real run metadata within the follow-up limit", () => {
  const output = DecompositionSchema.parse({
    summary: "【合成测试数据】A 记录完整的需求拆解，等待本人确认。",
    items: Array.from({ length: 40 }, (_, index) => ({
      id: `item_${index}`,
      topic: "function",
      title: `【合成测试数据】第 ${index + 1} 项`,
      description: "x".repeat(800),
      dependsOn: [],
      required: true,
      acceptance: Array.from({ length: 6 }, () => "y".repeat(300)),
      sourceRefs: [],
    })),
    retired: [],
    suggestions: [],
  });
  expect(JSON.stringify(output).length).toBeGreaterThan(30000);
  const version = fixtureVersion();
  version.workflow = "clarification";
  version.clarification = {
    protocol: "clarification-1",
    items: output.items,
    retiredIds: [],
    runs: [
      {
        id: "fixture-large-run",
        operationId: "fixture-large-operation",
        role: "A",
        round: 1,
        basedOnRevision: 7,
        status: "completed",
        summary: output.summary,
        output,
        usage: [],
        createdAt: "2026-11-12T00:00:00.000Z",
      },
    ],
    rounds: [],
    suggestions: [],
    conflicts: [],
    review: null,
    next: "summary",
    draftOnly: true,
    specification: "",
    executionPrompt: "",
  };
  const context = stepContext(version, "clarification:fixture-large-run")!;
  expect(context.quote).toContain(output.summary);
  expect(context.quote).toContain("fixture-large-run");
  expect(context.quote).toContain("fixture-large-operation");
  expect(context.quote).toContain("依据修订 7");
  expect(context.quote.length).toBeLessThan(2000);
  expect(
    FollowUpSchema.safeParse({ ...context, text: "【合成测试数据】执行者提出的补充问题。" })
      .success,
  ).toBe(true);
  expect(stepContext(version, context.stepId)).toEqual(context);
  version.clarification.runs[0].basedOnRevision = 8;
  expect(stepContext(version, context.stepId)?.quote).not.toBe(context.quote);
});
