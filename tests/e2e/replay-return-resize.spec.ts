import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { beatsOf } from "../../src/components/console/beats";
import type { RecordedExamplePayload } from "../../src/lib/recorded-examples";

// Read-only saved real-model simulations, with simulated answers. These checks
// observe native animation geometry. Physical pixel cadence needs separate capture.
type Box = { x: number; y: number; width: number; height: number };
type Owner = { node: HTMLElement; natural: Box };
type Redirect = {
  time: number;
  duration: number;
  expected: Box[];
  opacity: number;
};
type Redirected = {
  duration: number;
  destination: { x: number; y: number };
  owners: Array<{ first: Box; last: Box; state: string; time: number; strip: boolean }>;
  opacity: number;
};
type ProbeWindow = Window & {
  __returnProbe?: {
    paper: HTMLElement;
    driver: Animation;
    owners: Owner[];
    before?: Redirect;
    after?: Redirected;
  };
  __returnHistory?: Array<{ action: string; identity: number }>;
  __returnSampling?: boolean;
};

function savedBeats() {
  const payload = JSON.parse(
    readFileSync("public/recorded-examples/personal-website.json", "utf8"),
  ) as RecordedExamplePayload;
  const version = payload.arena.versions.find(
    (entry) => entry.id === payload.arena.activeVersionId,
  )!;
  return beatsOf(version, payload.replayActions);
}

async function openReplay(page: Page) {
  const forbidden: string[] = [];
  await page.route("**/api/**", (route) => {
    forbidden.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.abort();
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/examples/personal-website");
  await page.getByRole("button", { name: "暂停自动开始", exact: true }).click();
  await page.getByRole("button", { name: "开始回看", exact: true }).click();
  await page.locator(".initial-paper-transfer").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "暂停放映", exact: true }).click();
  const speed = page.getByRole("button", { name: "放映速度", exact: true });
  for (let attempt = 0; attempt < 3 && (await speed.textContent()) !== "常速"; attempt++)
    await speed.click();
  await expect(speed).toHaveText("常速");
  return forbidden;
}

async function seekPrecedingStep(page: Page, step: number) {
  // A real keyboard selection settles the preceding step. Resume then enters the
  // target naturally, including C -> summary acknowledgement -> final handoff.
  await page.getByRole("button", { name: `第 ${step} 步`, exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('.c-time [aria-current="step"]')).toHaveAttribute(
    "aria-label",
    `第 ${step} 步`,
  );
  await page.evaluate(() => {
    const target = window as ProbeWindow;
    const identities = new WeakMap<HTMLElement, number>();
    let identity = 0;
    target.__returnHistory = [];
    target.__returnSampling = true;
    const tick = () => {
      if (!target.__returnSampling) return;
      const paper = document.querySelector<HTMLElement>(".c-stage3 > .replay-question-scene");
      if (paper) {
        if (!identities.has(paper)) identities.set(paper, ++identity);
        const entry = { action: paper.dataset.replayAction!, identity: identities.get(paper)! };
        const last = target.__returnHistory!.at(-1);
        if (!last || last.action !== entry.action || last.identity !== entry.identity)
          target.__returnHistory!.push(entry);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.getByRole("button", { name: "继续放映", exact: true }).click();
}

async function armResize(page: Page, action: string, paused: boolean, receiver: string) {
  await page.waitForFunction((kind) => {
    const paper = document.querySelector<HTMLElement>(".c-stage3 > .replay-question-scene");
    if (paper?.dataset.replayAction !== kind) return false;
    const owner = document.querySelector<HTMLElement>(".replay-handoff-strip") ?? paper;
    return owner.getAnimations().some((animation) => {
      if (!(animation.effect instanceof KeyframeEffect) || animation.effect.target !== owner)
        return false;
      const transform = animation.effect.getKeyframes().some((frame) => frame.transform);
      const duration = Number(animation.effect.getTiming().duration);
      const progress = Number(animation.currentTime) / duration;
      return transform && animation.playState === "running" && progress > 0.1 && progress < 0.35;
    });
  }, action);
  if (paused) await page.getByRole("button", { name: "暂停放映", exact: true }).click();
  await page.evaluate((receiverSelector) => {
    const target = window as ProbeWindow;
    const paper = document.querySelector<HTMLElement>(".c-stage3 > .replay-question-scene")!;
    const strip = document.querySelector<HTMLElement>(".replay-handoff-strip");
    const owner = strip ?? paper;
    const ownTransform = (node: HTMLElement) =>
      node
        .getAnimations()
        .find(
          (animation) =>
            animation.effect instanceof KeyframeEffect &&
            animation.effect.target === node &&
            animation.effect.getKeyframes().some((frame) => frame.transform),
        )!;
    const driver = ownTransform(owner);
    const owners = [paper, ...(strip ? [strip] : [])].map((node) => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
      const box = node.getBoundingClientRect();
      return {
        node,
        natural: {
          x: box.left + box.width / 2 + scrollX - matrix.m41 - node.offsetWidth / 2,
          y: box.top + box.height / 2 + scrollY - matrix.m42 - node.offsetHeight / 2,
          width: node.offsetWidth,
          height: node.offsetHeight,
        },
      };
    });
    const probe = { paper, driver, owners } as NonNullable<ProbeWindow["__returnProbe"]>;
    target.__returnProbe = probe;
    const original = driver.cancel;
    driver.cancel = function () {
      // Passive instrumentation preserves native time and the real cancel operation.
      probe.before = {
        time: Number(this.currentTime),
        duration: Number(this.effect!.getTiming().duration),
        opacity: Number(getComputedStyle(owner).opacity),
        expected: owners.map(({ node, natural }) => {
          const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
          const width = natural.width * matrix.m11;
          const height = natural.height * matrix.m22;
          return {
            x: natural.x + natural.width / 2 + matrix.m41 - width / 2,
            y: natural.y + natural.height / 2 + matrix.m42 - height / 2,
            width,
            height,
          };
        }),
      };
      original.call(this);
    };
    window.addEventListener(
      "resize",
      () => {
        const currentStrip = document.querySelector<HTMLElement>(".replay-handoff-strip");
        const currentOwners = [paper, ...(currentStrip ? [currentStrip] : [])];
        const primary = currentStrip ?? paper;
        const currentDriver = ownTransform(primary);
        const destination = document.querySelector(receiverSelector)!.getBoundingClientRect();
        const opacityEffect = primary
          .getAnimations()
          .find(
            (animation) =>
              animation.effect instanceof KeyframeEffect &&
              animation.effect.target === primary &&
              animation.effect.getKeyframes().some((frame) => frame.opacity !== undefined),
          )!;
        probe.after = {
          duration: Number(currentDriver.effect!.getTiming().duration),
          destination: {
            x: destination.left + destination.width / 2 + scrollX,
            y: destination.top + destination.height / 2 + scrollY,
          },
          opacity: Number((opacityEffect.effect as KeyframeEffect).getKeyframes()[0].opacity),
          owners: currentOwners.map((node) => {
            const animation = ownTransform(node);
            const frames = (animation.effect as KeyframeEffect).getKeyframes();
            const current = new DOMMatrixReadOnly(getComputedStyle(node).transform);
            const box = node.getBoundingClientRect();
            const center = {
              x: box.left + box.width / 2 + scrollX - current.m41,
              y: box.top + box.height / 2 + scrollY - current.m42,
            };
            const projected = (frame: ComputedKeyframe) => {
              const matrix = new DOMMatrixReadOnly(String(frame.transform));
              const width = node.offsetWidth * matrix.m11;
              const height = node.offsetHeight * matrix.m22;
              return {
                x: center.x + matrix.m41 - width / 2,
                y: center.y + matrix.m42 - height / 2,
                width,
                height,
              };
            };
            return {
              first: projected(frames[0]),
              last: projected(frames.at(-1)!),
              state: animation.playState,
              time: Number(animation.currentTime),
              strip: node === currentStrip,
            };
          }),
        };
      },
      { once: true },
    );
  }, receiver);
}

for (const width of [390, 1440]) {
  for (const kind of ["round_confirm", "handoff"] as const) {
    for (const paused of [false, true]) {
      test(`normal return resize: ${kind} ${paused ? "paused" : "moving"} at ${width}px`, async ({
        page,
      }, info) => {
        test.setTimeout(45000);
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        const beats = savedBeats();
        const round = beats.findIndex(
          (beat, index) =>
            beat.replayAction?.kind === "round_confirm" && !!beats[index + 1]?.clarificationRun,
        );
        const acknowledged = beats.findIndex(
          (beat) => beat.replayAction?.kind === "summary_confirm",
        );
        expect(beats[acknowledged - 1].clarificationRun?.role).toBe("C");
        expect(beats[acknowledged + 1].replayAction?.kind).toBe("handoff");
        const preceding = kind === "handoff" ? acknowledged : round;
        const nextRole = beats[round + 1].clarificationRun!.role;
        const receiver = kind === "handoff" ? "#verdict" : `[data-board="${nextRole}"]`;
        const forbidden = await openReplay(page);
        await seekPrecedingStep(page, preceding);
        await armResize(page, kind, paused, receiver);
        await page.setViewportSize({
          width: width === 390 ? 430 : 1280,
          height: width === 390 ? 780 : 760,
        });
        // Both resize listeners must publish their samples before geometry is compared.
        await page.waitForFunction(() => {
          const probe = (window as ProbeWindow).__returnProbe;
          return Boolean(probe?.before && probe.after);
        });
        const redirect = await page.evaluate(() => {
          const probe = (window as ProbeWindow).__returnProbe!;
          return { before: probe.before!, after: probe.after! };
        });
        await info.attach("native-return-resize", {
          body: JSON.stringify({ width, kind, paused, redirect }, null, 2),
          contentType: "application/json",
        });
        expect(redirect.before.time).toBeGreaterThan(0);
        expect(redirect.before.time).toBeLessThan(redirect.before.duration);
        expect(
          Math.abs(redirect.after.duration - (redirect.before.duration - redirect.before.time)),
        ).toBeLessThanOrEqual(1);
        expect(Math.abs(redirect.after.opacity - redirect.before.opacity)).toBeLessThanOrEqual(
          0.01,
        );
        for (const [index, owner] of redirect.after.owners.entries()) {
          const expected = redirect.before.expected[index] ?? redirect.before.expected[0];
          for (const key of ["x", "y", "width", "height"] as const)
            expect(Math.abs(owner.first[key] - expected[key])).toBeLessThanOrEqual(1);
          expect(
            Math.abs(owner.last.x + owner.last.width / 2 - redirect.after.destination.x),
          ).toBeLessThanOrEqual(1);
          expect(
            Math.abs(owner.last.y + owner.last.height / 2 - redirect.after.destination.y),
          ).toBeLessThanOrEqual(1);
        }
        if (paused) {
          const held = await page.evaluate(async () => {
            const probe = (window as ProbeWindow).__returnProbe!;
            const identities = new WeakMap<Animation, number>();
            let identity = 0;
            const sample = () => {
              const paper =
                document.querySelector<HTMLElement>(".replay-handoff-strip") ?? probe.paper;
              const box = paper.getBoundingClientRect();
              const matrix = new DOMMatrixReadOnly(getComputedStyle(paper).transform);
              return {
                at: performance.now(),
                scrollX,
                scrollY,
                viewport: { x: box.x, y: box.y, width: box.width, height: box.height },
                document: {
                  x: box.x + scrollX,
                  y: box.y + scrollY,
                  width: box.width,
                  height: box.height,
                },
                natural: {
                  x: box.x + box.width / 2 + scrollX - matrix.m41 - paper.offsetWidth / 2,
                  y: box.y + box.height / 2 + scrollY - matrix.m42 - paper.offsetHeight / 2,
                  width: paper.offsetWidth,
                  height: paper.offsetHeight,
                },
                effects: paper.getAnimations().flatMap((animation) => {
                  if (
                    !(animation.effect instanceof KeyframeEffect) ||
                    animation.effect.target !== paper
                  )
                    return [];
                  if (!identities.has(animation)) identities.set(animation, ++identity);
                  const frames = animation.effect.getKeyframes();
                  return [
                    {
                      id: identities.get(animation)!,
                      state: animation.playState,
                      time: Number(animation.currentTime),
                      duration: animation.effect.getTiming().duration,
                      firstTransform: frames[0].transform ?? null,
                      lastTransform: frames.at(-1)!.transform ?? null,
                    },
                  ];
                }),
              };
            };
            const samples = [sample()];
            // Page navigation intentionally finishes on its interaction clock
            // while the native return stays paused in document coordinates.
            await new Promise((resolve) => setTimeout(resolve, 160));
            for (let frame = 0; frame < 9; frame++) {
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              samples.push(sample());
            }
            return samples;
          });
          await info.attach("paused-document-return-samples", {
            body: JSON.stringify(
              {
                observationContract: {
                  coordinates: "document",
                  approvedTolerancePx: 1,
                  previousAdditionalTolerancePx: 0.1,
                  previousFailuresPreservedAt: [
                    "work/interaction-motion/production-candidate-first/first-failure-raw/47/native-return-resize.json",
                    "work/interaction-motion/production-candidate-first/first-failure-raw/51/native-return-resize.json",
                  ],
                  reason:
                    "The first check compared screen coordinates while page navigation was still scrolling and added an unrequested 0.1px limit. Native return geometry uses document coordinates and the approved 1px tolerance.",
                },
                samples: held,
              },
              null,
              2,
            ),
            contentType: "application/json",
          });
          expect(held).toHaveLength(10);
          for (const sample of held) {
            for (const key of ["x", "y", "width", "height"] as const)
              expect(Math.abs(sample.document[key] - held[0].document[key])).toBeLessThanOrEqual(1);
            expect(sample.effects.length).toBeGreaterThan(0);
            expect(
              sample.effects.every((effect) => effect.state === "paused" && effect.time === 0),
            ).toBe(true);
          }
          await page.getByRole("button", { name: "继续放映", exact: true }).click();
        }
        await page.waitForFunction((action) => {
          const paper = document.querySelector<HTMLElement>(".c-stage3 > .replay-question-scene");
          return !paper || paper.dataset.replayAction !== action;
        }, kind);
        await expect(page.locator(".replay-handoff-strip")).toHaveCount(0);
        const history = await page.evaluate(() => {
          const target = window as ProbeWindow;
          target.__returnSampling = false;
          return target.__returnHistory!;
        });
        if (kind === "handoff") {
          const receipt = history.find((entry) => entry.action === "summary_confirm");
          const handoff = history.find((entry) => entry.action === "handoff");
          expect(receipt).toBeDefined();
          expect(handoff?.identity).toBe(receipt!.identity);
          await expect(page.locator("#verdict")).toBeVisible();
        }
        await info.attach("natural-action-sequence", {
          body: JSON.stringify(history),
          contentType: "application/json",
        });
        expect(forbidden).toEqual([]);
      });
    }
  }
}

test("normal preference seam: a settled reduced action hands its real content to the next normal action", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const beats = savedBeats();
  const answer = beats.findIndex(
    (beat, index) =>
      beat.replayAction?.kind === "answer" && beats[index + 1]?.replayAction?.kind === "answer",
  );
  expect(answer).toBeGreaterThan(0);
  const forbidden = await openReplay(page);
  await seekPrecedingStep(page, answer);
  await page.waitForFunction(
    (step) =>
      document.querySelector('.c-time [aria-current="step"]')?.getAttribute("aria-label") ===
      `第 ${step} 步`,
    answer + 1,
  );
  await page.getByRole("button", { name: "暂停放映", exact: true }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("[data-replay-content-retiring]")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.getByRole("button", { name: "继续放映", exact: true }).click();
  const contentHandle = await page.waitForFunction((step) => {
    if (
      document.querySelector('.c-time [aria-current="step"]')?.getAttribute("aria-label") !==
      `第 ${step} 步`
    )
      return null;
    const paper = document.querySelector<HTMLElement>(".c-stage3 > .replay-question-scene");
    if (!paper?.querySelector("[data-replay-content-retiring]")) return null;
    const old = paper.querySelector<HTMLElement>("[data-replay-content-retiring]");
    const heading = paper.querySelector<HTMLElement>(":scope > header");
    // Capture the native frame synchronously with the successful observation.
    // A locator click can scroll into view for longer than this 220ms fade.
    return {
      at: performance.now(),
      step,
      action: paper.dataset.replayAction,
      progress: document.querySelector<HTMLElement>(".c-root")?.dataset.replayProgress,
      copies: paper.querySelectorAll("[data-replay-content-retiring]").length,
      nestedCopies: paper.querySelectorAll(
        "[data-replay-content-retiring] [data-replay-content-retiring]",
      ).length,
      oldOpacity: old ? Number(getComputedStyle(old).opacity) : 0,
      newOpacity: heading ? Number(getComputedStyle(heading).opacity) : 0,
      livePreference: matchMedia("(prefers-reduced-motion: reduce)").matches,
      effects: paper.getAnimations({ subtree: true }).flatMap((animation) => {
        if (!(animation.effect instanceof KeyframeEffect)) return [];
        const target = animation.effect.target;
        if (!(target instanceof HTMLElement)) return [];
        return [
          {
            target: target.className,
            retiring: !!target.closest("[data-replay-content-retiring]"),
            state: animation.playState,
            time: Number(animation.currentTime),
            duration: animation.effect.getTiming().duration,
            frames: animation.effect
              .getKeyframes()
              .map((frame) => ({ opacity: frame.opacity, offset: frame.computedOffset })),
          },
        ];
      }),
    };
  }, answer + 2);
  const content = (await contentHandle.jsonValue())!;
  await info.attach("reduced-to-normal-next-action", {
    body: JSON.stringify(
      {
        observationContract:
          "The native frame is captured when the expected natural transition is first observed. No subsequent scrolling click can change this recorded frame.",
        previousFailurePreservedAt:
          "work/interaction-motion/production-candidate-first/artifacts/replay-return-resize-norma-8c9b4-t-to-the-next-normal-action-chromium/trace.zip",
        content,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  expect(content.livePreference).toBe(false);
  expect(content.copies).toBe(1);
  expect(content.nestedCopies).toBe(0);
  expect(content.oldOpacity + content.newOpacity).toBeGreaterThanOrEqual(0.98);
  expect(content.effects.some((effect) => effect.retiring && effect.state === "running")).toBe(
    true,
  );
  expect(forbidden).toEqual([]);
});
