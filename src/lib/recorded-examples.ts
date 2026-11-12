import type { ArenaSnapshot } from "./contracts";

export interface RecordedExample {
  workflow?: "clarification";
  caseType?: "simulated_real_model";
  simulationActor?: "Codex";
  initialMaterials?: string;
  recordedCostUsd?: number;
  recordedCostCny?: number;
  sourceCommits?: string[];
  slug: string;
  title: string;
  direction: string;
  question: string;
  summary: string;
  modelId: string;
  generatedAt: string;
  sourceCommit: string;
  qualityNote: string;
  versionCount: number;
  sourceFile: string;
  sourceFileSha256: string;
  sourceCapturedAt: string | null;
  sourceVersionIds: string[];
  sourceVersionPointer: string;
  sourceVersionContentSha256: string;
  inputProvenance: "synthetic-task-input";
  outputProvenance: "real-provider-output";
  redactions: string[];
}

export interface RecordedExamplePayload {
  metadata: RecordedExample;
  arena: ArenaSnapshot;
}

// Metadata only: completed real-model clarification simulations.
export const RECORDED_EXAMPLES: RecordedExample[] = [
  {
    workflow: "clarification",
    caseType: "simulated_real_model",
    simulationActor: "Codex",
    initialMaterials: "",
    slug: "personal-website",
    title: "个人网站，从模糊想法到确认需求",
    direction: "个人网站",
    question: "我想做一个个人网站，具体没想好。",
    summary:
      "需求已足够交接：中文单页线上名片，使用明确标注的占位内容，交付设计与可运行代码；本轮仅整理需求与提示词。",
    modelId: "gpt-6.1-terra",
    generatedAt: "2026-11-12T07:17:14.730Z",
    sourceCommit: "bd8c2da0e1db7e97669590249199577cbe378867",
    sourceCommits: ["bd8c2da0e1db7e97669590249199577cbe378867"],
    qualityNote:
      "需求与回答由 Codex 技术模拟，问题和审查来自真实模型。已保存最终需求与执行提示词，尚无执行反馈。本记录保留第8轮的一次冗余确认，完整过程未删减。",
    versionCount: 1,
    sourceFile: "work/new-clarification-examples/personal-site/completed-record.json",
    sourceFileSha256: "74f2df612321d2ff150c7ef5edf74d72dc8ffa76a70853c6e33bd4772cdb7041",
    sourceCapturedAt: "2026-11-12T07:17:14.730Z",
    sourceVersionIds: ["recording-4982839f464e239c0d5f"],
    sourceVersionPointer: "/snapshot/versions/0",
    sourceVersionContentSha256: "563a8d0e733e1ca1f11df49ea2a4b645bcec12f95ef28c7ca3d2ce5a6edaff53",
    inputProvenance: "synthetic-task-input",
    outputProvenance: "real-provider-output",
    recordedCostUsd: 0.229945,
    recordedCostCny: 0,
    redactions: [
      "owner/session/configuration fields omitted",
      "transport identifiers replaced with recording-local aliases",
      "provider response identifiers replaced with [redacted]",
      "model configuration marked unavailable in read-only replay",
      "goal, questions, answers and model output text retained verbatim",
    ],
  },
  {
    workflow: "clarification",
    caseType: "simulated_real_model",
    simulationActor: "Codex",
    initialMaterials: "",
    slug: "presentation",
    title: "PPT，逐步明确内容与风格",
    direction: "PPT",
    question: "我想做一份PPT，内容和风格还没想好。",
    summary: "需求已明确：6页可编辑PPT，供5分钟讲解，会后独立练习；本轮交付需求与提示词。",
    modelId: "gpt-6.1-terra",
    generatedAt: "2026-11-12T06:35:58.123Z",
    sourceCommit: "d3d328d6fd35381ad407e07e513e31a79528aa87",
    sourceCommits: [
      "07086bec538ee2215c75ca7db8324ece31d7a5b5",
      "d3d328d6fd35381ad407e07e513e31a79528aa87",
    ],
    qualityNote:
      "需求与回答由 Codex 技术模拟，问题和审查来自真实模型。已保存最终需求与执行提示词，尚无执行反馈。",
    versionCount: 1,
    sourceFile: "work/new-clarification-examples/ppt/completed-record.json",
    sourceFileSha256: "ed8cc8ee9c6e594fd1fadf89c8b03aacb15646b9732ca99edd1128e95e643bd1",
    sourceCapturedAt: "2026-11-12T06:35:58.123Z",
    sourceVersionIds: ["recording-2c0bf023093495350f6d"],
    sourceVersionPointer: "/snapshot/versions/0",
    sourceVersionContentSha256: "f77b7adf70b314700b47574abebbbd7e0604ba4876de4288b828e43e20e4f882",
    inputProvenance: "synthetic-task-input",
    outputProvenance: "real-provider-output",
    recordedCostUsd: 0.088679,
    recordedCostCny: 0,
    redactions: [
      "owner/session/configuration fields omitted",
      "transport identifiers replaced with recording-local aliases",
      "provider response identifiers replaced with [redacted]",
      "model configuration marked unavailable in read-only replay",
      "goal, questions, answers and model output text retained verbatim",
    ],
  },
  {
    workflow: "clarification",
    caseType: "simulated_real_model",
    simulationActor: "Codex",
    initialMaterials: "",
    slug: "user-guide",
    title: "说明文档，逐步明确结构与交付",
    direction: "说明文档",
    question: "我想整理一份说明文档，具体怎么组织还没想好。",
    summary:
      "主题、读者、四步流程、示例、模板、回看清单、风格及验收标准已明确，可交接需求与提示词。",
    modelId: "gpt-6.1-terra",
    generatedAt: "2026-11-12T06:35:57.979Z",
    sourceCommit: "d3d328d6fd35381ad407e07e513e31a79528aa87",
    sourceCommits: [
      "07086bec538ee2215c75ca7db8324ece31d7a5b5",
      "d3d328d6fd35381ad407e07e513e31a79528aa87",
    ],
    qualityNote:
      "需求与回答由 Codex 技术模拟，问题和审查来自真实模型。已保存最终需求与执行提示词，尚无执行反馈。",
    versionCount: 1,
    sourceFile: "work/new-clarification-examples/document/completed-record.json",
    sourceFileSha256: "6a9474c318ef106de0687a23fe3c09d2264cb26b97807cdca37eb4e5f849e842",
    sourceCapturedAt: "2026-11-12T06:35:57.979Z",
    sourceVersionIds: ["recording-40af04a91c63e481ea4b"],
    sourceVersionPointer: "/snapshot/versions/0",
    sourceVersionContentSha256: "33c20112a5284319e437b86c426b954739cb6762fc62e297ae5e188e9a0cddc2",
    inputProvenance: "synthetic-task-input",
    outputProvenance: "real-provider-output",
    recordedCostUsd: 0.084464,
    recordedCostCny: 0,
    redactions: [
      "owner/session/configuration fields omitted",
      "transport identifiers replaced with recording-local aliases",
      "provider response identifiers replaced with [redacted]",
      "model configuration marked unavailable in read-only replay",
      "goal, questions, answers and model output text retained verbatim",
    ],
  },
  {
    workflow: "clarification",
    caseType: "simulated_real_model",
    simulationActor: "Codex",
    initialMaterials: "",
    slug: "event-registration",
    title: "活动报名页，逐步明确流程与范围",
    direction: "活动报名页",
    question: "我想做一个活动报名页，具体还没想好。",
    summary: "已明确本地虚构报名演示的范围、流程、样式和验收，可交接需求与提示词；尚未执行。",
    modelId: "gpt-6.1-terra",
    generatedAt: "2026-11-12T10:54:09.735Z",
    sourceCommit: "52e57f9b0a2887ded0e85cf6c106947a31f6c72d",
    sourceCommits: ["52e57f9b0a2887ded0e85cf6c106947a31f6c72d"],
    qualityNote:
      "需求与回答由 Codex 技术模拟，问题和审查来自真实模型。已保存最终需求与执行提示词，尚无执行反馈。",
    versionCount: 1,
    sourceFile: "work/new-clarification-examples/event-registration/completed-record.json",
    sourceFileSha256: "70fc99eb4e89f6160964dc658c9dce0666a7a304fcba2936778a892fd8db75b4",
    sourceCapturedAt: "2026-11-12T10:54:09.735Z",
    sourceVersionIds: ["recording-b11e720911e7463d2902"],
    sourceVersionPointer: "/snapshot/versions/0",
    sourceVersionContentSha256: "0650451d2ea05cbf1be4af29413e437f81fdc8ad7e30328d95c872b40101729b",
    inputProvenance: "synthetic-task-input",
    outputProvenance: "real-provider-output",
    recordedCostUsd: 0.142538,
    recordedCostCny: 0,
    redactions: [
      "owner/session/configuration fields omitted",
      "transport identifiers replaced with recording-local aliases",
      "provider response identifiers replaced with [redacted]",
      "model configuration marked unavailable in read-only replay",
      "goal, questions, answers and model output text retained verbatim",
    ],
  },
];
