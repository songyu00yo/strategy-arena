import path from "node:path";
import { TextDecoder } from "node:util";
import sharp from "sharp";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { parse as parseCsv } from "csv-parse/sync";
import yauzl from "yauzl";

export interface ParsedAttachment {
  kind: "document" | "spreadsheet" | "image";
  pageCount?: number;
  chunks: Array<{ location: string; text: string }>;
  images: Array<{ location: string; dataUrl: string; width: number; height: number }>;
  warnings: string[];
}

export class AttachmentParseError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly pageCount?: number,
  ) {
    super(message);
    this.name = "AttachmentParseError";
  }
}

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_TEXT = 200_000;
const MAX_CELLS = 20_000;
const extractedSizes = new WeakMap<ParsedAttachment, number>();
const MAX_ZIP_BYTES = 40 * 1024 * 1024;
function fail(code: string, message: string): never {
  throw new AttachmentParseError(code, message);
}

function addChunk(result: ParsedAttachment, location: string, text: string) {
  if (!text.trim()) return;
  const size = extractedSizes.get(result) ?? 0;
  if (size + text.length > MAX_TEXT)
    fail("extraction_limit", "提取文字超过 20 万字，请拆分材料后上传。");
  result.chunks.push({ location, text });
  extractedSizes.set(result, size + text.length);
}

function decodeText(bytes: Buffer) {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("invalid_encoding", "文字文件须使用 UTF-8 编码。");
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
    fail("invalid_format", "文件内容不是受支持的文字格式。");
  }
  if (text.length > MAX_TEXT) fail("extraction_limit", "提取文字超过 20 万字，请拆分材料后上传。");
  return text;
}

async function imageResult(bytes: Buffer, location: string) {
  const { data, info } = await sharp(bytes, { limitInputPixels: 40_000_000, failOn: "warning" })
    .rotate()
    .resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85 })
    .toBuffer({ resolveWithObject: true });
  return {
    location,
    dataUrl: `data:image/jpeg;base64,${data.toString("base64")}`,
    width: info.width,
    height: info.height,
  };
}

// Inspect every member before Office parsers expand the archive. Never write ZIP paths to disk.
async function inspectOfficeZip(bytes: Buffer) {
  return new Promise<Set<string>>((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip)
        return reject(new AttachmentParseError("invalid_format", "Office 文件已损坏。"));
      let count = 0;
      let total = 0;
      let settled = false;
      const names = new Set<string>();
      const abort = (reason: unknown) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(
          reason instanceof AttachmentParseError
            ? reason
            : new AttachmentParseError("invalid_format", "Office 压缩内容已损坏。"),
        );
      };
      zip.on("error", abort);
      zip.on("end", () => {
        if (!settled) {
          settled = true;
          resolve(names);
        }
      });
      zip.on("entry", (entry: yauzl.Entry) => {
        count++;
        total += entry.uncompressedSize;
        if (count > 2000 || total > MAX_ZIP_BYTES || entry.uncompressedSize > 20 * 1024 * 1024) {
          return abort(
            new AttachmentParseError("extraction_limit", "Office 文件解压后过大，请拆分材料。"),
          );
        }
        if (entry.generalPurposeBitFlag & 1)
          return abort(new AttachmentParseError("encrypted", "暂不支持加密文件，请先解密。"));
        if (names.has(entry.fileName) || entry.fileName.split("/").includes(".."))
          return abort(new Error("Invalid ZIP entry"));
        names.add(entry.fileName);
        if (/\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return abort(streamError);
          let actual = 0;
          let tail = "";
          stream.on("error", abort);
          stream.on("data", (chunk: Buffer) => {
            actual += chunk.length;
            if (actual > entry.uncompressedSize || actual > 20 * 1024 * 1024) {
              stream.destroy();
              abort(new AttachmentParseError("extraction_limit", "Office 文件解压内容过大。"));
              return;
            }
            if (/\.xml(?:\.rels)?$|\.rels$/i.test(entry.fileName)) {
              const text = tail + chunk.toString("utf8");
              if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(text)) {
                stream.destroy();
                abort(
                  new AttachmentParseError(
                    "invalid_format",
                    "不支持含外部实体声明的 Office 文件。",
                  ),
                );
                return;
              }
              tail = text.slice(-32);
            }
          });
          stream.on("end", () => {
            if (!settled) zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return String(value);
  if ("richText" in value) return value.richText.map((part) => part.text).join("");
  if ("formula" in value || "sharedFormula" in value) {
    const formula = "formula" in value ? value.formula : `shared:${value.sharedFormula}`;
    return `[公式未执行：${formula}]${value.result === undefined ? "（无缓存结果）" : ` 缓存结果：${String(value.result)}`}`;
  }
  if ("hyperlink" in value) return value.text;
  if ("error" in value) return value.error;
  return String(value);
}

async function parsePdf(bytes: Buffer, pages?: number[]): Promise<ParsedAttachment> {
  // Legacy build supports Node's canvas implementation; document data is always local bytes.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");
  const loading = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    stopAtErrors: true,
    useWorkerFetch: false,
    useWasm: false,
    disableAutoFetch: true,
    disableFontFace: true,
    useSystemFonts: true,
    enableXfa: false,
    maxImageSize: 40_000_000,
    verbosity: 0,
  });
  try {
    const pdf = await loading.promise;
    const pageCount = pdf.numPages;
    if (!pages && pageCount > 20)
      throw new AttachmentParseError(
        "needs_page_selection",
        `此 PDF 共 ${pageCount} 页，请选择本次读取的页码（最多 20 页）。`,
        pageCount,
      );
    const selected = pages ?? Array.from({ length: pageCount }, (_, i) => i + 1);
    if (
      !selected.length ||
      selected.length > 20 ||
      new Set(selected).size !== selected.length ||
      selected.some((page) => !Number.isInteger(page) || page < 1 || page > pageCount)
    ) {
      fail("invalid_pages", "页码须在文件范围内、不重复，且每次最多选择 20 页。");
    }
    const result: ParsedAttachment = {
      kind: "document",
      pageCount,
      chunks: [],
      images: [],
      warnings: [],
    };
    if (selected.length < pageCount)
      result.warnings.push(`仅读取所选页：${selected.join("、")}；其余页面未读取。`);
    for (const pageNumber of selected) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
        .join("")
        .trim();
      const location = `第 ${pageNumber} 页`;
      addChunk(result, location, text);
      const operators = await page.getOperatorList();
      const visualOps = new Set([
        pdfjs.OPS.paintImageXObject,
        pdfjs.OPS.paintInlineImageXObject,
        pdfjs.OPS.paintImageMaskXObject,
        pdfjs.OPS.constructPath,
      ]);
      if (!text || operators.fnArray.some((op: number) => visualOps.has(op))) {
        const viewport = page.getViewport({ scale: 1 });
        const scale = Math.min(1536 / Math.max(viewport.width, viewport.height), 2);
        const sized = page.getViewport({ scale });
        if (
          !Number.isFinite(sized.width) ||
          !Number.isFinite(sized.height) ||
          sized.width <= 0 ||
          sized.height <= 0
        )
          fail("invalid_format", "PDF 页面尺寸无效。");
        const canvas = createCanvas(
          Math.max(1, Math.ceil(sized.width)),
          Math.max(1, Math.ceil(sized.height)),
        );
        await page.render({
          canvas: canvas as unknown as HTMLCanvasElement,
          canvasContext: canvas.getContext("2d") as unknown as CanvasRenderingContext2D,
          viewport: sized,
        }).promise;
        result.images.push(await imageResult(canvas.toBuffer("image/png"), location));
        result.warnings.push(
          `${location}包含扫描内容或图形，已保留页面图像供视觉读取；文字提取不代表图形已被解析。`,
        );
      }
      page.cleanup();
    }
    return result;
  } finally {
    await loading.destroy();
  }
}

export async function parseAttachment(
  bytes: Buffer,
  filename: string,
  options: { pages?: number[] } = {},
): Promise<ParsedAttachment> {
  if (!bytes.length) fail("empty_file", "文件为空。");
  if (bytes.length > MAX_BYTES) fail("file_too_large", "单个文件不能超过 10 MiB。");
  const extension = path.extname(filename).toLowerCase();
  const result: ParsedAttachment = { kind: "document", chunks: [], images: [], warnings: [] };
  try {
    if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") {
      if (extension !== ".pdf") fail("format_mismatch", "文件实际格式与扩展名不一致。");
      return await parsePdf(bytes, options.pages);
    }
    const imageType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "png"
      : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        ? "jpeg"
        : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP"
          ? "webp"
          : null;
    if (imageType) {
      if (!(imageType === "jpeg" ? [".jpg", ".jpeg"] : [`.${imageType}`]).includes(extension))
        fail("format_mismatch", "文件实际格式与扩展名不一致。");
      return {
        ...result,
        kind: "image",
        images: [await imageResult(bytes, "图片 1")],
        warnings: ["图片保留为视觉材料，尚未执行 OCR 或内容理解。"],
      };
    }
    if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      const names = await inspectOfficeZip(bytes);
      if (
        extension === ".docx" &&
        names.has("word/document.xml") &&
        names.has("[Content_Types].xml")
      ) {
        const extracted = await mammoth.extractRawText({ buffer: bytes });
        extracted.value
          .split(/\n\s*\n/)
          .forEach((text, index) => addChunk(result, `段落 ${index + 1}`, text));
        result.warnings.push(
          "DOCX 按正文段落提取；表格单元格按文档顺序展开，布局、图片和合并关系未保留。",
        );
        if (extracted.messages.length)
          result.warnings.push("文档包含部分不受支持的内容，请核对原文。");
        return result;
      }
      if (
        extension === ".xlsx" &&
        names.has("xl/workbook.xml") &&
        names.has("[Content_Types].xml")
      ) {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
        result.kind = "spreadsheet";
        let cells = 0;
        workbook.eachSheet((sheet) =>
          sheet.eachRow((row) =>
            row.eachCell((cell) => {
              if (++cells > MAX_CELLS)
                fail("extraction_limit", "非空单元格超过 2 万个，请拆分表格。");
              addChunk(result, `${sheet.name}!${cell.address}`, cellText(cell.value));
            }),
          ),
        );
        result.warnings.push(
          "仅读取单元格文字与公式缓存结果；公式未执行，图表、图片和外部链接内容未读取。",
        );
        return result;
      }
      fail("format_mismatch", "文件不是与扩展名一致的 DOCX 或 XLSX 文件。");
    }
    if ([".txt", ".md", ".csv"].includes(extension)) {
      const text = decodeText(bytes);
      if (extension === ".csv") {
        result.kind = "spreadsheet";
        const rows: string[][] = parseCsv(text, {
          bom: true,
          skip_empty_lines: true,
          relax_column_count: true,
          max_record_size: MAX_TEXT,
        });
        let cells = 0;
        rows.forEach((row, index) =>
          row.forEach((value, column) => {
            if (++cells > MAX_CELLS) fail("extraction_limit", "单元格超过 2 万个，请拆分表格。");
            let letters = "";
            for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26))
              letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
            addChunk(result, `CSV!${letters}${index + 1}`, value);
          }),
        );
        return result;
      }
      const lines = text.split("\n");
      for (let start = 0; start < lines.length; start += 80)
        addChunk(
          result,
          `第 ${start + 1}–${Math.min(start + 80, lines.length)} 行`,
          lines.slice(start, start + 80).join("\n"),
        );
      return result;
    }
    if (bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])))
      fail(
        "encrypted_or_legacy",
        "不支持加密的 Office 文件或旧版 DOC/XLS，请另存为未加密的 DOCX/XLSX。",
      );
    fail(
      "unsupported_format",
      "文件格式无效或不受支持。支持 PDF、DOCX、TXT、MD、XLSX、CSV、PNG、JPEG、WebP。",
    );
  } catch (error) {
    if (error instanceof AttachmentParseError) throw error;
    if (error instanceof Error && /password|encrypted/i.test(error.message))
      fail("encrypted", "暂不支持加密文件，请先解密。");
    return fail("invalid_format", "文件已损坏或包含无法解析的内容，请重新导出后上传。");
  }
}
