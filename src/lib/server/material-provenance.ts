import type { MaterialSource } from "../intake-contracts";

export type MaterialOrigin = NonNullable<MaterialSource["origin"]> | "user_text" | "unknown";
export interface MaterialSpan {
  start: number;
  end: number;
  origin: MaterialOrigin;
  sourceId?: string;
  filename?: string;
  location?: string;
  registered?: boolean;
}

/** Keep rendering and retrieval aligned; an inline label is never proof of its own origin. */
export function sourceBlock(source: MaterialSource) {
  return `[${source.id}] 文件：${source.filename}；位置：${source.location}${source.interpretation ? "；模型解读，非原文" : ""}\n${source.text}`;
}

export function materialSpans(materials: string, sources: MaterialSource[] = []): MaterialSpan[] {
  const spans: MaterialSpan[] = [];
  for (const source of sources) {
    const block = sourceBlock(source);
    if (!source.text) continue;
    let start = materials.indexOf(block);
    while (start >= 0) {
      spans.push({
        start,
        end: start + block.length,
        origin:
          source.interpretation || source.origin === "model_interpretation"
            ? "model_interpretation"
            : (source.origin ?? "unknown"),
        sourceId: source.id,
        registered: true,
        filename: source.filename,
        location: source.location,
      });
      start = materials.indexOf(block, start + block.length);
    }
  }
  // Historical headers may survive without the structured source record. Preserve their warning,
  // but never upgrade a header's self-description into document provenance.
  const headers = [...materials.matchAll(/^\[S-[^\]\r\n]+\] 文件：[^\r\n]+/gm)];
  headers.forEach((header, index) => {
    if (spans.some((span) => span.registered && span.start === header.index)) return;
    const description = header[0].match(/^\[[^\]]+\] 文件：(.*?)；位置：(.*)$/);
    spans.push({
      start: header.index!,
      end: headers[index + 1]?.index ?? materials.length,
      origin: /模型解读/.test(header[0])
        ? "model_interpretation"
        : /模型转录/.test(header[0])
          ? "model_transcription"
          : "unknown",
      ...(description
        ? { filename: description[1], location: description[2].replace(/；模型解读，非原文$/, "") }
        : {}),
    });
  });
  return spans;
}

export function materialSpanAt(spans: MaterialSpan[], start: number, end: number): MaterialSpan {
  const overlapping = spans.filter((span) => span.start < end && span.end > start);
  const registered = overlapping.filter((span) => span.registered);
  const candidates = registered.length ? registered : overlapping;
  const unoriginal = candidates.find((span) => !["user_text", "document"].includes(span.origin));
  if (unoriginal) return unoriginal;
  const contained = candidates.find((span) => start >= span.start && end <= span.end);
  if (contained) return contained;
  return { start, end, origin: candidates.length ? "unknown" : "user_text" };
}

export function originalUserText(materials: string, sources: MaterialSource[] = []) {
  const spans = materialSpans(materials, sources);
  const boundaries = [
    ...new Set([0, materials.length, ...spans.flatMap((span) => [span.start, span.end])]),
  ].sort((a, b) => a - b);
  return boundaries
    .slice(0, -1)
    .map((start, index) => {
      const end = boundaries[index + 1];
      const span = materialSpanAt(spans, start, end);
      const text = materials.slice(start, end);
      return ["user_text", "document"].includes(span.origin) ? text : text.replace(/[^\r\n]/g, " ");
    })
    .join("");
}
