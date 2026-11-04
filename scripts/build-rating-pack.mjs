/** Build an offline HUMAN rating page from anonymous cards only. Never loads run metadata or mappings. */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const metrics = ["constraintCompliance", "claimTraceability", "actionability", "adaptation"];
const pick = (value, keys) =>
  Object.fromEntries(
    keys.filter((key) => Object.hasOwn(value ?? {}, key)).map((key) => [key, value[key]]),
  );
const list = (value) => (Array.isArray(value) ? value : []);
const challengeKeys = [
  "goal",
  "constraints",
  "preferences",
  "options",
  "materials",
  "domain",
  "budget",
  "timeHours",
];
function anonymousCard(card) {
  return {
    label: card.label,
    task: {
      ...pick(card.task, ["id", "changeReason", "positiveChecks", "negativeChecks"]),
      initial: pick(card.task?.initial, challengeKeys),
      changed: pick(card.task?.changed, challengeKeys),
    },
    conditions: list(card.conditions).map((condition) => ({
      ...pick(condition, ["condition", "status", "incomplete"]),
      strategies: list(condition.strategies).map((strategy) => ({
        ...pick(strategy, [
          "id",
          "title",
          "thesis",
          "steps",
          "resources",
          "firstAction",
          "failureCondition",
          "estimatedCost",
          "estimatedHours",
        ]),
        claims: list(strategy.claims).map((claim) =>
          pick(claim, ["id", "text", "status", "sourceIds"]),
        ),
      })),
      evidence: list(condition.evidence).map((evidence) =>
        pick(evidence, [
          "id",
          "attackId",
          "tool",
          "status",
          "title",
          "content",
          "source",
          "sourceIds",
          "expression",
          "result",
          "assumptions",
          "createdAt",
        ]),
      ),
      verdict: condition.verdict
        ? {
            ...pick(condition.verdict, [
              "outcome",
              "preferred",
              "headline",
              "rationale",
              "conditions",
              "uncertainties",
              "nextActions",
              "exitCondition",
              "evidenceIds",
            ]),
            comparisons: list(condition.verdict.comparisons).map((item) =>
              pick(item, ["strategyId", "status", "reason"]),
            ),
            attackFindings: list(condition.verdict.attackFindings).map((item) =>
              pick(item, ["attackId", "status", "reason", "evidenceIds"]),
            ),
          }
        : null,
    })),
  };
}

/** Also embedded verbatim in the HTML. Missing scores stay null, including failed samples. */
export function exportRatingState(template, draft, raterId = draft?.raterId ?? "") {
  const metricNames = ["constraintCompliance", "claimTraceability", "actionability", "adaptation"];
  const records = template.records.map((base) => {
    const saved = Array.isArray(draft?.records)
      ? draft.records.find(
          (item) => item?.label === base.label && item?.condition === base.condition,
        )
      : undefined;
    const value = saved ?? base;
    return {
      label: base.label,
      condition: base.condition,
      raterId: String(raterId).trim(),
      scores: Object.fromEntries(
        metricNames.map((metric) => {
          const score = value.scores?.[metric];
          return [metric, Number.isInteger(score) && score >= 0 && score <= 2 ? score : null];
        }),
      ),
      reason: typeof value.reason === "string" ? value.reason : "",
      evidenceLocations: Array.isArray(value.evidenceLocations)
        ? value.evidenceLocations
            .filter((item) => typeof item === "string" && item.trim())
            .map((item) => item.trim())
        : [],
    };
  });
  return { rubric: template.rubric, records };
}

export function loadAnonymousRun(directory) {
  const blind = resolve(directory, "blind");
  if (!lstatSync(blind).isDirectory() || lstatSync(blind).isSymbolicLink())
    throw new Error("blind must be a regular directory.");
  function read(name) {
    const path = resolve(blind, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20 * 1024 * 1024)
      throw new Error("Anonymous inputs must be regular JSON files below 20 MB.");
    return JSON.parse(readFileSync(path, "utf8"));
  }
  const raw = read("scorecards.json");
  if (!Array.isArray(raw.records) || !raw.records.length)
    throw new Error("Missing anonymous scorecard records.");
  const seen = new Set(),
    labels = new Set();
  for (const record of raw.records) {
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(record.label ?? "") ||
      !["initial", "changed"].includes(record.condition)
    )
      throw new Error("Invalid anonymous label or condition.");
    const key = `${record.label}/${record.condition}`;
    if (seen.has(key)) throw new Error("Duplicate scorecard record.");
    seen.add(key);
    labels.add(record.label);
    if (
      metrics.some(
        (metric) =>
          record.scores?.[metric] !== undefined &&
          record.scores[metric] !== null &&
          (!Number.isInteger(record.scores[metric]) ||
            record.scores[metric] < 0 ||
            record.scores[metric] > 2),
      )
    )
      throw new Error("Invalid human score; expected null or 0/1/2.");
  }
  const filenames = readdirSync(blind)
    .filter((name) => name.endsWith(".json") && name !== "scorecards.json")
    .sort();
  if (filenames.length !== labels.size || filenames.some((name) => !labels.has(name.slice(0, -5))))
    throw new Error("Anonymous cards and scorecards differ; no samples may be omitted.");
  const cards = filenames.map((name) => {
    const card = read(name);
    if (card.label !== name.slice(0, -5) || !card.task || !Array.isArray(card.conditions))
      throw new Error("Malformed anonymous card.");
    if (
      card.conditions.length !== 2 ||
      !["initial", "changed"].every(
        (condition) =>
          card.conditions.filter((item) => item.condition === condition).length === 1 &&
          seen.has(`${card.label}/${condition}`),
      )
    )
      throw new Error("Both initial and changed conditions must be retained, including failures.");
    return anonymousCard(card);
  });
  if (raw.records.length !== cards.length * 2) throw new Error("Missing condition scorecards.");
  const template = {
    rubric: Object.fromEntries(
      metrics.map((metric) => [
        metric,
        typeof raw.rubric?.[metric] === "string"
          ? raw.rubric[metric]
          : "0=未满足，1=部分满足，2=满足。",
      ]),
    ),
    records: raw.records.map((record) =>
      pick(record, ["label", "condition", "raterId", "scores", "reason", "evidenceLocations"]),
    ),
  };
  const raters = [
    ...new Set(template.records.map((record) => record.raterId?.trim()).filter(Boolean)),
  ];
  if (raters.length > 1) throw new Error("Use one independent rater per pack.");
  return {
    cards,
    template: exportRatingState(template, { records: template.records }, raters[0] ?? ""),
    raterId: raters[0] ?? "",
  };
}

function ratingPage() {
  const payload = JSON.parse(document.getElementById("rating-data").textContent);
  const exportState = EXPORT_STATE;
  let state = { raterId: payload.raterId, records: payload.template.records };
  let storageAvailable = true;
  const notice = document.getElementById("notice");
  try {
    const saved = JSON.parse(localStorage.getItem(payload.storageKey) || "null");
    if (saved)
      state = {
        raterId: typeof saved.raterId === "string" ? saved.raterId : "",
        records: exportState(payload.template, saved).records,
      };
  } catch {
    storageAvailable = false;
  }
  const rater = document.getElementById("rater");
  rater.value = state.raterId;
  const statusNames = {
    completed: "已完成",
    failed: "失败",
    uncertain: "结果未知",
    skipped: "未运行",
    budget_exhausted: "额度耗尽",
    found: "检索有命中",
    calculated: "计算已完成",
    unavailable: "资料缺失",
    error: "工具失败",
    unknown: "未知",
    estimate: "估算",
    user: "用户提供",
    supported: "有依据",
    refuted: "已反驳",
    unresolved: "未解决",
    eligible: "满足条件",
    violates: "超出限制",
    recommendation: "有条件建议",
    tie: "并列",
    insufficient: "信息不足",
    infeasible: "不可行",
    partial: "部分结论",
  };
  const named = (value) => statusNames[value] || String(value ?? "未提供");
  const text = (value) => (value === null || value === undefined ? "未提供" : String(value));
  function element(tag, content, parent, className) {
    const node = document.createElement(tag);
    if (content !== undefined) node.textContent = text(content);
    if (className) node.className = className;
    if (parent) parent.append(node);
    return node;
  }
  function row(parent, label, value) {
    if (value === "" || value === undefined) return;
    element("dt", label, parent);
    element("dd", text(value), parent);
  }
  function bullets(parent, title, values) {
    if (!Array.isArray(values) || !values.length) return;
    element("h4", title, parent);
    const ul = element("ul", undefined, parent);
    values.forEach((value) => element("li", value, ul));
  }
  function save() {
    state.raterId = rater.value;
    try {
      localStorage.setItem(payload.storageKey, JSON.stringify(state));
      storageAvailable = true;
    } catch {
      storageAvailable = false;
    }
    const exported = exportState(payload.template, state, state.raterId);
    const count = exported.records.filter(
      (record) =>
        record.raterId &&
        record.reason.trim() &&
        record.evidenceLocations.length &&
        Object.values(record.scores).every(Number.isInteger),
    ).length;
    document.getElementById("progress").textContent =
      `完整填写 ${count} / ${exported.records.length} 条。`;
    notice.textContent = storageAvailable
      ? "草稿仅保存在当前浏览器。交回前请点击“导出评分文件”。"
      : "浏览器未允许本地保存。请及时导出文件，关闭页面可能丢失草稿。";
  }
  rater.addEventListener("input", save);
  function condition(parent, card, run) {
    const area = element("section", undefined, parent, "condition");
    const label = run.condition === "initial" ? "初始条件" : "变化条件";
    element("h3", `${label} · ${named(run.status)}`, area);
    if (run.incomplete || run.status !== "completed")
      element(
        "p",
        "未完成或失败样本：保留全部现有内容，请按实际内容独立评分。系统不会代填分数。",
        area,
        "warning",
      );
    const task = card.task[run.condition] || {};
    const requirements = element("dl", undefined, area);
    row(requirements, "目标", task.goal);
    row(requirements, "硬限制", task.constraints);
    row(requirements, "偏好", task.preferences);
    row(requirements, "预算（元）", task.budget);
    row(requirements, "时间（小时）", task.timeHours);
    bullets(area, "已有备选", task.options);
    if (task.materials) {
      const details = element("details", undefined, area);
      element("summary", "用户提供的文字材料", details);
      element("pre", task.materials, details);
    }
    element("h4", "最终方案", area);
    if (!run.strategies.length) element("p", "没有生成可展示的方案。", area);
    run.strategies.forEach((strategy, index) => {
      const box = element("section", undefined, area, "output");
      element("h4", `方案 ${strategy.id}：${strategy.title}`, box);
      element("small", `${run.condition}.strategies[${index}]`, box);
      element("p", strategy.thesis, box);
      bullets(box, "行动步骤", strategy.steps);
      const info = element("dl", undefined, box);
      row(info, "资源", strategy.resources);
      row(info, "第一步", strategy.firstAction);
      row(info, "退出或失败条件", strategy.failureCondition);
      row(info, "估计费用（元）", strategy.estimatedCost);
      row(info, "估计时间（小时）", strategy.estimatedHours);
      strategy.claims.forEach((claim) =>
        element(
          "p",
          `观点 ${claim.id}［${named(claim.status)}］：${claim.text}；引用：${claim.sourceIds?.join("、") || "无"}`,
          box,
        ),
      );
    });
    element("h4", "工具证据", area);
    if (!run.evidence.length) element("p", "没有工具证据。", area);
    run.evidence.forEach((evidence) => {
      const details = element("details", undefined, area, "output");
      element(
        "summary",
        `${evidence.id} · ${evidence.title}［${named(evidence.status)}］`,
        details,
      );
      element("small", `${run.condition}.evidence / ${evidence.id}`, details);
      element("pre", evidence.content, details);
      const info = element("dl", undefined, details);
      row(info, "来源", evidence.source);
      row(info, "对应质疑", evidence.attackId);
      row(info, "材料定位", evidence.sourceIds?.join("、"));
      row(info, "算式", evidence.expression);
      row(info, "计算结果", evidence.result);
      row(info, "前提与限制", evidence.assumptions);
    });
    element("h4", "最终裁决", area);
    const verdict = run.verdict;
    if (!verdict) element("p", "没有完成裁决。此记录仍须评分，不能删除。", area);
    else {
      const box = element("section", undefined, area, "output");
      element("small", `${run.condition}.verdict`, box);
      element("h4", `${named(verdict.outcome)}：${verdict.headline}`, box);
      element("p", verdict.rationale, box);
      element("p", `优选：${verdict.preferred || "未选定"}`, box);
      bullets(box, "成立条件", verdict.conditions);
      bullets(box, "仍未知", verdict.uncertainties);
      bullets(box, "下一步", verdict.nextActions);
      element("p", `退出条件：${verdict.exitCondition}`, box);
      element("p", `裁决引用：${verdict.evidenceIds?.join("、") || "无"}`, box);
      verdict.comparisons.forEach((item) =>
        element("p", `方案 ${item.strategyId}［${named(item.status)}］：${item.reason}`, box),
      );
      verdict.attackFindings.forEach((item) =>
        element(
          "p",
          `质疑 ${item.attackId}［${named(item.status)}］：${item.reason}；证据：${item.evidenceIds?.join("、") || "无"}`,
          box,
        ),
      );
    }
    const record = state.records.find(
      (item) => item.label === card.label && item.condition === run.condition,
    );
    const form = element("fieldset", undefined, area, "rating");
    element("legend", `为${label}评分`, form);
    const metricNames = {
      constraintCompliance: "限制遵守",
      claimTraceability: "依据可追溯",
      actionability: "可执行性",
      adaptation: "条件适应",
    };
    Object.entries(metricNames).forEach(([metric, name]) => {
      const labelNode = element("label", name, form);
      const select = element("select", undefined, labelNode);
      [
        ["", "未评分"],
        ["0", "0 · 未满足"],
        ["1", "1 · 部分满足"],
        ["2", "2 · 满足"],
      ].forEach(([value, title]) => {
        const option = element("option", title, select);
        option.value = value;
      });
      select.value = record.scores[metric] === null ? "" : String(record.scores[metric]);
      select.addEventListener("change", () => {
        record.scores[metric] = select.value === "" ? null : Number(select.value);
        save();
      });
      element("small", payload.template.rubric[metric], labelNode);
    });
    const reasonLabel = element("label", "评分理由（说明依据，不只写好或不好）", form);
    const reason = element("textarea", undefined, reasonLabel);
    reason.rows = 4;
    reason.value = record.reason;
    reason.addEventListener("input", () => {
      record.reason = reason.value;
      save();
    });
    const locationLabel = element(
      "label",
      "证据定位（每行一条，例如 initial.strategies[0].firstAction 或证据 ID）",
      form,
    );
    const location = element("textarea", undefined, locationLabel);
    location.rows = 3;
    location.value = record.evidenceLocations.join("\n");
    location.addEventListener("input", () => {
      record.evidenceLocations = location.value
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      save();
    });
  }
  const main = document.getElementById("cards");
  payload.cards.forEach((card, index) => {
    const article = element("article", undefined, main);
    article.id = `card-${index}`;
    element("h2", `匿名答卷 ${index + 1} / ${payload.cards.length} · ${card.label}`, article);
    element("p", `任务：${card.task.id || "未命名"}`, article);
    if (card.task.changeReason) element("p", `变化说明：${card.task.changeReason}`, article);
    bullets(article, "应有表现", card.task.positiveChecks);
    bullets(article, "应避免的退步", card.task.negativeChecks);
    const grid = element("div", undefined, article, "pair");
    ["initial", "changed"].forEach((name) =>
      condition(
        grid,
        card,
        card.conditions.find((item) => item.condition === name),
      ),
    );
  });
  document.getElementById("export").addEventListener("click", () => {
    save();
    const data = exportState(payload.template, state, state.raterId);
    const blob = new Blob([JSON.stringify(data, null, 2) + "\n"], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `人工评分-${(state.raterId.trim() || "未署名").replace(/[^\p{L}\p{N}_-]/gu, "_").slice(0, 40)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice.textContent =
      "文件已导出。未填写的分数仍是 null；交回前请检查全部分数、理由、定位和评分人署名。";
  });
  document.getElementById("clear").addEventListener("click", () => {
    if (window.confirm("清除当前浏览器的本包草稿？已导出的文件不会删除。")) {
      try {
        localStorage.removeItem(payload.storageKey);
      } catch {}
      window.location.reload();
    }
  });
  save();
}

export function buildRatingPack(data) {
  const storageKey = `anonymous-ratings:${createHash("sha256").update(JSON.stringify(data)).digest("hex")}`;
  const embedded = JSON.stringify({ ...data, storageKey })
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const client = ratingPage.toString().replace("EXPORT_STATE", exportRatingState.toString());
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>匿名人工评分包</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f5f5f2;color:#252923;font:16px/1.65 system-ui,-apple-system,sans-serif}header,main{max-width:1500px;margin:auto;padding:24px}header{background:#fff;border-bottom:1px solid #d6dbd0}h1{font-size:28px;margin:0 0 12px}h2{font-size:23px}h3{font-size:20px}h4{margin:20px 0 8px}p{margin:8px 0}article{background:#fff;padding:24px;margin:0 0 28px;border:1px solid #d6dbd0;border-radius:8px}.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:28px}.condition{min-width:0}.output{padding:14px;border:1px solid #d6dbd0;border-radius:5px;margin:12px 0}small{display:block;color:#586152;overflow-wrap:anywhere}dl{display:grid;grid-template-columns:100px minmax(0,1fr);gap:6px 10px}dt{font-weight:600}dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}summary{cursor:pointer;font-weight:600}.warning{background:#fff2ce;padding:10px}.rating{margin-top:24px;border:1px solid #77866c;padding:16px;background:#f7faf4}legend{font-weight:700}label{display:block;margin:12px 0}input,select,textarea,button{font:inherit}input,select,textarea{display:block;width:100%;padding:9px;border:1px solid #8a9384;border-radius:4px;background:white;color:#252923}select{max-width:230px}textarea{resize:vertical}button{padding:10px 16px;margin:6px 8px 6px 0;border:1px solid #496338;border-radius:4px;background:#35562a;color:white;cursor:pointer}button.secondary{background:white;color:#35562a}input:focus,select:focus,textarea:focus,button:focus{outline:3px solid #d2ad37;outline-offset:2px}#rater{max-width:420px}.notice{color:#47533d}#progress{font-weight:700}@media(max-width:900px){.pair{grid-template-columns:1fr}header,main{padding:16px}article{padding:16px}}
  </style></head><body><header><h1>匿名人工评分</h1><p>请独立阅读每份答卷的初始与变化条件，按下方标准填写四项 0、1、2 分，并说明理由和证据位置。没有填写的分数保持空白（null），系统不会自动评分。</p><p>失败、未知和未运行的样本也要保留。请按实际缺失内容评分，不要删除它们。每位评分人使用独立文件和浏览器配置，先独立评分，再交流分歧。</p><p>本页不联网，答案和草稿只在本机。浏览器临时保存不能代替导出；可以导出未完成草稿，全部填写后再交回评分 JSON 文件。盲化不能隐藏生成文本本身的风格，请不要猜测方法组别。</p><label for="rater">评分人代号（整份文件使用同一个代号，不必填写真实姓名）</label><input id="rater" autocomplete="off" maxlength="100"><p id="progress"></p><button id="export" type="button">导出评分文件</button><button id="clear" type="button" class="secondary">清除本机草稿</button><p id="notice" class="notice" role="status" aria-live="polite"></p></header><main id="cards"></main><script id="rating-data" type="application/json">${embedded}</script><script>(${client})();</script></body></html>`;
}

export function main(args = process.argv.slice(2)) {
  const [directory, outputArgument] = args;
  if (!directory || !outputArgument || args.length !== 2)
    throw new Error(
      "Usage: node scripts/build-rating-pack.mjs <completed-run-directory> <outputs/rating-pack.html>",
    );
  const output = resolve(outputArgument);
  if (extname(output).toLowerCase() !== ".html") throw new Error("Output must be an HTML file.");
  const data = loadAnonymousRun(directory);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, buildRatingPack(data), { mode: 0o600, flag: "wx" });
  console.log(
    `Built ${data.cards.length} anonymous cards and ${data.template.records.length} unscored/human records: ${output}`,
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Could not build anonymous rating pack.",
    );
    process.exitCode = 1;
  }
}
