import type {
  PlanningDraft,
  PlanningReport,
  PlanningReview,
  PlanningSection,
} from "@/lib/planning-contracts";

// This is a bounded presentation filter for explicit internal blocks, not a
// semantic classifier. Ordinary discussion of AI, prompts and model products
// remains readable. It does not touch stored reports, public streams or answers.
const internalLabel =
  /^(?:(?:给|供|面向)\s*(?:AI|模型|执行模型)\s*(?:的|使用的)?\s*(?:执行说明|执行指令|执行提示词|系统提示词|提示词|指令)|(?:AI|模型)\s*执行说明|系统提示词|系统指令|开发者提示词|开发者指令|内部(?:执行|交接)?(?:说明|指令|提示词)|执行提示词|(?:internal|system|developer|execution)\s+(?:prompt|instructions?))$/iu;
const internalFields = new Set([
  "executionprompt",
  "systemprompt",
  "developerprompt",
  "internalinstructions",
  "systeminstructions",
  "developerinstructions",
]);
const fieldKey = (value: string) => value.replace(/[\s_-]/g, "").toLowerCase();
const plainLabel = (value: string) =>
  value
    .trim()
    .replace(/^>\s*/, "")
    .replace(/^(?:[-*+]\s+|\d+[.)、]\s*)/, "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/[：:]\s*$/, "")
    .replace(/\s*[（(](?:仅供内部|内部|仅供模型)(?:使用)?[）)]\s*$/, "")
    .trim();
const isInternalTitle = (value: string) => internalLabel.test(plainLabel(value));
const modelDirective =
  /^(?:(?:你|您)\s*(?:是|将作为|将扮演)\s*(?:(?:一个|一名)\s*)?(?:(?:负责[^，。！？\n]{1,24}的|(?:本项目|该项目|本次任务)的|(?:专用|内部|指定|自主|资深|高级)(?:的)?)\s*)?(?:AI\s*)?(?:执行模型|执行代理|执行\s*agent|执行器)(?:[，。！：:、\s]|$)|you\s+(?:are|will\s+act\s+as)\s+(?:(?:an?|the)\s+)?(?:(?:AI|autonomous|internal|designated)\s+){0,3}(?:execution|implementation|coding)\s+(?:model|agent|assistant)\b)/iu;

function marker(value: string) {
  const line = plainLabel(value);
  const field = line.match(/^(?:\{\s*)?["']?([\w-]+)["']?\s*[:=]/u);
  if (field && internalFields.has(fieldKey(field[1]))) return true;
  const colon = line.search(/[：:]/u);
  return (
    isInternalTitle(line) ||
    (colon >= 0 && isInternalTitle(line.slice(0, colon))) ||
    modelDirective.test(line)
  );
}

/** Remove explicit instruction paragraphs/sections while retaining adjacent analysis. */
export function readerText(value: string): string {
  // A fence containing an explicit internal payload is omitted as one block.
  // Do not attempt to interpret arbitrary Markdown, JSON or model semantics.
  const text = value
    .replace(/\r\n?/g, "\n")
    .replace(
      /(^|\n)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\2(?=\n|$)/gu,
      (block, prefix: string, _fence: string, body: string) =>
        body.split("\n").some(marker) ||
        [...body.matchAll(/["']([\w-]+)["']\s*:/gu)].some((field) =>
          internalFields.has(fieldKey(field[1])),
        )
          ? prefix
          : block,
    )
    .trim();
  if (!text) return "";
  const lines = text.split("\n");
  const kept: string[] = [];
  let hiddenHeading: number | null = null;
  let hiddenParagraph = false;
  let paragraphHasBody = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/u);
    if (hiddenHeading !== null) {
      if (!heading || heading[1].length > hiddenHeading) continue;
      hiddenHeading = null;
    }
    if (heading) hiddenParagraph = false;
    if (hiddenParagraph) {
      if (!line.trim() && paragraphHasBody) hiddenParagraph = false;
      else if (line.trim()) paragraphHasBody = true;
      continue;
    }
    if (marker(line)) {
      if (heading) hiddenHeading = heading[1].length;
      else {
        hiddenParagraph = true;
        paragraphHasBody = !isInternalTitle(line);
      }
      continue;
    }
    kept.push(line);
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const readerList = (values: string[]) => [...new Set(values.map(readerText).filter(Boolean))];
const readerSections = (sections: PlanningSection[]): PlanningSection[] =>
  sections.flatMap((section) => {
    if (isInternalTitle(section.title)) return [];
    const title = readerText(section.title);
    const content = readerText(section.content);
    if (!title || !content) return [];
    return [
      {
        ...section,
        title,
        content,
        // Do not rewrite a quotation: omit an explicitly internal source in full.
        sources: section.sources.filter(
          (source) =>
            readerText(source.quote) ===
            source.quote
              .replace(/\r\n?/g, "\n")
              .replace(/\n{3,}/g, "\n\n")
              .trim(),
        ),
      },
    ];
  });

export interface ReportPresentation {
  title: string;
  summary: string;
  sections: PlanningSection[];
  tasks: PlanningReport["tasks"];
  risks: string[];
  unresolved: string[];
  acceptance: string[];
  changes: PlanningDraft["changes"];
  documentText: string;
}

/** One reader object feeds the screen, clipboard, file download and draft preview. */
export function reportPresentation(
  report: PlanningReport | null,
  draft: PlanningDraft | null,
  review: PlanningReview | null = null,
): ReportPresentation {
  const source = report ?? draft;
  const tasks = (report?.tasks ?? []).flatMap((task) => {
    if (isInternalTitle(task.title)) return [];
    const title = readerText(task.title);
    const instructions = readerText(task.instructions);
    return title && instructions
      ? [{ ...task, title, instructions, acceptance: readerList(task.acceptance) }]
      : [];
  });
  const visibleTaskIds = new Set(tasks.map((task) => task.id));
  const view: ReportPresentation = {
    title: readerText(source?.title ?? ""),
    summary: readerText(source?.summary ?? ""),
    sections: readerSections(source?.sections ?? []),
    tasks: tasks.map((task) => ({
      ...task,
      dependsOn: task.dependsOn.filter((id) => visibleTaskIds.has(id)),
    })),
    risks: readerList(report?.risks ?? []),
    unresolved: readerList([
      ...(report?.unresolved ?? []),
      ...(review?.uncertainties ?? []),
      ...(review?.blockers.map((blocker) => blocker.description) ?? []),
    ]),
    acceptance: readerList(report?.acceptance ?? []),
    changes: (draft?.changes ?? []).flatMap((change) => {
      const before = readerText(change.before);
      const after = readerText(change.after);
      const reason = readerText(change.reason);
      return before || after || reason ? [{ ...change, before, after, reason }] : [];
    }),
    documentText: "",
  };
  view.documentText = [
    `# ${view.title || "项目分析"}`,
    view.summary,
    ...view.sections.map((section) => `## ${section.title}\n\n${section.content}`),
    view.tasks.length
      ? `## 建议步骤\n\n${view.tasks.map((task, index) => `${index + 1}. ${task.title}\n${task.instructions}${task.acceptance.length ? `\n检查要点：${task.acceptance.join("；")}` : ""}`).join("\n\n")}`
      : "",
    ...(
      [
        ["风险与取舍", view.risks],
        ["待确认事项", view.unresolved],
        ["检查要点", view.acceptance],
      ] as const
    ).map(([title, entries]) =>
      entries.length ? `## ${title}\n\n${entries.map((entry) => `- ${entry}`).join("\n")}` : "",
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
  return view;
}
