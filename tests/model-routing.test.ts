import { describe, expect, it } from "vitest";
import {
  ChallengeSchema,
  CreateArenaRequestSchema,
  VersionRequestSchema,
} from "../src/lib/contracts";
import { MODEL_CATALOG } from "../src/lib/model-catalog";
import { routeModel } from "../src/lib/model-routing";

const challenge = ChallengeSchema.parse({ goal: "在一个月内完成一门入门课程" });
describe("free deterministic model selection", () => {
  it("routes each exact model ID without changing legacy selection modes", () => {
    expect(MODEL_CATALOG).toHaveLength(5);
    for (const model of MODEL_CATALOG) {
      expect(CreateArenaRequestSchema.parse({ ...challenge, modelMode: model.id }).modelMode).toBe(
        model.id,
      );
      expect(routeModel(challenge, model.id)).toMatchObject({
        provider: model.provider,
        modelId: model.id,
      });
    }
  });
  it("prefers DeepSeek for short everyday tasks, with no network or secret dependency", () => {
    expect(routeModel(challenge, "auto")).toMatchObject({ provider: "deepseek" });
  });
  it("selects GPT at the material boundary and counts Unicode characters", () => {
    expect(routeModel({ ...challenge, materials: "文".repeat(5999) }, "auto").provider).toBe(
      "deepseek",
    );
    expect(routeModel({ ...challenge, materials: "文".repeat(6000) }, "auto").provider).toBe(
      "openai",
    );
    expect(routeModel({ ...challenge, materials: "😀".repeat(3000) }, "auto").provider).toBe(
      "deepseek",
    );
  });
  it("counts distinct nonempty rows or semicolon clauses and explicit numeric constraints", () => {
    expect(
      routeModel(
        { ...challenge, constraints: "本地完成；只用现有设备\n\n", budget: 0, timeHours: 2 },
        "auto",
      ).provider,
    ).toBe("openai");
    expect(
      routeModel({ ...challenge, constraints: "本地完成；只用现有设备\n\n", budget: 0 }, "auto")
        .provider,
    ).toBe("deepseek");
    expect(routeModel({ ...challenge, preferences: "a;b;c;d" }, "auto").provider).toBe("deepseek");
  });
  it("manual choices override routing thresholds and never enter the business prompt", () => {
    const request = CreateArenaRequestSchema.parse({ ...challenge, modelMode: "gpt" });
    expect(routeModel(challenge, "gpt").provider).toBe("openai");
    expect(routeModel({ ...challenge, materials: "文".repeat(6000) }, "deepseek").provider).toBe(
      "deepseek",
    );
    expect(ChallengeSchema.parse(request)).not.toHaveProperty("modelMode");
    expect(CreateArenaRequestSchema.safeParse({ ...challenge, modelMode: "unknown" }).success).toBe(
      false,
    );
    expect(
      VersionRequestSchema.parse({ challenge, changeReason: "补充条件" }).modelMode,
    ).toBeUndefined();
  });
});
