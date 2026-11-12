/** Synthetic multi-round records. No generated model output or browser/provider traffic. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArenaVersion } from "../src/lib/contracts";
import type { ClarificationRun } from "../src/lib/clarification-contracts";
import { AGENT_LIMITS, AGENT_PROTOCOL } from "../src/lib/agent-contracts";
import { beatsOf, latestShownRevision } from "../src/components/console/beats";
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
