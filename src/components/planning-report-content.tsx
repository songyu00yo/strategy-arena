import { createElement, type ReactNode } from "react";

function inlineText(text: string) {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .map((part, index) =>
      part.length > 4 && part.startsWith("**") && part.endsWith("**") ? (
        <strong key={index}>{part.slice(2, -2)}</strong>
      ) : (
        part
      ),
    );
}

/** Render the report's printed structure while keeping all source text escaped. */
export function PlanningReportContent({ content }: { content: string }) {
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: Array<{ text: string; order?: number }> = [];
  let listKind: "ul" | "ol" = "ul";

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(<p key={blocks.length}>{inlineText(paragraph.join("\n"))}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    blocks.push(
      createElement(
        listKind,
        { key: blocks.length, start: listKind === "ol" ? list[0].order : undefined },
        list.map((item, index) => (
          <li key={index} value={item.order}>
            {inlineText(item.text)}
          </li>
        )),
      ),
    );
    list = [];
  };

  for (const line of content.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    const numbered = /^\s*(\d+)[.)]\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push(
        createElement(
          `h${Math.min(6, heading[1].length + 1)}`,
          { key: blocks.length },
          inlineText(heading[2]),
        ),
      );
    } else if (/^\s*---+\s*$/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push(<hr key={blocks.length} />);
    } else if (bullet || numbered) {
      flushParagraph();
      const kind = numbered ? "ol" : "ul";
      if (kind !== listKind) flushList();
      listKind = kind;
      list.push(
        numbered ? { text: numbered[2], order: Number(numbered[1]) } : { text: bullet![1] },
      );
    } else {
      flushList();
      if (line.trim()) paragraph.push(line);
      else flushParagraph();
    }
  }
  flushParagraph();
  flushList();
  return <div className="planning-report-content">{blocks}</div>;
}
