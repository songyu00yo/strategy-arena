/** Explicit synthetic display and network fixtures. No provider calls or real user data. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prepareRecordedIntake } from "../src/components/recorded-intake";
import { RecordedExampleViewer } from "../src/components/recorded-example-viewer";
import { readIntakeDraftPointer } from "../src/components/intake-draft-pointer";
import { RECORDED_EXAMPLES } from "../src/lib/recorded-examples";
import { fixtureIntake } from "./e2e/intake.fixture";
import { fixtureSnapshot } from "./e2e/ui.fixture";

const metadata = {
  ...RECORDED_EXAMPLES[0],
  workflow: "clarification" as const,
  caseType: "simulated_real_model" as const,
  simulationActor: "Codex" as const,
  initialMaterials: "",
  sourceCommits: ["fixture-source-commit-one", "fixture-source-commit-two"],
};
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
function version() {
  const value = fixtureSnapshot().versions[0];
  value.workflow = "clarification";
  value.challenge.goal = "FINAL_GOAL_MUST_NOT_PREFILL_THE_ORIGINAL_ENTRY";
  value.challenge.constraints = "FINAL_CONSTRAINTS_MUST_NOT_APPEAR_BEFORE_REPLAY";
  value.challenge.preferences = "FINAL_PREFERENCES_MUST_NOT_APPEAR_BEFORE_REPLAY";
  value.challenge.materials = "FINAL_MATERIALS_MUST_NOT_APPEAR_AS_INITIAL_UPLOADS";
  value.intake = {
    id: "fixture-source-intake",
    originalGoal: "【合成测试输入】我想做个个人网站，还没想好其他内容。",
    answers: [],
    assumptions: [],
    usedSources: [],
    usage: [],
  };
  return value;
}
const args = () => ({
  goal: "【合成测试输入】这是我本人这次补充的需求。",
  modelMode: "gpt-6.1-sol" as const,
  metadata,
  version: version(),
  quote: "【合成测试输入】旧模型建议，待本人核对。",
  materials: "【合成测试输入】旧资料。",
  signal: new AbortController().signal,
});

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("localStorage", storage());
  vi.stubGlobal("sessionStorage", storage());
  vi.stubGlobal("window", {
    location: { href: "http://127.0.0.1/examples/personal-website?examples=open" },
    history: { state: null, replaceState: vi.fn() },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("recorded clarification draft preparation", () => {
  it("creates only the user's input, attaches old opinions as reference and retains an older arena pointer", async () => {
    localStorage.setItem("strategy-arena:last-id", "fixture-old-arena");
    sessionStorage.setItem("strategy-arena:tab-arena-id", "fixture-old-arena");
    const draft = fixtureIntake({ id: "fixture-own-intake", workflow: "clarification" });
    let reference = "";
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/intakes") return Response.json(draft, { status: 201 });
      const file = (init!.body as FormData).get("file") as File;
      reference = await file.text();
      return Response.json({ ...draft, revision: 1 }, { status: 201 });
    });
    vi.stubGlobal("fetch", fetch);
    const input = args();
    await prepareRecordedIntake(input);
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({
      goal: input.goal,
      modelMode: input.modelMode,
      workflow: "clarification",
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/intakes",
      "/api/intakes/fixture-own-intake/attachments",
    ]);
    expect(reference).toContain("模拟回答、确认和模型建议均不代表本次用户已经选择或授权");
    expect(reference).toContain(input.quote);
    expect(reference).toContain(input.version.intake!.originalGoal);
    expect(reference).toContain("fixture-source-commit-one → fixture-source-commit-two");
    expect(readIntakeDraftPointer()).toBe(draft.id);
    expect(localStorage.getItem("strategy-arena:last-id")).toBe("fixture-old-arena");
    expect(sessionStorage.getItem("strategy-arena:tab-arena-id")).toBe("fixture-old-arena");
    expect(window.history.replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/examples/personal-website",
    );
  });
  it("rejects an oversized new goal before creating a draft and leaves the text intact", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const input = { ...args(), goal: "x".repeat(3001) };
    await expect(prepareRecordedIntake(input)).rejects.toThrow("超过3000字");
    expect(fetch).not.toHaveBeenCalled();
    expect(input.goal).toHaveLength(3001);
  });
  it("keeps a recoverable draft pointer when the reference upload fails", async () => {
    const draft = fixtureIntake({ id: "fixture-partial-intake", workflow: "clarification" });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(draft, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ error: "合成测试上传失败" }, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    await expect(prepareRecordedIntake(args())).rejects.toThrow("合成测试上传失败");
    expect(readIntakeDraftPointer()).toBe(draft.id);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("does not adopt a stale accepted response after the caller aborts", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => {
      controller.abort();
      return Response.json(fixtureIntake({ id: "fixture-late-intake" }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetch);
    await expect(
      prepareRecordedIntake({ ...args(), signal: controller.signal }),
    ).rejects.toHaveProperty("name", "AbortError");
    expect(readIntakeDraftPointer()).toBeNull();
  });
});

describe("recorded clarification original entry", () => {
  it("shows the vague original goal and initial submission without revealing final answers", () => {
    const arena = fixtureSnapshot();
    arena.versions = [version()];
    const html = renderToStaticMarkup(
      React.createElement(RecordedExampleViewer, { payload: { metadata, arena } }),
    );
    expect(html).toContain(arena.versions[0].intake!.originalGoal);
    expect(html).toContain("真实模型运行的模拟案例");
    expect(html).toContain("Codex");
    expect(html).toContain("原始提交未附材料。");
    expect(html).toContain("没有真实执行反馈");
    expect(html).not.toContain("FINAL_GOAL_MUST_NOT_PREFILL");
    expect(html).not.toContain("FINAL_CONSTRAINTS_MUST_NOT_APPEAR");
    expect(html).not.toContain("FINAL_PREFERENCES_MUST_NOT_APPEAR");
    expect(html).not.toContain("FINAL_MATERIALS_MUST_NOT_APPEAR");
  });
  it("retains legacy entry bindings for an existing old recording", () => {
    const arena = fixtureSnapshot();
    const oldMetadata = {
      ...metadata,
      workflow: undefined,
      caseType: undefined,
      simulationActor: undefined,
    };
    const html = renderToStaticMarkup(
      React.createElement(RecordedExampleViewer, { payload: { metadata: oldMetadata, arena } }),
    );
    expect(html).toContain(arena.versions[0].challenge.goal);
    expect(html).toContain(arena.versions[0].challenge.constraints);
    expect(html).toContain("开始分析");
    expect(html).not.toContain("Codex模拟");
  });
});
