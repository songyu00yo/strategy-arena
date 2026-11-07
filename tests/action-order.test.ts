/** Synthetic and frozen recorded-output regression only. No provider or real execution. */
import { describe, expect, it } from "vitest";
import type { Strategy } from "../src/lib/contracts";
import { assertDeclaredCheckOrder } from "../src/lib/server/action-preconditions";
import { assertStrategyArithmetic } from "../src/lib/server/tools";

function strategy(overrides: Partial<Strategy> = {}): Strategy {
  return {
    id: "A",
    title: "合成顺序回归",
    thesis: "核实安全条件后使用设备",
    resources: "现有资源",
    firstAction: "核实检查要求",
    failureCondition: "条件不满足则停止",
    claims: [
      { id: "A1", text: "自检不能替代专业安全检查结论。", status: "unknown", sourceIds: [] },
    ],
    steps: ["先试用设备测试安全功能。", "再安排专业安全检查并取得结论。"],
    estimatedCost: null,
    estimatedHours: null,
    ...overrides,
  };
}

describe("bounded ordering of the route's own declared check dependency", () => {
  it.each(["试用设备", "试骑", "试驾", "试运行机器"])(
    "rejects a declared necessary safety check scheduled after %s",
    (action) => {
      const candidate = strategy({ steps: [`先${action}测试安全功能。`, "再安排独立安全检查。"] });
      const before = structuredClone(candidate);
      expect(() => assertDeclaredCheckOrder(candidate)).toThrow("声明的检查顺序矛盾");
      expect(candidate).toEqual(before);
    },
  );

  it("also checks an explicit trial precondition with no inferred physical safety requirement", () => {
    expect(() =>
      assertDeclaredCheckOrder(
        strategy({
          thesis: "试用不能替代独立检查，独立检查通过后才可试用。",
          steps: ["先试用。", "再取得独立检查结论。"],
        }),
      ),
    ).toThrow("检查顺序矛盾");
  });

  it.each([
    ["先取得专业安全检查通过结论。", "再试用设备测试安全功能。"],
    ["先取得专业安全检查结论。", "再试用设备测试安全功能。", "维修后做专业复检。"],
    [
      "先由专业技师检查刹车，未通过则退出本路线。",
      "检查通过后才低速试骑测试刹车。",
      "维修后做专业复检。",
    ],
    ["专业安全检查通过后才试用设备测试安全功能。", "记录独立检查结论。"],
    ["先取得专业安全检查通过结论，再试用设备。", "复查专业安全检查记录。"],
    ["未取得专业安全检查通过结论前不得试用设备。", "再安排专业安全检查。"],
    ["尚未试骑，只记录已有问题。", "再安排专业安全检查。"],
    ["未试骑测试刹车。", "再安排专业安全检查。"],
    ["没试驾测试安全功能。", "再安排专业安全检查。"],
    ["试用尚未进行。", "再安排专业安全检查。"],
    ["试骑不得进行。", "再安排专业安全检查。"],
    ["联系场地方预约试驾，尚未执行。", "再安排独立安全检查。"],
    ["原文写着“先试骑测试安全功能”，只讨论顺序。", "再安排专业安全检查。"],
    ['材料写着"先试驾测试安全功能"。', "再安排专业安全检查。"],
    ["> 先试骑测试刹车。", "再安排专业安全检查。"],
    ["避免试用设备。", "再安排专业安全检查。"],
    ["软件在隔离环境先试运行。", "再进行独立安全审计和专业检查。"],
    ["在沙箱中试运行机器的仿真模型。", "再进行专业安全检查。"],
    ["先试用设备测试安全功能。", "专业检查只是建议，并非必需。"],
    ["先试用设备测试安全功能。", "专业检查可选。"],
    ["先试用效果，属于普通软件测试。", "再进行专业安全检查。"],
    ["先试驾体验舒适度。", "再进行专业安全检查。"],
    ["先试用设备记录外观。", "再进行专业安全检查。"],
    ["先静态检查设备。", "再安排专业安全检查。"],
    ["先试用设备测试安全功能。", "后续安排待定。"],
  ])("preserves supported, negated, quoted, optional or ambiguous steps %j", (...steps) => {
    expect(() => assertDeclaredCheckOrder(strategy({ steps }))).not.toThrow();
  });

  it("does not invent a professional prerequisite without the route's declaration", () => {
    expect(() =>
      assertDeclaredCheckOrder(
        strategy({
          claims: [{ id: "A1", text: "专业检查可能有帮助。", status: "unknown", sourceIds: [] }],
        }),
      ),
    ).not.toThrow();
  });

  it("uses the shared proposal and revision strategy assertion", () => {
    expect(() => assertStrategyArithmetic(strategy())).toThrow("声明的检查顺序矛盾");
  });

  it("does not let unrelated optional appearance inspection cancel the declared safety dependency", () => {
    const candidate = strategy({
      thesis: "自检不能替代专业安全检查结论。",
      resources: "第三方外观检查可选。",
      claims: [{ id: "A1", text: "检查费用未知。", status: "unknown", sourceIds: [] }],
      steps: ["先试用设备测试安全功能。", "再安排专业安全检查。"],
    });
    expect(() => assertDeclaredCheckOrder(candidate)).toThrow("声明的检查顺序矛盾");
  });

  it.each([
    "原文声称“自检不能替代专业安全检查结论”。",
    "并非自检不能替代专业安全检查结论。",
    "讨论自检不能替代专业安全检查结论是否合理。",
    "自检不能替代专业安全检查结论，但专业检查只是建议。",
  ])("does not promote quotation, negation or optional advice into a dependency %s", (text) => {
    expect(() =>
      assertDeclaredCheckOrder(
        strategy({
          claims: [{ id: "A1", text, status: "unknown", sourceIds: [] }],
        }),
      ),
    ).not.toThrow();
  });

  it("does not mistake an inquiry or failed check for a previous passing conclusion", () => {
    for (const first of [
      "询问专业安全检查是否通过。",
      "专业安全检查未通过则停止。",
      "尚未取得专业安全检查通过结论。",
      "询问专业检查费用与通过标准。",
    ]) {
      expect(() =>
        assertDeclaredCheckOrder(
          strategy({
            steps: [first, "先试用设备测试安全功能。", "再取得独立安全检查结论。"],
          }),
        ),
      ).toThrow("检查顺序矛盾");
    }
  });
});

// Exact necessary excerpts from recorded synthetic model output at
// ae3122aec8a227573b5ba4bc15aa483ec8e89062, artifact SHA256
// 013f04061bf202b41491014cbd56ba6f0f8e2f4223ec4c9f42fce23566067ac4.
// Full artifact replay is separately logged. These CI regressions need no local artifacts.
describe("self-contained R3 recorded-sentence regressions", () => {
  it.each([
    {
      declaration:
        "静态检查与试骑可自行免费完成，但静态观察不能替代维修方对车架、刹车等安全项的专业检查结论。",
      steps: [
        "静态检查通过后低速试骑测试刹车，确认可安全通勤；同时向维修方逐项确认300元报价包含项目、是否含配件、是否另收检测费，取得可留存的报价明细。",
        "借鉴对C路线的质疑：若维修方要求先付款才做安全项检查，或检测费无法事先封顶，则本路线同样停止，不先付款换取检查结论。",
      ],
    },
    {
      declaration:
        "本人免费静态检查与试骑只能筛除明显问题，不能替代技师对车架暗裂、轮组与传动的专业判断；复检是否收费、能否付款前完成仍待核实。",
      steps: [
        "免费静态查验，静态通过后低速试骑测试刹车，记录需更换配件（刹车皮、内胎、链条等）与预计费用；同时书面询问卖家600元是否含锁具、配件、过户或收据，未说明的按未知处理，不假定已含。",
        "核实安全项复检：向本地技师询问对车架、刹车、轮组等安全项复检是否收费、金额多少、能否在付款前出具结论；若须先付款才能取得结论或费用无法事先封顶，则暂停该车，不先付款换结论。",
      ],
    },
    {
      declaration:
        "静态检查与试骑可自行免费完成，但不能替代维修方对车架、刹车等安全项的专业检查结论。",
      steps: [
        "静态检查通过后低速试骑测试刹车；同时向维修方索取300元报价逐项明细，书面问清是否含配件、安全检测是否单独收费及金额上限、能否在付款前出具车架与刹车检查书面结论。",
        "前置门槛：取得维修方车架与刹车安全检查通过结论后才可安排维修。若检测须先付费，仅在金额已封顶且不超剩余额度时支付；检测费未知或须先付且金额不明，则停在询价阶段，不进入维修。检测不通过即停止后续维修费，已付检测费计入已花支出。",
      ],
    },
    {
      declaration:
        "本人免费静态检查与低速试骑只能筛除明显问题，不能替代技师对车架暗裂、轮组与传动的判断；检测是否收费、能否付款前完成仍待核实。",
      steps: [
        "免费静态查验，静态通过后低速试骑测试刹车，记录需更换配件（刹车皮、内胎、链条等）并逐项询价；同时书面询问卖家600元是否含锁具、配件、过户或收据，未说明的按未知处理，不假定已含。",
        "核实安全项检测：向本地技师询问对车架、刹车、轮组等安全项检测是否收费、金额上限、能否在付款前出具通过结论；若须先付款才能取得结论或费用无法事先封顶，则暂停该车，不先付款换结论。",
      ],
    },
  ])("rejects recorded declaration and ordered steps %#", ({ declaration, steps }) => {
    expect(() =>
      assertDeclaredCheckOrder(
        strategy({
          claims: [{ id: "A1", text: declaration, status: "unknown", sourceIds: [] }],
          steps,
        }),
      ),
    ).toThrow("声明的检查顺序矛盾");
  });
});
