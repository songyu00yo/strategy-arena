import { describe, expect, it } from "vitest";
import type { MaterialSource } from "../src/lib/intake-contracts";
import { sourceBlock } from "../src/lib/server/material-provenance";
import { freezeCorpus, retrieveCorpus } from "../src/lib/server/retrieval";

const source = (
  id: string,
  text: string,
  origin: MaterialSource["origin"] = "document",
): MaterialSource => ({
  id,
  text,
  origin,
  attachmentId: "attachment",
  filename: `${id}.txt`,
  location: "正文",
  interpretation: false,
});
describe("frozen version material retrieval", () => {
  it("retrieves full parsed attachments beyond their truncated material previews", () => {
    const full = source("S-full", `${"普通文字".repeat(3000)}\n末尾专属关键词量子通信`);
    const corpus = freezeCorpus("version", "预览正文已省略", [full]);
    expect(retrieveCorpus(corpus, "量子通信")[0]).toMatchObject({
      sourceId: "S-full",
      filename: "S-full.txt",
      origin: "document",
    });
    expect(retrieveCorpus(corpus, "量子通信")[0].text).toContain("末尾专属关键词");
  });
  it("copies source data and preserves stable references and hashes across persistence", () => {
    const full = source("S-original", "预算上限三百元");
    const corpus = freezeCorpus("version", "", [full], "2026-01-01T00:00:00.000Z");
    full.text = "原材料被修改";
    expect(corpus.sources[0].text).toBe("预算上限三百元");
    expect(retrieveCorpus(JSON.parse(JSON.stringify(corpus)), "预算")).toEqual(
      retrieveCorpus(corpus, "预算"),
    );
    expect(freezeCorpus("version", "", [full]).snapshotHash).not.toBe(corpus.snapshotHash);
  });
  it("ranks all documents together, removes duplicate text and excludes rendered headers", () => {
    const a = source("S-a", "学习计划需要复习");
    const b = source("S-b", "量子通信实验");
    const duplicate = source("S-c", "量子通信实验");
    const corpus = freezeCorpus("version", `用户补充量子通信\n${sourceBlock(b)}`, [
      a,
      b,
      duplicate,
    ]);
    const hits = retrieveCorpus(corpus, "量子通信");
    expect(hits.map((hit) => hit.text)).toHaveLength(2);
    expect(hits.some((hit) => hit.text.startsWith("[S-b]"))).toBe(false);
    expect(hits.filter((hit) => hit.text === "量子通信实验")).toHaveLength(1);
    expect(hits.every((hit) => hit.snapshotHash === corpus.snapshotHash)).toBe(true);
  });
  it("keeps model interpretations and unregistered historical headers untrusted", () => {
    const interpretation = { ...source("S-model", "材料可能可行"), interpretation: true };
    const legacy = "[S-old] 文件：旧文件；位置：第一页\n历史文字关键词";
    const corpus = freezeCorpus("version", legacy, [interpretation]);
    expect(retrieveCorpus(corpus, "材料")[0].origin).toBe("model_interpretation");
    expect(retrieveCorpus(corpus, "历史文字")[0].origin).toBe("unknown");
  });
  it("retains distinct provenance for identical text and handles missing query matches", () => {
    const corpus = freezeCorpus("version", "", [
      source("S-doc", "费用报价"),
      source("S-model", "费用报价", "model_transcription"),
    ]);
    expect(
      retrieveCorpus(corpus, "费用")
        .map((hit) => hit.origin)
        .sort(),
    ).toEqual(["document", "model_transcription"]);
    expect(retrieveCorpus(corpus, " completely-unrelated ")).toEqual([]);
    expect(() => retrieveCorpus(corpus, "费用", 0)).toThrow();
  });
});
