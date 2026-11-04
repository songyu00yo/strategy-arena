import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import { buildRatingPack, exportRatingState, loadAnonymousRun } from "./build-rating-pack.mjs";

const metrics = ["constraintCompliance", "claimTraceability", "actionability", "adaptation"];
const attackText = '</script><img src="https://do-not-fetch.invalid/" onerror="INJECTION">\u2028';
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "anonymous-rating-fixture-"));
  for (const folder of ["blind", "private", "raw"]) mkdirSync(join(directory, folder));
  writeFileSync(join(directory, "metadata.json"), "INVALID_PRIVATE_MODEL_METADATA");
  writeFileSync(join(directory, "private/blind-mapping.json"), "INVALID_PRIVATE_METHOD_MAPPING");
  writeFileSync(join(directory, "raw/trajectory.json"), "INVALID_RAW_MODEL_METADATA");
  const scorecards = {
    rubric: Object.fromEntries(metrics.map((name) => [name, "0=未满足，1=部分满足，2=满足。"])),
    records: ["initial", "changed"].map((condition) => ({
      label: "anonymous-fixture",
      condition,
      raterId: "",
      scores: Object.fromEntries(metrics.map((name) => [name, null])),
      reason: "",
      evidenceLocations: [],
    })),
  };
  const task = {
    goal: `合成评分任务 ${attackText}`,
    constraints: "时间不超过三小时",
    materials: "仅为合成测试",
    budget: 10,
    timeHours: 3,
  };
  const card = {
    label: "anonymous-fixture",
    arm: "strong-single",
    model: "RAW_MODEL_METADATA",
    task: {
      id: "synthetic-task",
      initial: task,
      changed: { ...task, timeHours: 2 },
      changeReason: "缩短时间",
      positiveChecks: ["回应时间变化"],
      negativeChecks: ["不得虚构工具结果"],
      model: "RAW_MODEL_METADATA",
    },
    conditions: [
      {
        condition: "initial",
        status: "failed",
        incomplete: true,
        strategies: [],
        evidence: [],
        verdict: null,
      },
      {
        condition: "changed",
        status: "skipped",
        incomplete: true,
        strategies: [],
        evidence: [],
        verdict: null,
      },
    ],
  };
  writeFileSync(join(directory, "blind/scorecards.json"), JSON.stringify(scorecards));
  writeFileSync(join(directory, "blind/anonymous-fixture.json"), JSON.stringify(card));
  return { directory, scorecards, card };
}
function withFixture(callback) {
  const data = fixture();
  try {
    return callback(data);
  } finally {
    rmSync(data.directory, { recursive: true, force: true });
  }
}
function scripts(html) {
  return [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].map((match) => ({
    attrs: match[1],
    text: match[2],
  }));
}

test("builds a self-contained pack without reading private/raw/model metadata or omitting failures", () =>
  withFixture(({ directory }) => {
    const output = join(directory, "outputs/rating.html");
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/build-rating-pack.mjs"), directory, output],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const html = readFileSync(output, "utf8");
    assert.doesNotMatch(html, /INVALID_PRIVATE|INVALID_RAW|RAW_MODEL_METADATA|strong-single/);
    const embedded = JSON.parse(scripts(html)[0].text);
    assert.deepEqual(
      embedded.cards[0].conditions.map((item) => item.status),
      ["failed", "skipped"],
    );
    assert.equal(embedded.template.records.length, 2);
    assert.equal(embedded.template.records[0].scores.actionability, null);
    assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|fetch\(|XMLHttpRequest/);
    assert.notEqual(
      spawnSync(process.execPath, [resolve("scripts/build-rating-pack.mjs"), directory, output])
        .status,
      0,
      "must not overwrite an existing rating pack",
    );
  }));

test("escapes embedded script delimiters while preserving exact display text and null/zero distinctions", () =>
  withFixture(({ directory, scorecards }) => {
    const data = loadAnonymousRun(directory);
    const html = buildRatingPack(data);
    assert.equal(scripts(html).length, 2);
    assert.doesNotMatch(scripts(html)[0].text, /<\/script>|<img/);
    assert.equal(
      JSON.parse(scripts(html)[0].text).cards[0].task.initial.goal,
      data.cards[0].task.initial.goal,
    );
    assert.equal(exportRatingState(scorecards, null).records[0].scores.actionability, null);
    const draft = {
      records: [
        {
          ...scorecards.records[0],
          scores: { actionability: 0, adaptation: "2" },
          reason: attackText,
          evidenceLocations: ["initial.verdict"],
        },
      ],
    };
    const exported = exportRatingState(scorecards, draft, "test-rater");
    assert.equal(exported.records[0].scores.actionability, 0);
    assert.equal(exported.records[0].scores.adaptation, null);
    assert.equal(exported.records[1].scores.actionability, null);
    assert.equal(exported.records[0].reason, attackText);
    assert.deepEqual(Object.keys(exported.records[0]), [
      "label",
      "condition",
      "raterId",
      "scores",
      "reason",
      "evidenceLocations",
    ]);
  }));

test("refuses missing scorecards, duplicate records and symlink cards instead of dropping samples", () =>
  withFixture(({ directory, scorecards }) => {
    scorecards.records.pop();
    writeFileSync(join(directory, "blind/scorecards.json"), JSON.stringify(scorecards));
    assert.throws(() => loadAnonymousRun(directory), /Both initial and changed/);
    scorecards.records.push(scorecards.records[0]);
    writeFileSync(join(directory, "blind/scorecards.json"), JSON.stringify(scorecards));
    assert.throws(() => loadAnonymousRun(directory), /Duplicate/);
    scorecards.records[1] = { ...scorecards.records[0], condition: "changed" };
    writeFileSync(join(directory, "blind/scorecards.json"), JSON.stringify(scorecards));
    rmSync(join(directory, "blind/anonymous-fixture.json"));
    symlinkSync(
      join(directory, "private/blind-mapping.json"),
      join(directory, "blind/anonymous-fixture.json"),
    );
    assert.throws(() => loadAnonymousRun(directory), /regular JSON/);
  }));

test("browser form starts unscored, saves locally, and exports compatible human labels only after a click", async () => {
  const f = fixture();
  try {
    f.card.conditions[1] = {
      condition: "changed",
      status: "completed",
      incomplete: false,
      strategies: [
        {
          id: "A",
          title: "合成方案",
          thesis: "先验证再执行",
          steps: ["先完成试听"],
          claims: [
            { id: "A1", text: "工时仍为估算", status: "estimate", sourceIds: ["E-fixture"] },
          ],
          resources: "现有设备",
          firstAction: "预约试听",
          failureCondition: "时间不足就停止",
          estimatedCost: null,
          estimatedHours: 2,
        },
      ],
      evidence: [
        {
          id: "E-fixture",
          attackId: "attack-B",
          status: "calculated",
          title: "合成工时核算",
          content: "1+1=2",
          source: "合成算术工具",
          expression: "1+1",
          result: 2,
          assumptions: "仅为测试",
          sourceIds: [],
        },
      ],
      verdict: {
        outcome: "recommendation",
        preferred: "A",
        headline: "合成条件建议",
        rationale: "只用于页面测试",
        conditions: ["先确认工时"],
        uncertainties: ["尚未实测"],
        nextActions: ["先试听"],
        exitCondition: "超时退出",
        evidenceIds: ["E-fixture"],
        comparisons: [{ strategyId: "A", status: "unknown", reason: "仍待核实" }],
        attackFindings: [
          {
            attackId: "attack-B",
            status: "unresolved",
            reason: "仅核算算术",
            evidenceIds: ["E-fixture"],
          },
        ],
      },
    };
    writeFileSync(join(f.directory, "blind/anonymous-fixture.json"), JSON.stringify(f.card));
    const html = buildRatingPack(loadAnonymousRun(f.directory));
    const embedded = scripts(html),
      all = [],
      nodes = new Map(),
      stored = new Map(),
      downloads = [];
    class Element {
      constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.listeners = {};
        this.value = "";
        this.textContent = "";
        all.push(this);
      }
      append(...items) {
        this.children.push(...items);
      }
      addEventListener(name, callback) {
        this.listeners[name] = callback;
      }
      click() {
        this.listeners.click?.();
      }
      remove() {}
    }
    for (const id of ["rating-data", "rater", "notice", "progress", "cards", "export", "clear"])
      nodes.set(id, new Element("div"));
    nodes.get("rating-data").textContent = embedded[0].text;
    const context = {
      document: {
        getElementById: (id) => nodes.get(id),
        createElement: (tag) => new Element(tag),
        body: new Element("body"),
      },
      localStorage: {
        getItem: (key) => stored.get(key),
        setItem: (key, value) => stored.set(key, value),
        removeItem: (key) => stored.delete(key),
      },
      window: { confirm: () => false },
      Blob,
      URL: {
        createObjectURL: (blob) => {
          downloads.push(blob);
          return "blob:synthetic";
        },
        revokeObjectURL() {},
      },
      setTimeout() {},
    };
    vm.runInNewContext(embedded[1].text, context);
    assert.equal(downloads.length, 0, "no automatic export");
    assert.equal(all.filter((node) => node.tagName === "select").length, 8);
    assert.ok(all.some((node) => node.textContent === `合成评分任务 ${attackText}`));
    assert.ok(all.some((node) => node.textContent === "方案 A：合成方案"));
    assert.ok(all.some((node) => node.textContent === "1+1=2"));
    assert.ok(all.some((node) => node.textContent.includes("合成条件建议")));
    const blank = JSON.parse([...stored.values()][0]);
    assert.equal(blank.records[0].scores.actionability, null);
    nodes.get("rater").value = "human-fixture";
    nodes.get("rater").listeners.input();
    const select = all.find((node) => node.tagName === "select");
    select.value = "0";
    select.listeners.change();
    const fields = all.filter((node) => node.tagName === "textarea");
    fields[0].value = "失败样本仍保留，缺少可执行方案。";
    fields[0].listeners.input();
    fields[1].value = "initial.strategies\ninitial.verdict";
    fields[1].listeners.input();
    nodes.get("export").click();
    assert.equal(downloads.length, 1);
    const result = JSON.parse(await downloads[0].text());
    assert.equal(result.records.length, 2);
    assert.equal(result.records[0].raterId, "human-fixture");
    assert.equal(result.records[0].scores.constraintCompliance, 0);
    assert.equal(result.records[0].scores.actionability, null);
    assert.equal(result.records[1].scores.constraintCompliance, null);
    assert.deepEqual(result.records[0].evidenceLocations, [
      "initial.strategies",
      "initial.verdict",
    ]);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
