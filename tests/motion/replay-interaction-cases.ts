import { expect, test as baseTest, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { displayTest } from "../display/display-validation";
import { RECORDED_EXAMPLES, type RecordedExamplePayload } from "../../src/lib/recorded-examples";
import { buildClarificationReplay } from "../../src/lib/replay";
import { replayChoiceTimes } from "../../src/components/console/ReplayQuestionScene";

// Saved real-model results with explicitly simulated answers. These tests make no model calls.
function recorded(slug: string) {
  const payload = JSON.parse(
    readFileSync(`public/recorded-examples/${slug}.json`, "utf8"),
  ) as RecordedExamplePayload;
  const version = payload.arena.versions.find(
    (entry) => entry.id === payload.arena.activeVersionId,
  )!;
  return { payload, version, steps: buildClarificationReplay(version, payload.replayActions) };
}

async function openReplay(page: Page, slug: string) {
  const forbidden: string[] = [];
  await page.route("**/api/**", (route) => {
    forbidden.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.abort();
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`/examples/${slug}`);
  await page.getByRole("button", { name: "暂停自动开始", exact: true }).click();
  await page.getByRole("button", { name: "开始回看", exact: true }).click();
  await expect(page.getByRole("button", { name: "第 1 步", exact: true })).toHaveAttribute(
    "aria-current",
    "step",
  );
  return forbidden;
}

async function go(page: Page, index: number) {
  await page.getByRole("button", { name: `第 ${index + 1} 步`, exact: true }).click();
}

const metric = (page: Page, label: string) =>
  page
    .locator(".c-metrics > div")
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator("dd");

export function registerReplayInteractionTests(mode: "functional" | "display") {
  const test = mode === "display" ? displayTest : baseTest;
  if (mode === "functional") {
    for (const example of RECORDED_EXAMPLES) {
      for (const width of [1440, 390]) {
        test(`normal animation: ${example.slug} shows choices before answers and confirms only at its own step at ${width}px`, async ({
          page,
        }) => {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
          const { steps } = recorded(example.slug);
          const forbidden = await openReplay(page, example.slug);
          await expect(metric(page, "已确认")).toHaveText("0");
          const questionIndex = steps.findIndex((step) => step.replayAction?.kind === "questions");
          const action = steps[questionIndex].replayAction!;
          await go(page, questionIndex);
          const scene = page.getByRole("region", { name: "补问过程回放", exact: true });
          await expect(scene).toBeVisible();
          const compact = await scene.boundingBox();
          expect(compact).not.toBeNull();
          expect(compact!.width).toBeLessThanOrEqual(660);
          expect(compact!.height).toBeLessThanOrEqual(
            width === 390 ? Math.min(480, 844 * 0.58) + 1 : 480,
          );
          const prefixes = await scene.locator(".gi-answer-options input").evaluateAll((inputs) =>
            inputs.map((input) => ({
              width: input.getBoundingClientRect().width,
              clip: getComputedStyle(input).clipPath,
              opacity: getComputedStyle(input).opacity,
            })),
          );
          expect(
            prefixes.every(
              (input) => input.width <= 1 && input.clip === "inset(50%)" && input.opacity === "0",
            ),
          ).toBe(true);
          for (const question of action.questions!) {
            const field = scene.locator(`[data-question-id="${question.id}"]`);
            await expect(field).toContainText(question.title);
            for (const option of question.options)
              await expect(field.getByLabel(option, { exact: true })).not.toBeChecked();
          }
          await expect(scene).toContainText("按保存记录重建");
          await expect(scene.locator('[data-confirmation="confirmed"]')).toHaveCount(0);
          const callsBefore = String(
            new Set(
              steps
                .slice(0, questionIndex + 1)
                .flatMap((step) => step.clarificationRun?.callIds ?? []),
            ).size,
          );
          await expect(metric(page, "模型调用")).toHaveText(callsBefore);
          const answerIndex = steps.findIndex((step) => step.replayAction?.kind === "answer");
          await go(page, answerIndex);
          await expect(scene).toContainText("待确认");
          await expect(metric(page, "已确认")).toHaveText("0");
          await expect(metric(page, "模型调用")).toHaveText(callsBefore);
          const confirmationIndex = steps.findIndex(
            (step) => step.replayAction?.kind === "round_confirm",
          );
          await go(page, confirmationIndex);
          const confirmed = steps[confirmationIndex].replayAction!.answers!.filter(
            (answer) =>
              answer.state === "answered" &&
              answer.confirmation === "confirmed" &&
              !answer.needsReconfirmation,
          ).length;
          await expect(metric(page, "已确认")).toHaveText(String(confirmed));
          await expect(scene).toContainText("本次确认已记录");
          await expect(page.locator(".c-result-region")).toHaveAttribute("aria-hidden", "true");
          const tickWithinTrack = await page
            .locator(".c-time [aria-current=step]")
            .evaluate((tick) => {
              const current = tick.getBoundingClientRect();
              const track = tick.closest(".c-time")!.getBoundingClientRect();
              return current.left >= track.left - 1 && current.right <= track.right + 1;
            });
          expect(tickWithinTrack).toBe(true);
          await expect(scene.locator(".replay-question-heading")).toBeInViewport({ ratio: 1 });
          await expect(scene.locator(".replay-question-footer")).toBeInViewport({ ratio: 1 });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          ).toBe(true);
          expect(forbidden).toEqual([]);
        });
      }
    }

    test("normal animation: pausing a newly entered B card leaves its text readable", async ({
      page,
    }) => {
      const forbidden = await openReplay(page, "personal-website");
      await page.waitForSelector(".c-board-B.speaking");
      await page.evaluate(() =>
        [...document.querySelectorAll("button")]
          .find((button) => button.textContent?.trim() === "暂停放映")
          ?.click(),
      );
      const text = page.locator(".c-board-B .c-board-body");
      const firstB = recorded("personal-website").steps.find(
        (step) => step.clarificationRun?.role === "B",
      )!.clarificationRun!;
      await expect(text).toContainText(firstB.summary);
      const state = async () =>
        text.evaluate((element) =>
          [...element.children].map((child) => ({
            opacity: Number(getComputedStyle(child).opacity),
            text: child.textContent,
          })),
        );
      expect((await state()).every((child) => child.opacity > 0)).toBe(true);
      const current = await page.locator(".c-time [aria-current=step]").getAttribute("aria-label");
      await page.waitForTimeout(700);
      expect((await state()).every((child) => child.opacity > 0)).toBe(true);
      await expect(page.locator(".c-time [aria-current=step]")).toHaveAttribute(
        "aria-label",
        current!,
      );
      expect(forbidden).toEqual([]);
    });

    test("explicit synthetic fixture: a later successful repair cannot hide the failure being replayed", async ({
      page,
    }) => {
      const { payload } = recorded("personal-website");
      const snapshot = structuredClone(payload.arena);
      const version = snapshot.versions.find((entry) => entry.id === snapshot.activeVersionId)!;
      const originalA = version.clarification!.runs.find((run) => run.role === "A")!;
      const originalB = version.clarification!.runs.find((run) => run.role === "B")!;
      const failed = {
        ...originalB,
        id: "synthetic-failed-review",
        status: "failed" as const,
        summary: "【测试替身】第一次选项审查失败",
        output: { error: "【测试替身】响应格式不合法" },
      };
      const repaired = { ...originalB, id: "synthetic-repaired-review", repairOf: failed.id };
      version.clarification = {
        ...version.clarification!,
        runs: [originalA, failed, repaired],
        rounds: [],
        review: null,
        next: "questions",
        specification: "",
        executionPrompt: "",
      };
      if (version.intake) version.intake.confirmation = undefined;
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.route("**/api/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/health")
          return route.fulfill({
            json: { status: "ok", model: snapshot.model, accessGranted: true },
          });
        if (path === `/api/arenas/${snapshot.id}`) return route.fulfill({ json: snapshot });
        return route.fulfill({
          status: 404,
          json: { error: "Explicit synthetic fixture boundary" },
        });
      });
      await page.goto(`/?arena=${snapshot.id}`);
      await page.getByRole("button", { name: "回放历史过程", exact: true }).click();
      await expect(page.locator(".clarification-replay")).toBeVisible();
      await go(page, 1);
      await expect(page.locator('.c-time [data-round="1"]')).toHaveAttribute(
        "data-state",
        "failed",
      );
      await expect(page.locator('[data-board="B"] > .c-board-body')).toContainText(failed.summary);
      await go(page, 2);
      await expect(page.locator('.c-time [data-round="1"]')).toHaveAttribute(
        "data-state",
        "passed",
      );
    });

    test("normal animation: selection, pause, modal, speed and resume share the same action clock", async ({
      page,
    }) => {
      const { steps } = recorded("personal-website");
      const forbidden = await openReplay(page, "personal-website");
      const questionIndex = steps.findIndex((step) => step.replayAction?.kind === "questions");
      const answerIndex = steps.findIndex((step) => step.replayAction?.kind === "answer");
      await go(page, questionIndex);
      await page.getByRole("button", { name: "继续放映", exact: true }).click();
      const root = page.locator(".c-root");
      await expect(root).toHaveAttribute("data-replay-kind", "answer", { timeout: 12000 });
      await page.waitForFunction(() => {
        const root = document.querySelector<HTMLElement>(".c-root");
        if (root?.dataset.replayKind !== "answer" || Number(root.dataset.replayProgress) < 0.5)
          return false;
        [...root.querySelectorAll("button")]
          .find((button) => button.textContent?.trim() === "暂停放映")
          ?.click();
        return true;
      });
      const progress = await root.getAttribute("data-replay-progress");
      const selected = steps[answerIndex].replayAction!.answers![0];
      const scene = page.getByRole("region", { name: "补问过程回放" });
      await expect(scene.getByLabel(String(selected.value), { exact: true })).toBeChecked();
      await expect(metric(page, "已确认")).toHaveText("0");
      for (let index = 0; index < 3; index++)
        await page.getByRole("button", { name: "放映速度", exact: true }).click();
      await page.waitForTimeout(600);
      await expect(root).toHaveAttribute("data-replay-progress", progress!);
      await page.getByRole("button", { name: "查看 A 需求拆解 的详情", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.waitForTimeout(400);
      await expect(root).toHaveAttribute("data-replay-progress", progress!);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toBeHidden();
      await expect(scene.getByLabel(String(selected.value), { exact: true })).toBeChecked();
      await page.getByRole("button", { name: "继续放映", exact: true }).click();
      await expect(root).toHaveAttribute("data-replay-kind", "round_confirm", { timeout: 6000 });
      await page.waitForFunction(() => {
        const root = document.querySelector<HTMLElement>(".c-root");
        return (
          root?.dataset.replayKind === "round_confirm" &&
          Number(root.dataset.replayProgress) >= 0.84
        );
      });
      await expect(metric(page, "已确认")).toHaveText("1");
      expect(forbidden).toEqual([]);
    });

    for (const width of [1440, 390]) {
      test(`normal animation: final handoff brings the original result into view at ${width}px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        const { steps } = recorded("personal-website");
        const forbidden = await openReplay(page, "personal-website");
        await go(page, steps.length - 2);
        await page.getByRole("button", { name: "继续放映", exact: true }).click();
        await expect(page.locator(".c-root")).toHaveClass(/at-result/, { timeout: 15000 });
        await expect(
          page.getByRole("heading", { name: "需求说明与执行提示词", exact: true }),
        ).toBeInViewport();
        await expect(page.locator(".c-root")).not.toHaveClass(/theater/);
        expect(forbidden).toEqual([]);
      });
    }

    test("normal animation: all three speeds show the same mobile selection and confirmation", async ({
      page,
    }) => {
      test.setTimeout(60000);
      await page.setViewportSize({ width: 390, height: 844 });
      const { steps } = recorded("personal-website");
      const forbidden = await openReplay(page, "personal-website");
      const questionIndex = steps.findIndex((step) => step.replayAction?.kind === "questions");
      const saved = steps.find((step) => step.replayAction?.kind === "answer")!.replayAction!
        .answers![0];
      const root = page.locator(".c-root");
      const scene = page.getByRole("region", { name: "补问过程回放", exact: true });
      for (const speed of ["慢速", "常速", "快速"]) {
        await go(page, questionIndex);
        const control = page.getByRole("button", { name: "放映速度", exact: true });
        for (let click = 0; click < 3 && (await control.textContent()) !== speed; click++)
          await control.click();
        await expect(control).toHaveText(speed);
        await page.getByRole("button", { name: "继续放映", exact: true }).click();
        await expect(root).toHaveAttribute("data-replay-kind", "answer");
        await page.waitForFunction(() => {
          const root = document.querySelector<HTMLElement>(".c-root");
          if (root?.dataset.replayKind !== "answer" || Number(root.dataset.replayProgress) < 0.5)
            return false;
          [...root.querySelectorAll("button")]
            .find((button) => button.textContent?.trim() === "暂停放映")
            ?.click();
          return true;
        });
        await expect(scene.getByLabel(String(saved.value), { exact: true })).toBeChecked();
        await expect(scene.locator(".replay-question-heading")).toBeInViewport({ ratio: 1 });
        await expect(scene.locator(".replay-question-footer")).toBeInViewport({ ratio: 1 });
        await expect(metric(page, "已确认")).toHaveText("0");
        await page.getByRole("button", { name: "继续放映", exact: true }).click();
        await expect(root).toHaveAttribute("data-replay-kind", "round_confirm", { timeout: 8000 });
        await page.waitForFunction(() => {
          const root = document.querySelector<HTMLElement>(".c-root");
          return (
            root?.dataset.replayKind === "round_confirm" &&
            Number(root.dataset.replayProgress) >= 0.84
          );
        });
        await expect(metric(page, "已确认")).toHaveText("1");
        await page.getByRole("button", { name: "暂停放映", exact: true }).evaluate((button) => {
          if (button instanceof HTMLButtonElement) button.click();
        });
      }
      expect(forbidden).toEqual([]);
    });
  }

  // Actual mobile controls scroll the rail into view before dispatching their click.
  // The replay must bring its stable, unfolded paper back into the viewport afterward.
  test("normal animation: mobile seek and resume keep the paper and each pressed control on screen", async ({
    page,
  }, testInfo) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const scenario of [
      { slug: "personal-website", type: "single" },
      { slug: "personal-website", type: "multiple" },
      { slug: "event-registration", type: "text" },
      { slug: "personal-website", type: "summary_submit" },
    ] as const) {
      const { steps } = recorded(scenario.slug);
      const forbidden = await openReplay(page, scenario.slug);
      const index = steps.findIndex(({ replayAction: action }) =>
        scenario.type === "summary_submit"
          ? action?.kind === "summary_submit"
          : action?.kind === "answer" &&
            action.answers?.[0].state === "answered" &&
            action.answers[0].question.type === scenario.type,
      );
      expect(index).toBeGreaterThan(0);
      const action = steps[index].replayAction!;
      const saved = action.answers?.[0];
      const values =
        saved && (saved.question.type === "single" || saved.question.type === "multiple")
          ? Array.isArray(saved.value)
            ? saved.value
            : [saved.value]
          : [];
      await go(page, index);
      const scene = page.getByRole("region", { name: "补问过程回放", exact: true });
      await expect(scene.locator(".replay-question-heading")).toBeInViewport({ ratio: 1 });
      await expect(scene.locator(".replay-question-footer")).toBeInViewport({ ratio: 1 });
      const labelOpacity = await scene
        .locator("fieldset:disabled label")
        .evaluateAll((labels) => labels.map((label) => Number(getComputedStyle(label).opacity)));
      expect(labelOpacity.every((value) => value === 1)).toBe(true);

      await go(page, index - 1);
      // The Functional observer reads the real DOM at the actual pressed mutation.
      // Display retains the original natural rAF observation requirement.
      const parameters = {
        step: index + 1,
        questionId: saved?.questionId,
        values,
        clickTimes: replayChoiceTimes(values.length),
        summary: scenario.type === "summary_submit",
      };
      const observing = page.evaluate(
        ({ mode, parameters }) => {
          const readPressed = ({
            step,
            questionId,
            values,
            clickTimes,
            summary,
          }: {
            step: number;
            questionId?: string;
            values: string[];
            clickTimes: number[];
            summary: boolean;
          }) => {
            const root = document.querySelector(".c-root");
            if (
              root?.querySelector(".c-time [aria-current=step]")?.getAttribute("aria-label") !==
              `第 ${step} 步`
            )
              return null;
            const paper = root.querySelector<HTMLElement>(".replay-question-scene");
            const pointer = paper?.querySelector<HTMLElement>(
              '.replay-question-pointer[data-pressed="true"]',
            );
            if (!paper || !pointer || getComputedStyle(pointer).visibility === "hidden")
              return null;
            const progress = Number(root.getAttribute("data-replay-progress"));
            const fieldset = [...paper.querySelectorAll<HTMLElement>("[data-question-id]")].find(
              (field) => field.dataset.questionId === questionId,
            );
            let target: HTMLElement | null = null;
            if (summary) target = paper.querySelector<HTMLElement>("[data-replay-confirm]");
            else if (values.length) {
              const selectedIndex = Math.max(
                0,
                clickTimes.filter((at) => progress >= at).length - 1,
              );
              const label = [
                ...(fieldset?.querySelectorAll<HTMLElement>("[data-answer-option]") ?? []),
              ].find((option) => option.dataset.answerOption === values[selectedIndex]);
              target = label ?? null;
            } else target = fieldset?.querySelector<HTMLElement>("[data-answer-field]") ?? null;
            if (!target) return null;
            const header = paper
              .querySelector<HTMLElement>(".replay-question-heading")!
              .getBoundingClientRect();
            const footer = paper
              .querySelector<HTMLElement>(".replay-question-footer")!
              .getBoundingClientRect();
            const cursor = pointer.getBoundingClientRect();
            const cursorStyle = getComputedStyle(pointer);
            const box = target.getBoundingClientRect();
            return {
              header: { top: header.top, bottom: header.bottom },
              footer: { top: footer.top, bottom: footer.bottom },
              tip: { x: cursor.left, y: cursor.top },
              pointerStyle: {
                left: cursorStyle.left,
                top: cursorStyle.top,
                filter: cursorStyle.filter,
                transform: pointer.style.transform,
                willChange: cursorStyle.willChange,
              },
              pointerCount: paper.querySelectorAll(".replay-question-pointer").length,
              target: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
              width: innerWidth,
              height: innerHeight,
            };
          };
          return new Promise<ReturnType<typeof readPressed>>((resolve, reject) => {
            let done = false;
            let frameId = 0;
            const finish = () => {
              const frame = readPressed(parameters);
              if (!frame) return false;
              done = true;
              observer.disconnect();
              cancelAnimationFrame(frameId);
              clearTimeout(timeout);
              resolve(frame);
              return true;
            };
            const observer = new MutationObserver(finish);
            const timeout = setTimeout(() => {
              observer.disconnect();
              cancelAnimationFrame(frameId);
              reject(new Error("Actual pressed replay control was not observed."));
            }, 15000);
            if (mode === "display") {
              const tick = () => {
                if (!done && !finish()) frameId = requestAnimationFrame(tick);
              };
              frameId = requestAnimationFrame(tick);
            } else
              observer.observe(document.body, {
                subtree: true,
                attributes: true,
                attributeFilter: ["data-pressed", "data-replay-pressed"],
              });
          });
        },
        { mode, parameters },
      );
      // Use the real click so focus and scrolling match the reported rail path.
      await page.getByRole("button", { name: "继续放映", exact: true }).click();
      const frame = await observing;
      if (!frame) throw new Error("No pressed replay control frame was captured.");
      await testInfo.attach(`pressed-control-${scenario.type}`, {
        body: JSON.stringify({
          samplingMode: mode === "display" ? "natural-raf" : "dom-mutation",
          frame,
        }),
        contentType: "application/json",
      });
      expect(frame.pointerCount).toBe(1);
      expect(frame.pointerStyle).toMatchObject({
        left: "0px",
        top: "0px",
        filter: "none",
        willChange: "transform",
      });
      expect(frame.pointerStyle.transform).toMatch(/^translate3d\(/);
      expect(frame.header.top).toBeGreaterThanOrEqual(0);
      expect(frame.header.bottom).toBeLessThanOrEqual(frame.height);
      expect(frame.footer.top).toBeGreaterThanOrEqual(0);
      expect(frame.footer.bottom).toBeLessThanOrEqual(frame.height);
      expect(frame.tip.x).toBeGreaterThanOrEqual(0);
      expect(frame.tip.x).toBeLessThanOrEqual(frame.width);
      expect(frame.tip.y).toBeGreaterThanOrEqual(0);
      expect(frame.tip.y).toBeLessThanOrEqual(frame.height);
      expect(frame.tip.x).toBeGreaterThanOrEqual(frame.target.left - 3);
      expect(frame.tip.x).toBeLessThanOrEqual(frame.target.right + 3);
      expect(frame.tip.y).toBeGreaterThanOrEqual(frame.target.top - 3);
      expect(frame.tip.y).toBeLessThanOrEqual(frame.target.bottom + 3);

      if (scenario.type === "single") {
        await page.getByRole("button", { name: "放映速度", exact: true }).click();
        await expect(scene.locator(".replay-question-heading")).toBeInViewport({ ratio: 1 });
        await expect(scene.locator(".replay-question-footer")).toBeInViewport({ ratio: 1 });
      }

      await page.getByRole("button", { name: "暂停放映", exact: true }).click();
      await expect(page.getByRole("button", { name: "继续放映", exact: true })).toBeVisible();
      const scrolling = page.evaluate(
        (mode) =>
          new Promise<{ trusted: boolean; positions: number[]; scrollEvents: number }>(
            (resolve) => {
              window.addEventListener(
                "wheel",
                (event) => {
                  const positions = [scrollY];
                  const began = performance.now();
                  let scrollEvents = 0;
                  const scroll = () => {
                    scrollEvents++;
                    if (mode === "functional") positions.push(scrollY);
                  };
                  addEventListener("scroll", scroll);
                  const sample = () => {
                    if (mode === "display") positions.push(scrollY);
                    if (performance.now() - began < 350) requestAnimationFrame(sample);
                    else {
                      removeEventListener("scroll", scroll);
                      if (mode === "functional") positions.push(scrollY);
                      resolve({ trusted: event.isTrusted, positions, scrollEvents });
                    }
                  };
                  requestAnimationFrame(sample);
                },
                { once: true, capture: true },
              );
            },
          ),
        mode,
      );
      await page.mouse.wheel(0, -620);
      const manual = await scrolling;
      await testInfo.attach(`trusted-wheel-${scenario.type}`, {
        body: JSON.stringify({ classification: "automated-trusted-browser-input", ...manual }),
        contentType: "application/json",
      });
      expect(manual.trusted).toBe(true);
      expect(manual.positions.length).toBeGreaterThan(mode === "display" ? 2 : 0);
      expect(
        manual.positions.every((position, at) => !at || position <= manual.positions[at - 1] + 1),
      ).toBe(true);
      expect(forbidden).toEqual([]);
    }
  });
}
