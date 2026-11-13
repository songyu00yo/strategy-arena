"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { MousePointer2 } from "lucide-react";
import type { IntakeAnswer, IntakeQuestion, RecordedAnswer } from "@/lib/intake-contracts";
import type { ReplayAction } from "@/lib/replay-contracts";
import { moveScroll } from "../motion-scroll";
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
const smooth = (amount: number) => {
  const value = bounded(amount);
  return value * value * (3 - 2 * value);
};
type Point = { x: number; y: number };

/** These durations use the shared clock's active elapsed time, including playback speed. */
export function replayPaperTiming(
  frame: PlaybackFrame,
  opening: boolean,
  closing: boolean,
  speed = 1,
  openingWindow = 1,
) {
  const rate = Math.max(1, speed);
  const foldStart = Math.max(frame.duration - PAPER_MOTION.fold * rate, frame.duration * 0.4);
  return {
    open:
      frame.settled || !opening
        ? 1
        : easeOut(
            frame.elapsed / Math.min(PAPER_MOTION.open * rate, frame.duration * openingWindow),
          ),
    fold:
      frame.settled || !closing
        ? 0
        : bounded((frame.elapsed - foldStart) / Math.max(1, frame.duration - foldStart)),
  };
}

/** One continuous transform carries the whole paper to the measured receiving card. */
export function replayReturnPose(
  progress: number,
  destination: NonNullable<ReturnType<typeof replayFlipGeometry>>,
  origin: Point & { scale: number } = { x: 0, y: 0, scale: 1 },
) {
  const amount = smooth(progress);
  const scale = Math.min(0.38, Math.max(0.12, destination.scaleX * 0.72));
  return {
    x: origin.x + (destination.x - origin.x) * amount,
    y: origin.y + (destination.y - origin.y) * amount,
    scale: origin.scale + (scale - origin.scale) * amount,
    opacity: 1 - smooth((progress - 0.62) / 0.38),
    contentOpacity: 1 - smooth((progress - 0.15) / 0.55),
  };
}

/** A curved approach starts and finishes at rest on the actual control. */
export function replayPointerAt(origin: Point, target: Point, progress: number): Point {
  const amount = smooth(progress);
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

/** Spread clicks through the visible action so the cursor can travel between controls. */
export function replayChoiceTimes(count: number) {
  if (count <= 1) return [0.45];
  return Array.from({ length: count }, (_, index) => 0.22 + (index * 0.52) / (count - 1));
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
  return crossesClip && fold > 0 && fold < 1 && !frame.settled;
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
  if (!saved) return empty;
  if (saved.state !== "answered")
    return progress >= 0.45 ? { ...empty, state: saved.state } : empty;
  if (Array.isArray(saved.value)) {
    const clicks = replayChoiceTimes(saved.value.length);
    return { ...empty, value: saved.value.filter((_, index) => progress >= clicks[index]) };
  }
  if (progress < 0.32) return empty;
  const entered = bounded((progress - 0.45) / 0.3);
  if (question.type === "single") return { ...empty, value: progress >= 0.45 ? saved.value : "" };
  const glyphs = Array.from(saved.value);
  const typed = Math.min(1, Math.ceil(entered * 6) / 6);
  return { ...empty, value: glyphs.slice(0, Math.ceil(typed * glyphs.length)).join("") };
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
  returnsToStage,
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
  returnsToStage?: boolean;
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
  const followScroll = useRef<(() => void) | null>(null);
  const playbackRate = useRef(speed);
  useLayoutEffect(() => {
    playbackRate.current = speed;
  }, [speed]);

  useLayoutEffect(() => {
    const element = root.current;
    const viewport = body.current;
    const cursor = pointer.current;
    const stage = element?.closest<HTMLElement>(".c-stage3");
    if (!element || !viewport || !cursor || !stage) return;
    const opening = action.kind === "questions" || action.kind === "summary_submit";
    const closing = returnsToStage ?? ["round_confirm", "handoff"].includes(action.kind);
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Latch the selected rate per action, preserving the return pose if speed changes mid-flight.
    const returnRate = playbackRate.current;
    const board = stage.querySelector<HTMLElement>(
      action.kind === "handoff" ? '[data-board="C"]' : '[data-board="B"]',
    );
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
      transferOutside: boolean;
      sheetStyles: Array<[string, string]>;
      content: HTMLElement[];
      shadow: HTMLElement | null;
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
      node: HTMLElement;
      content: HTMLElement[];
    } | null = null;
    let nativeReturn: {
      scope: ReturnType<typeof createMotionScope>;
      transform: Animation;
      parts: Animation[];
      duration: number;
      start: number;
      rate: number;
      started: boolean;
      running: boolean;
    } | null = null;
    const clearTransfer = () => {
      transfer?.scope.dispose();
      transfer = null;
      element.style.opacity = "1";
      element.dataset.stripOwner = "local";
    };
    const clickTimes = userConfirmation ? [0.4] : replayChoiceTimes(choices.length);

    const localSignature = (frame: PlaybackFrame) => {
      if (action.kind === "questions") return activeStepId;
      if (action.kind !== "answer") return `${activeStepId}:${frame.progress >= 0.8}`;
      const shown = targetQuestion
        ? replayAnswerAt(targetQuestion, currentAnswer, frame.progress)
        : null;
      return JSON.stringify([activeStepId, shown?.state, shown?.value, frame.progress >= 0.75]);
    };

    const paint = (frame: PlaybackFrame) => {
      if (!cache || frame.stepId !== activeStepId) return;
      const paper = replayPaperTiming(
        frame,
        opening,
        closing,
        returnRate,
        action.kind === "summary_submit" ? 0.25 : 1,
      );
      const open = reducedMotion ? 1 : paper.open;
      const handoff = action.kind === "handoff";
      let fold =
        reducedMotion || !cache.destination || frame.settled
          ? 0
          : handoff
            ? bounded(frame.elapsed / frame.duration)
            : paper.fold;
      if (frame.settled && nativeReturn) {
        nativeReturn.scope.dispose();
        nativeReturn = null;
      }
      if (nativeReturn && fold > 0 && !nativeReturn.started && frame.running && !motionPaused()) {
        const offset = Math.max(0, frame.elapsed - nativeReturn.start);
        for (const part of nativeReturn.parts) {
          part.playbackRate = playbackRate.current;
          part.currentTime = offset;
          part.play();
        }
        nativeReturn.started = true;
        nativeReturn.running = true;
        nativeReturn.rate = playbackRate.current;
      }
      if (nativeReturn?.started) {
        const running = frame.running && !motionPaused();
        if (nativeReturn.rate !== playbackRate.current) {
          for (const part of nativeReturn.parts) part.updatePlaybackRate(playbackRate.current);
          nativeReturn.rate = playbackRate.current;
        }
        if (nativeReturn.running !== running) {
          for (const part of nativeReturn.parts) {
            if (!running) part.pause();
            else if (part.playState !== "finished") part.play();
          }
          nativeReturn.running = running;
        }
        const time = nativeReturn.transform.currentTime;
        if (typeof time === "number") fold = bounded(time / nativeReturn.duration);
      }
      const destination = cache.destination;
      const source = cache.source;
      const returning = destination
        ? replayReturnPose(
            fold,
            destination,
            handoff && source
              ? { x: source.x, y: source.y, scale: Math.min(0.85, source.scaleX * 0.8) }
              : undefined,
          )
        : null;
      const x = (source?.x ?? 0) * (1 - open) + (returning?.x ?? 0);
      const y = (source?.y ?? 0) * (1 - open) + (returning?.y ?? 0);
      const scaleX = (1 + ((source?.scaleX ?? 1) - 1) * (1 - open)) * (returning?.scale ?? 1);
      const scaleY = (1 + ((source?.scaleY ?? 1) - 1) * (1 - open)) * (returning?.scale ?? 1);
      let scroll = cache.scroll;
      let scrollPhase: ReplayScrollPhase = frame.running ? "reading" : "paused";
      if (frame.running && action.kind === "questions" && returnRate < 1) {
        const reading = replayReadingState(frame.progress, cache.stops, cache.range);
        scroll = reading.top;
        scrollPhase = reading.phase;
      }
      const clickIndex = choices.length
        ? Math.min(
            choices.length - 1,
            clickTimes.filter(
              (at) =>
                frame.elapsed >= at * frame.duration + Math.min(30, PAPER_MOTION.feedback / 4),
            ).length,
          )
        : 0;
      const target = cache.targets[clickIndex];
      const previousTarget = clickIndex > 0 ? cache.targets[clickIndex - 1] : null;
      const moveStart =
        userConfirmation || clickIndex === 0
          ? (userConfirmation ? 0.08 : choices.length > 1 ? 0.03 : 0.15) * frame.duration
          : Math.min(
              clickTimes[clickIndex - 1] * frame.duration + Math.min(30, PAPER_MOTION.feedback / 4),
              clickTimes[clickIndex] * frame.duration,
            );
      const moveEnd = (userConfirmation ? 0.34 : clickTimes[clickIndex]) * frame.duration;
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
        const eased = smooth(movement);
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
      const carry = cache.transferOutside && replayHandoffActive(frame, fold, true);

      // Geometry was read during refresh. All frame writes follow the completed calculation.
      const nativeMoving = nativeReturn?.started === true;
      if (!nativeMoving)
        element.style.transform =
          "translate3d(" + x + "px," + y + "px,0) scale(" + scaleX + "," + scaleY + ")";
      if (cache.shadow) cache.shadow.style.opacity = String(1 - open);
      if (!nativeMoving)
        for (const content of cache.content)
          content.style.opacity = String(returning?.contentOpacity ?? 1);
      element.dataset.replayOpened = String(open >= 1);
      element.dataset.replayFold = fold.toFixed(3);
      element.dataset.replayPhase =
        frame.progress < 0.2 ? "show" : frame.progress < 0.8 ? "answer" : "settle";
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
      if (transfer && !nativeMoving) {
        const node = transfer.node;
        node.style.opacity = document.hidden
          ? "0"
          : carry
            ? String(returning?.opacity ?? 1)
            : "0.001";
        node.style.transform =
          "translate3d(" + x + "px," + y + "px,0) scale(" + scaleX + "," + scaleY + ")";
        for (const content of transfer.content)
          content.style.opacity = String(returning?.contentOpacity ?? 1);
      }
      if (!nativeMoving || transfer)
        element.style.opacity = carry ? "0" : String(returning?.opacity ?? 1);
      element.dataset.stripOwner = carry ? "body" : "local";
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
      if (disposed || nativeReturn?.started) return;
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
        "font-size",
        "font-weight",
        "line-height",
        "letter-spacing",
        "text-align",
        "color",
        "background",
        "border",
        "border-radius",
        "box-shadow",
        "padding",
      ].map((property): [string, string] => [property, sheetStyle.getPropertyValue(property)]);
      const visibleSource =
        !!sourceBox &&
        sourceBox.width > 0 &&
        sourceBox.height > 0 &&
        sourceBox.right > Math.max(0, stageBox.left) &&
        sourceBox.left < Math.min(innerWidth, stageBox.right) &&
        sourceBox.bottom > Math.max(0, stageBox.top) &&
        sourceBox.top < Math.min(innerHeight, stageBox.bottom);
      // The final receipt starts at C even when C is outside the current viewport.
      // Scrolling must not switch its origin between the board and the stage plane.
      const useBoardSource =
        visibleSource || (action.kind === "handoff" && !!sourceBox?.width && !!sourceBox.height);
      const source = replayFlipGeometry(
        useBoardSource && sourceBox ? sourceBox : stageBox,
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
        transferOutside:
          action.kind === "handoff" && !!receiverBox && replayHandoffOutside(receiverBox, stageBox),
        sheetStyles,
        content: [
          ...element.querySelectorAll<HTMLElement>(
            ":scope > header, :scope > .replay-question-body, :scope > footer",
          ),
        ],
        shadow: element.querySelector<HTMLElement>(":scope > .replay-paper-shadow"),
      };
      // Prepare the final handoff before movement starts. Its geometry stays out of frame writes.
      if (closing && cache.transferOutside) {
        if (!transfer) {
          const scope = createMotionScope();
          const context = scope.own(document.createElement("div"));
          context.className = "console-shell";
          context.style.display = "contents";
          context.setAttribute("aria-hidden", "true");
          context.inert = true;
          const node = element.cloneNode(true) as HTMLElement;
          node.className = `replay-handoff-strip guided-intake ${action.kind === "handoff" ? "is-handoff" : ""}`;
          node.dataset.replayHandoffFor = activeStepId;
          node.querySelector(".replay-question-pointer")?.remove();
          node.querySelectorAll("[id]").forEach((child) => child.removeAttribute("id"));
          context.appendChild(node);
          document.body.appendChild(context);
          transfer = {
            scope,
            node,
            content: [
              ...node.querySelectorAll<HTMLElement>(
                ":scope > header, :scope > .replay-question-body, :scope > footer",
              ),
            ],
          };
        }
        const node = transfer.node;
        cache.sheetStyles.forEach(([property, value]) => node.style.setProperty(property, value));
        Object.assign(node.style, {
          left: cache.sheet.left - scrollX + "px",
          top: cache.sheet.top - scrollY + "px",
          width: width + "px",
          height: height + "px",
        });
        const footer = node.querySelector("footer");
        const sourceFooter = element.querySelector("footer");
        if (footer && sourceFooter)
          footer.replaceChildren(
            ...[...sourceFooter.childNodes].map((child) => child.cloneNode(true)),
          );
        const carriedBody = node.querySelector<HTMLElement>(".replay-question-body");
        if (carriedBody) carriedBody.scrollTop = viewport.scrollTop;
      }
      // Prepare idle compositor effects while the sheet is still being read. Once started,
      // the browser owns the entire return, including frames where React is busy.
      if (closing && destination && !reducedMotion && !frameRef.current.settled) {
        nativeReturn?.scope.dispose();
        const scope = createMotionScope();
        const start =
          action.kind === "handoff"
            ? 0
            : Math.max(duration - PAPER_MOTION.fold * Math.max(1, returnRate), duration * 0.4);
        const span = duration - start;
        const returnOrigin =
          action.kind === "handoff" && source
            ? { x: source.x, y: source.y, scale: Math.min(0.85, source.scaleX * 0.8) }
            : undefined;
        const from = replayReturnPose(0, destination, returnOrigin);
        const to = replayReturnPose(1, destination, returnOrigin);
        const easing = "cubic-bezier(.3333333333,0,.6666666667,1)";
        const transformFrames = [from, to].map((pose) => ({
          transform: `translate3d(${pose.x}px,${pose.y}px,0) scale(${pose.scale})`,
        }));
        const options: KeyframeAnimationOptions = { duration: span, fill: "both" };
        const transform = scope.prepare(transfer?.node ?? element, transformFrames, {
          ...options,
          easing,
        });
        const parts = [transform];
        if (transfer) parts.push(scope.prepare(element, transformFrames, { ...options, easing }));
        parts.push(
          scope.prepare(
            transfer?.node ?? element,
            [{ opacity: 1, offset: 0 }, { opacity: 1, offset: 0.62, easing }, { opacity: 0 }],
            options,
          ),
        );
        for (const content of [...cache.content, ...(transfer?.content ?? [])]) {
          parts.push(
            scope.prepare(
              content,
              [
                { opacity: 1, offset: 0 },
                { opacity: 1, offset: 0.15, easing },
                { opacity: 0, offset: 0.7 },
                { opacity: 0, offset: 1 },
              ],
              options,
            ),
          );
        }
        nativeReturn = {
          scope,
          transform,
          parts,
          duration: span,
          start,
          rate: playbackRate.current,
          started: false,
          running: false,
        };
      }
      origin ??= headingPoint;
      // Attribution is observable in browser evidence, including every fallback.
      element.dataset.flipOrigin = source
        ? useBoardSource
          ? action.kind === "handoff"
            ? "board-c"
            : "board-b"
          : "stage-plane"
        : "unavailable";
      element.dataset.flipFallback = useBoardSource
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
      if (transfer) {
        transfer.node.style.left = cache.sheet.left - scrollX + "px";
        transfer.node.style.top = cache.sheet.top - scrollY + "px";
      }
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
      nativeReturn?.scope.dispose();
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
    returnsToStage,
    targetQuestion,
    timeline,
    userConfirmation,
  ]);

  useLayoutEffect(() => refresh.current(), [activeStepId, confirmed]);

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
      (previous.playing && !playing) ||
      (!previous.seeking && seeking) ||
      (activePlaying && previous.speed !== speed);
    followed.current = { id: action.id, playing: activePlaying, seeking, speed };
    if (!shouldFollow) return;
    if (action.kind === "handoff") {
      followScroll.current?.();
      followScroll.current = null;
      return;
    }
    const element = root.current;
    if (!element) return;
    const page = layoutPoint(element);
    const viewport = window.visualViewport;
    const top = (viewport?.offsetTop ?? 0) + 12;
    const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight) - 12;
    if (page.y - scrollY < top || page.y - scrollY + element.offsetHeight > bottom) {
      // Navigation uses the interaction clock. Pausing the recorded answer keeps
      // its pose while the window finishes bringing that paper into reading view.
      followScroll.current = moveScroll(
        window,
        { left: scrollX, top: Math.max(0, page.y - top) },
        { duration: 240, onFinish: () => refresh.current() },
      );
    } else {
      followScroll.current?.();
      followScroll.current = null;
    }
  }, [action.id, action.kind, playing, seeking, speed]);
  useLayoutEffect(() => () => followScroll.current?.(), []);

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
      className={`replay-question-scene guided-intake ${action.kind === "handoff" ? "is-handoff" : ""} ${playing ? "is-playing" : ""} ${seeking ? "is-seeking" : ""}`}
      aria-label="补问过程回放"
      data-replay-action={action.kind}
      data-replay-phase={phase}
    >
      <div className="replay-paper-shadow" aria-hidden="true" />
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
