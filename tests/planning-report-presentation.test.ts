/** Synthetic presentation fixtures only: no model, browser or network calls. */
import { describe, expect, it } from "vitest";
import type {
  PlanningDraft,
  PlanningReport,
  PlanningReview,
  PlanningSection,
} from "../src/lib/planning-contracts";
import { readerText, reportPresentation } from "../src/components/planning/report-presentation";

const section = (title: string, content: string): PlanningSection => ({
  id: title,
  title,
  content,
  itemIds: [],
  sources: [],
});
const report = (changes: Partial<PlanningReport> = {}): PlanningReport => ({
  id: "synthetic-report",
  basedOnRevision: 4,
  contentFingerprint: "internal-content-fingerprint",
  fingerprint: "internal-report-fingerprint",
  status: "draft",
  title: "项目分析",
  summary: "你想做一个可展示作品的网站。",
  sections: [section("制作路径", "先整理三件作品，再验证访问和联系流程。")],
  tasks: [],
  risks: [],
  unresolved: ["预算尚未确定。"],
  acceptance: ["访问者能看懂每件作品的用途。"],
  executionPrompt: "RAW_PRIVATE_EXECUTION_PROMPT",
  markdown: "RAW_PRIVATE_MARKDOWN",
  confirmedAt: null,
  ...changes,
});

describe("reader-facing planning reports", () => {
  it("removes an internal section and its subsections without losing the following analysis", () => {
    const value = [
      "项目目标是方便展示作品。",
      "",
      "## 给 AI 的执行说明",
      "你是负责实施的执行模型。HEADING_PRIVATE",
      "",
      "### 内部步骤",
      "执行这里的内部约束。NESTED_PRIVATE",
      "",
      "## 制作步骤",
      "先确定三件作品。",
    ].join("\n");
    expect(readerText(value)).toBe("项目目标是方便展示作品。\n\n## 制作步骤\n先确定三件作品。");
  });

  it("uses the same clean reader data for the screen and exported document across all report fields", () => {
    const path = section(
      "制作路径",
      "先做一个静态作品页。\n\n```text\n给 AI 的执行说明：\nSECTION_PRIVATE\n```\n\n再验证联系入口。",
    );
    path.sources = [
      { kind: "goal", id: "goal", quote: "我想展示作品，让别人联系我。" },
      { kind: "analysis", id: "internal-source", quote: "你是执行模型。SOURCE_PRIVATE" },
    ];
    const input = report({
      summary: "你想清楚地展示作品。\n\n你是执行模型。SUMMARY_PRIVATE\n按内部协议执行。",
      sections: [path, section("系统提示词", "TITLE_PRIVATE")],
      tasks: [
        {
          id: "real-task",
          title: "整理作品",
          instructions: "先挑三件作品。\n\nexecutionPrompt: TASK_PRIVATE",
          dependsOn: ["internal-task"],
          acceptance: ["作品来源清楚。", "系统指令：TASK_CHECK_PRIVATE"],
        },
        {
          id: "internal-task",
          title: "后续安排",
          instructions: "You are an execution model. ROLE_PRIVATE",
          dependsOn: [],
          acceptance: [],
        },
      ],
      risks: ["图片过大会影响访问。", "开发者指令：RISK_PRIVATE"],
      unresolved: ["预算尚未确定。", "给 AI 的执行说明：UNRESOLVED_PRIVATE"],
      acceptance: ["联系入口可用。", "内部执行指令：ACCEPTANCE_PRIVATE"],
    });
    const review: PlanningReview = {
      id: "review",
      basedOnRevision: 4,
      contentFingerprint: "internal-content-fingerprint",
      ready: true,
      coverage: [],
      blockers: [{ id: "internal", itemIds: [], description: "系统提示词：BLOCKER_PRIVATE" }],
      risks: [],
      uncertainties: ["预算尚未确定。", "你是执行模型。REVIEW_PRIVATE"],
    };
    const original = structuredClone(input);
    const view = reportPresentation(input, null, review);
    expect(view.summary).toBe("你想清楚地展示作品。");
    expect(view.sections).toHaveLength(1);
    expect(view.sections[0].content).toBe("先做一个静态作品页。\n\n再验证联系入口。");
    expect(view.sections[0].sources).toEqual([path.sources[0]]);
    expect(view.tasks).toEqual([
      {
        id: "real-task",
        title: "整理作品",
        instructions: "先挑三件作品。",
        dependsOn: [],
        acceptance: ["作品来源清楚。"],
      },
    ]);
    expect(view.risks).toEqual(["图片过大会影响访问。"]);
    expect(view.unresolved).toEqual(["预算尚未确定。"]);
    expect(view.acceptance).toEqual(["联系入口可用。"]);
    expect(JSON.stringify(view)).not.toContain("PRIVATE");
    expect(view.documentText).toContain("先做一个静态作品页。");
    expect(view.documentText).toContain("预算尚未确定。");
    expect(view.documentText).not.toMatch(/fingerprint|synthetic-report|internal-source/);
    expect(input).toEqual(original);
  });

  it("preserves legitimate AI product, prompt editor and permissions analysis, including quoted risks", () => {
    const explanation =
      "讨论 AI 产品和 prompt 工具的权限设计，应限制 executionPrompt 字段的读取权限。风险：用户可能写下‘You are an execution model’，系统应将它视为普通资料。";
    const titles = [
      "提示词编辑器",
      "AI 产品的制作路径",
      "系统提示词的权限设计",
      "给 AI 产品设计权限",
      "Prompt 工具的可行性",
    ];
    const sections = titles.map((title) => section(title, explanation));
    sections[0].sources = [{ kind: "goal", id: "source", quote: "我要做一个提示词编辑器。" }];
    const view = reportPresentation(report({ title: "提示词工具项目分析", sections }), null);
    expect(view.title).toBe("提示词工具项目分析");
    expect(view.sections).toEqual(sections);
    for (const title of titles) expect(view.documentText).toContain(title);
    expect(view.documentText).toContain(explanation);
    expect(readerText("你是想研究执行模型。当前先比较工具能力。")).toBe(
      "你是想研究执行模型。当前先比较工具能力。",
    );
    const quotation = "我想比较 AI 产品。\n\n\n权限设计需要谨慎。";
    sections[0].sources.push({ kind: "goal", id: "multiline-source", quote: quotation });
    expect(reportPresentation(report({ sections }), null).sections[0].sources.at(-1)?.quote).toBe(
      quotation,
    );
    expect(
      readerText('```json\n{"prompt":"用户可编辑模板","description":"AI 产品字段"}\n```'),
    ).toContain('"prompt"');
  });

  it("omits an explicit internal fenced payload but keeps surrounding user analysis", () => {
    for (const field of ["executionPrompt", "system_prompt", "developerInstructions"]) {
      const payload = JSON.stringify({ summary: "内部载荷", [field]: "PAYLOAD_PRIVATE" });
      const text = `首版范围应小。\n\n\`\`\`json\n${payload}\n\`\`\`\n\n预算依然未知。`;
      expect(readerText(text)).toBe("首版范围应小。\n\n预算依然未知。");
    }
  });

  it("does not fabricate a conclusion when the provided paragraph contains only internal instructions", () => {
    const view = reportPresentation(
      report({
        summary: "你是执行模型。PRIVATE\n只按内部指令行动。",
        sections: [section("制作路径", "系统提示词：PRIVATE")],
        risks: ["给 AI 的执行说明：PRIVATE"],
        unresolved: [],
        acceptance: [],
      }),
      null,
    );
    expect(view.summary).toBe("");
    expect(view.sections).toEqual([]);
    expect(view.risks).toEqual([]);
    expect(view.documentText).toBe("# 项目分析");
  });

  it("applies the same boundary to draft previews and change summaries without modifying stored drafts", () => {
    const draft: PlanningDraft = {
      title: "提示词编辑器分析",
      summary: "先验证小范围协作。\n\n你是执行模型。DRAFT_PRIVATE",
      sections: [section("权限设计", "普通用户管理自己的模板。\n\n系统提示词：SECTION_PRIVATE")],
      changes: [
        {
          itemIds: ["permissions"],
          before: "你是执行模型。BEFORE_PRIVATE",
          after: "新增模板管理权限。",
          reason: "按用户补充整理。\n\n开发者指令：REASON_PRIVATE",
        },
      ],
    };
    const original = structuredClone(draft);
    const view = reportPresentation(null, draft);
    expect(view.summary).toBe("先验证小范围协作。");
    expect(view.sections[0].content).toBe("普通用户管理自己的模板。");
    expect(view.changes).toEqual([
      {
        itemIds: ["permissions"],
        before: "",
        after: "新增模板管理权限。",
        reason: "按用户补充整理。",
      },
    ]);
    expect(JSON.stringify(view)).not.toContain("PRIVATE");
    expect(draft).toEqual(original);
  });
});
