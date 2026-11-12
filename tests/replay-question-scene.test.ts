/** Explicit synthetic replay display records. No provider, browser or task-writing calls. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IntakeQuestion, RecordedAnswer } from "../src/lib/intake-contracts";
import type { ReplayAction } from "../src/lib/replay-contracts";
import { QuestionInput } from "../src/components/question-input";
import {
  ReplayQuestionScene,
  replayAnswerAt,
  replayFlipGeometry,
} from "../src/components/console/ReplayQuestionScene";
import { Chars, Decode } from "../src/components/console/effects";
import { RouteStage } from "../src/components/console/RouteStage";
import { LiveRecord } from "../src/components/console/fx";
import { beatsOf } from "../src/components/console/beats";
import { fixtureSnapshot } from "./e2e/ui.fixture";

const question = (overrides: Partial<IntakeQuestion> = {}): IntakeQuestion => ({
  id: "style",
  title: "【合成测试】选择展示风格",
  reason: "【合成测试】完整保存的题目说明。",
  type: "single",
  options: ["白底单栏", "深色多栏", "由我补充"],
  placeholder: "",
  unit: "",
  ...overrides,
});
const answer = (q: IntakeQuestion, overrides: Partial<RecordedAnswer> = {}): RecordedAnswer => ({
  questionId: q.id,
  question: q,
  state: "answered",
  value: q.type === "multiple" ? q.options.slice(0, 2) : q.options[0] || "【合成测试】填写的内容",
  confirmation: "confirmed",
  ...overrides,
});
const action = (overrides: Partial<ReplayAction> = {}): ReplayAction => ({
  id: "fixture-replay-answer",
  kind: "answer",
  round: 1,
  revision: 2,
  questions: [question()],
  answers: [answer(question())],
  source: { kind: "snapshot", reference: "fixture-saved-snapshot" },
  ...overrides,
});
const scene = (value: ReplayAction, progress = 1, previousAnswers: RecordedAnswer[] = []) =>
  renderToStaticMarkup(
    React.createElement(ReplayQuestionScene, { action: value, progress, previousAnswers }),
  );

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => vi.unstubAllGlobals());

describe("shared original question controls", () => {
  it("keeps the live control types, selected values and original disclosure path", () => {
    for (const type of ["single", "multiple", "number", "text"] as const) {
      const q = question({ type });
      const html = renderToStaticMarkup(
        React.createElement(QuestionInput, {
          question: q,
          answer: answer(q),
          disabled: false,
          onChange: () => {},
        }),
      );
      expect(html).toContain('class="gi-question"');
      expect(html).toContain("我来补充");
      expect(html).toContain("暂时不知道");
      expect(html).toContain("跳过");
      expect(html).not.toContain("gi-answer-readonly");
      if (type === "single") expect(html.match(/type="radio"/g)).toHaveLength(3);
      if (type === "multiple") expect(html.match(/type="checkbox"/g)).toHaveLength(3);
      if (type === "number") expect(html).toContain('type="number"');
      if (type === "text") expect(html).toContain("<textarea");
    }
  });

  it("shows all original options statically for read-only unknown and skipped states", () => {
    const q = question({ authorization: "只允许比较当前三个候选风格" });
    for (const state of ["unknown", "skipped"] as const) {
      const html = renderToStaticMarkup(
        React.createElement(QuestionInput, {
          question: q,
          answer: answer(q, { state }),
          disabled: false,
          readOnly: true,
          onChange: () => {},
        }),
      );
      expect(html).toContain("gi-answer-readonly");
      expect(html).toContain("disabled");
      expect(html).toContain(q.authorization);
      for (const option of q.options) expect(html).toContain(option);
      expect(html).not.toContain('checked=""');
      expect(html).not.toContain("visibility:hidden");
    }
  });
});

describe("controlled recorded question scenes", () => {
  it("derives paper FLIP offsets and ratios from supplied rectangles and rejects empty geometry", () => {
    const source = { left: 100, top: 60, width: 300, height: 200 };
    const target = { left: 40, top: 20, width: 600, height: 400 };
    expect(replayFlipGeometry(source, target)).toEqual({
      x: -90,
      y: -60,
      scaleX: 0.5,
      scaleY: 0.5,
    });
    expect(replayFlipGeometry(target, target)).toEqual({ x: 0, y: 0, scaleX: 1, scaleY: 1 });
    expect(replayFlipGeometry({ ...source, width: 0 }, target)).toBeNull();
    expect(replayFlipGeometry(source, { ...target, height: 0 })).toBeNull();
  });

  it("has no default selection and applies only the saved single choice after the pointer phase", () => {
    const q = question();
    const saved = answer(q);
    expect(replayAnswerAt(q, saved, 0.3).value).toBe("");
    expect(replayAnswerAt(q, saved, 0.44).value).toBe("");
    expect(replayAnswerAt(q, saved, 0.46).value).toBe("白底单栏");
    expect(saved.confirmation).toBe("confirmed");
    const html = scene(action(), 1);
    expect(html).toContain('data-confirmation="pending"');
    expect(html).not.toContain('data-confirmation="confirmed"');
    expect(html).toContain("按保存记录重建，动画节奏为演示编排");
    expect(scene(action(), 0.1)).toContain("正在填写，待确认");
    expect(scene(action(), 0.1)).not.toContain("已保存");
    expect(html).toContain("已填写，待确认");
  });

  it("replays checkbox selections and complete Unicode text without mutating saved records", () => {
    const multiple = question({ type: "multiple" });
    const selected = answer(multiple);
    expect(replayAnswerAt(multiple, selected, 0.4).value).toEqual([]);
    expect(replayAnswerAt(multiple, selected, 0.51).value).toEqual(["白底单栏"]);
    expect(replayAnswerAt(multiple, selected, 1).value).toEqual(["白底单栏", "深色多栏"]);
    for (const type of ["text", "number"] as const) {
      const q = question({ id: type, type, options: [] });
      const value = type === "text" ? "给新人看📚，保留完整原文。" : "120";
      const saved = answer(q, { value });
      const midway = replayAnswerAt(q, saved, 0.5).value as string;
      expect(value.startsWith(midway)).toBe(true);
      expect(replayAnswerAt(q, saved, 1).value).toBe(value);
      expect(saved.value).toBe(value);
    }
  });

  it("keeps the full question group and confirms only at the shared 0.8 threshold", () => {
    const questions = [
      question(),
      question({ id: "content", title: "【合成测试】内容", type: "multiple" }),
      question({ id: "budget", title: "【合成测试】预算", type: "number", options: [] }),
    ];
    const answers = questions.map((q) => answer(q));
    const current = action({ questions, answers: [answers[1]] });
    for (const progress of [0, 0.5, 1]) {
      const html = scene(current, progress, [answers[0]]);
      expect(html.match(/class="gi-question"/g)).toHaveLength(3);
      for (const q of questions) expect(html).toContain(q.title);
    }
    const confirmation = action({ kind: "round_confirm", questions, answers });
    expect(scene(confirmation, 0.79)).not.toContain('data-confirmation="confirmed"');
    expect(scene(confirmation, 0.8).match(/data-confirmation="confirmed"/g)).toHaveLength(3);
  });

  it("keeps unknown, skipped and changed answers unresolved during round confirmation", () => {
    for (const state of ["unknown", "skipped"] as const) {
      const q = question();
      const saved = answer(q, { state });
      const html = scene(action({ kind: "round_confirm", answers: [saved] }), 1);
      expect(html).toContain("保持未决");
      expect(html).not.toContain('data-confirmation="confirmed"');
    }
    const q = question();
    const html = scene(
      action({ kind: "round_confirm", answers: [answer(q, { needsReconfirmation: true })] }),
      1,
    );
    expect(html).toContain("待重新确认");
    expect(html).not.toContain('data-confirmation="confirmed"');
  });

  it("keeps normal-motion text readable underneath decorative letter and ink effects", () => {
    const chars = renderToStaticMarkup(
      React.createElement(Chars, { text: "【合成测试】可读标题", active: true, delay: 5000 }),
    );
    const decode = renderToStaticMarkup(
      React.createElement(Decode, { text: "【合成测试】可读正文", active: true, delay: 5000 }),
    );
    expect(chars).toContain('<span class="c-readable-text">【合成测试】可读标题</span>');
    expect(chars).toContain('class="c-text-ornament" aria-hidden="true"');
    expect(decode).toContain("<span>【合成测试】可读正文</span>");
    expect(decode).toContain('class="c-decode-ornament" aria-hidden="true"');
  });

  it("shows the exact saved summary and keeps submission distinct from explicit confirmation", () => {
    const challenge = {
      ...fixtureSnapshot().versions[0].challenge,
      goal: "【合成测试】第一版原始摘要",
      constraints: "【合成测试】当时的限制",
      preferences: "【合成测试】当时的偏好",
      options: ["【合成测试】当时的想法"],
      materials: "【合成测试】当时的材料全文",
      budget: null,
      timeHours: 0,
    };
    const saved = action({
      kind: "summary_submit",
      questions: undefined,
      answers: undefined,
      summary: { challenge, assumptions: ["【合成测试】假设仍待核对"] },
    });
    const later = answer(question(), {
      value: "LATER_FINAL_VALUE_MUST_NOT_REPLACE_THE_SAVED_SUMMARY",
    });
    const html = scene(saved, 1, [later]);
    for (const value of [
      challenge.goal,
      challenge.constraints,
      challenge.preferences,
      challenge.options[0],
      challenge.materials,
    ])
      expect(html).toContain(value);
    expect(html).toContain("未说明");
    expect(html).toContain("暂定假设，待核对");
    expect(html).toContain("摘要已提交，继续查漏");
    expect(html).not.toContain("本次确认已记录");
    expect(html).not.toContain(later.value);
    const confirmation = { ...saved, kind: "summary_confirm" as const };
    expect(scene(confirmation, 0.79)).not.toContain("本次确认已记录");
    expect(scene(confirmation, 0.8)).toContain("本次提交的摘要确认已接受");
    expect(scene(confirmation, 0.8)).not.toContain("data-replay-confirm");
    expect(scene(confirmation, 0.8)).not.toContain('data-pressed="true"');
    expect(scene(action({ kind: "handoff", questions: undefined }), 0.8)).not.toContain(
      'data-pressed="true"',
    );
    expect(
      scene(action({ kind: "summary_submit", questions: undefined, answers: undefined }), 1),
    ).toContain("这次操作未保存完整摘要");
  });

  it("does not inherit a prior confirmed answer across unit or authorization changes", () => {
    const original = question({ unit: "次", authorization: "仅比较展示方案" });
    const saved = answer(original);
    for (const changed of [
      question({ unit: "人", authorization: original.authorization }),
      question({ unit: original.unit, authorization: "允许修改账户设置" }),
    ]) {
      const html = scene(
        action({ kind: "questions", questions: [changed], answers: undefined }),
        1,
        [saved],
      );
      expect(html).not.toContain('checked=""');
      expect(html).not.toContain('data-confirmation="confirmed"');
      expect(html).toContain("待回答");
    }
  });

  it("keeps the complete answer out of live step text until its playback action is accepted", () => {
    const version = fixtureSnapshot().versions[0];
    const q = question({ type: "text", options: [] });
    const saved = answer(q, {
      value: "COMPLETE_SAVED_TEXT_MUST_WAIT_FOR_THE_CONTROL",
      confirmation: "pending",
    });
    const current = {
      id: "replay:fixture",
      stage: "revise" as const,
      agent: "B" as const,
      title: "【合成测试】填写回答",
      plain: "【合成测试】回看",
      replayAction: action({ questions: [q], answers: [saved] }),
    };
    const render = (replayProgress: number) =>
      renderToStaticMarkup(
        React.createElement(LiveRecord, {
          version,
          beat: current,
          index: 0,
          directed: true,
          lead: 0,
          replayProgress,
          replayAnswersVisible: [saved],
          onEvidence: () => {},
        }),
      );
    expect(render(0.79)).toContain("正在按保存记录填写");
    expect(render(0.79)).not.toContain(saved.value);
    expect(render(0.8)).toContain(saved.value);
    expect(render(0.8)).toContain("待确认");
  });

  it("renders all model review items in the original scrollable role board", () => {
    const version = fixtureSnapshot().versions[0];
    const items = Array.from({ length: 9 }, (_, i) => ({
      id: `item_${i}`,
      topic: "content" as const,
      title: `【合成测试】事项${i + 1}`,
      description: `第${i + 1}项完整说明`,
      dependsOn: [],
      required: true,
      acceptance: [],
      sourceRefs: [],
    }));
    version.workflow = "clarification";
    version.clarification = {
      protocol: "clarification-1",
      items,
      retiredIds: [],
      runs: [
        {
          id: "fixture-a",
          operationId: "fixture-call",
          role: "A",
          round: 1,
          basedOnRevision: 1,
          status: "completed",
          summary: "【合成测试】九项完整事项",
          output: { summary: "【合成测试】九项完整事项", items, retired: [], suggestions: [] },
          usage: [],
          createdAt: "2026-11-12T00:00:00Z",
        },
      ],
      rounds: [],
      suggestions: [],
      conflicts: [],
      review: null,
      next: "questions",
      draftOnly: true,
      specification: "",
      executionPrompt: "",
    };
    const html = renderToStaticMarkup(
      React.createElement(RouteStage, {
        version,
        demo: false,
        beats: beatsOf(version),
        index: 0,
        speed: 1,
        directed: false,
        camera: false,
        lead: 0,
        reviewing: true,
        entering: false,
        readOnly: true,
        onStep: () => {},
        onEvidence: () => {},
        onClaim: () => {},
      }),
    );
    for (const item of items) expect(html).toContain(item.title);
    expect(html).toContain('class="c-board-body"');
  });
});
