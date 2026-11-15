import { readFileSync } from "node:fs";
import { expect, test as baseTest, type Page } from "@playwright/test";
import { displayTest } from "../display/display-validation";
import { beatsOf } from "../../src/components/console/beats";
import {
  playbackCommitAt,
  playbackDuration,
} from "../../src/components/console/use-playback-progress";
import type { RecordedExamplePayload } from "../../src/lib/recorded-examples";

// Saved real-model simulations with simulated answers. Browser inputs are trusted,
// APIs are blocked, and these DOM/rAF regressions do not establish pixel cadence.
const scenarios = [
  { slug: "personal-website", kind: "single", width: 1440, speed: "常速" },
  { slug: "presentation", kind: "single", width: 390, speed: "快速" },
  { slug: "personal-website", kind: "multiple", width: 390, speed: "慢速" },
  { slug: "event-registration", kind: "multiple", width: 1440, speed: "快速" },
  { slug: "user-guide", kind: "confirm", width: 1440, speed: "慢速" },
  { slug: "event-registration", kind: "confirm", width: 390, speed: "常速" },
  { slug: "event-registration", kind: "confirm", width: 344, speed: "常速" },
] as const;

type Box = { x: number; y: number; width: number; height: number };
type TargetFrame = {
  identity: string;
  nodeId: number;
  box: Box;
  layout: Box;
  pressed: boolean;
  pressOffset: number;
  transform: string;
  transitionProperty: string;
  transformTransitions: number;
};
type PressEvent = {
  at: number;
  target: string;
  nodeId: number;
  pressed: boolean;
  amount: number;
  activeTarget: string | null;
  activeAmount: number;
  step: number;
  progress: number;
  ring: number;
  paper: Box | null;
  box: Box;
  layout: Box;
  pointer: { x: number; y: number } | null;
};
type ClickFrame = {
  at: number;
  step: number;
  progress: number;
  fold: number;
  rate: number;
  paper: Box | null;
  body: Box | null;
  legend: Box | null;
  options: Box[];
  scroll: number;
  pointer: { x: number; y: number; opacity: number; amount: number; ring: number } | null;
  targets: Array<TargetFrame | null>;
};

function extent(values: number[]) {
  return Math.max(...values) - Math.min(...values);
}

function smooth(value: number) {
  const amount = Math.max(0, Math.min(1, value));
  return amount * amount * (3 - 2 * amount);
}

async function openPausedReplay(page: Page, slug: string, speed: string) {
  const forbidden: string[] = [];
  await page.route("**/api/**", (route) => {
    forbidden.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.abort();
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    const inputs: unknown[] = [];
    Object.assign(window, { __clickContinuityInputs: inputs });
    for (const type of ["pointerdown", "pointerup", "click", "keydown", "keyup"])
      addEventListener(
        type,
        (event) => {
          const button = event.target instanceof Element ? event.target.closest("button") : null;
          inputs.push({
            type,
            at: performance.now(),
            trusted: event.isTrusted,
            control: button?.getAttribute("aria-label") || button?.textContent?.trim(),
            key: event instanceof KeyboardEvent ? event.key : undefined,
          });
        },
        true,
      );
  });
  await page.goto(`/examples/${slug}`);
  await page.getByRole("button", { name: "暂停自动开始", exact: true }).click();
  await page.getByRole("button", { name: "开始回看", exact: true }).click();
  await page.locator(".initial-paper-transfer").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "暂停放映", exact: true }).click();
  const speedControl = page.getByRole("button", { name: "放映速度", exact: true });
  for (let attempt = 0; attempt < 3 && (await speedControl.textContent()) !== speed; attempt++)
    await speedControl.click();
  return forbidden;
}

export function registerReplayClickContinuityTests(mode: "functional" | "display") {
  const test = mode === "display" ? displayTest : baseTest;
  test.beforeEach(async ({ browserName }, info) => {
    info.annotations.push({
      type: "motion-validation",
      description: JSON.stringify({
        mode,
        browserName,
        reducedMotionSwitchCases: mode === "functional" ? 2 : 0,
      }),
    });
  });
  for (const scenario of scenarios) {
    test(`normal click continuity: ${scenario.slug} ${scenario.kind} at ${scenario.width}px ${scenario.speed}`, async ({
      page,
    }, info) => {
      test.setTimeout(45000);
      await page.setViewportSize({
        width: scenario.width,
        height: scenario.width === 390 ? 844 : 900,
      });
      const payload = JSON.parse(
        readFileSync(`public/recorded-examples/${scenario.slug}.json`, "utf8"),
      ) as RecordedExamplePayload;
      const version = payload.arena.versions.find(
        (entry) => entry.id === payload.arena.activeVersionId,
      )!;
      const beats = beatsOf(version, payload.replayActions);
      const index = beats.findIndex((beat, at) => {
        const action = beat.replayAction;
        if (scenario.kind === "confirm") return action?.kind === "round_confirm";
        const answer = action?.answers?.[0];
        return (
          action?.kind === "answer" &&
          answer?.state === "answered" &&
          answer.question.type === scenario.kind &&
          beats[at - 1]?.replayAction?.kind === "questions" &&
          (scenario.kind !== "multiple" || (Array.isArray(answer.value) && answer.value.length > 1))
        );
      });
      if (index < 1) throw new Error("The immutable saved case lacks the required click sequence.");
      const action = beats[index].replayAction!;
      const answer = action.answers?.[0];
      const values =
        scenario.kind === "confirm"
          ? []
          : Array.isArray(answer!.value)
            ? answer!.value
            : [String(answer!.value)];
      const questionId = answer?.questionId ?? action.questions?.[0]?.id;
      const duration = playbackDuration(beats[index]);
      const commitAt = playbackCommitAt(beats[index]);
      const forbidden = await openPausedReplay(page, scenario.slug, scenario.speed);
      // The original timeline is keyboard-operated. Playback then advances normally
      // from the preceding saved action into the click being inspected.
      await page.getByRole("button", { name: `第 ${index} 步`, exact: true }).focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        (step) =>
          document.querySelector('.c-time [aria-current="step"]')?.getAttribute("aria-label") ===
          `第 ${step} 步`,
        index,
      );
      await page.waitForTimeout(300);
      const sampling = page.evaluate(
        ({ targetStep, questionId, values, confirmation }) =>
          new Promise<{ frames: ClickFrame[]; timedOut: boolean; pressEvents: PressEvent[] }>(
            (resolve) => {
              const frames: ClickFrame[] = [];
              const pressEvents: PressEvent[] = [];
              const nodeIds = new WeakMap<HTMLElement, number>();
              let nextNodeId = 1;
              const nodeId = (node: HTMLElement) => {
                let id = nodeIds.get(node);
                if (id === undefined) {
                  id = nextNodeId++;
                  nodeIds.set(node, id);
                }
                return id;
              };
              const identity = (node: HTMLElement) =>
                node.dataset.answerOption === undefined
                  ? JSON.stringify(["confirm", questionId ?? "round"])
                  : JSON.stringify([
                      "choice",
                      node.closest<HTMLElement>("[data-question-id]")?.dataset.questionId,
                      node.dataset.answerOption,
                    ]);
              let entered = false;
              let followingFrames = 0;
              const began = performance.now();
              const layoutPoint = (element: HTMLElement) => {
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
                return { x, y, width: element.offsetWidth, height: element.offsetHeight };
              };
              const box = (element: Element): Box => {
                const rect = element.getBoundingClientRect();
                return {
                  x: rect.x + scrollX,
                  y: rect.y + scrollY,
                  width: rect.width,
                  height: rect.height,
                };
              };
              const pressObserver = new MutationObserver((records) => {
                for (const record of records) {
                  const target = record.target;
                  if (!(target instanceof HTMLElement)) continue;
                  const paper = document.querySelector<HTMLElement>(".replay-question-scene");
                  const body = paper?.querySelector<HTMLElement>(".replay-question-body");
                  const cursor = paper?.querySelector<HTMLElement>(".replay-question-pointer");
                  const activeControl = [
                    ...(paper?.querySelectorAll<HTMLElement>("[data-replay-pressed=true]") ?? []),
                  ].find((control) => !control.closest('[inert], [aria-hidden="true"]'));
                  const pointer = cursor?.getBoundingClientRect();
                  const origin = body ? layoutPoint(body) : { x: 0, y: 0 };
                  const targetLayout = layoutPoint(target);
                  pressEvents.push({
                    at: performance.now(),
                    target: identity(target),
                    nodeId: nodeId(target),
                    pressed: target.dataset.replayPressed === "true",
                    amount:
                      Number.parseFloat(target.style.getPropertyValue("--replay-control-press")) ||
                      0,
                    activeTarget: activeControl ? identity(activeControl) : null,
                    activeAmount: activeControl
                      ? Number.parseFloat(
                          activeControl.style.getPropertyValue("--replay-control-press"),
                        ) || 0
                      : 0,
                    step: Number(
                      document
                        .querySelector('.c-time [aria-current="step"]')
                        ?.getAttribute("aria-label")
                        ?.match(/\d+/)?.[0] ?? 0,
                    ),
                    progress: Number(
                      document.querySelector<HTMLElement>(".c-root")?.dataset.replayProgress ?? 0,
                    ),
                    ring: cursor ? Number(getComputedStyle(cursor, "::before").opacity) : 0,
                    paper: paper ? box(paper) : null,
                    box: box(target),
                    layout: {
                      ...targetLayout,
                      x: targetLayout.x - origin.x,
                      y: targetLayout.y - origin.y,
                    },
                    pointer: pointer ? { x: pointer.x + scrollX, y: pointer.y + scrollY } : null,
                  });
                }
              });
              pressObserver.observe(document.querySelector(".c-root")!, {
                subtree: true,
                attributes: true,
                attributeFilter: ["data-replay-pressed"],
                attributeOldValue: true,
              });
              const tick = (at: number) => {
                const root = document.querySelector<HTMLElement>(".c-root");
                const paper = root?.querySelector<HTMLElement>(".replay-question-scene");
                const body = paper?.querySelector<HTMLElement>(".replay-question-body");
                const field = [
                  ...(paper?.querySelectorAll<HTMLElement>("[data-question-id]") ?? []),
                ].find((node) => node.dataset.questionId === questionId);
                const legend = field?.querySelector<HTMLElement>("legend");
                const cursor = paper?.querySelector<HTMLElement>(".replay-question-pointer");
                const options = [
                  ...(field?.querySelectorAll<HTMLElement>("[data-answer-option]") ?? []),
                ];
                const nodes = confirmation
                  ? [paper?.querySelector<HTMLElement>("[data-replay-confirm]")]
                  : values.map((value) =>
                      options.find((node) => node.dataset.answerOption === value),
                    );
                const origin = body ? layoutPoint(body) : { x: 0, y: 0 };
                const local = (node: HTMLElement) => {
                  const point = layoutPoint(node);
                  return { ...point, x: point.x - origin.x, y: point.y - origin.y };
                };
                const pointerBox = cursor?.getBoundingClientRect();
                const step = Number(
                  document
                    .querySelector('.c-time [aria-current="step"]')
                    ?.getAttribute("aria-label")
                    ?.match(/\d+/)?.[0] ?? 0,
                );
                frames.push({
                  at,
                  step,
                  progress: Number(root?.dataset.replayProgress ?? 0),
                  fold: Number(paper?.dataset.replayFold ?? 0),
                  rate: root
                    ? Number(getComputedStyle(root).getPropertyValue("--playback-speed"))
                    : 0,
                  paper: paper ? box(paper) : null,
                  body: body ? box(body) : null,
                  legend: legend ? local(legend) : null,
                  options: options.map(local),
                  scroll: body?.scrollTop ?? 0,
                  pointer:
                    cursor && pointerBox
                      ? {
                          x: pointerBox.x + scrollX,
                          y: pointerBox.y + scrollY,
                          opacity: Number(getComputedStyle(cursor).opacity),
                          amount: Number(cursor.style.getPropertyValue("--replay-press-amount")),
                          ring: Number(getComputedStyle(cursor, "::before").opacity),
                        }
                      : null,
                  targets: nodes.map((node) =>
                    node
                      ? {
                          identity: identity(node),
                          nodeId: nodeId(node),
                          box: box(node),
                          layout: local(node),
                          pressed: node.dataset.replayPressed === "true",
                          pressOffset:
                            Number.parseFloat(
                              node.style.getPropertyValue("--replay-control-press"),
                            ) || 0,
                          transform: getComputedStyle(node).transform,
                          transitionProperty: getComputedStyle(node).transitionProperty,
                          transformTransitions: node
                            .getAnimations()
                            .filter(
                              (animation) =>
                                animation instanceof CSSTransition &&
                                animation.transitionProperty === "transform",
                            ).length,
                        }
                      : null,
                  ),
                });
                if (step === targetStep) entered = true;
                if (entered && step !== targetStep) followingFrames++;
                const timedOut = at - began > 12000;
                if (followingFrames >= 2 || timedOut) {
                  pressObserver.disconnect();
                  resolve({ frames, timedOut, pressEvents });
                } else requestAnimationFrame(tick);
              };
              requestAnimationFrame(tick);
            },
          ),
        { targetStep: index + 1, questionId, values, confirmation: scenario.kind === "confirm" },
      );
      await page.getByRole("button", { name: "继续放映", exact: true }).click();
      await page.mouse.move(0, 0);
      const observed = await sampling;
      const inputs = await page.evaluate(
        () => (window as unknown as { __clickContinuityInputs: unknown[] }).__clickContinuityInputs,
      );
      // Preserve every measured phase, current rate and actual sample timestamp
      // before the first assertion, including evidence from a failed regression.
      await info.attach("click-continuity-raw", {
        body: JSON.stringify({
          classification: "saved-simulation-normal-DOM-rAF-regression",
          scenario,
          action,
          step: index + 1,
          previousKind: beats[index - 1].replayAction?.kind,
          duration,
          commitAt,
          observed,
          inputs,
          forbidden,
          pixelCadenceAcceptance: false,
        }),
        contentType: "application/json",
      });

      const check = expect.soft;
      try {
        check(observed.timedOut).toBe(false);
        const frames = observed.frames.filter((frame) => frame.step === index + 1);
        if (mode === "display") check(frames.length).toBeGreaterThan(5);
        else check(frames.length).toBeGreaterThan(0);
        const expectedRate = { 常速: 1, 慢速: 0.6, 快速: 1.8 }[scenario.speed];
        check(frames.every((frame) => frame.rate === expectedRate)).toBe(true);
        const baseline = observed.frames.find((frame) => frame.step === index && frame.legend);
        check(baseline?.legend).toBeTruthy();
        for (const frame of frames) {
          check(frame.paper).not.toBeNull();
          check(frame.legend).toEqual(baseline?.legend);
          check(frame.options).toEqual(baseline?.options);
          for (const target of frame.targets.filter((target) => target !== null)) {
            check(target!.transformTransitions).toBe(0);
            check(
              target!.transitionProperty.split(",").map((property) => property.trim()),
            ).not.toContain("transform");
          }
          check(frame.pointer).not.toBeNull();
          if (!frame.pointer) continue;
          check(Math.abs(frame.pointer!.ring - frame.pointer!.amount)).toBeLessThan(0.03);
          const progress =
            frame.progress <= 0.8
              ? (frame.progress / 0.8) * commitAt
              : commitAt + ((frame.progress - 0.8) / 0.2) * (1 - commitAt);
          const elapsed = progress * duration;
          const expectedOpacity =
            smooth(elapsed / 120) *
            smooth((duration - elapsed) / 120) *
            (1 - smooth((frame.fold - 0.1) / 0.15));
          check(Math.abs(frame.pointer!.opacity - expectedOpacity)).toBeLessThan(0.04);
        }
        if (mode === "display")
          check(
            frames.some(
              (frame) =>
                frame.pointer && frame.pointer.opacity > 0.02 && frame.pointer.opacity < 0.95,
            ),
          ).toBe(true);
        check(baseline?.pointer?.opacity).toBe(0);
        // rAF need not land on the exact terminal millisecond. The equation above
        // checks the captured endpoint approach at each actual active-clock sample.
        if (mode === "display") check(frames.at(-1)?.pointer?.opacity).toBeLessThan(0.95);

        for (let targetIndex = 0; targetIndex < Math.max(1, values.length); targetIndex++) {
          const pressed = frames.filter((frame) => frame.targets[targetIndex]?.pressed);
          const target = frames
            .map((frame) => frame.targets[targetIndex])
            .find((target) => target !== null)!;
          check(target).toBeTruthy();
          if (!target) continue;
          check(frames.every((frame) => !!frame.targets[targetIndex])).toBe(true);
          const events = observed.pressEvents.filter((event) => event.target === target.identity);
          const pressEvents = events.filter((event) => event.pressed);
          check(pressEvents.length).toBeGreaterThan(0);
          if (!pressEvents.length) continue;
          check(events.some((event) => !event.pressed && event.at >= pressEvents[0].at)).toBe(true);
          check(events.at(-1)?.pressed).toBe(false);
          check(new Set(events.map((event) => event.nodeId))).toEqual(new Set([target.nodeId]));
          if (mode === "display") {
            check(pressed.length).toBeGreaterThanOrEqual(2);
            check(
              pressed.some((frame) => frame.pointer!.ring > 0.2 && frame.pointer!.ring < 0.99),
            ).toBe(true);
          }
          for (const event of events) {
            check(event.pointer).not.toBeNull();
            check(event.paper).not.toBeNull();
            check(Math.abs(event.ring - event.activeAmount / 1.5)).toBeLessThan(0.03);
            if (event.pressed) check(event.activeTarget).toBe(event.target);
            else check(event.amount).toBe(0);
            if (event.step === index + 1) {
              const progress =
                event.progress <= 0.8
                  ? (event.progress / 0.8) * commitAt
                  : commitAt + ((event.progress - 0.8) / 0.2) * (1 - commitAt);
              const elapsed = progress * duration;
              const clickTimes =
                values.length > 1
                  ? values.map((_, at) => 0.22 + (at * 0.52) / (values.length - 1))
                  : [scenario.kind === "confirm" ? 0.4 : 0.45];
              const gaps = clickTimes
                .slice(1)
                .map((at, key) => (at - clickTimes[key]) * duration * 0.6);
              const pressDuration = Math.max(1, Math.min(120, ...gaps));
              const active = clickTimes.findLastIndex(
                (at) => elapsed >= at * duration && elapsed < at * duration + pressDuration,
              );
              const phase =
                active < 0 ? 0 : (elapsed - clickTimes[active] * duration) / pressDuration;
              const expectedRing = active < 0 ? 0 : Math.sin(phase * Math.PI) ** 2;
              check(Math.abs(event.ring - expectedRing)).toBeLessThan(0.03);
            }
          }
          const ended = events.find((event) => !event.pressed && event.at >= pressEvents[0].at)!;
          if (!ended) continue;
          const first = pressed.length
            ? frames.indexOf(pressed[0])
            : frames.findIndex((frame) => frame.at > pressEvents[0].at);
          const last = pressed.length
            ? frames.indexOf(pressed.at(-1)!)
            : frames.findLastIndex((frame) => frame.at < ended.at);
          const before = pressed.length
            ? first - 1
            : frames.findLastIndex((frame) => frame.at <= pressEvents[0].at);
          const after = pressed.length
            ? last + 1
            : frames.findIndex((frame) => frame.at >= ended.at);
          if (mode === "display") {
            check(before).toBeGreaterThanOrEqual(0);
            check(after).toBeLessThan(frames.length);
            check(after).toBeGreaterThan(before);
          }
          if (mode === "display" && before >= 0 && after < frames.length && after > before) {
            check(frames[before].pointer?.ring).toBeLessThan(0.01);
            check(frames[after].pointer?.ring).toBeLessThan(0.01);
          }
          const relative = [
            ...pressed
              .filter((frame) => frame.pointer && frame.targets[targetIndex])
              .map((frame) => ({
                x: frame.pointer!.x - frame.targets[targetIndex]!.box.x,
                y: frame.pointer!.y - frame.targets[targetIndex]!.box.y,
              })),
            ...pressEvents
              .filter((event) => event.pointer)
              .map((event) => ({
                x: event.pointer!.x - event.box.x,
                y: event.pointer!.y - event.box.y,
              })),
          ];
          check(extent(relative.map((position) => position.x))).toBeLessThan(0.35);
          check(extent(relative.map((position) => position.y))).toBeLessThan(0.35);
          const around = before >= 0 && after > before ? frames.slice(before, after + 1) : [];
          const paperPoses = [
            ...around.map((frame) => frame.paper!),
            ...events.map((event) => event.paper),
          ].filter((paper) => paper !== null);
          const targetPoses = [
            ...around
              .map((frame) => frame.targets[targetIndex]?.layout)
              .filter((pose) => pose !== undefined),
            ...events.map((event) => event.layout),
          ];
          check(extent(paperPoses.map((paper) => paper.width))).toBeLessThanOrEqual(1);
          check(extent(paperPoses.map((paper) => paper.height))).toBeLessThanOrEqual(1);
          check(extent(paperPoses.map((paper) => paper.x))).toBeLessThanOrEqual(1);
          check(extent(paperPoses.map((paper) => paper.y))).toBeLessThanOrEqual(1);
          for (const axis of ["x", "y", "width", "height"] as const)
            check(extent(targetPoses.map((pose) => pose[axis]))).toBeLessThanOrEqual(1);
        }
      } finally {
        check(forbidden).toEqual([]);
        check(
          (inputs as Array<{ trusted: boolean; key?: string }>).some(
            (input) => input.trusted && input.key === "Enter",
          ),
        ).toBe(true);
      }
    });
  }

  // Live preference switching is functional coverage. Display qualification keeps
  // normal motion enabled for its complete sampling session.
  if (mode === "functional")
    for (const phase of ["press", "return"] as const) {
      test(`normal click interruption: live reduced motion settles a paused ${phase} without replaying it`, async ({
        page,
      }, info) => {
        test.setTimeout(45000);
        await page.setViewportSize({ width: 390, height: 844 });
        const payload = JSON.parse(
          readFileSync("public/recorded-examples/personal-website.json", "utf8"),
        ) as RecordedExamplePayload;
        const version = payload.arena.versions.find(
          (entry) => entry.id === payload.arena.activeVersionId,
        )!;
        const beats = beatsOf(version, payload.replayActions);
        const index = beats.findIndex((beat) =>
          phase === "return"
            ? beat.replayAction?.kind === "round_confirm"
            : beat.replayAction?.kind === "answer" &&
              beat.replayAction.answers?.[0]?.question.type === "single",
        );
        const forbidden = await openPausedReplay(page, "personal-website", "慢速");
        await page.getByRole("button", { name: `第 ${index} 步`, exact: true }).focus();
        await page.keyboard.press("Enter");
        await page.waitForTimeout(300);
        // Keep focus on the original playback button, so the native Space pause does
        // not need to scroll or wait for a moving control during the short press.
        await page.getByRole("button", { name: "继续放映", exact: true }).focus();
        await page.keyboard.press("Enter");
        await page.waitForFunction(
          ({ targetStep, phase }) => {
            const step = document
              .querySelector('.c-time [aria-current="step"]')
              ?.getAttribute("aria-label");
            if (step !== `第 ${targetStep} 步`) return false;
            const paper = document.querySelector<HTMLElement>(".replay-question-scene");
            if (phase === "return") return Number(paper?.dataset.replayFold) > 0.05;
            const cursor = paper?.querySelector<HTMLElement>(".replay-question-pointer");
            return (
              cursor?.dataset.pressed === "true" &&
              Number(cursor.style.getPropertyValue("--replay-press-amount")) > 0.05
            );
          },
          { targetStep: index + 1, phase },
        );
        await page.keyboard.press("Space");
        const snapshot = () =>
          page.evaluate(() => {
            const paper = document.querySelector<HTMLElement>(".replay-question-scene")!;
            const cursor = paper.querySelector<HTMLElement>(".replay-question-pointer")!;
            const matrix = new DOMMatrixReadOnly(getComputedStyle(paper).transform);
            return {
              at: performance.now(),
              current: document
                .querySelector('.c-time [aria-current="step"]')
                ?.getAttribute("aria-label"),
              progress: document.querySelector<HTMLElement>(".c-root")?.dataset.replayProgress,
              kind: paper.dataset.replayAction,
              fold: Number(paper.dataset.replayFold),
              pressed: cursor.dataset.pressed,
              pointer: Number(getComputedStyle(cursor).opacity),
              ring: Number(getComputedStyle(cursor, "::before").opacity),
              pressAmount: Number(cursor.style.getPropertyValue("--replay-press-amount")),
              transform: { x: matrix.m41, y: matrix.m42, sx: matrix.m11, sy: matrix.m22 },
              text: [
                ...paper.querySelectorAll<HTMLElement>(
                  ":scope > header, :scope > .replay-question-body, :scope > footer",
                ),
              ].map((node) => Number(getComputedStyle(node).opacity)),
              answers: [...paper.querySelectorAll<HTMLInputElement>("input")].map(
                (node) => node.checked,
              ),
              confirmations: [...paper.querySelectorAll<HTMLElement>("[data-confirmation]")].map(
                (node) => node.dataset.confirmation,
              ),
              oldTransfers: document.querySelectorAll(".replay-handoff-strip").length,
              nativeTransforms: paper
                .getAnimations()
                .filter(
                  (animation) =>
                    animation.effect instanceof KeyframeEffect &&
                    animation.effect
                      .getKeyframes()
                      .some((key) => typeof key.transform === "string"),
                ).length,
              playButton: [...document.querySelectorAll(".c-ctrl button")].find((button) =>
                /继续放映|暂停放映/.test(button.textContent ?? ""),
              )?.textContent,
            };
          });
        const before = await snapshot();
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.waitForTimeout(100);
        const reduced = await snapshot();
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.waitForTimeout(250);
        const restored = await snapshot();
        await info.attach(`paused-${phase}-live-preference-raw`, {
          body: JSON.stringify({
            classification: "normal-saved-simulation-live-preference-regression",
            before,
            reduced,
            restored,
            forbidden,
          }),
          contentType: "application/json",
        });
        expect(before.current).toBe(`第 ${index + 1} 步`);
        expect(before.playButton).toBe("继续放映");
        if (phase === "press") expect(before.pressAmount).toBeGreaterThan(0);
        else expect(before.fold).toBeGreaterThan(0);
        for (const state of [reduced, restored]) {
          expect(state.current).toBe(before.current);
          expect(state.progress).toBe(before.progress);
          expect(state.answers).toEqual(before.answers);
          expect(state.confirmations).toEqual(before.confirmations);
          expect(state.pointer).toBe(0);
          expect(state.ring).toBe(0);
          expect(state.pressAmount).toBe(0);
          expect(state.pressed).toBe("false");
          expect(state.text).toEqual([1, 1, 1]);
          expect(state.oldTransfers).toBe(0);
          expect(state.nativeTransforms).toBe(0);
          expect(state.transform).toEqual({ x: 0, y: 0, sx: 1, sy: 1 });
        }
        expect(forbidden).toEqual([]);
      });
    }
}
