"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { MousePointer2 } from "lucide-react";
import type { IntakeAnswer, IntakeQuestion, RecordedAnswer } from "@/lib/intake-contracts";
import type { ReplayAction } from "@/lib/replay-contracts";
import { QuestionInput } from "../question-input";
import { createMotionScope, motionPaused, subscribeMotionPause } from "./motion-runtime";
import { PAPER_MOTION } from "./paper-stage";
import type { PlaybackFrame, PlaybackTimeline } from "./use-playback-progress";
import "../guided-intake.css";
import "./replay-question-scene.css";

const LABELS = {
  questions: "这一轮需要补充什么",
  answer: "回看这一项回答",
  round_confirm: "确认这一轮的回答",
  summary_submit: "确认摘要并继续查漏",
  summary_confirm: "摘要提交的确认结果",
  handoff: "交接确认需求与执行提示词",
};

const BUTTONS = {
  questions: "开始回答",
  answer: "继续梳理",
  round_confirm: "确认本轮回答并继续梳理",
  summary_submit: "确认摘要并继续查漏",
  summary_confirm: "摘要确认已接受",
  handoff: "需求交接记录已生成",
};
const EMPTY_CHOICES: string[] = [];

const bounded = (progress: number) =>
  Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 1;
const easeOut = (amount: number) => 1 - (1 - bounded(amount)) ** 3;
type Point = { x: number; y: number };

/** These durations use the shared clock's active elapsed time, including playback speed. */
export function replayPaperTiming(frame: PlaybackFrame, opening: boolean, closing: boolean) {
  const foldStart = Math.max(frame.duration - PAPER_MOTION.fold, frame.duration * 0.8);
  return {
    open: frame.settled || !opening ? 1 : easeOut(frame.elapsed / PAPER_MOTION.open),
    fold:
      frame.settled || !closing
        ? 0
        : bounded((frame.elapsed - foldStart) / Math.max(1, frame.duration - foldStart)),
  };
}

/** A curved approach decelerates at the actual control rather than overshooting it. */
export function replayPointerAt(origin: Point, target: Point, progress: number): Point {
  const amount = easeOut(progress);
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const bend = {
    x: (origin.x + target.x) / 2 - dy * 0.12,
    y: (origin.y + target.y) / 2 + dx * 0.12,
  };
  return {
    x: (1 - amount) ** 2 * origin.x + 2 * (1 - amount) * amount * bend.x + amount ** 2 * target.x,
    y: (1 - amount) ** 2 * origin.y + 2 * (1 - amount) * amount * bend.y + amount ** 2 * target.y,
  };
}

export function replayPressAt(elapsed: number, duration: number, clickTimes: number[]) {
  const index = clickTimes.findLastIndex(
    (at) => elapsed >= at * duration && elapsed < at * duration + PAPER_MOTION.feedback,
  );
  const progress = index < 0 ? 0 : (elapsed - clickTimes[index] * duration) / PAPER_MOTION.feedback;
  return { index, progress, offset: index < 0 ? 0 : Math.sin(progress * Math.PI) * 1.5 };
}

export function replayPressedAt(elapsed: number, duration: number, clickTimes: number[]) {
  return replayPressAt(elapsed, duration, clickTimes).index >= 0;
}

/** A body-owned ornament is needed only when the measured recipient leaves the stage clip. */
export function replayHandoffOutside(
  receiver: Pick<DOMRect, "left" | "top" | "width" | "height">,
  stage: Pick<DOMRect, "left" | "top" | "width" | "height">,
) {
  if (receiver.width <= 0 || receiver.height <= 0 || stage.width <= 0 || stage.height <= 0)
    return false;
  const x = receiver.left + receiver.width / 2;
  const y = receiver.top + receiver.height / 2;
  return (
    x < stage.left || x > stage.left + stage.width || y < stage.top || y > stage.top + stage.height
  );
}

/** A paused frame owns the same ornament until seeking or completion replaces it. */
export function replayHandoffActive(frame: PlaybackFrame, fold: number, crossesClip: boolean) {
  return crossesClip && fold >= 0.42 && fold < 1 && frame.progress >= 0.8 && !frame.settled;
}

type ReplayScrollPhase = "reading" | "accelerating" | "travel" | "settling" | "paused";

function scrollMotionPhase(eased: number): ReplayScrollPhase {
  if (eased <= 0 || eased >= 1) return "reading";
  return eased < 0.1 ? "accelerating" : eased > 0.9 ? "settling" : "travel";
}

/** Each measured question gets a reading stop before the next continuous scroll. */
export function replayReadingState(progress: number, stops: number[], range: number) {
  const positions = [
    ...new Set([0, ...stops.map((stop) => Math.max(0, Math.min(range, stop))), range]),
  ].sort((a, b) => a - b);
  // Fold a bottom-padding remainder into the preceding move, without another reading pause.
  if (positions.length > 2 && range - positions[positions.length - 2] < 16) positions.splice(-2, 1);
  if (positions.length < 2) return { top: 0, phase: "reading" as ReplayScrollPhase };
  const travel = bounded((progress - 0.2) / 0.6) * (positions.length - 1);
  const index = Math.min(positions.length - 2, Math.floor(travel));
  const amount = bounded((travel - index - 0.42) / 0.58);
  const eased = amount * amount * (3 - 2 * amount);
  return {
    top: positions[index] + (positions[index + 1] - positions[index]) * eased,
    phase: scrollMotionPhase(eased),
  };
}

export function replayReadingScroll(progress: number, stops: number[], range: number) {
  return replayReadingState(progress, stops, range).top;
}

function layoutPoint(element: HTMLElement): Point {
  let x = 0;
  let y = 0;
  for (
    let node: HTMLElement | null = element;
    node;
    node = node.offsetParent as HTMLElement | null
  ) {
    x += node.offsetLeft;
    y += node.offsetTop;
  }
  return { x, y };
}

/** FLIP geometry is derived from measured rectangles, with no guessed source position. */
export function replayFlipGeometry(
  source: Pick<DOMRect, "left" | "top" | "width" | "height">,
  target: Pick<DOMRect, "left" | "top" | "width" | "height">,
) {
  if (source.width <= 0 || source.height <= 0 || target.width <= 0 || target.height <= 0)
    return null;
  return {
    x: source.left + source.width / 2 - target.left - target.width / 2,
    y: source.top + source.height / 2 - target.top - target.height / 2,
    scaleX: source.width / target.width,
    scaleY: source.height / target.height,
  };
}

/** Display only the saved value reached by the current, externally controlled action. */
export function replayAnswerAt(
  question: IntakeQuestion,
  saved: RecordedAnswer | undefined,
  progress: number,
): IntakeAnswer {
  const empty: IntakeAnswer = {
    questionId: question.id,
    state: "answered",
    value: question.type === "multiple" ? [] : "",
  };
  if (!saved || progress < 0.32) return empty;
  if (saved.state !== "answered")
    return progress >= 0.45 ? { ...empty, state: saved.state } : empty;
  const entered = bounded((progress - 0.45) / 0.3);
  if (Array.isArray(saved.value))
    return {
      ...empty,
      value: saved.value.filter(
        (_, index) => progress >= 0.45 + index * (0.3 / Math.max(saved.value.length, 1)),
      ),
    };
  if (question.type === "single") return { ...empty, value: progress >= 0.45 ? saved.value : "" };
  const glyphs = Array.from(saved.value);
  return { ...empty, value: glyphs.slice(0, Math.ceil(entered * glyphs.length)).join("") };
}

function previousAnswer(question: IntakeQuestion, answers: RecordedAnswer[]) {
  return answers.findLast(
    (answer) =>
      answer.questionId === question.id &&
      answer.question.title === question.title &&
      answer.question.type === question.type &&
      answer.question.unit === question.unit &&
      (answer.question.authorization ?? "") === (question.authorization ?? "") &&
      JSON.stringify(answer.question.options) === JSON.stringify(question.options),
  );
}

function answerLabel(answer: RecordedAnswer | undefined, confirmed: boolean) {
  if (!answer) return "待回答";
  if (answer.state === "unknown") return "暂时不知道，保持未决";
  if (answer.state === "skipped") return "已跳过，保持未决";
  if (answer.needsReconfirmation) return "待重新确认";
  return confirmed ? "已确认" : "已保存，待确认";
}

export function ReplayQuestionScene({
  action,
  previousAnswers = [],
  progress = 1,
  playing = false,
  speed = 1,
  seeking = false,
  timeline,
  stepId,
  duration = 2500,
  nextRole,
}: {
  action: ReplayAction;
  previousAnswers?: RecordedAnswer[];
  progress?: number;
  playing?: boolean;
  speed?: number;
  seeking?: boolean;
  timeline?: PlaybackTimeline;
  stepId?: string;
  duration?: number;
  nextRole?: "A" | "B" | "C";
}) {
  const root = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const pointer = useRef<HTMLDivElement>(null);
  const activeStepId = stepId ?? action.id;
  const [sample, setSample] = useState({ stepId: activeStepId, amount: bounded(progress) });
  const amount = timeline && sample.stepId === activeStepId ? sample.amount : bounded(progress);
  const questions = action.questions ?? [];
  const currentAnswer = action.kind === "answer" ? action.answers?.[0] : undefined;
  const confirmed = amount >= 0.8;
  const confirming = ["round_confirm", "summary_submit", "summary_confirm", "handoff"].includes(
    action.kind,
  );
  const userConfirmation = action.kind === "round_confirm" || action.kind === "summary_submit";
  const targetQuestion = questions.find((question) => question.id === currentAnswer?.questionId);
  const choices =
    currentAnswer?.state === "answered" && Array.isArray(currentAnswer.value)
      ? currentAnswer.value
      : EMPTY_CHOICES;
  const phase = amount < 0.2 ? "show" : amount < 0.8 ? "answer" : "settle";
  const frameRef = useRef<PlaybackFrame>({
    stepId: activeStepId,
    progress: bounded(progress),
    elapsed: bounded(progress) * duration,
    duration,
    running: playing,
    settled: seeking,
  });
  const sync = useRef<(frame: PlaybackFrame) => void>(() => {});
  const refresh = useRef<() => void>(() => {});
  const pointerPosition = useRef<Point | null>(null);
  const followed = useRef({ id: "", playing: false, seeking: false, speed });

  useLayoutEffect(() => {
    const element = root.current;
    const viewport = body.current;
    const cursor = pointer.current;
    const stage = element?.closest<HTMLElement>(".c-stage3");
    if (!element || !viewport || !cursor || !stage) return;
    const opening = action.kind === "questions" || action.kind === "summary_submit";
    const closing = ["round_confirm", "summary_submit", "handoff"].includes(action.kind);
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const board = stage.querySelector<HTMLElement>('[data-board="B"]');
    const receiver = nextRole
      ? stage.querySelector<HTMLElement>('[data-board="' + nextRole + '"]')
      : action.kind === "handoff"
        ? element.closest(".c-root")?.querySelector<HTMLElement>("#verdict")
        : null;
    let cache: {
      source: ReturnType<typeof replayFlipGeometry>;
      destination: ReturnType<typeof replayFlipGeometry>;
      bodyTop: number;
      bodyHeight: number;
      range: number;
      scroll: number;
      stops: number[];
      targets: Array<Point | null>;
      controls: Array<HTMLElement | null>;
      heading: Point;
      startScroll: number;
      sheet: { left: number; top: number; width: number; height: number };
      clip: { left: number; top: number; right: number; bottom: number };
      transferOutside: boolean;
      sheetStyles: Array<[string, string]>;
    } | null = null;
    let scheduled = 0;
    let disposed = false;
    let signature = "";
    let origin: Point | null = pointerPosition.current;
    let pressedControl: HTMLElement | null = null;
    const resetControl = () => {
      pressedControl?.style.removeProperty("--replay-control-press");
      if (pressedControl) delete pressedControl.dataset.replayPressed;
      pressedControl = null;
    };
    let transfer: {
      scope: ReturnType<typeof createMotionScope>;
      node: HTMLDivElement;
    } | null = null;
    const clearTransfer = () => {
      transfer?.scope.dispose();
      transfer = null;
      element.style.setProperty("--replay-paper-opacity", "1");
      element.dataset.stripOwner = "local";
    };
    const clickTimes = userConfirmation
      ? [0.8]
      : choices.length
        ? choices.map((_, index) => 0.45 + index * (0.3 / choices.length))
        : [0.45];

    const localSignature = (frame: PlaybackFrame) => {
      const shown = targetQuestion
        ? replayAnswerAt(targetQuestion, currentAnswer, frame.progress)
        : null;
      return JSON.stringify([
        activeStepId,
        shown?.state,
        shown?.value,
        frame.progress >= 0.2,
        frame.progress >= 0.45,
        frame.progress >= 0.75,
        frame.progress >= 0.8,
      ]);
    };

    const paint = (frame: PlaybackFrame) => {
      if (!cache || frame.stepId !== activeStepId) return;
      const paper = replayPaperTiming(frame, opening, closing);
      const open = reducedMotion ? 1 : paper.open;
      const fold = reducedMotion || !cache.destination ? 0 : paper.fold;
      const unfolded = easeOut(fold);
      const flight = easeOut(bounded((fold - 0.42) / 0.58));
      const destination = cache.destination;
      const source = cache.source;
      const x = (source?.x ?? 0) * (1 - open) + (destination?.x ?? 0) * flight;
      const y = (source?.y ?? 0) * (1 - open) + (destination?.y ?? 0) * flight;
      const scaleX = (1 + ((source?.scaleX ?? 1) - 1) * (1 - open)) * (1 - unfolded * 0.16);
      const scaleY = (1 + ((source?.scaleY ?? 1) - 1) * (1 - open)) * (1 - unfolded * 0.86);
      let scroll = cache.scroll;
      let scrollPhase: ReplayScrollPhase = frame.running ? "reading" : "paused";
      if (frame.running && action.kind === "questions") {
        const reading = replayReadingState(frame.progress, cache.stops, cache.range);
        scroll = reading.top;
        scrollPhase = reading.phase;
      }
      const clickIndex = choices.length
        ? Math.min(
            choices.length - 1,
            clickTimes.filter((at) => frame.elapsed >= at * frame.duration + PAPER_MOTION.feedback)
              .length,
          )
        : 0;
      const target = cache.targets[clickIndex];
      const previousTarget = clickIndex > 0 ? cache.targets[clickIndex - 1] : null;
      const moveStart =
        userConfirmation || clickIndex === 0
          ? 0.15 * frame.duration
          : Math.min(
              clickTimes[clickIndex - 1] * frame.duration + PAPER_MOTION.feedback,
              clickTimes[clickIndex] * frame.duration,
            );
      const moveEnd = (userConfirmation ? 0.75 : clickTimes[clickIndex]) * frame.duration;
      const movement = bounded((frame.elapsed - moveStart) / Math.max(1, moveEnd - moveStart));
      if (target && frame.running && !userConfirmation && action.kind === "answer") {
        const desired = Math.max(
          0,
          Math.min(cache.range, target.y - cache.bodyTop - cache.bodyHeight * 0.35),
        );
        const start = previousTarget
          ? Math.max(
              0,
              Math.min(cache.range, previousTarget.y - cache.bodyTop - cache.bodyHeight * 0.35),
            )
          : cache.startScroll;
        const eased = easeOut(movement);
        scroll = start + (desired - start) * eased;
        scrollPhase = desired === start ? "reading" : scrollMotionPhase(eased);
      }
      const toVisible = (point: Point) => ({
        x: point.x,
        y: point.y - (userConfirmation ? 0 : scroll),
      });
      const position = target
        ? replayPointerAt(
            previousTarget ? toVisible(previousTarget) : (origin ?? cache.heading),
            toVisible(target),
            reducedMotion ? 1 : movement,
          )
        : null;
      const press = replayPressAt(frame.elapsed, frame.duration, clickTimes);
      const pressed = !!(currentAnswer || userConfirmation) && press.index >= 0;
      const control = pressed ? (cache.controls[press.index] ?? null) : null;
      const stripLeft = cache.sheet.left + x + (cache.sheet.width * (1 - scaleX)) / 2;
      const stripTop = cache.sheet.top + y + (cache.sheet.height * (1 - scaleY)) / 2;
      const crossesClip =
        stripLeft < cache.clip.left ||
        stripTop < cache.clip.top ||
        stripLeft + cache.sheet.width * scaleX > cache.clip.right ||
        stripTop + cache.sheet.height * scaleY > cache.clip.bottom;
      const carry = cache.transferOutside && replayHandoffActive(frame, fold, crossesClip);

      // Geometry was read during refresh. All frame writes follow the completed calculation.
      element.style.transform =
        "translate3d(" + x + "px," + y + "px,0) scale(" + scaleX + "," + scaleY + ")";
      element.style.setProperty("--replay-shadow", String(1 - open + unfolded * 0.75));
      element.style.setProperty("--replay-fold", String(unfolded));
      element.style.setProperty("--replay-content-visibility", fold >= 0.42 ? "hidden" : "visible");
      element.style.setProperty("--replay-strip-visibility", fold >= 0.42 ? "visible" : "hidden");
      element.style.setProperty("--replay-strip-scale-x", String(1 / scaleX));
      element.style.setProperty("--replay-strip-scale-y", String(1 / scaleY));
      element.dataset.replayOpened = String(open >= 1);
      element.dataset.replayFold = fold.toFixed(3);
      viewport.dataset.scrollPhase = scrollPhase;
      viewport.dataset.scrollTarget = scroll.toFixed(3);
      if (pressedControl !== control) resetControl();
      if (control) {
        pressedControl = control;
        control.style.setProperty(
          "--replay-control-press",
          (reducedMotion ? 0 : press.offset) + "px",
        );
        control.dataset.replayPressed = "true";
      }
      if (carry) {
        if (!transfer) {
          const scope = createMotionScope();
          const node = scope.own(document.createElement("div"));
          node.className = "replay-handoff-strip";
          node.setAttribute("aria-hidden", "true");
          node.inert = true;
          node.dataset.replayHandoffFor = activeStepId;
          const shadow = document.createElement("div");
          shadow.className = "replay-paper-shadow";
          const label = document.createElement("span");
          label.textContent = "第 " + action.round + " 轮 · " + LABELS[action.kind];
          node.append(shadow, label);
          document.body.appendChild(node);
          transfer = { scope, node };
        }
        const node = transfer.node;
        node.style.visibility = document.hidden ? "hidden" : "visible";
        cache.sheetStyles.forEach(([property, value]) => node.style.setProperty(property, value));
        node.style.left = cache.sheet.left - scrollX + "px";
        node.style.top = cache.sheet.top - scrollY + "px";
        node.style.width = cache.sheet.width + "px";
        node.style.height = cache.sheet.height + "px";
        node.style.transform =
          "translate3d(" + x + "px," + y + "px,0) scale(" + scaleX + "," + scaleY + ")";
        node.style.setProperty("--replay-shadow", String(unfolded * 0.75));
        node.style.setProperty("--replay-strip-scale-x", String(1 / scaleX));
        node.style.setProperty("--replay-strip-scale-y", String(1 / scaleY));
        element.style.setProperty("--replay-paper-opacity", "0");
        element.dataset.stripOwner = "body";
      } else clearTransfer();
      if (frame.running && Math.abs(scroll - cache.scroll) > 0.1) {
        viewport.scrollTop = scroll;
        cache.scroll = scroll;
      }
      cursor.dataset.pressed = String(pressed);
      cursor.style.setProperty("--replay-press-amount", String(pressed ? press.offset / 1.5 : 0));
      cursor.style.opacity =
        frame.progress >= 0.15 && frame.progress < 0.96 && fold < 0.25 ? "1" : "0";
      cursor.style.visibility = position ? "visible" : "hidden";
      if (position) {
        pointerPosition.current = position;
        cursor.style.transform =
          "translate3d(" + (position.x + 2) + "px," + (position.y + 2) + "px,0)";
      }
    };

    const measure = () => {
      scheduled = 0;
      if (disposed) return;
      const page = layoutPoint(element);
      const bodyPage = layoutPoint(viewport);
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      const targetBox = {
        left: page.x - scrollX,
        top: page.y - scrollY,
        width,
        height,
      };
      const sourceBox = board?.getBoundingClientRect();
      const stageBox = stage.getBoundingClientRect();
      const receiverBox = receiver?.getBoundingClientRect();
      const sheetStyle = getComputedStyle(element);
      const sheetStyles = [
        "font-family",
        "color",
        "background",
        "border",
        "border-radius",
        "box-shadow",
      ].map((property): [string, string] => [property, sheetStyle.getPropertyValue(property)]);
      const visibleSource =
        !!sourceBox &&
        sourceBox.width > 0 &&
        sourceBox.height > 0 &&
        sourceBox.right > Math.max(0, stageBox.left) &&
        sourceBox.left < Math.min(innerWidth, stageBox.right) &&
        sourceBox.bottom > Math.max(0, stageBox.top) &&
        sourceBox.top < Math.min(innerHeight, stageBox.bottom);
      const source = replayFlipGeometry(
        visibleSource && sourceBox ? sourceBox : stageBox,
        targetBox,
      );
      const destination = receiverBox ? replayFlipGeometry(receiverBox, targetBox) : null;
      const positionOf = (node: HTMLElement): Point => {
        const point = layoutPoint(node);
        return {
          x:
            point.x -
            page.x +
            (node.hasAttribute("data-answer-option")
              ? node.offsetWidth / 2
              : Math.min(node.offsetWidth / 2, 22)),
          y: point.y - page.y + node.offsetHeight / 2,
        };
      };
      const fieldset = [...viewport.querySelectorAll<HTMLElement>("[data-question-id]")].find(
        (node) => node.dataset.questionId === currentAnswer?.questionId,
      );
      const optionCard = (value: string) =>
        [...(fieldset?.querySelectorAll<HTMLElement>("[data-answer-option]") ?? [])].find(
          (node) => node.dataset.answerOption === value,
        );
      const nodes: Array<HTMLElement | null | undefined> = userConfirmation
        ? [element.querySelector<HTMLElement>("[data-replay-confirm]")]
        : currentAnswer?.state === "unknown" || currentAnswer?.state === "skipped"
          ? [
              fieldset?.querySelector<HTMLElement>(
                '[data-answer-state="' + currentAnswer.state + '"]',
              ),
            ]
          : targetQuestion?.type === "single" || targetQuestion?.type === "multiple"
            ? (choices.length ? choices : [String(currentAnswer?.value ?? "")]).map(optionCard)
            : [fieldset?.querySelector<HTMLElement>("[data-answer-field]")];
      const targets = nodes.map((node) => (node ? positionOf(node) : null));
      const heading = element.querySelector<HTMLElement>("h3");
      const headingPoint = heading ? positionOf(heading) : { x: width / 2, y: 0 };
      const stops = [
        ...viewport.querySelectorAll<HTMLElement>(
          "[data-question-id], .replay-summary-answers > div",
        ),
      ].map((node) => Math.max(0, layoutPoint(node).y - bodyPage.y));
      cache = {
        source,
        destination,
        bodyTop: bodyPage.y - page.y,
        bodyHeight: viewport.clientHeight,
        range: Math.max(0, viewport.scrollHeight - viewport.clientHeight),
        scroll: viewport.scrollTop,
        stops,
        targets,
        controls: nodes.map((node) => node ?? null),
        heading: headingPoint,
        startScroll: cache?.startScroll ?? viewport.scrollTop,
        sheet: { left: page.x, top: page.y, width, height },
        clip: {
          left: stageBox.left + scrollX,
          top: stageBox.top + scrollY,
          right: stageBox.right + scrollX,
          bottom: stageBox.bottom + scrollY,
        },
        transferOutside:
          action.kind === "handoff" && !!receiverBox && replayHandoffOutside(receiverBox, stageBox),
        sheetStyles,
      };
      origin ??= headingPoint;
      // Attribution is observable in browser evidence, including every fallback.
      element.dataset.flipOrigin = source
        ? visibleSource
          ? "board-b"
          : "stage-plane"
        : "unavailable";
      element.dataset.flipFallback = visibleSource
        ? ""
        : !board
          ? "board-missing"
          : !sourceBox?.width || !sourceBox.height
            ? "board-empty-size"
            : "board-outside-viewport";
      element.dataset.foldTarget = destination
        ? nextRole
          ? "board-" + nextRole.toLowerCase()
          : "original-result"
        : "unavailable";
      element.dataset.foldFallback = destination
        ? ""
        : !receiver
          ? "target-missing"
          : "target-empty-size";
      paint(frameRef.current);
    };
    const scheduleMeasure = () => {
      if (!scheduled && !disposed) scheduled = requestAnimationFrame(measure);
    };
    const receive = (frame: PlaybackFrame) => {
      if (disposed || frame.stepId !== activeStepId) return;
      frameRef.current = frame;
      const key = localSignature(frame);
      if (signature !== key) {
        signature = key;
        setSample({ stepId: activeStepId, amount: bounded(frame.progress) });
      }
      paint(frame);
    };
    const scrollBody = () => {
      if (cache) cache.scroll = viewport.scrollTop;
      paint(frameRef.current);
    };
    const scrollPage = () => {
      if (!cache) return;
      // Scroll changes viewport offsets, never the measured content geometry.
      paint(frameRef.current);
    };
    sync.current = receive;
    refresh.current = scheduleMeasure;
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(element);
    observer.observe(viewport);
    observer.observe(stage);
    if (board) observer.observe(board);
    if (receiver) observer.observe(receiver);
    viewport.addEventListener("scroll", scrollBody, { passive: true });
    addEventListener("scroll", scrollPage, { passive: true });
    addEventListener("resize", scheduleMeasure, { passive: true });
    window.visualViewport?.addEventListener("resize", scheduleMeasure);
    const unsubscribe = timeline?.subscribe(receive);
    const unsubscribePause = subscribeMotionPause(() => {
      paint(frameRef.current);
    });
    const initial = timeline?.read();
    if (initial?.stepId === activeStepId) frameRef.current = initial;
    else
      frameRef.current = {
        stepId: activeStepId,
        progress: 0,
        elapsed: 0,
        duration,
        running: false,
        settled: false,
      };
    measure();
    receive(frameRef.current);
    return () => {
      disposed = true;
      if (scheduled) cancelAnimationFrame(scheduled);
      observer.disconnect();
      unsubscribe?.();
      unsubscribePause();
      clearTransfer();
      resetControl();
      viewport.removeEventListener("scroll", scrollBody);
      removeEventListener("scroll", scrollPage);
      removeEventListener("resize", scheduleMeasure);
      window.visualViewport?.removeEventListener("resize", scheduleMeasure);
    };
  }, [
    action,
    activeStepId,
    choices,
    currentAnswer,
    duration,
    nextRole,
    targetQuestion,
    timeline,
    userConfirmation,
  ]);

  useLayoutEffect(() => {
    if (timeline) {
      const frame = timeline.read();
      if (frame.stepId === activeStepId) sync.current(frame);
    } else {
      sync.current({
        stepId: activeStepId,
        progress: bounded(progress),
        elapsed: bounded(progress) * duration,
        duration,
        running: playing,
        settled: seeking,
      });
    }
  }, [activeStepId, duration, playing, progress, seeking, timeline]);

  useLayoutEffect(() => {
    const previous = followed.current;
    const activePlaying = playing && !motionPaused();
    const shouldFollow =
      previous.id !== action.id ||
      (!previous.playing && activePlaying) ||
      (!previous.seeking && seeking) ||
      (activePlaying && previous.speed !== speed);
    followed.current = { id: action.id, playing: activePlaying, seeking, speed };
    if (!shouldFollow) return;
    const element = root.current;
    if (!element) return;
    const page = layoutPoint(element);
    const viewport = window.visualViewport;
    const top = (viewport?.offsetTop ?? 0) + 12;
    const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight) - 12;
    if (page.y - scrollY < top || page.y - scrollY + element.offsetHeight > bottom) {
      window.scrollTo({ left: scrollX, top: Math.max(0, page.y - top), behavior: "instant" });
      refresh.current();
    }
  }, [action.id, playing, seeking, speed]);

  const rows = questions.length
    ? questions.map((question) => ({
        question,
        saved:
          action.answers?.find((answer) => answer.questionId === question.id) ??
          previousAnswer(question, previousAnswers),
      }))
    : previousAnswers.map((answer) => ({ question: answer.question, saved: answer }));
  const summary = action.summary?.challenge;
  const summaryFields: Array<[string, string]> = summary
    ? [
        ["目标", summary.goal],
        ["硬性限制", summary.constraints || "未说明"],
        ["偏好", summary.preferences || "未说明"],
        ["已有想法", summary.options.join("\n") || "未说明"],
        ["预算（元）", summary.budget == null ? "未说明" : String(summary.budget)],
        ["时间（小时）", summary.timeHours == null ? "未说明" : String(summary.timeHours)],
        ["材料", summary.materials || "未说明"],
      ]
    : [];

  return (
    <section
      ref={root}
      className={`replay-question-scene guided-intake ${playing ? "is-playing" : ""} ${seeking ? "is-seeking" : ""}`}
      aria-label="补问过程回放"
      data-replay-action={action.kind}
      data-replay-phase={phase}
    >
      <div className="replay-paper-shadow" aria-hidden="true" />
      <div className="replay-paper-strip" aria-hidden="true">
        <span>
          第 {action.round} 轮 · {LABELS[action.kind]}
        </span>
      </div>
      <header className="replay-question-heading">
        <div>
          <span>
            第 {action.round} 轮 · 需求修订 {action.revision}
          </span>
          <h3>{LABELS[action.kind]}</h3>
        </div>
        <p>按保存记录重建，动画节奏为演示编排</p>
      </header>
      <div ref={body} className="replay-question-body">
        {questions.length ? (
          rows.map(({ question, saved }) => {
            const editing = action.kind === "answer" && currentAnswer?.questionId === question.id;
            const shown = editing
              ? replayAnswerAt(question, saved, amount)
              : replayAnswerAt(question, saved, 1);
            const savedConfirmed =
              saved?.state === "answered" &&
              saved.confirmation === "confirmed" &&
              !saved.needsReconfirmation;
            const committed =
              !editing && savedConfirmed && (action.kind !== "round_confirm" || confirmed);
            return (
              <div
                key={question.id}
                className={`replay-question-item ${editing ? "is-current" : ""}`}
              >
                <QuestionInput
                  question={question}
                  answer={shown}
                  onChange={() => {}}
                  disabled={false}
                  readOnly
                />
                <p
                  className="replay-answer-status"
                  data-confirmation={committed ? "confirmed" : "pending"}
                >
                  {editing && saved?.state === "answered"
                    ? amount < 0.75
                      ? "正在填写，待确认"
                      : "已填写，待确认"
                    : answerLabel(editing && amount < 0.45 ? undefined : saved, committed)}
                </p>
              </div>
            );
          })
        ) : summary ? (
          <dl className="replay-summary-answers">
            {summaryFields.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
            {!!action.summary?.assumptions.length && (
              <div>
                <dt>暂定假设，待核对</dt>
                <dd>{action.summary.assumptions.join("\n")}</dd>
              </div>
            )}
          </dl>
        ) : (
          <>
            <p className="replay-summary-source">
              这次操作未保存完整摘要，下面显示此前已回放的回答。
            </p>
            <dl className="replay-summary-answers">
              {rows.map(({ question, saved }) => (
                <div key={question.id}>
                  <dt>{question.title}</dt>
                  <dd>
                    {saved?.state === "answered"
                      ? Array.isArray(saved.value)
                        ? saved.value.join("、")
                        : saved.value
                      : answerLabel(saved, false)}
                  </dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </div>
      <footer className="replay-question-footer">
        <p role="status">
          {confirming && confirmed
            ? action.kind === "handoff"
              ? "交接记录已生成"
              : action.kind === "summary_submit"
                ? "摘要已提交，继续查漏"
                : action.kind === "summary_confirm"
                  ? "本次提交的摘要确认已接受"
                  : "本次确认已记录"
            : action.kind === "answer"
              ? amount < 0.75
                ? "正在填写，待确认"
                : "已填写，待确认"
              : "按记录回看本轮操作"}
        </p>
        {action.kind === "summary_confirm" || action.kind === "handoff" ? (
          <span className="replay-question-acknowledgement">
            {confirmed
              ? BUTTONS[action.kind]
              : action.kind === "handoff"
                ? "正在生成交接记录"
                : "正在接收摘要确认结果"}
          </span>
        ) : (
          <button
            type="button"
            disabled
            data-replay-confirm
            className={`primary-button ${confirming && confirmed ? "is-confirmed" : ""}`}
          >
            {BUTTONS[action.kind]}
          </button>
        )}
      </footer>
      <div ref={pointer} className="replay-question-pointer" aria-hidden="true">
        <MousePointer2 size={25} />
      </div>
    </section>
  );
}
