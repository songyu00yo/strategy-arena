import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import sharp from "sharp";
import { parseAttachment } from "../src/lib/server/attachment-parser";
import { docxFixture, pdfFixture, zipFixture } from "./fixtures/attachments/generate";

describe("local attachment parsing with synthetic fixtures", () => {
  it("preserves UTF-8 text and line references and rejects invalid encoding", async () => {
    const parsed = await parseAttachment(Buffer.from("目标：学会数学\n预算：300 元"), "plan.md");
    expect(parsed.chunks).toEqual([
      { location: "第 1–2 行", text: "目标：学会数学\n预算：300 元" },
    ]);
    await expect(
      parseAttachment(Buffer.from([0xff, 0xfe, 0, 1]), "plan.txt"),
    ).rejects.toMatchObject({ code: "invalid_encoding" });
  });
  it("preserves CSV cell coordinates, multiline cells, and formula text without evaluating", async () => {
    const parsed = await parseAttachment(
      Buffer.from('\uFEFFname,cost\n"two\nlines",=1+2'),
      "plan.csv",
    );
    expect(parsed.kind).toBe("spreadsheet");
    expect(parsed.chunks).toContainEqual({ location: "CSV!A2", text: "two\nlines" });
    expect(parsed.chunks).toContainEqual({ location: "CSV!B2", text: "=1+2" });
  });
  it("reads XLSX sheet/cell coordinates and labels unexecuted formulas", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("预算");
    sheet.getCell("B3").value = "交通";
    sheet.getCell("C3").value = { formula: "1+2", result: 3 };
    const parsed = await parseAttachment(
      Buffer.from(await workbook.xlsx.writeBuffer()),
      "budget.xlsx",
    );
    expect(parsed.chunks).toContainEqual({ location: "预算!B3", text: "交通" });
    expect(parsed.chunks).toContainEqual({
      location: "预算!C3",
      text: "[公式未执行：1+2] 缓存结果：3",
    });
    expect(parsed.warnings.join(" ")).toContain("公式未执行");
  });
  it("extracts DOCX paragraphs and table cell text with a layout warning", async () => {
    const parsed = await parseAttachment(docxFixture(), "plan.docx");
    expect(parsed.chunks.map((chunk) => chunk.text).join(" ")).toContain("Example plan");
    expect(parsed.chunks.map((chunk) => chunk.text).join(" ")).toContain("Budget");
    expect(parsed.chunks.map((chunk) => chunk.text).join(" ")).toContain("300");
    expect(parsed.warnings.join(" ")).toContain("表格");
  });
  it("extracts text PDF and renders graphics in mixed text pages", async () => {
    const text = await parseAttachment(pdfFixture(), "plan.pdf");
    expect(text.pageCount).toBe(1);
    expect(text.chunks[0]).toMatchObject({ location: "第 1 页" });
    expect(text.chunks[0].text).toContain("Example page 1");
    expect(text.images).toEqual([]);
    const mixed = await parseAttachment(pdfFixture(1, true, true), "chart.pdf");
    expect(mixed.chunks[0].text).toContain("Example page 1");
    expect(mixed.images[0].dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(Math.max(mixed.images[0].width, mixed.images[0].height)).toBeLessThanOrEqual(1536);
  });
  it("renders image-only PDF pages and requires page selection above 20 pages", async () => {
    const raster = await sharp({
      create: { width: 400, height: 500, channels: 3, background: "white" },
    })
      .jpeg()
      .toBuffer();
    const scanned = await parseAttachment(pdfFixture(1, false, false, false, raster), "scan.pdf");
    expect(scanned.chunks).toEqual([]);
    expect(scanned.images).toHaveLength(1);
    await expect(parseAttachment(pdfFixture(21), "long.pdf")).rejects.toMatchObject({
      code: "needs_page_selection",
      pageCount: 21,
    });
    const selected = await parseAttachment(pdfFixture(21), "long.pdf", { pages: [21] });
    expect(selected.chunks[0].text).toContain("Example page 21");
    expect(selected.warnings.join(" ")).toContain("其余页面未读取");
    await expect(parseAttachment(pdfFixture(), "plan.pdf", { pages: [2] })).rejects.toMatchObject({
      code: "invalid_pages",
    });
    await expect(
      parseAttachment(pdfFixture(), "plan.pdf", { pages: [1, 1] }),
    ).rejects.toMatchObject({ code: "invalid_pages" });
  });
  it.each(["png", "jpeg", "webp"] as const)(
    "sniffs and downsizes %s to bounded JPEG",
    async (format) => {
      const bytes = await sharp({
        create: { width: 2000, height: 1000, channels: 3, background: "white" },
      })
        .toFormat(format)
        .toBuffer();
      const parsed = await parseAttachment(bytes, `image.${format}`);
      expect(parsed.kind).toBe("image");
      expect(parsed.images[0]).toMatchObject({ width: 1536, height: 768 });
      expect(parsed.images[0].dataUrl).toMatch(/^data:image\/jpeg;base64,/);
      await expect(parseAttachment(bytes, "fake.pdf")).rejects.toMatchObject({
        code: "format_mismatch",
      });
    },
  );
  it("rejects damaged, encrypted, oversized, and mismatched input", async () => {
    await expect(parseAttachment(Buffer.from("%PDF-1.4 broken"), "bad.pdf")).rejects.toMatchObject({
      code: "invalid_format",
    });
    await expect(
      parseAttachment(pdfFixture(1, true, false, true), "encrypted.pdf"),
    ).rejects.toMatchObject({ code: "encrypted" });
    await expect(
      parseAttachment(Buffer.alloc(10 * 1024 * 1024 + 1), "large.txt"),
    ).rejects.toMatchObject({ code: "file_too_large" });
    await expect(
      parseAttachment(Buffer.from("a".repeat(200_001)), "long.txt"),
    ).rejects.toMatchObject({ code: "extraction_limit" });
    await expect(parseAttachment(Buffer.from("not a pdf"), "fake.pdf")).rejects.toMatchObject({
      code: "unsupported_format",
    });
    await expect(parseAttachment(docxFixture(), "fake.xlsx")).rejects.toMatchObject({
      code: "format_mismatch",
    });
  });
  it("rejects ZIP expansion limits and XML entity declarations before Office parsing", async () => {
    const oversized = docxFixture();
    const central = oversized.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    oversized.writeUInt16LE(8, central + 10);
    oversized.writeUInt16LE(8, 8);
    oversized.writeUInt32LE(50 * 1024 * 1024, central + 24);
    await expect(parseAttachment(oversized, "large.docx")).rejects.toMatchObject({
      code: "extraction_limit",
    });
    const entity = zipFixture({
      "word/document.xml": '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><x>&x;</x>',
    });
    await expect(parseAttachment(entity, "entity.docx")).rejects.toMatchObject({
      code: "invalid_format",
    });
  });
});
