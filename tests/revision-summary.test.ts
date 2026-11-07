import { describe, expect, it } from "vitest";
import { normalizedRevisionSummary } from "../src/lib/server/revision-summary";

// Recorded real-model summary/state contradictions on synthetic acceptance input.
// The pairs are copied here; tests never read private artifacts or call a model.
const acceptedBoth =
  "接受两条针对A-claim-1的质疑：模板路线“等待与重试最少”降为有条件判断，把无水印/1080p导出核实与订阅比价单列为1小时第一步并计入八小时，核实通过才进入选模板，缓冲与保底阈值明确写出；超预算或无法无水印导出即退出改走本地剪辑。费用仍未知，全程估计8小时为模型估计。";
const rejectedAll =
  "三条攻击均指向 A、B 路线，本角色不替对手认输，故均拒绝并说明工具未提供实测证据；借鉴其有效点，本路线把导出权限核实、订阅比价与解锁等待单列为第 0–1 小时并计入八小时，新增 5.5 小时停止生成阈值与 7.5–8 小时缓冲，缓冲不重复计入。费用与全程工时仍未知，不宣称可行。";

describe("summaries agree with normalized revision responses", () => {
  it("corrects the recorded 'accepted both' summary when one acceptance lacks evidence", () => {
    const checked = normalizedRevisionSummary(
      acceptedBoth,
      [
        { attackId: "attack-B", decision: "accept" },
        { attackId: "attack-C", decision: "accept" },
      ],
      [
        { attackId: "attack-B", decision: "unresolved" },
        { attackId: "attack-C", decision: "accept" },
      ],
      true,
    );
    expect(checked).not.toBe(acceptedBoth);
    expect(checked).toContain("接受1项质疑，拒绝0项，未解决1项");
    expect(checked).toContain("行动、资源或成立条件有变化");
    expect(checked).toContain("未解决的质疑不算已解决或已证实");
  });

  it("corrects the recorded 'rejected all' summary when two rejections become unresolved", () => {
    const checked = normalizedRevisionSummary(
      rejectedAll,
      [
        { attackId: "attack-A", decision: "reject" },
        { attackId: "attack-B", decision: "reject" },
        { attackId: "attack-C", decision: "reject" },
      ],
      [
        { attackId: "attack-A", decision: "unresolved" },
        { attackId: "attack-B", decision: "unresolved" },
        { attackId: "attack-C", decision: "reject" },
      ],
      true,
    );
    expect(checked).not.toBe(rejectedAll);
    expect(checked).toContain("接受0项质疑，拒绝1项，未解决2项");
  });

  it("counts mixed accepted, rejected and unresolved responses without claiming all are resolved", () => {
    const checked = normalizedRevisionSummary(
      "合成摘要：质疑均已解决。",
      [
        { attackId: "one", decision: "accept" },
        { attackId: "two", decision: "reject" },
        { attackId: "three", decision: "accept" },
      ],
      [
        { attackId: "one", decision: "accept" },
        { attackId: "two", decision: "reject" },
        { attackId: "three", decision: "unresolved" },
      ],
      true,
    );
    expect(checked).toContain("接受1项质疑，拒绝1项，未解决1项");
  });

  it("accounts for an omitted attack added as an unresolved response", () => {
    const checked = normalizedRevisionSummary(
      "合成摘要：已回应全部质疑。",
      [{ attackId: "one", decision: "accept" }],
      [
        { attackId: "one", decision: "accept" },
        { attackId: "missing", decision: "unresolved" },
      ],
      true,
    );
    expect(checked).toContain("接受1项质疑，拒绝0项，未解决1项");
  });

  it("does not infer a substantive action change from the model's original summary", () => {
    const checked = normalizedRevisionSummary(
      "合成摘要：已接受质疑并完成实质修改。",
      [{ attackId: "one", decision: "accept" }],
      [{ attackId: "one", decision: "unresolved" }],
      false,
    );
    expect(checked).toContain("接受0项质疑，拒绝0项，未解决1项");
    expect(checked).toContain("未检测到行动、资源或成立条件变化");
  });

  it("preserves an already unresolved summary when its response decision stays unresolved", () => {
    const summary = "合成摘要：已增加核实步骤，但这条质疑仍未解决。";
    const responses = [{ attackId: "one", decision: "unresolved" }] as const;
    expect(normalizedRevisionSummary(summary, responses, responses, true)).toBe(summary);
  });

  it.each([true, false])(
    "preserves the original prose without response changes (changed=%s)",
    (changed) => {
      const summary = "合成摘要：保留本路线，接受首项、拒绝次项，具体原因见逐条回应。";
      const original = [
        { attackId: "one", decision: "accept" },
        { attackId: "two", decision: "reject" },
      ] as const;
      const reordered = [original[1], original[0]];
      expect(normalizedRevisionSummary(summary, original, reordered, changed)).toBe(summary);
      expect(normalizedRevisionSummary("合成摘要：无相关质疑。", [], [], changed)).toBe(
        "合成摘要：无相关质疑。",
      );
    },
  );

  it("detects a decision change per attack even when aggregate counts stay equal", () => {
    const summary = "合成摘要：第一项已接受，第二项已拒绝。";
    const checked = normalizedRevisionSummary(
      summary,
      [
        { attackId: "one", decision: "accept" },
        { attackId: "two", decision: "reject" },
      ],
      [
        { attackId: "one", decision: "reject" },
        { attackId: "two", decision: "accept" },
      ],
      true,
    );
    expect(checked).not.toBe(summary);
    expect(checked).toContain("接受1项质疑，拒绝1项，未解决0项");
  });
});
