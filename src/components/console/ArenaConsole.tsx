"use client";
import { moveScroll, revealInWindow } from "@/components/motion-scroll";
import { readableClaimText } from "@/components/claim-label";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  startTransition,
  addTransitionType,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  STAGES,
  type ArenaEvent,
  type ArenaStep,
  type ArenaVersion,
  type Attack,
  type Strategy,
} from "@/lib/contracts";
import { attackMeta } from "@/components/status";
import type { StepContext } from "@/lib/step-context";
import type { ReplayAction } from "@/lib/replay-contracts";
import { projectReplay } from "@/lib/replay";
import { verdictLabel } from "@/lib/verdict-label";
import { Chars, reducedMotion, ROUTE_COLOR, Roll } from "./effects";
import { RecordWall, VerdictFilm } from "./fx";
import { RouteChart } from "./RouteChart";
import { RouteStage, captureStageText, type StageTextTransition } from "./RouteStage";
import { StepCard } from "./StepCard";
import { ResultRegion } from "./ResultRegion";
import { acquireMotionHold, createMotionScope, motionNow, useMotionPaused } from "./motion-runtime";
import "./console-motion.css";
import { beatName, beatsOf, clock, nameOf, stageName, usageOf } from "./beats";
import { playbackCommitAt, playbackDuration, usePlaybackProgress } from "./use-playback-progress";
import "./replay-console.css";

/** Joins sentences without doubling their end marks. */
const listOf = (items: string[]) => items.map((item) => item.replace(/[。；;.]+$/, "")).join("；");

const METRIC_STATE: Record<string, string> = {
  成立: "supported",
  已反驳: "refuted",
  未决: "unresolved",
};

/** How long each kind of step holds the screen during a film. */
const SHOT_MS = { propose: 2600, attack: 3200, verify: 3000, revise: 2600, judge: 4200 };
const SPEEDS = [
  { value: 1, label: "常速" },
  { value: 0.6, label: "慢速" },
  { value: 1.8, label: "快速" },
];

const OUTCOME = {
  recommendation: "当前条件下的建议",
  tie: "几条路线各有适用条件",
  insufficient: "现有依据不足以判断",
  infeasible: "当前条件下无法成立",
  partial: "阶段性判断",
};

function recordedEventTime(event: ArenaEvent) {
  const data = event.data as { createdAt?: unknown } | null;
  return typeof data?.createdAt === "string" ? data.createdAt : event.createdAt;
}

export function ArenaConsole({
  version,
  steps,
  events,
  demo,
  slate,
  notices,
  conditions,
  agent,
  drafts,
  selectedAttack,
  historical,
  startFromBeginning = false,
  replayActions,
  allowRecordedChallenges = false,
  busy,
  onEvidence,
  onClaim,
  onFollowUp,
  onAdjustConditions,
}: {
  version: ArenaVersion;
  steps: ArenaStep[];
  events: ArenaEvent[];
  demo: boolean;
  slate: React.ReactNode;
  notices: React.ReactNode;
  conditions: React.ReactNode;
  /** The agent's plan and action chain: its own band, so it never pushes the stage around. */
  agent?: React.ReactNode;
  /** Live and archived draft text: kept in the rail with its own scroll. */
  drafts?: React.ReactNode;
  selectedAttack?: string;
  historical: boolean;
  startFromBeginning?: boolean;
  replayActions?: readonly ReplayAction[];
  allowRecordedChallenges?: boolean;
  busy: boolean;
  onEvidence: (attack: Attack) => void;
  onClaim: (strategy: Strategy, claimId: string) => void;
  onFollowUp?: (context: StepContext, trigger: HTMLElement | null) => void;
  onAdjustConditions?: (trigger: HTMLElement | null) => void;
}) {
  const beats = useMemo(() => beatsOf(version, replayActions), [version, replayActions]);
  const clarification = version.workflow === "clarification" ? version.clarification : undefined;
  const exportClarification = () => {
    if (!clarification?.specification.trim() || !clarification.executionPrompt.trim()) return;
    const markdown = `${clarification.specification}\n\n---\n\n# 执行提示词\n\n${clarification.executionPrompt}`;
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `方案擂台-${clarification.draftOnly ? "需求草稿" : "正式需求"}-${version.id}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const last = beats.length - 1;
  const [cursor, setCursor] = useState<number | null>(startFromBeginning ? -1 : null);
  const [playing, setPlaying] = useState(startFromBeginning);
  const [speed, setSpeed] = useState(1);
  const [intro, setIntro] = useState(startFromBeginning);
  const [revealed, setRevealed] = useState(false);
  const [motion, setMotion] = useState(startFromBeginning);
  const [seeking, setSeeking] = useState(false);
  const [playbackPaused, setPlaybackPaused] = useState(false);
  const [filmDone, setFilmDone] = useState(false);
  const [stepwise, setStepwise] = useState(false);
  const [wholeResult, setWholeResult] = useState(false);
  const [openStep, setOpenStep] = useState<number | null>(null);
  const [seekRevision, setSeekRevision] = useState(0);
  const [railInteraction, setRailInteraction] = useState(false);
  const railState = useRef({ hover: false, keyboard: false, pressing: false, touch: false });
  const railRelease = useRef<ReturnType<typeof createMotionScope> | null>(null);
  const seekIntent = useRef({ epoch: 0, pending: 0 });
  const pausedOnPointerDown = useRef(false);
  const [stageTransition, setStageTransition] = useState<StageTextTransition | null>(null);
  const renderedEpoch = seekIntent.current.epoch;
  const paused = useMotionPaused();
  useEffect(() => () => railRelease.current?.dispose(), []);
  const updateRailInteraction = () => {
    const state = railState.current;
    setRailInteraction(state.hover || state.keyboard || state.touch);
  };
  const cancelRailRelease = () => {
    railRelease.current?.dispose();
    railRelease.current = null;
    railState.current.touch = false;
  };
  const beginRailPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    cancelRailRelease();
    const state = railState.current;
    state.pressing = true;
    state.keyboard = false;
    state.hover = event.pointerType !== "touch";
    state.touch = event.pointerType === "touch";
    updateRailInteraction();
  };
  const endRailPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary) return;
    const state = railState.current;
    state.pressing = false;
    if (event.type === "pointercancel") state.hover = false;
    if (event.pointerType === "touch") {
      cancelRailRelease();
      state.touch = true;
      const scope = createMotionScope("interaction");
      railRelease.current = scope;
      scope.later(160, () => {
        state.touch = false;
        railRelease.current = null;
        scope.dispose();
        updateRailInteraction();
      });
    }
    updateRailInteraction();
  };
  const nowPanel = useRef<HTMLElement>(null);
  const resultPanel = useRef<HTMLElement>(null);
  const consoleRoot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = consoleRoot.current;
    if (!root || root.dataset.shellEntered === "true") return;
    const hud = root.querySelector(":scope > .c-hud");
    const rail = root.querySelector(":scope > .c-hud > .c-main > .c-rail");
    const title = root.querySelector(":scope > .c-hud > .c-slate h1");
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const entranceNames = new Set([
      "c-console-enter",
      "c-hud-enter",
      "c-drop",
      "band-in",
      "band-up",
    ]);
    const isShellEntrance = (name: string, target: EventTarget | null, pseudo: string | null) => {
      if (name === "band-side") return target === rail && !pseudo;
      if (name === "rule-draw") return target === title && pseudo === "::after";
      return (
        entranceNames.has(name) &&
        !pseudo &&
        (target === root || (target instanceof Element && target.parentElement === hud))
      );
    };
    const settleEntrance = () => {
      const active = root.getAnimations({ subtree: true }).some((animation) => {
        if (!(animation instanceof CSSAnimation)) return false;
        const effect = animation.effect instanceof KeyframeEffect ? animation.effect : null;
        return (
          isShellEntrance(
            animation.animationName,
            effect?.target ?? null,
            effect?.pseudoElement ?? null,
          ) &&
          (animation.pending ||
            animation.playState === "running" ||
            animation.playState === "paused")
        );
      });
      if (preference.matches || !active) root.dataset.shellEntered = "true";
    };
    const onEntranceEnd = (event: AnimationEvent) => {
      if (isShellEntrance(event.animationName, event.target, event.pseudoElement)) settleEntrance();
    };
    root.addEventListener("animationend", onEntranceEnd);
    root.addEventListener("animationcancel", onEntranceEnd);
    preference.addEventListener("change", settleEntrance);
    settleEntrance();
    return () => {
      root.removeEventListener("animationend", onEntranceEnd);
      root.removeEventListener("animationcancel", onEntranceEnd);
      preference.removeEventListener("change", settleEntrance);
    };
  }, []);
  const index = cursor === null ? last : Math.min(cursor, last);
  const current = index >= 0 ? beats[index] : null;
  const shown = useMemo(() => beats.slice(0, index + 1), [beats, index]);
  const repairedRunIds = useMemo(
    () =>
      new Set(
        shown.flatMap(({ clarificationRun: repair }) => {
          const failed = shown.find(
            ({ clarificationRun }) => clarificationRun?.id === repair?.repairOf,
          )?.clarificationRun;
          return repair?.status === "completed" &&
            failed?.status === "failed" &&
            failed.role === repair.role &&
            failed.round === repair.round &&
            failed.basedOnRevision === repair.basedOnRevision
            ? [failed.id]
            : [];
        }),
      ),
    [shown],
  );
  const seen = new Set(shown.map((b) => b.id));
  const live = version.status === "running" || version.status === "ready";
  const advanceReplay = useCallback(() => {
    if (seekIntent.current.pending || renderedEpoch !== seekIntent.current.epoch) return;
    if (index < last) return setCursor(index + 1);
    if (live) return;
    if (current?.replayAction?.kind === "handoff" && !filmDone) return;
    setPlaying(false);
    setMotion(false);
    setCursor(null);
  }, [index, last, live, current?.replayAction?.kind, filmDone, renderedEpoch]);
  const { progress: replayProgress, timeline: replayTimeline } = usePlaybackProgress({
    stepId: clarification ? (current?.id ?? "") : "",
    duration: playbackDuration(current),
    commitAt: playbackCommitAt(current),
    speed,
    running:
      !!clarification &&
      playing &&
      !paused &&
      openStep === null &&
      (!intro || revealed) &&
      !stepwise,
    settled: seeking || stepwise || (cursor === null && !playing),
    queueRevision: `${last}:${live}`,
    onComplete: advanceReplay,
  });
  const committed = replayProgress >= 0.8;
  const projection = useMemo(
    () => (clarification ? projectReplay(version, beats, index, events, committed ? 1 : 0) : null),
    [clarification, version, beats, index, events, committed],
  );
  useLayoutEffect(() => {
    if (!clarification) return;
    const update = (frame: ReturnType<typeof replayTimeline.read>) => {
      if (frame.stepId === current?.id && consoleRoot.current)
        consoleRoot.current.dataset.replayProgress = frame.progress.toFixed(4);
    };
    update(replayTimeline.read());
    return replayTimeline.subscribe(update);
  }, [clarification, current?.id, replayTimeline, replayProgress]);
  const reviewMessages = projection
    ? [...new Set([...projection.conflicts, ...projection.unresolved])]
    : [];
  const answersBefore = useMemo(
    () => (clarification ? projectReplay(version, beats, index - 1).answers : []),
    [version, beats, index, clarification],
  );

  // A game in progress plays out as its results arrive. A finished game opens on its result.
  const startedLive = useRef(live);
  useEffect(() => {
    if (!startedLive.current || reducedMotion()) return;
    const frame = requestAnimationFrame(() => {
      if (!startedLive.current || seekIntent.current.pending) return;
      setMotion(true);
      setCursor(0);
      setPlaying(true);
      try {
        if (!sessionStorage.getItem("arena-intro")) setIntro(true);
      } catch {
        // Without session storage the opening simply does not play.
      }
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const reveal = useCallback(() => {
    setRevealed(true);
    if (startFromBeginning) setCursor((cursor) => (cursor === -1 ? 0 : cursor));
  }, [startFromBeginning]);
  const endFilm = useCallback(() => {
    if (seekIntent.current.pending || renderedEpoch !== seekIntent.current.epoch) return;
    setFilmDone(true);
    if (clarification && current?.replayAction?.kind === "handoff") {
      setPlaying(false);
      setMotion(false);
      setCursor(null);
    }
  }, [clarification, current?.replayAction?.kind, renderedEpoch]);
  const endIntro = useCallback(() => {
    setIntro(false);
    try {
      sessionStorage.setItem("arena-intro", "1");
    } catch {
      // Nothing to remember it in.
    }
  }, []);
  // The opening happens on the page itself, never over it: the bands are printed in from the
  // top, then the boards are raised. Nothing covers the whole screen.
  useEffect(() => {
    if (!intro) return;
    const quick = reducedMotion();
    const raise = setTimeout(reveal, quick ? 0 : 520);
    const settle = setTimeout(endIntro, quick ? 0 : 2000);
    return () => {
      clearTimeout(raise);
      clearTimeout(settle);
    };
  }, [intro, reveal, endIntro]);

  const stage = current?.stage;
  // The first step of a stage waits for its word to land, so the two never collide.
  const firstOfStage = !!stage && stage !== "judge" && beats[index - 1]?.stage !== stage;
  const lead = (clarification || playing) && !seeking && firstOfStage ? 560 / speed : 0;
  // Count only active playback time. Data refreshes and overlays must not spend the remaining shot.
  const shotClock = useRef({ id: "", elapsed: 0 });
  useLayoutEffect(() => {
    if (playbackPaused) return acquireMotionHold();
  }, [playbackPaused]);
  useEffect(() => {
    if (clarification) return;
    if (!playing || !stage || paused || openStep !== null || (intro && !revealed)) return;
    if (stepwise && index < last) return;
    const id = current?.id ?? "";
    if (shotClock.current.id !== id) shotClock.current = { id, elapsed: 0 };
    const clock = shotClock.current;
    const began = motionNow();
    const backlog = last - index;
    const full = SHOT_MS[stage] + (firstOfStage ? 560 : 0);
    const hold =
      backlog > 0 && startedLive.current ? Math.max(650, full / (1 + backlog * 0.5)) : full;
    const timerEpoch = seekIntent.current.epoch;
    const timer = setTimeout(
      () => {
        if (seekIntent.current.pending || timerEpoch !== seekIntent.current.epoch) return;
        if (index < last) return setCursor(live || index + 1 < last ? index + 1 : null);
        if (live) return;
        setPlaying(false);
        setMotion(false);
        setCursor(null);
      },
      Math.max(0, hold - clock.elapsed) / speed,
    );
    return () => {
      clearTimeout(timer);
      clock.elapsed += (motionNow() - began) * speed;
    };
  }, [
    playing,
    current?.id,
    index,
    last,
    stage,
    speed,
    live,
    intro,
    revealed,
    firstOfStage,
    stepwise,
    openStep,
    paused,
    clarification,
  ]);

  const goTo = useCallback(
    (i: number) => {
      const target = Math.max(0, Math.min(i, last));
      if (last < 0 || (target === index && !seekIntent.current.pending)) return;
      const epoch = ++seekIntent.current.epoch;
      seekIntent.current.pending = epoch;
      const capturedStage = captureStageText(consoleRoot.current, epoch);
      startedLive.current = false;
      const keepPlaying = playing && stepwise && target === index + 1 && target < last;
      // The old playback may finish while React prepares the next paper snapshot.
      // Its captured epoch cannot replace this explicitly requested destination.
      startTransition(() => {
        addTransitionType("arena-seek");
        const latest = () => epoch === seekIntent.current.epoch;
        setIntro((value) => (latest() ? false : value));
        setPlaying((value) => (latest() ? keepPlaying : value));
        setPlaybackPaused((value) => (latest() ? false : value));
        setSeeking((value) => (latest() ? true : value));
        setMotion((value) => (latest() ? true : value));
        setFilmDone((value) => (latest() ? true : value));
        setCursor((value) => (latest() ? (target >= last ? null : target) : value));
        setStageTransition((value) => (latest() ? capturedStage : value));
        setSeekRevision((value) => (latest() ? epoch : value));
      });
      shotClock.current = { id: "", elapsed: 0 };
    },
    [last, index, playing, stepwise],
  );
  useLayoutEffect(() => {
    if (!seekRevision || seekIntent.current.pending !== seekRevision) return;
    // Leave the guard through the current frame, including any old completion callback.
    const frame = requestAnimationFrame(() => {
      if (seekIntent.current.pending === seekRevision) seekIntent.current.pending = 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [seekRevision]);
  const replay = useCallback(() => {
    if (seekIntent.current.pending) {
      seekIntent.current.epoch++;
      seekIntent.current.pending = 0;
    }
    startedLive.current = false;
    if (playing) {
      setPlaybackPaused(true);
      return setPlaying(false);
    }
    setPlaybackPaused(false);
    setSeeking(false);
    setMotion(true);
    if (!playbackPaused) setFilmDone(false);
    if (index >= last && !playbackPaused) {
      shotClock.current = { id: "", elapsed: 0 };
      setCursor(0);
    }
    setPlaying(true);
  }, [playing, index, last, playbackPaused]);

  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement;
      if (
        target?.closest?.(
          "input, textarea, select, dialog, .evidence-drawer, .c-result-region, .c-conditions",
        )
      )
        return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        goTo(index + 1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goTo(index - 1);
      } else if (e.key === "End" || e.key === "G") {
        e.preventDefault();
        goTo(last);
      } else if (e.key === "Home") {
        e.preventDefault();
        goTo(0);
      } else if (e.key === " " && target?.tagName !== "BUTTON") {
        e.preventDefault();
        replay();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [goTo, index, last, replay]);

  // A replay reveals the log in step with the boards. Nothing is invented for the gap.
  const logged = projection
    ? projection.logs
    : index >= last
      ? events
      : events.slice(0, Math.ceil(((index + 1) / Math.max(beats.length, 1)) * events.length));
  const used = logged.flatMap((e) => usageOf(e) ?? []);
  const attacks = shown.filter((b) => b.stage === "attack" && b.attack).map((b) => b.attack!);
  const checked = attacks.filter((a) => seen.has(`v:${a.id}`));
  const count = (status: Attack["status"]) => checked.filter((a) => a.status === status).length;
  const tokens = used.reduce((t, u) => t + u.inputTokens + u.outputTokens, 0);
  const peak = Math.max(1, ...used.map((u) => u.inputTokens + u.outputTokens));
  const verdict = version.verdict;
  const hasResult = !!verdict || !!clarification;
  const directed = motion;
  // The result takes the lead once the game has reached it. Looking back at a step hides it.
  const atResult =
    hasResult &&
    index === last &&
    (!projection || (projection.handoffComplete && replayProgress === 1));
  useEffect(() => {
    if (!clarification || !atResult || playing) return;
    const frame = requestAnimationFrame(() => {
      const panel = resultPanel.current;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      if (rect.top < 16 || rect.top + Math.min(rect.height, 120) > innerHeight - 16)
        revealInWindow(panel, { block: "start", duration: 300 });
    });
    return () => cancelAnimationFrame(frame);
  }, [clarification, atResult, playing]);
  // Looking back over a finished game, each step shows how it turned out.
  const reviewing = hasResult && !live && !playing;
  const canReturn = hasResult && index < last && !playing;
  const speedLabel = SPEEDS.find((s) => s.value === speed)?.label ?? "常速";
  // Counts roll when the energy reaches them, not before.
  const rollDelay =
    !directed || clarification
      ? 0
      : stage === "attack"
        ? lead + 980 / speed
        : stage === "verify"
          ? lead + 1280 / speed
          : 0;
  const hasCallIds = clarification?.runs.every((run) => run.callIds !== undefined);
  const metrics: [string, number, string][] = clarification
    ? [
        [
          "事项",
          projection!.items.filter((item) => !projection!.retiredIds.includes(item.id)).length,
          "",
        ],
        [
          "已确认",
          projection!.answers.filter(
            (answer) =>
              answer.state === "answered" &&
              answer.confirmation === "confirmed" &&
              !answer.needsReconfirmation,
          ).length,
          "ok",
        ],
        ["已排除", projection!.retiredIds.length, ""],
        ["需核对", reviewMessages.length, "warn"],
        [hasCallIds ? "模型调用" : "角色记录", projection!.calls, ""],
        ["Token", projection!.tokens, ""],
      ]
    : [
        ["质疑", attacks.length, ""],
        ["成立", count("supported"), "bad"],
        ["已反驳", count("refuted"), "ok"],
        ["未决", attacks.length - count("supported") - count("refuted"), "warn"],
        [demo ? "演示调用" : startFromBeginning ? "原记录调用" : "模型调用", used.length, ""],
        [demo ? "Token（预设）" : startFromBeginning ? "原记录 Token" : "Token", tokens, ""],
      ];

  const timelineGroups = clarification
    ? [
        ...new Set(
          beats.map((beat) => beat.replayAction?.round ?? beat.clarificationRun?.round ?? 0),
        ),
      ].map((round) => {
        const list = beats.flatMap((beat, i) =>
          (beat.replayAction?.round ?? beat.clarificationRun?.round ?? 0) === round
            ? [{ b: beat, i }]
            : [],
        );
        return {
          key: String(round),
          label: `第 ${round} 轮`,
          list,
          done: list.every(({ i }) => i < index || (i === index && replayProgress === 1)),
          bad: list.some(
            ({ b, i }) =>
              i <= index &&
              (b.clarificationRun?.status === "failed" ||
                b.clarificationRun?.status === "uncertain") &&
              !repairedRunIds.has(b.clarificationRun.id),
          ),
          active: list.some(({ i }) => i === index),
        };
      })
    : STAGES.map((stage) => {
        const own = steps.filter((step) => step.stage === stage);
        const list = beats.flatMap((beat, i) => (beat.stage === stage ? [{ b: beat, i }] : []));
        return {
          key: stage,
          label: stageName(version, stage),
          list,
          done:
            own.length > 0 &&
            own.every((step) => step.status === "completed" || step.status === "skipped") &&
            (!startFromBeginning || list.every(({ i }) => i <= index)),
          bad: own.some((step) => step.status === "failed" || step.status === "uncertain"),
          active: current?.stage === stage,
        };
      });

  const timeline = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!clarification) return;
    const track = timeline.current;
    const selected = track?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!track || !selected) return;
    const target = selected.getBoundingClientRect();
    const box = track.getBoundingClientRect();
    if (target.left < box.left || target.right > box.right)
      moveScroll(
        track,
        { left: track.scrollLeft + target.left - box.left - box.width / 2 },
        { duration: 220 },
      );
  }, [clarification, index]);

  // Keep controls mounted. Interruptions start from the displayed pose, not the start keyframe.
  useLayoutEffect(() => {
    const nodes = [
      ...(nowPanel.current?.querySelectorAll<HTMLElement>(
        ":scope > .fl, :scope > .big, :scope > p",
      ) ?? []),
    ];
    if (!seeking || reducedMotion()) {
      nodes.forEach((node) => {
        node.style.opacity = "";
        node.style.transform = "";
      });
      return;
    }
    const scope = createMotionScope("interaction");
    const starts = nodes.map((node) => ({
      opacity: node.style.opacity || "0.35",
      transform: node.style.transform || "translateY(16px)",
    }));
    const animations = nodes.map((node, i) => {
      const animation = scope.animate(node, [starts[i], { opacity: 1, transform: "none" }], {
        duration: 560,
        easing: "cubic-bezier(.16,1,.3,1)",
        fill: "both",
      });
      animation.onfinish = () => {
        node.style.opacity = "";
        node.style.transform = "";
        animation.cancel();
      };
      return animation;
    });
    return () => {
      const displayed = nodes.map((node) => {
        const style = getComputedStyle(node);
        return { opacity: style.opacity, transform: style.transform };
      });
      animations.forEach((animation, i) => {
        const interrupted = animation.playState === "running";
        animation.cancel();
        if (interrupted) Object.assign(nodes[i].style, displayed[i]);
      });
      scope.dispose();
    };
  }, [current?.id, seeking]);

  return (
    <div
      ref={consoleRoot}
      data-motion-origin={seeking ? "interaction" : "story"}
      data-replay-kind={current?.replayAction?.kind ?? (clarification ? "model" : undefined)}
      data-replay-progress={clarification ? replayProgress.toFixed(3) : undefined}
      style={{ "--playback-speed": speed } as CSSProperties}
      className={`c-root ${clarification ? "clarification-replay" : ""} ${intro ? "opening" : ""} ${playing ? "theater" : ""} ${paused ? "held" : ""} ${seeking ? "is-seeking" : ""} ${atResult ? "at-result" : ""}`}
    >
      <RecordWall
        version={version}
        shown={shown}
        currentId={current?.id}
        events={logged}
        directed={directed && !seeking}
        replayProgress={replayProgress}
        replayAnswersVisible={projection?.answers}
        timeline={clarification ? replayTimeline : undefined}
      />
      <div className="c-hud">
        <div className="c-slate">{slate}</div>
        {hasResult && (
          <ResultRegion
            open={atResult}
            expanded={wholeResult}
            theater={!!clarification}
            speed={speed}
            holdSpace={railInteraction || paused}
          >
            <section
              ref={resultPanel}
              data-confirmation={
                clarification
                  ? projection?.handoffComplete
                    ? clarification.draftOnly
                      ? "draft"
                      : "confirmed"
                    : "pending"
                  : undefined
              }
              className={`c-result ${wholeResult ? "whole" : ""}`}
              aria-label="结论"
              id="verdict"
            >
              <div className="lead">
                <div className="tag">
                  <b
                    className={verdict?.preferred ? "pick" : "none"}
                    style={
                      verdict?.preferred
                        ? ({
                            "--route": ROUTE_COLOR[verdict.preferred].replaceAll(",", " "),
                          } as CSSProperties)
                        : undefined
                    }
                  >
                    {clarification
                      ? clarification.draftOnly
                        ? "需求草稿"
                        : "已确认"
                      : verdictLabel(verdict!)}
                  </b>
                  <span>
                    {clarification
                      ? clarification.draftOnly
                        ? "保留未决事项"
                        : "依据本版本确认记录"
                      : OUTCOME[verdict!.outcome]}
                  </span>
                </div>
                <h2>
                  {clarification
                    ? "需求说明与执行提示词"
                    : version.requirements
                      ? "已确认需求与执行提示词"
                      : readableClaimText(version, verdict!.headline)}
                </h2>
                <p style={clarification ? { whiteSpace: "pre-wrap" } : undefined}>
                  {clarification
                    ? wholeResult
                      ? clarification.specification
                      : "展开完整结论查看需求说明、未决事项和材料交接。"
                    : version.requirements
                      ? wholeResult
                        ? listOf(version.requirements.confirmed) || "当前要求尚待确认"
                        : `已确认 ${version.requirements.confirmed.length} 项要求，展开完整结论查看。`
                      : readableClaimText(version, verdict!.rationale)}
                </p>
              </div>
              <div className="act">
                <div className="first">
                  <small>
                    {clarification?.draftOnly
                      ? "交接草稿提示词"
                      : version.requirements || clarification
                        ? "执行提示词"
                        : "现在该做的第一步"}
                  </small>
                  <strong style={clarification ? { whiteSpace: "pre-wrap" } : undefined}>
                    {clarification
                      ? wholeResult
                        ? clarification.executionPrompt
                        : "展开完整结论查看本版本执行提示词"
                      : version.requirements
                        ? wholeResult
                          ? version.requirements.executionPrompt
                          : "展开完整结论查看本版本执行提示词"
                        : readableClaimText(version, verdict!.nextActions[0])}
                  </strong>
                </div>
                <dl>
                  <div>
                    <dt>
                      {version.requirements || clarification
                        ? "AI 建议及暂定假设（待确认）"
                        : "前提"}
                    </dt>
                    <dd>
                      {clarification
                        ? listOf(clarification.suggestions) || "未列出"
                        : version.requirements
                          ? listOf(version.requirements.suggestions) || "未列出"
                          : readableClaimText(version, listOf(verdict!.conditions)) || "未给出"}
                    </dd>
                  </div>
                  <div>
                    <dt>仍需确认</dt>
                    <dd>
                      {clarification
                        ? listOf([
                            ...new Set([
                              ...(version.requirements?.unresolved ?? []),
                              ...clarification.conflicts,
                              ...(clarification.review?.gaps.map((item) => item.title) ?? []),
                            ]),
                          ]) || "未列出"
                        : version.requirements
                          ? listOf(version.requirements.unresolved) || "未列出"
                          : readableClaimText(version, listOf(verdict!.uncertainties)) || "未列出"}
                    </dd>
                  </div>
                  <div>
                    <dt>{version.requirements || clarification ? "待提供材料" : "退出条件"}</dt>
                    <dd>
                      {version.requirements
                        ? listOf(version.requirements.missingMaterials) || "未列出缺失材料"
                        : clarification
                          ? "材料状态详见需求说明中的材料交接记录"
                          : readableClaimText(version, verdict!.exitCondition)}
                    </dd>
                  </div>
                </dl>
                {(clarification || verdict!.nextActions.length > 1) && (
                  <p className="more">
                    {version.requirements || clarification
                      ? `材料引用 ${version.intake?.usedSources.map((source) => `${source.filename} ${source.location} [${source.id}]`).join("、") || "暂无材料引用"}`
                      : `接着做：${readableClaimText(version, listOf(verdict!.nextActions.slice(1)))}`}
                  </p>
                )}
                {clarification && (
                  <button
                    type="button"
                    className="c-report-export"
                    disabled={
                      !clarification.specification.trim() || !clarification.executionPrompt.trim()
                    }
                    onClick={exportClarification}
                  >
                    导出完整规划与执行提示词（Markdown）
                  </button>
                )}
                <button
                  type="button"
                  aria-expanded={wholeResult}
                  aria-controls="verdict"
                  onClick={() => setWholeResult((w) => !w)}
                >
                  {wholeResult ? "收起结论" : "看完整结论"}
                </button>
              </div>
            </section>
          </ResultRegion>
        )}
        <div className="c-conditions" tabIndex={0} aria-label="当前条件；内容较长时可独立滚动">
          {conditions}
        </div>
        {agent && <div className="c-agent">{agent}</div>}
        <div className="c-notices">{notices}</div>
        <div className="c-track">
          <div
            ref={timeline}
            className={`c-time ${clarification ? "replay-time" : ""}`}
            role="group"
            aria-label={clarification ? "需求梳理回放步骤" : "推演步骤"}
            onPointerEnter={(event) => {
              if (event.pointerType === "touch") return;
              cancelRailRelease();
              railState.current.hover = true;
              updateRailInteraction();
            }}
            onPointerLeave={(event) => {
              if (event.pointerType === "touch") return;
              railState.current.hover = false;
              railState.current.pressing = false;
              updateRailInteraction();
            }}
            onPointerDown={beginRailPointer}
            onPointerUp={endRailPointer}
            onPointerCancel={endRailPointer}
            onFocusCapture={(event) => {
              if (railState.current.pressing) return;
              railState.current.keyboard = event.target.matches(":focus-visible");
              updateRailInteraction();
            }}
            onBlurCapture={(event) => {
              if (
                event.relatedTarget instanceof Node &&
                event.currentTarget.contains(event.relatedTarget)
              )
                return;
              railState.current.keyboard = false;
              updateRailInteraction();
            }}
            onKeyDownCapture={() => {
              cancelRailRelease();
              railState.current.keyboard = true;
              updateRailInteraction();
            }}
          >
            {timelineGroups.map((group) => (
              <div
                key={group.key}
                data-round={clarification ? group.key : undefined}
                data-state={
                  group.bad
                    ? "failed"
                    : group.done
                      ? "passed"
                      : group.active
                        ? "current"
                        : "pending"
                }
                className={`seg ${group.bad ? "bad" : group.done ? "done" : !clarification && version.stage === group.key ? "live" : ""} ${group.active ? "here" : ""}`}
                style={{ flexGrow: Math.max(group.list.length, 2) }}
              >
                <span>{group.label}</span>
                <div className="ticks">
                  {group.list.map(({ b, i }) => (
                    <button
                      key={b.id}
                      type="button"
                      aria-label={`第 ${i + 1} 步`}
                      title={b.title}
                      data-tip={`第 ${i + 1} 步 · ${b.title}`}
                      aria-current={i === index ? "step" : undefined}
                      className={`${i <= index ? "seen" : ""} ${i === index ? "cur" : ""} ${b.stage === "verify" && b.attack ? `is-${b.attack.status}` : ""}`}
                      onClick={() => goTo(i)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <dl className="c-metrics">
            {metrics.map(([label, value, tone]) => (
              <div key={label} className={tone} data-state={METRIC_STATE[label]}>
                <dt>{label}</dt>
                <dd>
                  <Roll
                    value={value}
                    delay={rollDelay}
                    animate={directed && !paused}
                    origin={seeking ? "interaction" : "story"}
                  />
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <main className="c-main">
          <RouteStage
            version={version}
            demo={demo}
            beats={beats}
            index={index}
            speed={speed}
            replayProgress={replayProgress}
            replayAnswersBefore={answersBefore}
            replayAnswersVisible={projection?.answers}
            timeline={clarification ? replayTimeline : undefined}
            playing={playing}
            directed={directed}
            seeking={seeking}
            textTransition={stageTransition}
            camera={playing || seeking || playbackPaused}
            lead={lead}
            located={selectedAttack}
            reviewing={reviewing}
            onStep={setOpenStep}
            onEvidence={onEvidence}
            entering={intro && !revealed}
            readOnly={(historical && !allowRecordedChallenges) || busy}
            onClaim={onClaim}
          />
          <div className="c-rail">
            <section className="c-now" ref={nowPanel} aria-label="正在发生">
              <div className="fl">
                {current ? (
                  <>
                    <b>{beatName(current)}</b>
                    {current.to && (
                      <>
                        {" → "}
                        <b>{nameOf(current.to)}</b>
                      </>
                    )}
                  </>
                ) : (
                  "正在发生"
                )}
                <span>
                  {index + 1}/{beats.length}
                </span>
              </div>
              <div className="big">
                <Chars
                  text={current ? current.title : "等待第一步"}
                  active={directed && !seeking}
                  speed={speed}
                  delay={180}
                />
              </div>
              <p>
                {current
                  ? current.plain
                  : demo
                    ? "等待演示步骤，三条路线与步骤内容均为预设，未调用模型。"
                    : clarification
                      ? "A 拆解需求、B 审查选项、C 检查遗漏，所有要求由本人确认。"
                      : "同一模型分成五个角色，替你比较三条路线。"}
              </p>
              {canReturn && (
                <button type="button" className="c-back" onClick={() => goTo(last)}>
                  回到结果 →
                </button>
              )}
              <div className="c-ctrl">
                <button
                  type="button"
                  aria-label="上一步"
                  disabled={index <= 0}
                  onClick={() => goTo(index - 1)}
                >
                  ←
                </button>
                <button
                  type="button"
                  disabled={beats.length < 2}
                  onPointerDown={(event) => {
                    if (!event.isPrimary || event.button !== 0 || event.currentTarget.disabled)
                      return;
                    pausedOnPointerDown.current = playing;
                    if (playing) replay();
                  }}
                  onPointerCancel={() => {
                    pausedOnPointerDown.current = false;
                  }}
                  onClick={(event) => {
                    const alreadyPaused = pausedOnPointerDown.current && event.detail !== 0;
                    pausedOnPointerDown.current = false;
                    if (!alreadyPaused) replay();
                  }}
                >
                  {playing ? "暂停放映" : index < last || playbackPaused ? "继续放映" : "从头放映"}
                </button>
                <button
                  type="button"
                  aria-label="下一步"
                  disabled={index >= last}
                  onClick={() => goTo(index + 1)}
                >
                  →
                </button>
                <button
                  type="button"
                  aria-label="放映速度"
                  onClick={() =>
                    setSpeed((s) => SPEEDS[(SPEEDS.findIndex((x) => x.value === s) + 1) % 3].value)
                  }
                >
                  {speedLabel}
                </button>
                <button
                  type="button"
                  aria-pressed={stepwise}
                  title="每一步停住，按 → 或“下一步”继续"
                  className={stepwise ? "on" : ""}
                  onClick={() => {
                    if (stepwise && playing) setSeeking(false);
                    setStepwise(!stepwise);
                  }}
                >
                  逐步看
                </button>
              </div>
            </section>
            {drafts && <div className="c-drafts">{drafts}</div>}
            <section className="c-trace" aria-label="步骤记录">
              <h2>
                步骤记录 <span>{logged.length}</span>
              </h2>
              <div className="c-log">
                {logged.slice(-40).map((event, i, list) => {
                  const usage = usageOf(event);
                  return (
                    <div
                      key={event.seq}
                      className={`${i === list.length - 1 ? "hot" : ""} ${/fail|uncertain/.test(event.type) ? "bad" : ""}`}
                    >
                      <b>{clock(recordedEventTime(event))}</b> {event.message}
                      {usage &&
                        Number.isFinite(usage.inputTokens) &&
                        Number.isFinite(usage.outputTokens) &&
                        ` ${usage.inputTokens}/${usage.outputTokens}`}
                    </div>
                  );
                })}
              </div>
              <div className="c-scope" aria-hidden="true">
                {used.map((u, i) => (
                  <i
                    key={i}
                    style={{ height: `${((u.inputTokens + u.outputTokens) / peak) * 100}%` }}
                  />
                ))}
              </div>
              <small>
                {demo
                  ? "演示内容：步骤和用量都是预设的，未调用模型。"
                  : `未保存模型的隐藏推理，这里展示的是实际记录的步骤。${version.modelSelection?.modelId ?? "早期记录：模型未记录"}`}
              </small>
            </section>
          </div>
        </main>
        <div className="c-bottom">
          <RouteChart version={version} beats={beats} index={index} onStep={setOpenStep} />
          <section className="c-list" aria-label={clarification ? "待核对事项" : "全部质疑"}>
            <h2>
              {clarification ? "待核对事项" : "全部质疑"}{" "}
              <span>{clarification ? "问题继续在原补问入口处理" : "点击看证据"}</span>
            </h2>
            <div className="rows">
              {attacks.length === 0 && (
                <div className="quiet">
                  {clarification
                    ? reviewMessages.join("；") || "当前步骤没有新增待核对事项。"
                    : "交叉质疑尚未开始。"}
                </div>
              )}
              {attacks.map((a) => {
                const state = seen.has(`v:${a.id}`) ? a.status : "pending";
                return (
                  <button
                    key={a.id}
                    type="button"
                    id={`dispute-${a.id}`}
                    data-attack={a.id}
                    title="查看这条质疑的证据"
                    className={`c-row ${a.id === current?.attack?.id ? "sel" : ""} ${a.id === selectedAttack ? "located" : ""}`}
                    onClick={() => onEvidence(a)}
                  >
                    <em className={`is-${state}`}>
                      {a.from}→{a.targetStrategyId} {attackMeta[state].label}
                    </em>
                    <span>{readableClaimText(version, a.reason)}</span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      </div>
      {hasResult &&
        directed &&
        !filmDone &&
        (clarification
          ? current?.replayAction?.kind === "handoff" && replayProgress === 1
          : current?.id === "judge") && (
          <VerdictFilm
            verdict={verdict ?? undefined}
            clarification={clarification}
            speed={speed}
            onDone={endFilm}
          />
        )}
      {openStep !== null && beats[openStep] && (
        <StepCard
          version={version}
          beats={beats}
          index={openStep}
          last={index}
          reviewing={reviewing}
          replayProgress={openStep === index ? replayProgress : 1}
          onOpen={setOpenStep}
          onClose={() => setOpenStep(null)}
          onFollowUp={
            onFollowUp && (!historical || allowRecordedChallenges) && !busy
              ? (context, trigger) => {
                  setOpenStep(null);
                  onFollowUp(context, trigger);
                }
              : undefined
          }
          onAdjustConditions={
            onAdjustConditions && (!historical || allowRecordedChallenges) && !busy
              ? (trigger) => {
                  setOpenStep(null);
                  onAdjustConditions(trigger);
                }
              : undefined
          }
          onStage={(i) => {
            setOpenStep(null);
            goTo(i);
          }}
          onEvidence={(attack) => {
            setOpenStep(null);
            onEvidence(attack);
          }}
        />
      )}
    </div>
  );
}
