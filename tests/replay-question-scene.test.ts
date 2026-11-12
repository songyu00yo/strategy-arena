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
  replayHandoffActive,
  replayHandoffOutside,
  replayPaperTiming,
  replayPointerAt,
  replayPressAt,
  replayPressedAt,
  replayReadingState,
  replayReadingScroll,
} from "../src/components/console/ReplayQuestionScene";
import type { PlaybackFrame } from "../src/components/console/use-playback-progress";
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
  it("opens over 420 active milliseconds and folds only during the final 360 after acceptance", () => {
    const frame = (elapsed: number, overrides: Partial<PlaybackFrame> = {}): PlaybackFrame => ({
      stepId: "synthetic-question",
      progress: elapsed / 2500,
      elapsed,
      duration: 2500,
      running: true,
      settled: false,
      ...overrides,
    });
    expect(replayPaperTiming(frame(0), true, true)).toEqual({ open: 0, fold: 0 });
    expect(replayPaperTiming(frame(210), true, true).open).toBe(0.875);
    expect(replayPaperTiming(frame(420), true, true).open).toBe(1);
    expect(replayPaperTiming(frame(2140), true, true).fold).toBe(0);
    expect(replayPaperTiming(frame(2320), true, true).fold).toBe(0.5);
    expect(replayPaperTiming(frame(2500), true, true).fold).toBe(1);
    expect(replayPaperTiming(frame(2320, { running: false }), true, true)).toEqual(
      replayPaperTiming(frame(2320), true, true),
    );
    expect(replayPaperTiming(frame(2500, { settled: true }), true, true)).toEqual({
      open: 1,
      fold: 0,
    });
    expect(replayPaperTiming(frame(420), false, false)).toEqual({ open: 1, fold: 0 });
    expect(replayPaperTiming(frame(399, { duration: 500 }), true, true).fold).toBe(0);
  });

  it("uses one 160ms press per actual selection and a curved decelerating pointer path", () => {
    for (const at of [0.45, 0.6]) {
      expect(replayPressedAt(at * 2500 - 1, 2500, [at])).toBe(false);
      expect(replayPressedAt(at * 2500, 2500, [at])).toBe(true);
      expect(replayPressedAt(at * 2500 + 159, 2500, [at])).toBe(true);
      expect(replayPressedAt(at * 2500 + 160, 2500, [at])).toBe(false);
    }
    const origin = { x: 10, y: 20 };
    const target = { x: 210, y: 20 };
    expect(replayPointerAt(origin, target, 0)).toEqual(origin);
    expect(replayPointerAt(origin, target, 1)).toEqual(target);
    expect(replayPointerAt(origin, target, 0.5).y).toBeGreaterThan(20);
    expect(replayPointerAt(origin, target, 0.1).x - origin.x).toBeGreaterThan(
      target.x - replayPointerAt(origin, target, 0.9).x,
    );
  });

  it("presses each real control by a 1.5px sine pulse and returns to rest after 160ms", () => {
    const clicks = [0.45, 0.6];
    expect(replayPressAt(1124, 2500, clicks)).toEqual({ index: -1, progress: 0, offset: 0 });
    expect(replayPressAt(1125, 2500, clicks)).toEqual({ index: 0, progress: 0, offset: 0 });
    expect(replayPressAt(1205, 2500, clicks)).toEqual({ index: 0, progress: 0.5, offset: 1.5 });
    expect(replayPressAt(1245, 2500, clicks).offset).toBeCloseTo(Math.sin(Math.PI * 0.75) * 1.5);
    expect(replayPressAt(1285, 2500, clicks)).toEqual({ index: -1, progress: 0, offset: 0 });
    expect(replayPressAt(1580, 2500, clicks)).toEqual({ index: 1, progress: 0.5, offset: 1.5 });
    expect(replayPressAt(1660, 2500, clicks)).toEqual({ index: -1, progress: 0, offset: 0 });
  });

  it("requests a temporary handoff ornament only for a measured recipient outside the stage", () => {
    const stage = { left: 80, top: 200, width: 900, height: 520 };
    expect(replayHandoffOutside({ left: 120, top: 240, width: 260, height: 320 }, stage)).toBe(
      false,
    );
    expect(replayHandoffOutside({ left: 80, top: 60, width: 900, height: 180 }, stage)).toBe(true);
    expect(replayHandoffOutside({ left: 960, top: 300, width: 260, height: 200 }, stage)).toBe(
      true,
    );
    expect(replayHandoffOutside({ left: 120, top: 0, width: 0, height: 0 }, stage)).toBe(false);
    const html = scene(action({ kind: "handoff", questions: undefined }), 1);
    expect(html).not.toContain('class="replay-handoff-strip"');
    expect(html).toContain('class="replay-paper-strip" aria-hidden="true"');
    expect(html).not.toContain('data-pressed="true"');
  });

  it("retains the identical handoff ornament pose during pause and releases it on seek or completion", () => {
    const frame: PlaybackFrame = {
      stepId: "synthetic-handoff",
      progress: 2320 / 2500,
      elapsed: 2320,
      duration: 2500,
      running: true,
      settled: false,
    };
    const paused = { ...frame, running: false };
    const fold = replayPaperTiming(frame, false, true).fold;
    expect(replayHandoffActive(frame, fold, true)).toBe(true);
    expect(replayHandoffActive(paused, fold, true)).toBe(true);
    expect(replayPaperTiming(paused, false, true)).toEqual(replayPaperTiming(frame, false, true));
    expect(replayHandoffActive({ ...paused, settled: true }, fold, true)).toBe(false);
    expect(replayHandoffActive({ ...frame, progress: 1 }, 1, true)).toBe(false);
    expect(replayHandoffActive({ ...frame, progress: 0.79 }, fold, true)).toBe(false);
    expect(replayHandoffActive(paused, fold, false)).toBe(false);
  });

  it("scrolls continuously between measured reading stops with pauses at each group", () => {
    const stops = [0, 180, 360];
    expect(replayReadingScroll(0.2, stops, 360)).toBe(0);
    expect(replayReadingScroll(0.3, stops, 360)).toBe(0);
    expect(replayReadingScroll(0.5, stops, 360)).toBe(180);
    expect(replayReadingScroll(0.55, stops, 360)).toBe(180);
    expect(replayReadingScroll(0.8, stops, 360)).toBe(360);
    expect(replayReadingScroll(1, [0], 0)).toBe(0);
    const positions = Array.from({ length: 61 }, (_, index) =>
      replayReadingScroll(0.2 + index / 100, stops, 360),
    );
    expect(positions.every((position, index) => !index || position >= positions[index - 1])).toBe(
      true,
    );
    expect(positions.some((position) => position > 0 && position < 180)).toBe(true);
  });

  it("labels the existing scroll curve by its eased segment progress without changing its target", () => {
    const stops = [0, 180, 360];
    expect(replayReadingState(0.3, stops, 360).phase).toBe("reading");
    expect(replayReadingState(0.34, stops, 360).phase).toBe("accelerating");
    expect(replayReadingState(0.41, stops, 360).phase).toBe("travel");
    expect(replayReadingState(0.49, stops, 360).phase).toBe("settling");
    expect(replayReadingState(0.55, stops, 360).phase).toBe("reading");
    expect(replayReadingState(0.8, stops, 360)).toEqual({ top: 360, phase: "reading" });
    expect(replayReadingState(0.5, [], 0)).toEqual({ top: 0, phase: "reading" });
    for (const progress of [0.2, 0.3, 0.34, 0.41, 0.49, 0.55, 0.8])
      expect(replayReadingState(progress, stops, 360).top).toBe(
        replayReadingScroll(progress, stops, 360),
      );
  });

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
    expect(scene(confirmation, 0.8)).not.toContain("lucide-check");
    expect(scene(confirmation, 0.8)).toContain('checked=""');
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
    expect(scene(confirmation, 0.8)).not.toContain("lucide-check");
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
