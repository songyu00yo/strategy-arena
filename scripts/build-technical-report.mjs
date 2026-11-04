#!/usr/bin/env node
/** Build the 18-page Chinese report without external services or model calls. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, relative, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.includes("--help")) {
  console.log(
    "Usage: node scripts/build-technical-report.mjs [--commit SHA] [--version VERSION] [--eval-summary FILE] [--output FILE.pdf] [--ui-screenshot FILE.png] [--ui-caption TEXT]\nDefaults: current Git SHA, package version, pending evaluation, outputs/technical-report-draft.pdf. SOURCE_DATE_EPOCH controls the displayed build date. No model calls are made.",
  );
  process.exit(0);
}
const allowed = new Set([
  "--commit",
  "--version",
  "--eval-summary",
  "--output",
  "--ui-screenshot",
  "--ui-caption",
]);
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!allowed.has(key) || !process.argv[i + 1] || process.argv[i + 1].startsWith("--"))
    throw new Error(`Unknown or missing option: ${key}`);
  options[key] = process.argv[i + 1];
}
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commit = options["--commit"] || git("rev-parse", "HEAD");
if (!/^[a-f0-9]{7,40}$/i.test(commit))
  throw new Error("--commit must be a Git SHA (7–40 hexadecimal characters)");
const version =
  options["--version"] || JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const dirty = !!git("status", "--porcelain");
const builtAt = process.env.SOURCE_DATE_EPOCH
  ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000)
  : new Date();
if (!Number.isFinite(builtAt.getTime())) throw new Error("Invalid SOURCE_DATE_EPOCH");
const date = builtAt.toISOString().slice(0, 10);
const output = resolve(root, options["--output"] || "outputs/technical-report-draft.pdf");
if (!output.endsWith(".pdf")) throw new Error("--output must end with .pdf");
const sourcePath = resolve(root, "docs/technical-report.md");
const source = readFileSync(sourcePath, "utf8");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
function inline(value) {
  const held = [];
  let text = value.replace(
    /`([^`]+)`/g,
    (_, x) => `\u0000${held.push(`<code>${esc(x)}</code>`) - 1}\u0000`,
  );
  text = esc(text);
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  text = text.replace(/&lt;(https?:\/\/[^&]+)&gt;/g, '<a href="$1">$1</a>');
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return text.replace(/\u0000(\d+)\u0000/g, (_, n) => held[Number(n)]);
}
function markdown(block) {
  const lines = block.trim().split("\n");
  let html = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith("<!-- DYNAMIC:")) {
      html += line;
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      let code = "";
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code += `${lines[i++]}\n`;
      i++;
      html += `<pre><code>${esc(code.trimEnd())}</code></pre>`;
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      html += `<h${level}>${inline(heading[2])}</h${level}>`;
      i++;
      continue;
    }
    if (line.startsWith("|")) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|"))
        rows.push(
          lines[i++]
            .split("|")
            .slice(1, -1)
            .map((s) => s.trim()),
        );
      html += `<table><thead><tr>${rows[0].map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead><tbody>${rows
        .slice(2)
        .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`;
      continue;
    }
    if (line.startsWith("- ")) {
      html += "<ul>";
      while (i < lines.length && lines[i].startsWith("- "))
        html += `<li>${inline(lines[i++].slice(2))}</li>`;
      html += "</ul>";
      continue;
    }
    let paragraph = line;
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,3} |\||```|- |<!-- DYNAMIC:)/.test(lines[i])
    )
      paragraph += lines[i++];
    html += `<p>${inline(paragraph)}</p>`;
  }
  return html;
}
let evaluationHash = null;
function evaluationHtml() {
  if (!options["--eval-summary"])
    return '<div class="notice"><strong>冻结评测汇总待补充</strong><p>本次构建未提供最终汇总。正式完成率与人工质量评分保持未确认；不从开发联调推断优越性。</p></div>';
  const path = resolve(root, options["--eval-summary"]);
  const bytes = readFileSync(path);
  const summary = JSON.parse(bytes);
  evaluationHash = hash(bytes);
  const rows = summary.aggregates || summary.perArm;
  let html = `<div class="eval-summary"><h3>本次构建载入的实际汇总</h3><p>状态：${esc(summary.status || "源文件未给出状态")}。来源：<code>${esc(basename(path))}</code>。</p>`;
  if (Array.isArray(rows)) {
    html +=
      "<table><thead><tr><th>方法</th><th>记录数 / 完成数</th><th>费用估算（元）</th></tr></thead><tbody>";
    for (const row of rows)
      html += `<tr><td>${esc(row.arm)}</td><td>${esc(row.count ?? row.trajectories ?? "未提供")} / ${esc(row.completed ?? "未提供")}</td><td>${Number.isFinite(row.totalCostCny ?? row.costCny) ? (row.totalCostCny ?? row.costCny).toFixed(6) : "未提供"}</td></tr>`;
    html += "</tbody></table>";
    const scored = rows.filter(
      (row) => row.meanScores && Object.values(row.meanScores).every(Number.isFinite),
    );
    if (scored.length)
      html += `<p>源文件包含人工评分汇总；须核对评分人与配对完整性。本页只展示运行概况，不自动生成质量胜负。</p>`;
    else html += "<p>未载入完整人工质量均值，不生成质量结论。</p>";
  } else html += "<p>源文件未提供可识别的方法汇总表。保留文件哈希，不推测缺失统计。</p>";
  return html + `<p class="hash-line">汇总 SHA-256：${evaluationHash}</p></div>`;
}
const evaluation = evaluationHtml();
const defaultScreenshot = resolve(root, "work/actualAPI-syntheticinput/04-v1-evidence.png");
const screenshot = options["--ui-screenshot"]
  ? resolve(root, options["--ui-screenshot"])
  : defaultScreenshot;
let screenshotHash = null;
let uiHtml = '<div class="notice"><p>同版本界面截图待补充。此处没有生成或替代截图。</p></div>';
if (existsSync(screenshot)) {
  const bytes = readFileSync(screenshot);
  screenshotHash = hash(bytes);
  const type = /\.jpe?g$/i.test(screenshot) ? "image/jpeg" : "image/png";
  const caption =
    options["--ui-caption"] || "历史实际浏览器联调：3 分钟合成输入的证据抽屉，非最终冻结页面。";
  uiHtml = `<figure><img src="data:${type};base64,${bytes.toString("base64")}" alt="${esc(caption)}"><figcaption>${esc(caption)}</figcaption></figure>`;
} else if (options["--ui-screenshot"]) throw new Error("Specified screenshot does not exist");
const metadata = `<div class="cover-metadata"><dl><div><dt>版本</dt><dd>${esc(version)} / 阶段草稿</dd></div><div><dt>源码标识</dt><dd>${esc(commit)}</dd></div><div><dt>工作区</dt><dd>${dirty ? "存在未提交变更；本稿不能充当冻结凭据" : "构建时工作区干净"}</dd></div><div><dt>构建日期</dt><dd>${esc(date)}</dd></div><div><dt>评测汇总</dt><dd>${evaluationHash ? "已载入实际文件，见第 15 页" : "待冻结与人工核对"}</dd></div></dl></div>`;
const blocks = source.split(/\n<!-- PAGE -->\n/);
if (blocks.length !== 18) throw new Error(`Expected 18 report pages, found ${blocks.length}`);
const pages = blocks
  .map(
    (block, index) =>
      `<section class="page ${index === 0 ? "cover" : ""}"><header><span>方案擂台 · 技术报告</span><span>阶段草稿 / ${esc(version)}</span></header><article class="page-body">${markdown(block).replace("<!-- DYNAMIC:METADATA -->", metadata).replace("<!-- DYNAMIC:EVALUATION -->", evaluation).replace("<!-- DYNAMIC:UI_SCREENSHOT -->", uiHtml)}</article><footer><span>${esc(commit.slice(0, 12))} · ${esc(date)}${dirty ? " · dirty" : ""}</span><span>${String(index + 1).padStart(2, "0")} / 18</span></footer></section>`,
  )
  .join("");
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>方案擂台技术报告 ${esc(version)}</title><style>
@page{size:A4;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#e8e9e2;color:#20251e;font-family:"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}.page{width:210mm;height:297mm;padding:16mm 18mm 14mm;background:#fffefa;display:flex;flex-direction:column;break-after:page;page-break-after:always;position:relative}.page:last-child{break-after:auto;page-break-after:auto}.page>header{font-size:8pt;color:#88907c;border-bottom:.5pt solid #cbd1bf;padding-bottom:4mm;display:flex;justify-content:space-between;flex-shrink:0;height:10mm;letter-spacing:.3pt}.page-body{flex:1;min-height:0;padding-top:6mm;overflow:visible}.page>footer{height:9mm;flex-shrink:0;border-top:.5pt solid #dbe0d2;display:flex;align-items:flex-end;justify-content:space-between;font-size:7.3pt;color:#8e9782}h1{font-size:37pt;line-height:1.23;letter-spacing:-1pt;margin:0 0 11mm;font-weight:750}h2{font-size:19pt;line-height:1.5;letter-spacing:-.4pt;font-weight:700;margin:0 0 6mm;padding-bottom:3.5mm;border-bottom:1.5pt solid #254fe3}h3{font-size:11.3pt;margin:5mm 0 2.4mm;line-height:1.6;font-weight:650;color:#4d6540}p,li{font-size:10.6pt;line-height:1.85;margin:2.6mm 0;letter-spacing:.05pt;word-break:normal;overflow-wrap:anywhere;text-align:justify}p{orphans:2;widows:2}ul{padding-left:5mm;margin:2.8mm 0}li{padding-left:1mm;margin:2.7mm 0}a{color:#254fe3;text-decoration:none;overflow-wrap:anywhere}code{font-family:"SFMono-Regular",Consolas,monospace;font-size:.86em;background:#eef1e6;padding:.15mm .65mm;border-radius:.3mm;overflow-wrap:anywhere}pre{background:#eef1e6;border-left:2pt solid #93a47e;padding:4mm 4.5mm;margin:4mm 0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7}pre code{font-size:8.2pt;line-height:1.7;background:none;padding:0}table{width:100%;border-collapse:collapse;font-size:9.2pt;line-height:1.7;margin:4mm 0;table-layout:auto}th,td{border-bottom:.5pt solid #d8dfcc;padding:2.5mm 2.1mm;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{font-weight:600;background:#eaf0df;color:#536945}td:first-child{color:#637956}table code{font-size:8pt}strong{font-weight:650}.notice,.eval-summary{background:#eef2e6;border:.5pt solid #d4dfc7;padding:3mm 4mm;margin:4mm 0}.notice p,.eval-summary p{font-size:9.2pt;line-height:1.75;margin:1.7mm 0}.notice strong{font-size:10pt;color:#60784c}.eval-summary h3{font-size:10pt;margin:0 0 2mm}.eval-summary table{font-size:8.5pt;margin:2mm 0}.eval-summary td,.eval-summary th{padding:1.4mm 1.8mm}.hash-line{font-family:monospace;font-size:7.5pt!important;overflow-wrap:anywhere;color:#8a997a}figure{margin:4mm 0 2.5mm;padding:0}figure img{display:block;width:100%;height:105mm;object-fit:contain;object-position:center;border:.5pt solid #d7decb;background:#f7f6f2}figcaption{font-size:8pt;line-height:1.65;color:#87967a;margin-top:2mm}.cover .page-body{padding-top:24mm}.cover h2{border:0;font-size:16pt;color:#254fe3;padding:0;margin:0 0 12mm}.cover p{font-size:11pt;line-height:1.95;margin:5mm 0}.cover-metadata{border-top:1.3pt solid #254fe3;border-bottom:.5pt solid #cbd6bb;padding:5mm 0;margin:10mm 0 8mm}.cover-metadata dl{margin:0}.cover-metadata dl>div{display:flex;gap:6mm;margin:3mm 0;font-size:9pt;line-height:1.8}.cover-metadata dt{width:22mm;flex-shrink:0;color:#879775}.cover-metadata dd{margin:0;overflow-wrap:anywhere}.page:nth-child(16) table{font-size:8.3pt;line-height:1.6}.page:nth-child(16) td,.page:nth-child(16) th{padding:1.8mm}.page:nth-child(18) li{font-size:10pt;line-height:1.8}.page:nth-child(15) p{font-size:10pt;line-height:1.8}.page:nth-child(15) table{font-size:8.8pt}.page:nth-child(15) td,.page:nth-child(15) th{padding:1.9mm}
@media screen{body{padding:12mm}.page{margin:0 auto 10mm;box-shadow:0 1mm 6mm #26301c20}}
</style></head><body>${pages}</body></html>`;
const work = resolve(root, "work/technical-report");
mkdirSync(work, { recursive: true });
mkdirSync(dirname(output), { recursive: true });
writeFileSync(resolve(work, "technical-report.html"), html);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1100 } });
  await page.setContent(html, { waitUntil: "load" });
  await page.emulateMedia({ media: "print" });
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.locator(".page-body").evaluateAll((nodes) =>
    nodes
      .map((node, index) => ({
        page: index + 1,
        height: node.clientHeight,
        content: node.scrollHeight,
        width: node.clientWidth,
        contentWidth: node.scrollWidth,
      }))
      .filter((value) => value.content > value.height + 2 || value.contentWidth > value.width + 2),
  );
  if (overflow.length) throw new Error(`Report overflow: ${JSON.stringify(overflow)}`);
  await page.pdf({ path: output, preferCSSPageSize: true, printBackground: true, tagged: true });
} finally {
  await browser.close();
}
const metadataRecord = {
  kind: "technical-report-draft",
  version,
  commit,
  workingTreeDirty: dirty,
  builtAt: builtAt.toISOString(),
  source: relative(root, sourcePath),
  sourceSha256: hash(source),
  evaluationSummarySha256: evaluationHash,
  evaluationSummarySource: options["--eval-summary"] || null,
  screenshotSha256: screenshotHash,
  output: relative(root, output),
  outputSha256: hash(readFileSync(output)),
  expectedPages: 18,
  note: "Reproducible build procedure, not a claim of byte-identical PDF across Chromium/platform versions. No model call, release tag, deployment, or contest submission is performed.",
};
writeFileSync(resolve(work, "build-metadata.json"), JSON.stringify(metadataRecord, null, 2) + "\n");
console.log(JSON.stringify(metadataRecord, null, 2));
