import { readFileSync } from "node:fs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { beatsOf, type Beat } from "../../src/components/console/beats";
import { playbackDuration } from "../../src/components/console/use-playback-progress";
import type { ClarificationRun, DecisionItem } from "../../src/lib/clarification-contracts";
import type { IntakeQuestion, RecordedAnswer } from "../../src/lib/intake-contracts";
import type { RecordedExamplePayload } from "../../src/lib/recorded-examples";
import { configureFixtureModels } from "./intake.fixture";
import { advanceFixture, fixtureSnapshot } from "./ui.fixture";

// Read-only saved real-model simulations. Their answers remain simulated.
// Native DOM/rAF observations verify transitions, independently of pixel cadence.
type Speed = "常速" | "慢速" | "快速";
type OpacityAncestor = {
  tag: string;
  className: string;
  inlineStyle: string | null;
  inlineOpacity: string;
  computedOpacity: string;
  visibility: string;
  display: string;
};
type Part = {
  text: string;
  opacity: number;
  width: number;
  height: number;
  left: number;
  top: number;
  inlineStyle: string | null;
  opacityAncestors: OpacityAncestor[];
};
type ActionFrame = {
  at: number;
  step: number;
  progress: number;
  action: string | null;
  paperId: number | null;
  paperHeight: number;
  paperAncestors: OpacityAncestor[];
  paperOpened: boolean;
  bodyScrollPhase: string | null;
  fold: number;
  pointer: { left: number; top: number; opacity: number } | null;
  nestedRetiringCopies: number;
  heading: Part | null;
  footer: Part | null;
  copies: Array<{
    text: string;
    opacity: number;
    inert: boolean;
    hidden: string | null;
    enabled: number;
  }>;
  questions: Array<{
    id: string;
    state: string | null;
    confirmation: string | null;
    checked: number;
    value: string;
  }>;
  controls: {
    button: number;
    acknowledgement: number;
    pointerOpacity: number;
    box: Part | null;
    layout: { width: number; height: number; left: number; top: number } | null;
  };
  originalParts: string[];
  nativeEffects: Array<{
    id: number;
    state: string;
    time: number | null;
    duration: number;
    properties: string[];
    targetClassName: string;
    directPart: boolean;
    retiring: boolean;
  }>;
};
type SamplerWindow = Window & {
  __actionFrames?: ActionFrame[];
  __actionSampling?: boolean;
  __actionInputs?: unknown[];
};
type ContentClockEffect = {
  id: number;
  kind: "opacity" | "height";
  state: string;
  time: number;
  writes: number;
};
type ContentClockFrame = { at: number; effects: ContentClockEffect[] };
type ContentClockWindow = Window & {
  __contentClock?: {
    frames: ContentClockFrame[];
    read: () => ContentClockFrame;
    pauseAfterPlay: "opacity" | "height" | null;
    excludedPlayId: number | null;
    stopped: boolean;
  };
};

async function observeContentClock(page: Page) {
  await page.evaluate(() => {
    const target = window as ContentClockWindow;
    const entries = new Map<
      Animation,
      { id: number; kind: "opacity" | "height"; writes: number }
    >();
    let identity = 0;
    let pauseOnCreation = true;
    const entry = (animation: Animation) => {
      if (entries.has(animation)) return entries.get(animation)!;
      const effect = animation.effect;
      if (!(effect instanceof KeyframeEffect) || !(effect.target instanceof HTMLElement))
        return null;
      const node = effect.target;
      if (node.closest<HTMLElement>(".replay-question-scene")?.dataset.replayAction !== "answer")
        return null;
      const properties = effect.getKeyframes().flatMap((frame) => Object.keys(frame));
      const height = node.matches(".replay-question-scene") && properties.includes("height");
      const opacity =
        properties.includes("opacity") &&
        (node.dataset.replayContentRetiring === "true" ||
          (node.parentElement?.matches(".replay-question-scene") &&
            node.matches("header,.replay-question-body,footer")));
      if (!height && !opacity) return null;
      const value = {
        id: ++identity,
        kind: height ? ("height" as const) : ("opacity" as const),
        writes: 0,
      };
      entries.set(animation, value);
      return value;
    };
    const pause = () => {
      const button = [...document.querySelectorAll("button")].find(
        (node) => node.textContent?.trim() === "暂停放映",
      );
      if (!button) throw new Error("The content-clock probe requires the actual pause control.");
      button.click();
    };
    const read = (): ContentClockFrame => ({
      at: performance.now(),
      effects: [...entries].flatMap(([animation, value]) =>
        animation.playState === "idle"
          ? []
          : [{ ...value, state: animation.playState, time: Number(animation.currentTime) }],
      ),
    });
    const probe = {
      frames: [] as ContentClockFrame[],
      read,
      pauseAfterPlay: null as "opacity" | "height" | null,
      excludedPlayId: null as number | null,
      stopped: false,
    };
    target.__contentClock = probe;
    const currentTime = Object.getOwnPropertyDescriptor(Animation.prototype, "currentTime")!;
    Object.defineProperty(Animation.prototype, "currentTime", {
      ...currentTime,
      set(this: Animation, value: number | CSSNumericValue | null) {
        currentTime.set!.call(this, value);
        const observed = entry(this);
        if (!observed) return;
        observed.writes++;
        if (pauseOnCreation && observed.kind === "opacity") {
          pauseOnCreation = false;
          // Keep the real play/pause implementation. The UI pauses before the first rendered frame.
          queueMicrotask(pause);
        }
      },
    });
    const play = Animation.prototype.play;
    Animation.prototype.play = function () {
      play.call(this);
      const observed = entry(this);
      if (observed?.kind === probe.pauseAfterPlay && observed?.id !== probe.excludedPlayId) {
        probe.pauseAfterPlay = null;
        setTimeout(pause, 35);
      }
    };
    const sample = () => {
      if (probe.stopped) return;
      probe.frames.push(read());
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

function savedBeats(slug: string) {
  const payload = JSON.parse(
    readFileSync(`public/recorded-examples/${slug}.json`, "utf8"),
  ) as RecordedExamplePayload;
  const version = payload.arena.versions.find((item) => item.id === payload.arena.activeVersionId)!;
  return beatsOf(version, payload.replayActions);
}

async function openReplay(page: Page, slug: string, speed: Speed) {
  const forbidden: string[] = [];
  await page.route("**/api/**", (route) => {
    forbidden.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.abort();
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    const inputs: unknown[] = [];
    (window as SamplerWindow).__actionInputs = inputs;
    for (const type of ["pointerdown", "pointerup", "click", "keydown", "keyup"])
      addEventListener(
        type,
        (event) => {
          const control = event.target instanceof Element ? event.target.closest("button") : null;
          inputs.push({
            type,
            at: performance.now(),
            trusted: event.isTrusted,
            name: control?.getAttribute("aria-label") || control?.textContent?.trim(),
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
  const control = page.getByRole("button", { name: "放映速度", exact: true });
  for (let attempt = 0; attempt < 3 && (await control.textContent()) !== speed; attempt++)
    await control.click();
  await expect(control).toHaveText(speed);
  return forbidden;
}

async function seek(page: Page, step: number) {
  await page.getByRole("button", { name: `第 ${step} 步`, exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('.c-time [aria-current="step"]')).toHaveAttribute(
    "aria-label",
    `第 ${step} 步`,
  );
}

async function startSampling(page: Page) {
  await page.evaluate(() => {
    const target = window as SamplerWindow;
    target.__actionFrames = [];
    target.__actionSampling = true;
    const ids = new WeakMap<Element, number>();
    const animationIds = new WeakMap<Animation, number>();
    let identity = 0;
    let animationIdentity = 0;
    const ancestors = (element: HTMLElement | null): OpacityAncestor[] => {
      const values: OpacityAncestor[] = [];
      for (let node = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        values.push({
          tag: node.tagName,
          className: node.className,
          inlineStyle: node.getAttribute("style"),
          inlineOpacity: node.style.opacity,
          computedOpacity: style.opacity,
          visibility: style.visibility,
          display: style.display,
        });
        if (node.matches(".c-root")) break;
      }
      return values;
    };
    const opacity = (element: HTMLElement | null) => {
      let amount = element ? 1 : 0;
      for (let node = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return 0;
        amount *= Number(style.opacity);
      }
      return amount;
    };
    const tick = (at: number) => {
      if (!target.__actionSampling) return;
      const paper = document.querySelector<HTMLElement>(".c-stage3 > .replay-question-scene");
      if (paper && !ids.has(paper)) ids.set(paper, ++identity);
      const root = document.querySelector<HTMLElement>(".c-root");
      const box = paper?.getBoundingClientRect();
      const scale = box && paper ? box.width / paper.offsetWidth : 1;
      const part = (node: HTMLElement | null): Part | null => {
        if (!node || !box) return null;
        const rectangle = node.getBoundingClientRect();
        return {
          text: node.textContent?.trim() ?? "",
          opacity: opacity(node),
          width: rectangle.width / scale,
          height: rectangle.height / scale,
          left: (rectangle.left - box.left) / scale,
          top: (rectangle.top - box.top) / scale,
          inlineStyle: node.getAttribute("style"),
          opacityAncestors: ancestors(node),
        };
      };
      const footer = paper?.querySelector<HTMLElement>(":scope > .replay-question-footer") ?? null;
      const footerControl =
        footer?.querySelector<HTMLElement>(
          "[data-replay-confirm],.replay-question-acknowledgement",
        ) ?? null;
      const body = paper?.querySelector<HTMLElement>(":scope > .replay-question-body");
      const current =
        paper?.querySelector<HTMLElement>(":scope > .replay-question-heading h3") ?? null;
      const cursor = paper?.querySelector<HTMLElement>(":scope > .replay-question-pointer") ?? null;
      const copies = [
        ...(paper?.querySelectorAll<HTMLElement>("[data-replay-content-retiring=true]") ?? []),
      ];
      const nativeEffects = (paper?.getAnimations({ subtree: true }) ?? []).map((animation) => {
        if (!animationIds.has(animation)) animationIds.set(animation, ++animationIdentity);
        const animated =
          animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
        const targetElement = animated instanceof HTMLElement ? animated : null;
        return {
          id: animationIds.get(animation)!,
          state: animation.playState,
          time: typeof animation.currentTime === "number" ? animation.currentTime : null,
          duration: Number(animation.effect?.getTiming().duration ?? 0),
          properties:
            animation.effect instanceof KeyframeEffect
              ? [
                  ...new Set(
                    animation.effect.getKeyframes().flatMap((frame) => Object.keys(frame)),
                  ),
                ].filter(
                  (key) => !["offset", "computedOffset", "easing", "composite"].includes(key),
                )
              : [],
          targetClassName: targetElement?.className ?? "",
          directPart:
            !!targetElement &&
            targetElement.parentElement === paper &&
            targetElement.matches(
              ".replay-question-heading,.replay-question-body,.replay-question-footer",
            ),
          retiring: !!targetElement?.closest("[data-replay-content-retiring=true]"),
        };
      });
      const questionNodes = [...(body?.querySelectorAll<HTMLElement>("[data-question-id]") ?? [])];
      target.__actionFrames!.push({
        at,
        step: Number(
          document
            .querySelector('.c-time [aria-current="step"]')
            ?.getAttribute("aria-label")
            ?.match(/\d+/)?.[0] ?? 0,
        ),
        progress: Number(root?.dataset.replayProgress ?? 0),
        action: paper?.dataset.replayAction ?? null,
        paperId: paper ? ids.get(paper)! : null,
        paperHeight: paper?.offsetHeight ?? 0,
        paperAncestors: ancestors(paper ?? null),
        paperOpened: paper?.dataset.replayOpened === "true",
        bodyScrollPhase: body?.dataset.scrollPhase ?? null,
        fold: Number(paper?.dataset.replayFold ?? 0),
        pointer: cursor
          ? {
              left: (cursor.getBoundingClientRect().left - (box?.left ?? 0)) / scale,
              top: (cursor.getBoundingClientRect().top - (box?.top ?? 0)) / scale,
              opacity: opacity(cursor),
            }
          : null,
        nestedRetiringCopies:
          paper?.querySelectorAll(
            "[data-replay-content-retiring=true] [data-replay-content-retiring=true]",
          ).length ?? 0,
        heading: part(current),
        footer: part(footer),
        copies: copies.map((copy) => ({
          text: copy.textContent?.trim() ?? "",
          opacity: opacity(copy),
          inert: copy.inert,
          hidden: copy.getAttribute("aria-hidden"),
          enabled: copy.querySelectorAll(
            "button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)",
          ).length,
        })),
        questions: questionNodes.map((question) => ({
          id: question.dataset.questionId!,
          state:
            question.querySelector<HTMLElement>('[data-answer-state][aria-pressed="true"]')?.dataset
              .answerState ?? null,
          confirmation:
            question
              .closest(".replay-question-item")
              ?.querySelector("[data-confirmation]")
              ?.getAttribute("data-confirmation") ?? null,
          checked: question.querySelectorAll('[aria-checked="true"],input:checked').length,
          value:
            question.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea")
              ?.value ?? "",
        })),
        controls: {
          button: footer?.querySelectorAll("[data-replay-confirm]").length ?? 0,
          acknowledgement: footer?.querySelectorAll(".replay-question-acknowledgement").length ?? 0,
          pointerOpacity: opacity(cursor),
          box: part(footerControl),
          layout: footerControl
            ? {
                width: footerControl.offsetWidth,
                height: footerControl.offsetHeight,
                left: footerControl.offsetLeft,
                top: footerControl.offsetTop,
              }
            : null,
        },
        originalParts: [...(paper?.children ?? [])]
          .filter((node) =>
            node.matches(
              ".replay-question-heading,.replay-question-body,.replay-question-footer,.replay-question-pointer",
            ),
          )
          .map((node) => node.tagName),
        nativeEffects,
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function finishSampling(
  page: Page,
  info: TestInfo,
  classification = "saved-simulation-native-dom-and-raf-only",
) {
  const record = await page.evaluate(() => {
    const target = window as SamplerWindow;
    target.__actionSampling = false;
    return { frames: target.__actionFrames ?? [], inputs: target.__actionInputs ?? [] };
  });
  await info.attach("normal-cross-action-raw", {
    body: JSON.stringify({
      classification,
      pixelCadenceAcceptance: false,
      ...record,
    }),
    contentType: "application/json",
  });
  return record.frames;
}

function checkStableStructure(frames: ActionFrame[]) {
  for (const frame of frames.filter((item) => item.paperId !== null)) {
    expect(frame.originalParts).toEqual(["HEADER", "DIV", "FOOTER", "DIV"]);
    for (const copy of frame.copies) {
      expect(copy.inert).toBe(true);
      expect(copy.hidden).toBe("true");
    }
  }
}

function checkStableButtonLayout(frames: ActionFrame[], steps: number[]) {
  const controls = frames
    .filter((frame) => steps.includes(frame.step) && frame.controls.button === 1)
    .flatMap((frame) => (frame.controls.layout ? [frame.controls.layout] : []));
  expect(controls.length).toBeGreaterThan(3);
  expect(
    Math.max(...controls.map((box) => box.width)) - Math.min(...controls.map((box) => box.width)),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.max(...controls.map((box) => box.left)) - Math.min(...controls.map((box) => box.left)),
  ).toBeLessThanOrEqual(1);
}

function checkSeam(
  frames: ActionFrame[],
  outgoing: number,
  incoming: number,
  requireTextChange: boolean,
) {
  const before = frames
    .filter((frame) => frame.step === outgoing && frame.heading && frame.fold === 0)
    .at(-1);
  const after = frames.filter(
    (frame) => frame.step === incoming && frame.heading && frame.fold === 0,
  );
  expect(before).toBeDefined();
  expect(after.length).toBeGreaterThan(3);
  expect(after[0].paperId).toBe(before!.paperId);
  const outgoingTitle = before!.heading!.text;
  if (requireTextChange) {
    expect(
      after.some((frame) =>
        frame.copies.some((copy) => copy.opacity > 0.05 && copy.text.includes(outgoingTitle)),
      ),
    ).toBe(true);
    expect(
      after.some(
        (frame) =>
          frame.heading!.text !== outgoingTitle &&
          frame.heading!.opacity > 0 &&
          frame.heading!.opacity < 0.95,
      ),
    ).toBe(true);
  }
  let seenIncoming = false;
  for (const frame of after) {
    if (frame.heading!.text !== outgoingTitle && frame.heading!.opacity > 0.05) seenIncoming = true;
    if (seenIncoming && requireTextChange && frame.heading!.opacity > 0.05)
      expect(frame.heading!.text).not.toBe(outgoingTitle);
  }
  const continuous = [before!, ...after];
  for (let index = 1; index < continuous.length; index++) {
    const previous = continuous[index - 1];
    const current = continuous[index];
    if (!previous.footer || !current.footer || current.at - previous.at > 40) continue;
    const elapsed = current.at - previous.at;
    // A full105px footer-button reflow in one frame fails. This is a geometric seam
    // regression bound, independently of captured-pixel cadence acceptance.
    const maximum = 1 + (28 * elapsed) / 16.7;
    expect(Math.abs(current.footer.height - previous.footer.height)).toBeLessThanOrEqual(maximum);
    expect(Math.abs(current.footer.top - previous.footer.top)).toBeLessThanOrEqual(maximum);
    if (current.controls.box && previous.controls.box) {
      expect(
        Math.abs(current.controls.box.width - previous.controls.box.width),
      ).toBeLessThanOrEqual(maximum);
      expect(
        Math.abs(current.controls.box.height - previous.controls.box.height),
      ).toBeLessThanOrEqual(maximum);
      expect(Math.abs(current.controls.box.left - previous.controls.box.left)).toBeLessThanOrEqual(
        maximum,
      );
      expect(Math.abs(current.controls.box.top - previous.controls.box.top)).toBeLessThanOrEqual(
        maximum,
      );
    }
  }
}

async function playThrough(page: Page, endStep: number) {
  await page.getByRole("button", { name: "继续放映", exact: true }).click();
  await page.waitForFunction(
    (last) => {
      const step = Number(
        document
          .querySelector('.c-time [aria-current="step"]')
          ?.getAttribute("aria-label")
          ?.match(/\d+/)?.[0] ?? 0,
      );
      const progress = Number(
        document.querySelector<HTMLElement>(".c-root")?.dataset.replayProgress ?? 0,
      );
      return step > last || (step === last && progress > 0.98);
    },
    endStep,
    { timeout: 30000 },
  );
}

const combinations: Array<{ width: number; speed: Speed }> = [
  { width: 1440, speed: "常速" },
  { width: 1440, speed: "慢速" },
  { width: 1440, speed: "快速" },
  { width: 390, speed: "常速" },
  { width: 390, speed: "慢速" },
  { width: 390, speed: "快速" },
];

for (const { width, speed } of combinations) {
  test(`normal action seams: questions answer confirmation retain one paper at ${width}px ${speed}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const beats = savedBeats("personal-website");
    const start = beats.findIndex((beat) => beat.replayAction?.kind === "questions");
    expect(beats.slice(start, start + 3).map((beat) => beat.replayAction?.kind)).toEqual([
      "questions",
      "answer",
      "round_confirm",
    ]);
    const forbidden = await openReplay(page, "personal-website", speed);
    await seek(page, start + 1);
    await startSampling(page);
    await playThrough(page, start + 3);
    const frames = await finishSampling(page, info);
    checkStableStructure(frames);
    checkStableButtonLayout(frames, [start + 1, start + 2, start + 3]);
    checkSeam(frames, start + 1, start + 2, true);
    checkSeam(frames, start + 2, start + 3, true);
    const question = beats[start + 1].replayAction!.answers![0].questionId;
    const pending = frames.filter(
      (frame) => frame.step <= start + 2 || (frame.step === start + 3 && frame.progress < 0.75),
    );
    const pendingAnswers = pending.flatMap((frame) =>
      frame.questions.filter((entry) => entry.id === question),
    );
    expect(pendingAnswers.length).toBeGreaterThan(0);
    expect(pendingAnswers.every((entry) => entry.confirmation !== "confirmed")).toBe(true);
    const unanswered = frames
      .filter((frame) => frame.step === start + 1)
      .flatMap((frame) => frame.questions.filter((entry) => entry.id === question));
    expect(unanswered.length).toBeGreaterThan(0);
    expect(unanswered.every((entry) => entry.checked === 0)).toBe(true);
    expect(forbidden).toEqual([]);
  });
}

for (const { width, speed } of [
  { width: 1440, speed: "常速" },
  { width: 390, speed: "快速" },
] as const) {
  test(`normal action seams: successive saved answers retain their own question at ${width}px ${speed}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const beats = savedBeats("user-guide");
    const next = beats.findIndex(
      (beat, index) =>
        beat.replayAction?.kind === "answer" &&
        beats[index - 1]?.replayAction?.kind === "answer" &&
        beat.replayAction.answers?.[0].questionId !==
          beats[index - 1].replayAction?.answers?.[0].questionId,
    );
    expect(next).toBeGreaterThan(0);
    const forbidden = await openReplay(page, "user-guide", speed);
    await seek(page, next);
    await startSampling(page);
    await playThrough(page, next + 1);
    const frames = await finishSampling(page, info);
    checkStableStructure(frames);
    checkSeam(frames, next, next + 1, false);
    const nextQuestion = beats[next].replayAction!.answers![0].questionId;
    const nextAnswers = frames
      .filter((frame) => frame.step === next + 1)
      .flatMap((frame) => frame.questions.filter((question) => question.id === nextQuestion));
    expect(nextAnswers.length).toBeGreaterThan(0);
    expect(nextAnswers.every((question) => question.confirmation !== "confirmed")).toBe(true);
    expect(forbidden).toEqual([]);
  });
}

for (const { width, speed } of [
  { width: 1440, speed: "慢速" },
  { width: 390, speed: "常速" },
] as const) {
  test(`normal action seams: summary server receipt remains visible before handoff at ${width}px ${speed}`, async ({
    page,
  }, info) => {
    test.setTimeout(45000);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const beats = savedBeats("user-guide");
    const submitted = beats.findIndex((beat) => beat.replayAction?.kind === "summary_submit");
    const accepted = beats.findIndex((beat) => beat.replayAction?.kind === "summary_confirm");
    expect(beats[accepted + 1].replayAction?.kind).toBe("handoff");
    const forbidden = await openReplay(page, "user-guide", speed);
    await seek(page, submitted + 1);
    await startSampling(page);
    await playThrough(page, accepted + 2);
    const frames = await finishSampling(page, info);
    checkStableStructure(frames);
    const receipt = frames.filter(
      (frame) => frame.step === accepted + 1 && frame.progress > 0.2 && frame.progress < 0.9,
    );
    expect(receipt.length).toBeGreaterThan(3);
    expect(
      receipt.every(
        (frame) =>
          frame.paperId !== null &&
          frame.controls.acknowledgement === 1 &&
          frame.controls.button === 0,
      ),
    ).toBe(true);
    expect(receipt.some((frame) => frame.heading && frame.heading.opacity > 0.9)).toBe(true);
    expect(
      frames.some(
        (frame) =>
          frame.step === accepted + 1 &&
          frame.heading?.text.includes("摘要确认已接受") &&
          frame.heading.opacity > 0.9,
      ),
    ).toBe(true);
    expect(receipt.every((frame) => frame.controls.pointerOpacity <= 0.02)).toBe(true);
    checkSeam(frames, accepted + 1, accepted + 2, true);
    expect(forbidden).toEqual([]);
  });
}

for (const width of [1440, 390]) {
  test(`normal action interruption: pause seek reverse and reduced motion retain the latest paper at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const beats: Beat[] = savedBeats("personal-website");
    const start = beats.findIndex((beat) => beat.replayAction?.kind === "questions");
    const forbidden = await openReplay(page, "personal-website", "慢速");
    await seek(page, start + 1);
    await startSampling(page);
    await page.getByRole("button", { name: "继续放映", exact: true }).click();
    await page.waitForFunction(
      (step) =>
        document.querySelector('.c-time [aria-current="step"]')?.getAttribute("aria-label") ===
        `第 ${step} 步`,
      start + 2,
    );
    await page.getByRole("button", { name: "暂停放映", exact: true }).click();
    const paused = await page.locator('.c-time [aria-current="step"]').getAttribute("aria-label");
    await page.waitForTimeout(180);
    await expect(page.locator('.c-time [aria-current="step"]')).toHaveAttribute(
      "aria-label",
      paused!,
    );
    await page.getByRole("button", { name: "继续放映", exact: true }).click();
    await page.waitForTimeout(80);
    await page.getByRole("button", { name: "暂停放映", exact: true }).click();
    await seek(page, start + 3);
    await seek(page, start + 1);
    await seek(page, start + 2);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(page.locator("[data-replay-content-retiring=true]")).toHaveCount(0);
    await expect(page.locator('.c-time [aria-current="step"]')).toHaveAttribute(
      "aria-label",
      `第 ${start + 2} 步`,
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForTimeout(240);
    await expect(page.locator("[data-replay-content-retiring=true]")).toHaveCount(0);
    const ending = await page.evaluate(() => (window as SamplerWindow).__actionFrames!.at(-1)!);
    await info.attach("reduced-restoration-before-natural-next-action", {
      body: JSON.stringify(ending),
      contentType: "application/json",
    });
    expect(ending.action).toBe("answer");
    expect(ending.heading!.opacity).toBeGreaterThan(0.95);
    expect(ending.footer!.opacity).toBeGreaterThan(0.95);
    expect(ending.copies).toEqual([]);
    // This latched action stays settled. The following action is reached through
    // normal playback and must regain its own continuous content transition.
    await playThrough(page, start + 3);
    const frames = await finishSampling(page, info);
    checkStableStructure(frames);
    const restored = frames.filter((frame) => frame.at >= ending.at);
    const latched = restored.filter((frame) => frame.step === start + 2);
    expect(latched.length).toBeGreaterThan(0);
    expect(latched.every((frame) => frame.controls.pointerOpacity <= 0.02)).toBe(true);
    checkSeam(restored, start + 2, start + 3, true);
    expect(
      restored.some((frame) => frame.step === start + 3 && frame.controls.pointerOpacity > 0.02),
    ).toBe(true);
    expect(forbidden).toEqual([]);
  });
}

test("normal action resize: an active text crossfade survives a narrow round trip without recursive copies", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const beats = savedBeats("personal-website");
  const start = beats.findIndex((beat) => beat.replayAction?.kind === "questions");
  const forbidden = await openReplay(page, "personal-website", "慢速");
  await seek(page, start + 1);
  await startSampling(page);
  await page.getByRole("button", { name: "继续放映", exact: true }).click();
  await page.waitForFunction(
    (step) =>
      document.querySelector('.c-time [aria-current="step"]')?.getAttribute("aria-label") ===
        `第 ${step} 步` && !!document.querySelector("[data-replay-content-retiring=true]"),
    start + 2,
  );
  await page.setViewportSize({ width: 344, height: 844 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(180);
  await page.getByRole("button", { name: "暂停放映", exact: true }).click();
  const frames = await finishSampling(page, info);
  checkStableStructure(frames);
  const answering = frames.filter((frame) => frame.step === start + 2);
  expect(answering.length).toBeGreaterThan(3);
  expect(
    answering.every((frame) => frame.copies.length <= 1 && frame.nestedRetiringCopies === 0),
  ).toBe(true);
  expect(answering.every((frame) => frame.paperHeight > 100)).toBe(true);
  expect(
    answering.every(
      (frame) =>
        (frame.heading?.opacity ?? 0) + frame.copies.reduce((sum, copy) => sum + copy.opacity, 0) >
        0.02,
    ),
  ).toBe(true);
  const firstVisible = answering.find((frame) => frame.pointer && frame.pointer.opacity > 0.02);
  expect(firstVisible).toBeDefined();
  expect(firstVisible!.progress).toBeLessThan(0.25);
  expect(forbidden).toEqual([]);
});

test("normal action pause: closing step details preserves the paused native crossfade until explicit resume", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const beats = savedBeats("personal-website");
  const start = beats.findIndex((beat) => beat.replayAction?.kind === "questions");
  const forbidden = await openReplay(page, "personal-website", "慢速");
  await seek(page, start + 1);
  await startSampling(page);
  await page.getByRole("button", { name: "继续放映", exact: true }).click();
  await page.waitForFunction(
    (step) =>
      document.querySelector('.c-time [aria-current="step"]')?.getAttribute("aria-label") ===
        `第 ${step} 步` && !!document.querySelector("[data-replay-content-retiring=true]"),
    start + 2,
  );
  await page.getByRole("button", { name: "暂停放映", exact: true }).click();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const latest = () => page.evaluate(() => (window as SamplerWindow).__actionFrames!.at(-1)!);
  const paused = await latest();
  await info.attach("paused-crossfade-before-details", {
    body: JSON.stringify(paused),
    contentType: "application/json",
  });
  const crossfade = (frame: ActionFrame) =>
    frame.nativeEffects.filter(
      (effect) =>
        (effect.directPart || effect.retiring) &&
        effect.properties.some((property) => property === "opacity" || property === "transform"),
    );
  const pausedMotion = crossfade(paused);
  expect(pausedMotion.length).toBeGreaterThan(0);
  expect(pausedMotion.every((effect) => effect.state === "paused")).toBe(true);
  await page.getByRole("button", { name: `查看第 ${start + 2} 步`, exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".c-pull")).toBeVisible();
  await page.getByRole("button", { name: "收起这张卡片", exact: true }).click();
  await expect(page.locator(".c-pull")).toHaveCount(0);
  await page.waitForTimeout(200);
  const returned = await latest();
  await info.attach("paused-details-native-crossfade", {
    body: JSON.stringify({ paused, returned }),
    contentType: "application/json",
  });
  expect(returned.step).toBe(paused.step);
  expect(returned.heading!.opacity).toBeCloseTo(paused.heading!.opacity, 3);
  expect(returned.footer!.opacity).toBeCloseTo(paused.footer!.opacity, 3);
  expect(returned.copies.map((copy) => copy.opacity)).toEqual(
    paused.copies.map((copy) => copy.opacity),
  );
  const returnedMotion = crossfade(returned);
  expect(returnedMotion.map((effect) => effect.id)).toEqual(
    pausedMotion.map((effect) => effect.id),
  );
  for (let index = 0; index < pausedMotion.length; index++) {
    expect(returnedMotion[index].state).toBe("paused");
    expect(Math.abs(returnedMotion[index].time! - pausedMotion[index].time!)).toBeLessThanOrEqual(
      1,
    );
  }
  await page.getByRole("button", { name: "继续放映", exact: true }).click();
  await page.waitForTimeout(40);
  // Native finish, DOM cleanup and logical progress can occupy separate sampled frames.
  // Inspect the first native time advancement without selecting an expected play state.
  const resumedSample = await page.waitForFunction(
    ({ after, held }) => {
      const samples = ((window as SamplerWindow).__actionFrames ?? []).filter(
        (frame) => frame.at > after,
      );
      const motion = (frame: ActionFrame) =>
        frame.nativeEffects.filter(
          (effect) =>
            (effect.directPart || effect.retiring) &&
            effect.properties.some(
              (property) => property === "opacity" || property === "transform",
            ),
        );
      const firstAdvance = samples.find((frame) =>
        motion(frame).some((effect) => {
          const previous = held.find((entry) => entry.id === effect.id);
          return (
            previous &&
            previous.time !== null &&
            effect.time !== null &&
            effect.time > previous.time
          );
        }),
      );
      if (firstAdvance && !motion(firstAdvance).every((effect) => effect.state === "finished"))
        return firstAdvance;
      const current = samples.at(-1);
      if (!current) return false;
      const effects = motion(current);
      if (effects.length)
        return effects.every((effect) => effect.state === "finished") ? false : current;
      if (!samples.some((frame) => motion(frame).some((effect) => effect.state === "finished")))
        return current;
      const previous = samples.at(-2);
      if (!previous || motion(previous).length || previous.copies.length || current.copies.length)
        return false;
      return current;
    },
    { after: returned.at, held: returnedMotion },
    { timeout: 5000 },
  );
  const resumed = (await resumedSample.jsonValue()) as ActionFrame;
  await resumedSample.dispose();
  const resumedMotion = crossfade(resumed);
  const frames = await finishSampling(page, info);
  const remaining = Math.max(...pausedMotion.map((effect) => effect.duration - effect.time!));
  const logicalElapsed =
    (resumed.progress - returned.progress) * playbackDuration(beats[start + 1]);
  await info.attach("resumed-details-native-crossfade", {
    body: JSON.stringify({
      resumed,
      remainingActiveDurationMs: remaining,
      logicalElapsedMs: logicalElapsed,
    }),
    contentType: "application/json",
  });
  expect(resumed.step).toBe(returned.step);
  expect(resumed.paperId).toBe(paused.paperId);
  for (const frame of frames.filter((frame) => frame.at > returned.at))
    for (const effect of crossfade(frame)) {
      const previous = pausedMotion.find((entry) => entry.id === effect.id);
      expect(previous).toBeDefined();
      expect(effect.time!).toBeGreaterThanOrEqual(previous!.time!);
    }
  if (resumedMotion.length) {
    expect(resumedMotion.map((effect) => effect.id)).toEqual(
      pausedMotion.map((effect) => effect.id),
    );
    expect(resumedMotion.every((effect) => effect.state === "running")).toBe(true);
    expect(
      resumedMotion.some(
        (effect) => effect.time! > pausedMotion.find((entry) => entry.id === effect.id)!.time!,
      ),
    ).toBe(true);
  } else {
    expect(logicalElapsed).toBeGreaterThanOrEqual(remaining);
    expect(resumed.heading!.opacity).toBeGreaterThan(0.95);
    expect(resumed.footer!.opacity).toBeGreaterThan(0.95);
    expect(resumed.heading!.text).toBe(returned.heading!.text);
    expect(resumed.copies).toEqual([]);
  }
  expect(forbidden).toEqual([]);
});

for (const boundary of ["first-start-paused", "paused-resize", "playing-resize"] as const) {
  test(`explicit geometry fixture: content crossfade preserves native clocks at ${boundary}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const beats = savedBeats("personal-website");
    const start = beats.findIndex((beat) => beat.replayAction?.kind === "questions");
    const forbidden = await openReplay(page, "personal-website", "慢速");
    await seek(page, start + 1);
    // Explicit geometry fixture makes the content-height branch deterministic.
    // Saved actions and the native animation implementation stay in use.
    await page.addStyleTag({
      content:
        '.console-shell .replay-question-scene { max-height: none; } .replay-question-scene[data-replay-action="questions"] { height: 620px; } .replay-question-scene[data-replay-action="answer"] { height: 360px; }',
    });
    await observeContentClock(page);
    await page.getByRole("button", { name: "继续放映", exact: true }).click();
    await page.waitForFunction(() => {
      const effects = (window as ContentClockWindow).__contentClock!.read().effects;
      return (
        effects.filter((effect) => effect.kind === "opacity").length === 4 &&
        effects.some((effect) => effect.kind === "height") &&
        effects.every((effect) => effect.state === "paused")
      );
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const snapshot = () =>
      page.evaluate(() => (window as ContentClockWindow).__contentClock!.read());
    const initial = await snapshot();
    expect(initial.effects.every((effect) => effect.time === 0)).toBe(true);
    await page.waitForTimeout(80);
    const initialHeld = await snapshot();
    expect(initialHeld.effects).toEqual(initial.effects);

    let held = initialHeld;
    if (boundary === "paused-resize") {
      await page.setViewportSize({ width: 344, height: 844 });
      held = await snapshot();
      const previousHeight = initial.effects.find((effect) => effect.kind === "height")!;
      const nextHeight = held.effects.find((effect) => effect.kind === "height")!;
      expect(nextHeight.id).not.toBe(previousHeight.id);
      expect(nextHeight.state).toBe("paused");
      expect(nextHeight.time).toBe(0);
      expect(nextHeight.writes).toBe(1);
      expect(held.effects.filter((effect) => effect.kind === "opacity")).toEqual(
        initial.effects.filter((effect) => effect.kind === "opacity"),
      );
      await page.waitForTimeout(80);
      expect((await snapshot()).effects).toEqual(held.effects);
    } else {
      await page.evaluate(
        ({ kind, initialHeightId }) => {
          const probe = (window as ContentClockWindow).__contentClock!;
          probe.pauseAfterPlay = kind;
          probe.excludedPlayId = initialHeightId;
        },
        {
          kind: boundary === "playing-resize" ? ("height" as const) : ("opacity" as const),
          initialHeightId: initial.effects.find((effect) => effect.kind === "height")!.id,
        },
      );
      await page.getByRole("button", { name: "继续放映", exact: true }).click();
      if (boundary === "playing-resize") await page.setViewportSize({ width: 344, height: 844 });
      await expect(page.getByRole("button", { name: "继续放映", exact: true })).toBeVisible();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      held = await snapshot();
      expect(held.effects.length).toBe(initial.effects.length);
      expect(held.effects.every((effect) => effect.state === "paused" && effect.time > 0)).toBe(
        true,
      );
      if (boundary === "playing-resize") {
        const height = held.effects.find((effect) => effect.kind === "height")!;
        expect(height.id).not.toBe(initial.effects.find((effect) => effect.kind === "height")!.id);
        expect(height.writes).toBe(1);
      }
    }

    await page.getByRole("button", { name: "继续放映", exact: true }).click();
    await page.waitForFunction((baseline) => {
      const current = (window as ContentClockWindow).__contentClock!.read().effects;
      return baseline.every((previous) =>
        current.some((effect) => effect.id === previous.id && effect.time > previous.time),
      );
    }, held.effects);
    const record = await page.evaluate(() => {
      const probe = (window as ContentClockWindow).__contentClock!;
      probe.stopped = true;
      return { frames: probe.frames, resumed: probe.read() };
    });
    await info.attach(`content-clock-${boundary}`, {
      body: JSON.stringify({
        classification: "explicit-css-geometry-fixture-native-waapi-observation",
        initial,
        held,
        ...record,
      }),
      contentType: "application/json",
    });
    for (const previous of held.effects) {
      const resumed = record.resumed.effects.find((effect) => effect.id === previous.id)!;
      expect(resumed).toBeDefined();
      expect(resumed.state).toBe("running");
      expect(resumed.writes).toBe(
        boundary === "playing-resize" && previous.kind === "height" ? 1 : 2,
      );
      let last = previous.time;
      for (const frame of record.frames.filter((frame) => frame.at > held.at)) {
        const effect = frame.effects.find((effect) => effect.id === previous.id);
        if (!effect) continue;
        expect(effect.time).toBeGreaterThanOrEqual(last);
        last = effect.time;
      }
    }
    expect(forbidden).toEqual([]);
  });
}

test("explicit UI fixture: a450ms unknown answer keeps unresolved state and flat old content across the next action", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => sessionStorage.setItem("arena-intro", "1"));
  const snapshot = configureFixtureModels(fixtureSnapshot());
  const version = snapshot.versions[0];
  version.workflow = "clarification";
  version.status = "paused";
  version.stage = "judge";
  version.challenge.goal = "【测试替身】未知回答的450ms跨步骤文字承接。";
  const date = "2026-11-14T00:00:00.000Z";
  const questions: IntakeQuestion[] = ["scope_unknown", "style_known"].map((id) => ({
    id,
    decisionId: id,
    title: id === "scope_unknown" ? "【测试替身】尚不能决定的范围" : "【测试替身】下一项风格",
    reason: "【测试替身】只验证正常动效，不使用真实用户回答。",
    type: "single",
    options: ["【测试替身】选项甲", "【测试替身】选项乙"],
    placeholder: "",
    unit: "",
  }));
  const items: DecisionItem[] = questions.map((question) => ({
    id: question.id,
    topic: question.id === "scope_unknown" ? "scope" : "style",
    title: question.title,
    description: question.reason,
    dependsOn: [],
    required: true,
    acceptance: [],
    sourceRefs: [],
  }));
  const answers: RecordedAnswer[] = [
    {
      questionId: questions[0].id,
      question: questions[0],
      state: "unknown",
      value: "",
      confirmation: "pending",
    },
    {
      questionId: questions[1].id,
      question: questions[1],
      state: "answered",
      value: questions[1].options[1],
      confirmation: "pending",
    },
  ];
  const run = (id: string, role: "A" | "B", round: number): ClarificationRun => ({
    id,
    operationId: `explicit-operation-${id}`,
    role,
    round,
    basedOnRevision: round - 1,
    status: "completed",
    summary: "【测试替身】预设角色记录，不调用模型。",
    output:
      role === "B"
        ? {
            summary: "【测试替身】预设问题",
            questions: questions.map((question) => ({ ...question, decisionId: question.id })),
            conflicts: [],
          }
        : { summary: "【测试替身】预设拆解", items, retired: [], suggestions: [] },
    usage: [],
    createdAt: date,
  });
  version.clarification = {
    protocol: "clarification-1",
    items,
    retiredIds: [],
    runs: [run("explicit-a1", "A", 1), run("explicit-b1", "B", 1), run("explicit-a2", "A", 2)],
    rounds: [
      {
        round: 1,
        revision: 0,
        questions: questions.map((question) => ({ ...question, decisionId: question.id })),
        answers: [],
        changes: { added: [], retired: [], changed: [], triggerAnswerIds: [] },
        runIds: ["explicit-a1", "explicit-b1"],
        createdAt: date,
      },
      {
        round: 2,
        revision: 1,
        questions: [],
        answers,
        changes: { added: [], retired: [], changed: [], triggerAnswerIds: [] },
        runIds: ["explicit-a2"],
        createdAt: date,
      },
    ],
    suggestions: [],
    conflicts: [],
    review: null,
    next: "completed",
    draftOnly: true,
    specification: "【测试替身】草稿。范围仍为未知，不得替用户选择。",
    executionPrompt: "【测试替身】执行前继续确认未知范围。",
  };
  const steps = beatsOf(version);
  const unknown = steps.findIndex(
    (step) =>
      step.replayAction?.kind === "answer" && step.replayAction.answers?.[0].state === "unknown",
  );
  expect(unknown).toBeGreaterThan(0);
  expect(playbackDuration(steps[unknown])).toBe(450);
  expect(steps[unknown + 1].replayAction?.kind).toBe("answer");
  const requests: string[] = [];
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push(`${request.method()} ${path}`);
    if (path === "/api/health")
      return route.fulfill({ json: { status: "ok", model: snapshot.model, accessGranted: true } });
    if (path === "/api/identity")
      return route.fulfill({ json: { identityTag: "e".repeat(64), hasRecoveryCode: false } });
    if (path === `/api/arenas/${snapshot.id}` && request.method() === "GET")
      return route.fulfill({ json: snapshot });
    if (path.endsWith("/events"))
      return route.fulfill({ contentType: "text/event-stream", body: ": explicit fixture\n\n" });
    return route.fulfill({
      status: 404,
      json: { error: "Explicit unknown-motion fixture boundary." },
    });
  });
  await page.goto(`/?arena=${snapshot.id}`);
  await page.locator(".c-root").waitFor();
  await seek(page, unknown);
  await startSampling(page);
  await playThrough(page, unknown + 2);
  const frames = await finishSampling(page, info, "explicit-ui-fixture-native-dom-and-raf-only");
  checkStableStructure(frames);
  const active = frames.filter((frame) => frame.step === unknown + 1 || frame.step === unknown + 2);
  expect(active.length).toBeGreaterThan(3);
  expect(
    active.every((frame) => frame.copies.length <= 1 && frame.nestedRetiringCopies === 0),
  ).toBe(true);
  expect(active.every((frame) => frame.paperHeight > 100)).toBe(true);
  const reading = active.filter(
    (frame) => frame.fold === 0 && frame.paperOpened && frame.bodyScrollPhase === "reading",
  );
  expect(reading.length).toBeGreaterThan(0);
  expect(
    reading.every(
      (frame) =>
        (frame.heading?.opacity ?? 0) + frame.copies.reduce((sum, copy) => sum + copy.opacity, 0) >
        0.02,
    ),
  ).toBe(true);
  const unresolved = active
    .filter((frame) => frame.step === unknown + 2 || frame.progress >= 0.75)
    .flatMap((frame) => frame.questions.filter((question) => question.id === questions[0].id));
  expect(unresolved.length).toBeGreaterThan(0);
  expect(
    unresolved.every(
      (question) =>
        question.state === "unknown" &&
        question.confirmation === "pending" &&
        question.checked === 0,
    ),
  ).toBe(true);
  expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
});

test("explicit legacy UI fixture: unfinished opening bands settle once across a live reduced-motion change", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => sessionStorage.removeItem("arena-intro"));
  const snapshot = configureFixtureModels(fixtureSnapshot());
  advanceFixture(snapshot);
  snapshot.versions[0].status = "running";
  snapshot.versions[0].challenge.goal = "【测试替身】原版纸面首次入场与减少动效恢复。";
  expect(snapshot.versions[0].workflow).toBeUndefined();
  const requests: string[] = [];
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push(`${request.method()} ${path}`);
    if (path === "/api/health")
      return route.fulfill({ json: { status: "ok", model: snapshot.model, accessGranted: true } });
    if (path === "/api/identity")
      return route.fulfill({ json: { identityTag: "f".repeat(64), hasRecoveryCode: false } });
    if (path === `/api/arenas/${snapshot.id}` && request.method() === "GET")
      return route.fulfill({ json: snapshot });
    if (path === `/api/arenas/${snapshot.id}/advance` && request.method() === "POST") {
      snapshot.versions[0].status = "paused";
      return route.fulfill({ json: snapshot });
    }
    if (path.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: ": explicit legacy fixture\n\n",
      });
    return route.fulfill({
      status: 404,
      json: { error: "Explicit legacy opening fixture boundary." },
    });
  });
  await page.goto(`/?arena=${snapshot.id}`);
  await page.waitForFunction(() => {
    const root = document.querySelector<HTMLElement>(".c-root.opening:not(.clarification-replay)");
    const hud = root?.querySelector(":scope > .c-hud");
    return root?.getAnimations({ subtree: true }).some((animation) => {
      if (!(animation instanceof CSSAnimation) || animation.animationName !== "band-up")
        return false;
      const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
      return (
        target instanceof HTMLElement &&
        target.parentElement === hud &&
        typeof animation.currentTime === "number" &&
        animation.currentTime >= 1400 &&
        animation.currentTime < 1650 &&
        animation.playState === "running"
      );
    });
  });
  const pose = () =>
    page.evaluate(() => {
      const root = document.querySelector<HTMLElement>(".c-root")!;
      const hud = root.querySelector<HTMLElement>(":scope > .c-hud")!;
      const rail = root.querySelector<HTMLElement>(".c-rail")!;
      const title = root.querySelector<HTMLElement>(".c-slate h1")!;
      const after = getComputedStyle(title, "::after");
      const entranceNames = ["c-console-enter", "c-hud-enter", "c-drop", "band-in", "band-up"];
      const opacity = (element: HTMLElement) => {
        let value = 1;
        for (let node: HTMLElement | null = element; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.display === "none" || style.visibility === "hidden") return 0;
          value *= Number(style.opacity);
        }
        return value;
      };
      const animationRecord = (animation: Animation) => ({
        name: animation instanceof CSSAnimation ? animation.animationName : null,
        state: animation.playState,
        pending: animation.pending,
        time: typeof animation.currentTime === "number" ? animation.currentTime : null,
        duration: animation.effect?.getTiming().duration,
        delay: animation.effect?.getTiming().delay,
        progress: animation.effect?.getComputedTiming().progress,
        pseudoElement:
          animation.effect instanceof KeyframeEffect
            ? (animation.effect as KeyframeEffect & { pseudoElement?: string }).pseudoElement
            : null,
      });
      return {
        at: performance.now(),
        opening: root.classList.contains("opening"),
        shellEntered: root.dataset.shellEntered === "true",
        rail: {
          opacity: opacity(rail),
          animations: rail
            .getAnimations()
            .filter(
              (animation) =>
                animation instanceof CSSAnimation && animation.animationName === "band-side",
            )
            .map(animationRecord),
        },
        titleAfter: {
          transform: after.transform,
          opacity: after.opacity,
          animationName: after.animationName,
          animations: root
            .getAnimations({ subtree: true })
            .filter(
              (animation) =>
                animation instanceof CSSAnimation &&
                animation.animationName === "rule-draw" &&
                animation.effect instanceof KeyframeEffect &&
                animation.effect.target === title &&
                (animation.effect as KeyframeEffect & { pseudoElement?: string }).pseudoElement ===
                  "::after",
            )
            .map(animationRecord),
        },
        parts: [root, ...hud.children].map((node) => {
          const style = getComputedStyle(node);
          return {
            tag: node.tagName,
            className: node.className,
            opacity: Number(style.opacity),
            display: style.display,
            visibility: style.visibility,
            entranceAnimations: node
              .getAnimations()
              .filter(
                (animation) =>
                  animation instanceof CSSAnimation &&
                  entranceNames.includes(animation.animationName),
              )
              .map((animation) => ({
                name: (animation as CSSAnimation).animationName,
                state: animation.playState,
                time: typeof animation.currentTime === "number" ? animation.currentTime : null,
                duration: animation.effect?.getTiming().duration,
                delay: animation.effect?.getTiming().delay,
                progress: animation.effect?.getComputedTiming().progress,
              })),
          };
        }),
      };
    });
  const before = await pose();
  await info.attach("legacy-unfinished-opening-before-reduce", {
    body: JSON.stringify(before),
    contentType: "application/json",
  });
  expect(before.opening).toBe(true);
  expect(before.shellEntered).toBe(false);
  expect(
    before.parts.some((part) =>
      part.entranceAnimations.some(
        (animation) => animation.name === "band-up" && animation.state === "running",
      ),
    ),
  ).toBe(true);
  await page.waitForFunction(() => {
    const root = document.querySelector<HTMLElement>(".c-root.opening:not(.clarification-replay)");
    const title = root?.querySelector<HTMLElement>(".c-slate h1");
    return root
      ?.getAnimations({ subtree: true })
      .some(
        (animation) =>
          animation instanceof CSSAnimation &&
          animation.animationName === "rule-draw" &&
          animation.effect instanceof KeyframeEffect &&
          animation.effect.target === title &&
          (animation.effect as KeyframeEffect & { pseudoElement?: string }).pseudoElement ===
            "::after" &&
          typeof animation.currentTime === "number" &&
          animation.currentTime >= 1760 &&
          animation.currentTime < 1860 &&
          animation.playState === "running",
      );
  });
  const beforeRuleFinished = await pose();
  await info.attach("legacy-original-rule-still-running-after-bands", {
    body: JSON.stringify(beforeRuleFinished),
    contentType: "application/json",
  });
  expect(beforeRuleFinished.opening).toBe(true);
  expect(beforeRuleFinished.shellEntered).toBe(false);
  expect(
    beforeRuleFinished.titleAfter.animations.some(
      (animation) => animation.state === "running" && animation.progress! < 1,
    ),
  ).toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const reduced = await pose();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const restored = await pose();
  await info.attach("legacy-opening-reduce-and-restored", {
    body: JSON.stringify({ reduced, restored }),
    contentType: "application/json",
  });
  for (const state of [reduced, restored]) {
    expect(state.opening).toBe(true);
    expect(state.shellEntered).toBe(true);
    const visible = state.parts.filter(
      (part) => part.display !== "none" && part.visibility !== "hidden",
    );
    expect(visible.length).toBeGreaterThan(1);
    expect(visible.every((part) => part.opacity === 1)).toBe(true);
    expect(state.parts.every((part) => part.entranceAnimations.length === 0)).toBe(true);
    expect(state.rail.opacity).toBe(1);
    expect(state.rail.animations).toEqual([]);
    expect(state.titleAfter.animations).toEqual([]);
  }
  await info.attach("legacy-opening-explicit-api-boundary", {
    body: JSON.stringify({ requests, newModelCalls: 0, realProductWrites: 0 }),
    contentType: "application/json",
  });
  expect(
    requests.every(
      (request) =>
        request.startsWith("GET ") || request === `POST /api/arenas/${snapshot.id}/advance`,
    ),
  ).toBe(true);
});
