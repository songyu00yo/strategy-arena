import type { ArenaSnapshot } from "./contracts";

export interface RecordedExample {
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

// Metadata only: full historical results load from public JSON when opened.
export const RECORDED_EXAMPLES: RecordedExample[] = [
  {
    slug: "learning",
    title: "免费学 Python，先上课还是做项目？",
    direction: "学习",
    question:
      "四周内补上 Python 基础并完成一个可以演示的记账小项目，比较课程、项目驱动和同伴练习。",
    summary: "倾向分步验证的项目驱动路线，先做记账小项目，并预留纠错时间。",
    modelId: "deepseek-flash",
    generatedAt: "2026-11-06T07:56:41.257Z",
    sourceCommit: "f597169237cc9b2127a216adeb91f0d308d51df7",
    qualityNote:
      "这份记录经过 AI 审查。切换路线时，还要把已经用掉的时间算进去，实际执行效果仍待验证。",
    versionCount: 1,
    sourceFile: "artifacts/acceptance-f597-deepseek.json",
    sourceFileSha256: "dc5b2c6edeafc3c877a08df618fef5adffbb247df067b46eb774e66302465809",
    sourceCapturedAt: "2026-11-06T08:02:35.149Z",
    sourceVersionIds: ["9b9c63ae-41de-47d3-b21d-abcf0e38603f"],
    sourceVersionPointer: "/cases/0/snapshot/versions/0",
    sourceVersionContentSha256: "8bf6c00f398b8d0fd697c9bf44e66fc712a5d178512e9266147a50677183a0b5",
    inputProvenance: "synthetic-task-input",
    outputProvenance: "real-provider-output",
    redactions: [
      "owner and session identities omitted",
      "operation and billing attempt IDs omitted",
      "provider response IDs replaced with [redacted]",
      "runtime configurations and private paths omitted",
      "intake transport details omitted; submitted challenge preserved",
      "event data limited to sanitized original usage",
      "step IDs replaced with recording-local labels",
    ],
  },
  {
    slug: "career",
    title: "换工作时，收入和家庭照护怎么取舍？",
    direction: "工作",
    question: "两周内决定留在当前公司、接受外地工作或协商远程，比较收入与家庭照护的影响。",
    summary: "有条件优先协商远程，同时核实留任的照护安排。",
    modelId: "gpt-6.1-terra",
    generatedAt: "2026-11-06T12:17:39.861Z",
    sourceCommit: "1d1f3f6b38eaa6acd36d45d67097ae69a7ccbff2",
    qualityNote:
      "当时有条件建议先协商远程，远程许可和照护安排仍需确认。这是经 AI 审查的初版记录，后续存在问题的版本未收录。",
    versionCount: 1,
    sourceFile: "artifacts/terra-cross-domain-1d1f3f6.json",
    sourceFileSha256: "9d79e5e5a1e526d1dfc14cf18dac2eea2d3b51e4a5007b48b0b4f1ee79e99977",
    sourceCapturedAt: "2026-11-06T12:21:17.189Z",
    sourceVersionIds: ["698a29dc-2511-456c-bd7c-d4544a526541"],
    sourceVersionPointer: "/cases/0/snapshot/versions/0",
    sourceVersionContentSha256: "d71bb140b59eb6427db160f826b441dd186202eef86fce61e5e93d90fb6a7368",
    inputProvenance: "synthetic-task-input",
    outputProvenance: "real-provider-output",
    redactions: [
      "owner and session identities omitted",
      "operation and billing attempt IDs omitted",
      "provider response IDs replaced with [redacted]",
      "runtime configurations and private paths omitted",
      "intake transport details omitted; submitted challenge preserved",
      "event data limited to sanitized original usage",
      "step IDs replaced with recording-local labels",
    ],
  },
  {
    slug: "creation",
    title: "用真实照片完成一支 90 秒短片",
    direction: "创作",
    question:
      "七天内用已有的十二张照片制作一支九十秒、1080p、有字幕且无水印的视频。比较模板、本地剪辑和 AI 镜头三条路线。",
    summary: "修订后比较模板、本地剪辑与照片运动；导出条件、费用和耗时未核实，暂不推荐具体路线。",
    modelId: "gpt-6.1-terra",
    generatedAt: "2026-11-06T07:53:47.719Z",
    sourceCommit: "f597169237cc9b2127a216adeb91f0d308d51df7",
    qualityNote:
      "这是原记录的第 2 版。AI 审查时未发现危险建议或明显的事实问题，导出条件、费用和耗时仍待实测，实际成片尚未验证。",
    versionCount: 1,
    sourceFile: "outputs/真实验收-f597169/真实结构化结果.json",
    sourceFileSha256: "608625aba3133c95b73f02906f9286d2205baa165c4e05d464deee2901a8e9ae",
    sourceCapturedAt: null,
    sourceVersionIds: ["835627b3-6e38-4c76-a6cd-09ba0d56187b"],
    sourceVersionPointer: "/records/6/versions/1",
    sourceVersionContentSha256: "6d561849f25bb31710cad1f4f594132381f5134a287c39bae0aa40ddce176703",
    inputProvenance: "synthetic-task-input",
    outputProvenance: "real-provider-output",
    redactions: [
      "owner and session identities omitted",
      "operation and billing attempt IDs omitted",
      "provider response IDs replaced with [redacted]",
      "runtime configurations and private paths omitted",
      "intake transport details omitted; submitted challenge preserved",
      "event data limited to sanitized original usage",
      "step IDs replaced with recording-local labels",
    ],
  },
  {
    slug: "course-site",
    title: "两个人、12 小时，怎么做课程作品页？",
    direction: "项目",
    question:
      "两名大一学生计划在两周内用现有笔记本做一个本地可展示的课程作品页，集中展示三个已完成练习。总预算上限300元，总工时上限12小时（两人合计）。两人目前只懂基础HTML和CSS；不能增加成员，不能购买服务器或使用收费平台，也不收集账号或个人信息。请比较从零手写、改现成静态模板、用免费静态生成工具三条路线，给出先验证再实施的行动步骤。",
    summary: "有条件优先手写静态页，先用累计 2 人时核对三个练习并验证样例。",
    modelId: "gpt-6.1-sol",
    generatedAt: "2026-11-06T11:48:10.935Z",
    sourceCommit: "69938cd83193dc1a157189f5ee0a9f9efa6d4da2",
    qualityNote:
      "这份记录通过了 AI 对该样例的审查，尚待人工验证。实际项目能否按期完成，还要结合自己的情况判断。",
    versionCount: 1,
    sourceFile: "artifacts/guided-live-69938cd.json",
    sourceFileSha256: "831edc018f8d632ed141b2fa56b8acdfdeff322996758eecce4956d87d3389fb",
    sourceCapturedAt: "2026-11-06T11:55:37.322Z",
    sourceVersionIds: ["5b28582c-2c20-440b-8677-95bc3e817ee9"],
    sourceVersionPointer: "/cases/0/snapshot/versions/0",
    sourceVersionContentSha256: "94a5a3d12ac8dbd075ede1abff3694adaf7fe1cbabda6fd07b4b0499a5560d5b",
    inputProvenance: "synthetic-task-input",
    outputProvenance: "real-provider-output",
    redactions: [
      "owner and session identities omitted",
      "operation and billing attempt IDs omitted",
      "provider response IDs replaced with [redacted]",
      "runtime configurations and private paths omitted",
      "intake transport details omitted; submitted challenge preserved",
      "event data limited to sanitized original usage",
      "step IDs replaced with recording-local labels",
    ],
  },
];
