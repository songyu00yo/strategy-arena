/** Synthetic multi-round records. No generated model output or browser/provider traffic. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArenaVersion } from "../src/lib/contracts";
import type { ClarificationRun } from "../src/lib/clarification-contracts";
import type { IntakeQuestion, RecordedAnswer } from "../src/lib/intake-contracts";
import { AGENT_LIMITS, AGENT_PROTOCOL } from "../src/lib/agent-contracts";
import { beatsOf, clarificationLines, latestShownRevision } from "../src/components/console/beats";
import { StepCard } from "../src/components/console/StepCard";
import { RouteChart } from "../src/components/console/RouteChart";
import { RouteStage } from "../src/components/console/RouteStage";
import { ArenaConsole } from "../src/components/console/ArenaConsole";
import { stepContext } from "../src/lib/step-context";
import { advanceFixture, fixtureSnapshot } from "./e2e/ui.fixture";

function syntheticVersion(): ArenaVersion {
  const snapshot = fixtureSnapshot();
  for (let index = 0; index < 5; index++) advanceFixture(snapshot);
  const version = snapshot.versions[0];
  const original = version.strategies[0];
  const attack = version.attacks[0];
  const evidence = version.evidence[0];
  version.attacks = [
    { ...attack, id: "attack-attack-one", round: 1 },
    { ...attack, id: "attack-attack-two", round: 2, from: "C", reason: "第二轮合成质疑" },
  ];
  version.evidence = [
    { ...evidence, id: "evidence-one", attackId: "attack-attack-one", actionId: "tools-one" },
    { ...evidence, id: "evidence-two", attackId: "attack-attack-two", actionId: "tools-two" },
  ];
  version.revisions = [
    {
      strategyId: "A",
      revisionId: "revision-one",
      round: 1,
      strategy: { ...original, title: "第一轮A路线", estimatedCost: 80, estimatedHours: 8 },
      responses: [
        {
          attackId: "attack-attack-one",
          decision: "accept",
          reason: "第一轮回应",
          evidenceIds: ["evidence-one"],
          change: "核实投入",
        },
      ],
      summary: "第一轮调整投入",
      changed: true,
    },
    {
      strategyId: "A",
      revisionId: "revision-two",
      round: 2,
      strategy: { ...original, title: "第二轮A路线", estimatedCost: 150, estimatedHours: 25 },
      responses: [
        {
          attackId: "attack-attack-one",
          decision: "unresolved",
          reason: "第二轮重新回应",
          evidenceIds: ["evidence-one"],
          change: "保留未知",
        },
        {
          attackId: "attack-attack-two",
          decision: "accept",
          reason: "第二轮回应",
          evidenceIds: ["evidence-two"],
          change: "调整投入",
        },
      ],
      summary: "第二轮再次调整投入",
      changed: true,
    },
  ];
  version.agent = {
    protocol: AGENT_PROTOCOL,
    limits: AGENT_LIMITS,
    plans: [],
    toolsUsed: 2,
    externalToolsUsed: 0,
    actions: [
      ...(["A", "B", "C"] as const).map((role) => ({
        id: `proposal-${role}`,
        kind: "propose" as const,
        role,
        round: 1,
        dependencies: [],
        status: "completed" as const,
      })),
      {
        id: "attack-one",
        kind: "attack",
        role: "B",
        round: 1,
        dependencies: [],
        status: "completed",
      },
      {
        id: "tools-one",
        kind: "tools",
        role: "tools",
        round: 1,
        dependencies: [],
        status: "completed",
      },
      {
        id: "revision-one",
        kind: "revise",
        role: "A",
        round: 1,
        dependencies: [],
        status: "completed",
      },
      {
        id: "attack-two",
        kind: "attack",
        role: "C",
        round: 2,
        dependencies: [],
        status: "completed",
      },
      {
        id: "tools-two",
        kind: "tools",
        role: "tools",
        round: 2,
        dependencies: [],
        status: "completed",
      },
      {
        id: "revision-two",
        kind: "revise",
        role: "A",
        round: 2,
        dependencies: [],
        status: "completed",
      },
      {
        id: "judge",
        kind: "judge",
        role: "judge",
        round: 2,
        dependencies: [],
        status: "completed",
      },
    ],
  };
  return version;
}

// The repository's test compiler uses classic JSX, while Next compiles these components itself.
beforeEach(() => {
  vi.stubGlobal("React", React);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("multi-round recorded display", () => {
  it("orders revisions and their own evidence checks according to persisted actions", () => {
    const beats = beatsOf(syntheticVersion());
    expect(beats.map((beat) => beat.id)).toEqual([
      "p:A",
      "p:B",
      "p:C",
      "a:attack-attack-one",
      "v:attack-attack-one",
      "r:revision-one",
      "a:attack-attack-two",
      "v:attack-attack-two",
      "r:revision-two",
      "judge",
    ]);
  });
  it("uses only the latest revision that has been revealed in the selected playback section", () => {
    const beats = beatsOf(syntheticVersion());
    expect(latestShownRevision(beats.slice(0, 5), "A")).toBeUndefined();
    expect(latestShownRevision(beats.slice(0, 6), "A")?.revision?.strategy.title).toBe(
      "第一轮A路线",
    );
    expect(latestShownRevision(beats.slice(0, 8), "A")?.revision?.strategy.title).toBe(
      "第一轮A路线",
    );
    expect(latestShownRevision(beats, "A")?.revision?.strategy.title).toBe("第二轮A路线");
    expect(latestShownRevision(beats, "B")).toBeUndefined();
  });
  it("retrieves the latest known response without revealing a future round's changed response", () => {
    const beats = beatsOf(syntheticVersion());
    const reply = (until: number) =>
      latestShownRevision(beats.slice(0, until), "A")?.revision?.responses.find(
        (response) => response.attackId === "attack-attack-one",
      );
    expect(reply(5)).toBeUndefined();
    expect(reply(6)?.reason).toBe("第一轮回应");
    expect(reply(8)?.reason).toBe("第一轮回应");
    expect(reply(9)?.reason).toBe("第二轮重新回应");
  });
  it("retains the exact first or second revision when opening a recorded step source", () => {
    const version = syntheticVersion();
    expect(stepContext(version, "r:revision-one")?.quote).toContain("第一轮A路线");
    expect(stepContext(version, "r:revision-one")?.quote).not.toContain("第二轮A路线");
    expect(stepContext(version, "r:revision-two")?.quote).toContain("第二轮A路线");
  });
  it("compares a later revision against its previous revision when it reverts an earlier change", () => {
    const version = syntheticVersion();
    version.revisions[0].strategy = { ...version.strategies[0], firstAction: "第一轮新行动" };
    version.revisions[1].strategy = structuredClone(version.strategies[0]);
    const beat = beatsOf(version).find((item) => item.id === "r:revision-two")!;
    expect(beat.changes).toContain("第一步行动");
    expect(beat.plain).not.toContain("没有改动");
  });
  it("keeps legacy revision identifiers readable and selects their recorded strategy", () => {
    const version = syntheticVersion();
    delete version.agent;
    version.revisions = [version.revisions[0]];
    delete version.revisions[0].revisionId;
    const beats = beatsOf(version);
    expect(latestShownRevision(beats, "A")?.id).toBe("r:A");
    expect(stepContext(version, "r:A")?.quote).toContain("第一轮A路线");
  });
  it("renders comparison estimates from the playback revision instead of proposal or future values", () => {
    const version = syntheticVersion();
    const beats = beatsOf(version);
    const render = (index: number) =>
      renderToStaticMarkup(
        React.createElement(RouteChart, { version, beats, index, onStep: () => {} }),
      );
    const firstRound = render(5);
    expect(firstRound).toContain("第一轮A路线");
    expect(firstRound).toContain("¥80");
    expect(firstRound).not.toContain("¥150");
    const secondRound = render(8);
    expect(secondRound).toContain("第二轮A路线");
    expect(secondRound).toContain("¥150");
    expect(secondRound).toContain("25小时");
    expect(secondRound).not.toContain("第一轮A路线");
  });
  it("renders the route board from the shown revision at each round", () => {
    const version = syntheticVersion();
    const beats = beatsOf(version);
    const render = (index: number) =>
      renderToStaticMarkup(
        React.createElement(RouteStage, {
          version,
          demo: true,
          beats,
          index,
          speed: 1,
          directed: false,
          camera: false,
          lead: 0,
          reviewing: false,
          entering: false,
          readOnly: true,
          onStep: () => {},
          onEvidence: () => {},
          onClaim: () => {},
        }),
      );
    expect(render(5)).toContain("第一轮A路线");
    expect(render(5)).not.toContain("第二轮A路线");
    expect(render(8)).toContain("第二轮A路线");
    expect(render(8)).toContain("已修订");
  });
});

describe("clarification repair display", () => {
  function recordedRun(overrides: Partial<ClarificationRun> = {}): ClarificationRun {
    return {
      id: "fixture-failed-review",
      operationId: "fixture-operation",
      role: "B",
      round: 2,
      basedOnRevision: 7,
      status: "failed",
      summary: "【合成测试数据】初次选项输出超出结构上限。",
      output: { error: "【合成测试数据】七个选项超过六个选项上限。" },
      usage: [],
      callIds: ["fixture-first-call"],
      createdAt: "2026-11-12T00:00:00.000Z",
      ...overrides,
    };
  }

  function recordedVersion(runs: ClarificationRun[]) {
    const version = fixtureSnapshot().versions[0];
    version.workflow = "clarification";
    version.status = "completed";
    version.clarification = {
      protocol: "clarification-1",
      items: [],
      retiredIds: [],
      runs,
      rounds: [],
      suggestions: [],
      conflicts: [],
      review: null,
      next: "completed",
      draftOnly: false,
      specification: "【合成测试数据】报告。",
      executionPrompt: "【合成测试数据】执行提示词。",
    };
    return version;
  }

  function stageClass(version: ArenaVersion) {
    const html = renderToStaticMarkup(
      React.createElement(ArenaConsole, {
        version,
        steps: [],
        events: [],
        demo: false,
        slate: null,
        notices: null,
        conditions: null,
        historical: false,
        busy: false,
        onEvidence: () => {},
        onClaim: () => {},
      }),
    );
    return html.match(/class="(seg [^"]*)"[^>]*><span>选项与执行审查<\/span>/)?.[1];
  }

  it("shows a successful linked repair as recovered while retaining the failed record and both steps", () => {
    const failed = recordedRun();
    const repaired = recordedRun({
      id: "fixture-repaired-review",
      repairOf: failed.id,
      status: "completed",
      summary: "【合成测试数据】修复后选项结构通过。",
      output: { summary: "【合成测试数据】选项审查通过。", questions: [], conflicts: [] },
      callIds: ["fixture-second-call"],
    });
    const version = recordedVersion([failed, repaired]);
    expect(stageClass(version)).toMatch(/\bdone\b/);
    expect(stageClass(version)).not.toMatch(/\bbad\b/);
    const beats = beatsOf(version);
    expect(beats.map((beat) => beat.id)).toEqual([
      `clarification:${failed.id}`,
      `clarification:${repaired.id}`,
    ]);
    expect(beats[0].clarificationRun?.status).toBe("failed");
    expect(beats[1].clarificationRun?.status).toBe("completed");
    expect(stepContext(version, beats[0].id)?.quote).toContain(failed.summary);
    expect(failed.status).toBe("failed");
    expect(failed.output).toEqual({ error: "【合成测试数据】七个选项超过六个选项上限。" });
  });

  it.each(["failed", "uncertain"] as const)("keeps a %s repair unresolved", (status) => {
    const failed = recordedRun();
    const repair = recordedRun({
      id: "fixture-unsuccessful-repair",
      repairOf: failed.id,
      status,
      callIds: ["fixture-second-call"],
    });
    const version = recordedVersion([failed, repair]);
    expect(stageClass(version)).toMatch(/\bbad\b/);
    expect(stageClass(version)).not.toMatch(/\bdone\b/);
    expect(version.clarification?.runs).toHaveLength(2);
    expect(failed.status).toBe("failed");
  });

  it("preserves an unlinked failure when another call succeeds", () => {
    const version = recordedVersion([
      recordedRun(),
      recordedRun({
        id: "fixture-unlinked-success",
        status: "completed",
        output: { summary: "【合成测试数据】另一条合法输出。", questions: [], conflicts: [] },
      }),
    ]);
    expect(stageClass(version)).toMatch(/\bbad\b/);
    expect(stageClass(version)).not.toMatch(/\bdone\b/);
  });

  it.each([{ role: "A" as const }, { round: 3 }, { basedOnRevision: 8 }])(
    "does not recover a failure when linked repair metadata differs by %o",
    (changed) => {
      const failed = recordedRun();
      const repaired = recordedRun({
        id: "fixture-mismatched-repair",
        repairOf: failed.id,
        status: "completed",
        output: { summary: "【合成测试数据】修复输出。", questions: [], conflicts: [] },
        ...changed,
      });
      const version = recordedVersion([failed, repaired]);
      expect(stageClass(version)).toMatch(/\bbad\b/);
      expect(stageClass(version)).not.toMatch(/\bdone\b/);
    },
  );

  it("keeps an uncertain original request unresolved even when a completed record claims to repair it", () => {
    const uncertain = recordedRun({ status: "uncertain" });
    const repaired = recordedRun({
      id: "fixture-claimed-repair",
      repairOf: uncertain.id,
      status: "completed",
      output: { summary: "【合成测试数据】后续输出。", questions: [], conflicts: [] },
    });
    const version = recordedVersion([uncertain, repaired]);
    expect(stageClass(version)).toMatch(/\bbad\b/);
    expect(stageClass(version)).not.toMatch(/\bdone\b/);
    expect(uncertain.status).toBe("uncertain");
  });
});

describe("saved clarification answers in round playback", () => {
  function playbackVersion() {
    const version = fixtureSnapshot().versions[0];
    const style: IntakeQuestion = {
      id: "style",
      decisionId: "style",
      title: "选择呈现风格",
      reason: "明确标注的显示测试替身",
      placeholder: "",
      type: "single",
      options: ["简洁正式", "活泼明亮", "杂志排版", "朴素文档", "学院风", "自定义描述"],
      unit: "",
    };
    const purpose: IntakeQuestion = {
      ...style,
      id: "purpose",
      decisionId: "purpose",
      title: "是否允许公开资料？",
      options: ["允许", "仅本人查看"],
    };
    const materials: IntakeQuestion = {
      ...style,
      id: "materials",
      decisionId: "materials",
      title: "补充附件说明",
      type: "text",
      options: [],
    };
    const original: RecordedAnswer = {
      questionId: style.id,
      question: style,
      state: "answered",
      value: "简洁正式",
      confirmation: "confirmed",
      confirmedRevision: 3,
    };
    const unknown: RecordedAnswer = {
      questionId: purpose.id,
      question: purpose,
      state: "unknown",
      value: "",
    };
    const skipped: RecordedAnswer = {
      questionId: materials.id,
      question: materials,
      state: "skipped",
      value: "",
    };
    const changed: RecordedAnswer = { ...original, value: "活泼明亮", confirmedRevision: 6 };
    const run = (id: string, round: number, questions: IntakeQuestion[]): ClarificationRun => ({
      id,
      operationId: `operation-${id}`,
      role: "B",
      round,
      basedOnRevision: round,
      status: "completed",
      summary: "【合成回放数据】依据当前回答生成选项",
      output: {
        summary: "【合成回放数据】选项审查",
        questions: questions.map((question) => ({ ...question, decisionId: question.decisionId! })),
        conflicts: [],
      },
      usage: [],
      createdAt: "2026-11-12T00:00:00.000Z",
    });
    const first = run("playback-b-one", 1, [style, purpose, materials]);
    const second = run("playback-b-two", 2, [style]);
    const final = run("playback-b-submit", 3, []);
    version.workflow = "clarification";
    version.clarification = {
      protocol: "clarification-1",
      items: [],
      retiredIds: [],
      runs: [first, second, final],
      rounds: [
        {
          round: 1,
          revision: 1,
          questions: [style, purpose, materials].map((question) => ({
            ...question,
            decisionId: question.decisionId!,
          })),
          answers: [],
          changes: { added: [], retired: [], changed: [], triggerAnswerIds: [] },
          runIds: [first.id],
          createdAt: first.createdAt,
        },
        {
          round: 2,
          revision: 4,
          questions: [{ ...style, decisionId: style.id }],
          answers: [original, unknown, skipped],
          changes: { added: [], retired: [], changed: [], triggerAnswerIds: [style.id] },
          runIds: [second.id],
          createdAt: second.createdAt,
        },
        {
          round: 3,
          revision: 7,
          questions: [],
          answers: [changed, unknown, skipped],
          changes: { added: [], retired: [], changed: [], triggerAnswerIds: [style.id] },
          runIds: [final.id],
          createdAt: final.createdAt,
        },
      ],
      suggestions: [],
      conflicts: [],
      review: null,
      next: "completed",
      draftOnly: false,
      specification: "【合成数据】确认后的说明",
      executionPrompt: "【合成数据】执行提示词",
    };
    return version;
  }

  it("binds each B step to the next actual saved answer snapshot including the submission round", () => {
    const version = playbackVersion();
    const beats = beatsOf(version);
    expect(
      beats[0].clarificationAnswers?.find((answer) => answer.questionId === "style")?.value,
    ).toBe("简洁正式");
    expect(
      beats[1].clarificationAnswers?.find((answer) => answer.questionId === "style")?.value,
    ).toBe("活泼明亮");
    const firstText = clarificationLines(
      beats[0].clarificationRun!,
      beats[0].clarificationAnswers,
    ).join("\n");
    expect(firstText).toContain("简洁正式 / 活泼明亮 / 杂志排版 / 朴素文档 / 学院风 / 自定义描述");
    expect(firstText).toContain("已记录回答 — 简洁正式（已确认）");
    expect(firstText).toContain("不知道（未决）");
    expect(firstText).toContain("已跳过（未决）");
    expect(firstText).not.toContain("已记录回答 — 活泼明亮");
    expect(stepContext(version, beats[0].id)?.quote).toContain("已记录回答 — 简洁正式（已确认）");
    expect(stepContext(version, beats[1].id)?.quote).toContain("已记录回答 — 活泼明亮（已确认）");
    expect(stepContext(version, beats[0].id)!.quote.length).toBeLessThan(30000);
    expect(version.clarification?.runs).toHaveLength(3);
  });

  it("shows unanswered when there is no following snapshot instead of borrowing a later answer", () => {
    const version = playbackVersion();
    version.clarification!.rounds.pop();
    const beats = beatsOf(version);
    expect(beats[1].clarificationAnswers).toEqual([]);
    expect(
      clarificationLines(beats[1].clarificationRun!, beats[1].clarificationAnswers).join("\n"),
    ).toContain("已记录回答 — 尚未回答（未确认）");
  });

  it("keeps answers scoped to the actual question text and options that were presented", () => {
    const version = playbackVersion();
    version.clarification!.rounds[0].questions[0].options = ["已更换的选项一", "已更换的选项二"];
    const first = beatsOf(version)[0];
    expect(
      first.clarificationAnswers?.find((answer) => answer.questionId === "style"),
    ).toBeUndefined();
    expect(
      clarificationLines(first.clarificationRun!, first.clarificationAnswers).join("\n"),
    ).toContain("已记录回答 — 尚未回答（未确认）");
  });

  it("renders saved answers inside the original step-card and three-role text fields", () => {
    const version = playbackVersion();
    const beats = beatsOf(version);
    const stage = renderToStaticMarkup(
      React.createElement(RouteStage, {
        version,
        demo: false,
        beats,
        index: 0,
        speed: 1,
        directed: false,
        camera: false,
        lead: 0,
        reviewing: true,
        onStep: () => {},
        onEvidence: () => {},
        entering: false,
        readOnly: true,
        onClaim: () => {},
      }),
    );
    expect(stage.match(/data-board="[ABC]"/g)).toHaveLength(3);
    expect(stage).toContain("已记录回答 — 简洁正式（已确认）");
    const card = renderToStaticMarkup(
      React.createElement(StepCard, {
        version,
        beats,
        index: 0,
        last: beats.length - 1,
        reviewing: true,
        onOpen: () => {},
        onStage: () => {},
        onEvidence: () => {},
        onClose: () => {},
      }),
    );
    expect(card).toContain("已记录回答 — 简洁正式（已确认）");
    expect(card).toContain("不知道（未决）");
    expect(card).toContain("自定义描述");
    expect(card).not.toContain("已记录回答 — 活泼明亮");
  });
});
