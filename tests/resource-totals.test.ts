import { describe, expect, it } from "vitest";
import { calculate } from "../src/lib/server/tools";
import {
  assertDeclaredResourceArithmetic,
  assertStrategyResourceTotals,
  extractDeclaredResourceArithmetic,
  extractSerialStepAllocation,
} from "../src/lib/server/resource-totals";
import type { Strategy } from "../src/lib/contracts";

const steps = [
  "第1步（约40分钟）：盘点软件，导出字幕样片。",
  "第2步（约40分钟，含比价与等待）：核实报价并排布照片。",
  "第3步（约180分钟）：粗剪精剪；若累计已用超过5小时仍未进入精剪，则停止加装饰。",
  "第4步（约60分钟）：导出并验收完整成片。",
  "第5步（约60分钟缓冲）：导出失败重试及字幕返工。",
];
function strategy(text: string, serial = steps): Strategy {
  return {
    id: "B",
    title: "本地剪辑",
    thesis: text,
    steps: serial,
    claims: [{ id: "B-claim-3", text, status: "estimate", sourceIds: [] }],
    resources: "现有设备",
    firstAction: "先核实",
    failureCondition: "超限退出",
    estimatedHours: 7.3,
    estimatedCost: null,
  };
}

describe("explicit numeric resource total declarations", () => {
  it("rejects the actual creation judgment error using an independently evaluated expression", () => {
    expect(() =>
      assertDeclaredResourceArithmetic("40+40+180+60+60分钟合计440分钟", calculate),
    ).toThrow("应为 380 分钟");
    expect(() =>
      assertDeclaredResourceArithmetic("分项40+40+180+60+60分钟合计约440分钟", calculate),
    ).toThrow("不得虚构额外工作");
  });
  it.each(["40+40+180+60+60分钟合计380分钟", "(1+2)*2小时总计6小时", "100+20元共计120元"])(
    "accepts an explicit correct calculation: %s",
    (text) => {
      expect(extractDeclaredResourceArithmetic(text)).toHaveLength(1);
      expect(() => assertDeclaredResourceArithmetic(text, calculate)).not.toThrow();
    },
  );
  it.each([
    "讲解“40+40分钟合计90分钟”中的错误。",
    "请判断40+40分钟合计90分钟是否正确。",
    "40+40分钟合计90分钟？",
    "练习题：40+40分钟合计90分钟。",
    "错误等式：40+40分钟合计90分钟。",
    "x+40+40分钟合计90分钟",
    "α+40+40分钟合计90分钟",
    "2026-11-07小时合计10小时",
    "2026/11/07小时合计26小时",
    "40-60分钟合计100分钟",
    "20%+40分钟合计60分钟",
    "40+40分钟合计1.3小时",
    "每步四十分钟，合计九十分钟。",
  ])(
    "does not interpret quotes, questions, variables, dates, ranges or unsupported units: %s",
    (text) => {
      expect(extractDeclaredResourceArithmetic(text)).toEqual([]);
    },
  );
});

describe("complete serial step allocations", () => {
  it("rejects the actual creation revision claim while retaining conditional cumulative exit thresholds", () => {
    expect(extractSerialStepAllocation(steps)?.minutes).toBe(380);
    expect(() =>
      assertStrategyResourceTotals(strategy("修订后分项合计约440分钟，含比价等待、返工与缓冲。")),
    ).toThrow("合计 380 分钟");
  });
  it.each(["修订后分项合计约380分钟。", "所有步骤合计约6.3小时。", "分项合计380分钟。"])(
    "accepts matching totals and single-decimal hour conversion: %s",
    (text) => {
      expect(() => assertStrategyResourceTotals(strategy(text))).not.toThrow();
    },
  );
  it("sums explicitly allocated mixed units without deriving a full-route estimate", () => {
    const mixed = [
      "第0步（约1小时）：核实。",
      "第1步（约30分钟）：制作。",
      "第2步（约0.5小时缓冲）：检查。",
    ];
    expect(extractSerialStepAllocation(mixed)?.minutes).toBe(120);
    expect(() => assertStrategyResourceTotals(strategy("步骤合计2小时。", mixed))).not.toThrow();
    expect(() => assertStrategyResourceTotals(strategy("步骤合计3小时。", mixed))).toThrow(
      "合计 120 分钟",
    );
  });
  it("does not compare estimatedHours or generic full-route estimates against listed allocations", () => {
    expect(() =>
      assertStrategyResourceTotals(strategy("全程估计7.3小时，包括尚未列明的等待。")),
    ).not.toThrow();
  });
  it.each([
    ["第1步（约40分钟）：验证。", "完成制作，时间未知。"],
    ["第1步（约40-60分钟）：验证。", "第2步（约60分钟）：制作。"],
    ["第1步（约40分钟，累计用时）：验证。", "第2步（约60分钟）：制作。"],
    ["第1步（约40分钟）：与第二步并行。", "第2步（约60分钟）：制作。"],
    ["第1步（约40分钟）：与第二步同时进行。", "第2步（约60分钟）：制作。"],
    ["第1步（约40分钟）：验证。", "第3步（约60分钟）：制作。"],
    ["第1步（约半小时）：验证。", "第2步（约60分钟）：制作。"],
    [`第1步（约${"9".repeat(400)}分钟）：验证。`, "第2步（约60分钟）：制作。"],
  ])("ignores partial, ranged, cumulative, parallel or incomplete allocations", (...serial) => {
    expect(extractSerialStepAllocation(serial)).toBeNull();
    expect(() => assertStrategyResourceTotals(strategy("分项合计999分钟。", serial))).not.toThrow();
  });
  it.each([
    "验证窗口分项合计约40分钟。",
    "前两步骤合计40分钟。",
    "讲解“分项合计440分钟”的错误。",
    "步骤合计440分钟是否正确？",
  ])("does not promote a validation window or a discussion into a full-step total: %s", (text) => {
    expect(() => assertStrategyResourceTotals(strategy(text))).not.toThrow();
  });
});
