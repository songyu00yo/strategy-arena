import { createHash } from "node:crypto";
import type { MaterialSource } from "../intake-contracts";
import { materialSpans, type MaterialOrigin } from "./material-provenance";
import { chunkMaterials, rankMaterialChunks } from "./tools";

export interface CorpusChunk {
  id: string;
  sourceId: string;
  filename: string;
  location: string;
  text: string;
  start: number;
  end: number;
  origin: MaterialOrigin;
}
export interface FrozenCorpus {
  versionId: string;
  snapshotHash: string;
  createdAt: string;
  sources: MaterialSource[];
  chunks: CorpusChunk[];
}
export type RetrievalHit = CorpusChunk & { snapshotHash: string; score: number };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Persist the returned value with its version. Never reconstruct it from a mutable intake. */
export function freezeCorpus(
  versionId: string,
  materials: string,
  sources: MaterialSource[] = [],
  createdAt = new Date().toISOString(),
): FrozenCorpus {
  const copiedSources = structuredClone(sources);
  const snapshotHash = hash(JSON.stringify({ materials, sources: copiedSources }));
  const spans = materialSpans(materials, copiedSources);
  const freeText = chunkMaterials(materials, copiedSources)
    .filter(
      (chunk) =>
        !spans.some((span) => span.registered && span.start < chunk.end && span.end > chunk.start),
    )
    .map(
      (chunk): CorpusChunk => ({
        id: `R-${hash(`${snapshotHash}:text:${chunk.start}`).slice(0, 24)}`,
        sourceId: chunk.provenance?.sourceId ?? `U-${snapshotHash.slice(0, 16)}`,
        filename: chunk.provenance?.filename ?? "用户文字材料",
        location: chunk.provenance?.location ?? `第${chunk.line}行`,
        text: chunk.text,
        start: chunk.start,
        end: chunk.end,
        origin: chunk.provenance?.origin ?? "user_text",
      }),
    );
  const documentChunks = copiedSources.flatMap((source) =>
    chunkMaterials(source.text).map(
      (chunk): CorpusChunk => ({
        id: `R-${hash(`${snapshotHash}:${source.id}:${chunk.start}`).slice(0, 24)}`,
        sourceId: source.id,
        filename: source.filename,
        location: `${source.location} · 第${chunk.line}行`,
        text: chunk.text,
        start: chunk.start,
        end: chunk.end,
        origin: source.interpretation ? "model_interpretation" : (source.origin ?? "unknown"),
      }),
    ),
  );
  return {
    versionId,
    snapshotHash,
    createdAt,
    sources: copiedSources,
    chunks: [...freeText, ...documentChunks],
  };
}

/** All parsed sources compete in one ranking, including text omitted from the intake preview. */
export function retrieveCorpus(corpus: FrozenCorpus, query: string, limit = 4): RetrievalHit[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 12)
    throw new Error("检索结果数量必须为1至12。");
  const seen = new Set<string>();
  return rankMaterialChunks(corpus.chunks, query)
    .filter(({ chunk }) => {
      const key = `${chunk.origin}:${chunk.text.trim().replace(/\s+/g, " ")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .map(({ chunk, score }) => ({ ...chunk, snapshotHash: corpus.snapshotHash, score }));
}
