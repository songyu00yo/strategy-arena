import { expect, test as baseTest, type Page, type Route, type TestInfo } from "@playwright/test";
import type { IntakeDraft } from "../../src/lib/intake-contracts";
import { MODEL_CATALOG } from "../../src/lib/model-catalog";
import { configureFixtureModels, fixtureIntake, intakeStorageKey } from "../e2e/intake.fixture";
import { advanceFixture, fixtureSnapshot } from "../e2e/ui.fixture";

import { displayTest } from "../display/display-validation";
import {
  assertNativeMotion,
  cleanupNativeMotionProbe,
  installNativeMotionProbe,
  readNativeMotionProbe,
  type NativeMotionEntry,
} from "./native-motion-probe";

// Explicit UI/API fixtures. The original page controls are used, normal motion
// stays enabled, and no request reaches a model or a user's stored records.
type Pose = {
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  text: string;
  minWidth: string;
  display: string;
  maxWidth: string;
  flexShrink: string;
  ancestors: Array<{
    tag: string;
    className: string;
    display: string;
    width: string;
    maxWidth: string;
    flexShrink: string;
  }>;
  busy: string | null;
  effects: Array<{ state: string; time: number | null; duration: number | string; keys: object[] }>;
};
type MotionFrame = {
  at: number;
  root: Pose | null;
  slots: Record<string, Pose | null>;
  retiring: Array<{
    kind: string;
    text: string;
    opacity: number;
    inert: boolean;
    hidden: string | null;
    scrolls: number[];
  }>;
  focus: { text: string; label: string | null; inRetiring: boolean };
};
type MotionRecord = {
  name: string;
  frames: MotionFrame[];
  events: MotionFrame[];
  native: NativeMotionEntry[];
};

async function installFixture(
  page: Page,
  options: {
    draft?: IntakeDraft;
    api?: (route: Route, url: URL, method: string) => Promise<boolean>;
  } = {},
) {
  const snapshot = configureFixtureModels(fixtureSnapshot());
  snapshot.versions[0].challenge.options = ["【测试替身】方案甲", "【测试替身】方案乙"];
  snapshot.versions[0].modelSelection = {
    requestedMode: "gpt-6.1-terra",
    provider: "openai",
    modelId: "gpt-6.1-terra",
    currency: "USD",
    policyVersion: "explicit-motion-fixture",
    reason: "Explicit UI fixture.",
  };
  for (let stage = 0; stage < 5; stage++) advanceFixture(snapshot);
  let draft = options.draft ?? fixtureIntake();
  const requests: string[] = [];
  const unexpected: string[] = [];
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(
    ({ restore, storageKey }) => {
      sessionStorage.setItem("arena-intro", "1");
      if (restore) localStorage.setItem(storageKey, restore);
      const inputs: unknown[] = [];
      Object.assign(window, { __layoutMotionInputs: inputs });
      for (const type of ["click", "keydown", "input", "change"])
        addEventListener(
          type,
          (event) => {
            const target = event.target instanceof Element ? event.target : null;
            inputs.push({
              type,
              at: performance.now(),
              trusted: event.isTrusted,
              label: target?.getAttribute("aria-label"),
              text: target?.textContent?.trim(),
              key: event instanceof KeyboardEvent ? event.key : undefined,
            });
          },
          true,
        );
    },
    { restore: options.draft?.id, storageKey: intakeStorageKey },
  );
  await page.route("**/api/**", async (route) => {
    const method = route.request().method();
    const url = new URL(route.request().url());
    const path = url.pathname;
    requests.push(`${method} ${path}`);
    if (options.api && (await options.api(route, url, method))) return;
    if (path === "/api/health")
      return route.fulfill({
        json: {
          status: "ok",
          version: "explicit-motion-fixture",
          model: snapshot.model,
          accessGranted: true,
          requiresAccessCode: false,
        },
      });
    if (path === "/api/identity")
      return route.fulfill({ json: { identityTag: "a".repeat(64), hasRecoveryCode: false } });
    if ((path === "/api/arenas" || path === "/api/intakes") && method === "GET")
      return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path.endsWith("/events"))
      return route.fulfill({ contentType: "text/event-stream", body: ": explicit UI fixture\n\n" });
    if (path === `/api/arenas/${snapshot.id}` && method === "GET")
      return route.fulfill({ json: snapshot });
    if (path === "/api/intakes" && method === "POST")
      return route.fulfill({ status: 201, json: draft });
    if (path === `/api/intakes/${draft.id}`) {
      if (method === "PATCH") {
        const { summary, ...fields } = route.request().postDataJSON();
        draft = {
          ...draft,
          ...fields,
          ...(summary ? { challenge: summary.challenge, assumptions: summary.assumptions } : {}),
          revision: draft.revision + 1,
        };
      }
      return route.fulfill({ json: draft });
    }
    if (path.startsWith(`/api/intakes/${draft.id}/attachments/`) && method === "DELETE") {
      const id = path.split("/").at(-1);
      draft = {
        ...draft,
        revision: draft.revision + 1,
        attachments: draft.attachments.filter((file) => file.id !== id),
        sources: draft.sources.filter((source) => source.attachmentId !== id),
      };
      return route.fulfill({ json: draft });
    }
    unexpected.push(`${method} ${path}`);
    return route.fulfill({
      status: 500,
      json: { error: "Explicit UI fixture blocked an unexpected request." },
    });
  });
  return { snapshot, requests, unexpected };
}

async function recordMotion(
  page: Page,
  name: string,
  root: string,
  selectors: Record<string, string>,
  action: () => Promise<unknown>,
  milliseconds = 800,
): Promise<MotionRecord> {
  await installNativeMotionProbe(page, selectors);
  const sampling = page.evaluate(
    ({ root, selectors, milliseconds }) =>
      new Promise<{ frames: MotionFrame[]; events: MotionFrame[] }>((resolve) => {
        const frames: MotionFrame[] = [];
        const events: MotionFrame[] = [];
        const began = performance.now();
        const sample = (at: number, event = false) => {
          const container = document.querySelector<HTMLElement>(root);
          const origin = container?.getBoundingClientRect();
          const pose = (node: HTMLElement | null): Pose | null => {
            if (!node) return null;
            const box = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return {
              x: box.x - (origin?.x ?? 0),
              y: box.y - (origin?.y ?? 0),
              width: box.width,
              height: box.height,
              opacity: Number(style.opacity),
              text: node.textContent ?? "",
              minWidth: style.minWidth,
              display: style.display,
              maxWidth: style.maxWidth,
              flexShrink: style.flexShrink,
              ancestors: node.matches('[aria-haspopup="listbox"]')
                ? (() => {
                    const ancestors = [];
                    for (
                      let parent = node.parentElement;
                      parent && ancestors.length < 4;
                      parent = parent.parentElement
                    ) {
                      const computed = getComputedStyle(parent);
                      ancestors.push({
                        tag: parent.tagName,
                        className: parent.className,
                        display: computed.display,
                        width: computed.width,
                        maxWidth: computed.maxWidth,
                        flexShrink: computed.flexShrink,
                      });
                    }
                    return ancestors;
                  })()
                : [],
              busy: node.getAttribute("aria-busy"),
              effects: node.getAnimations({ subtree: true }).map((animation) => {
                const duration = animation.effect?.getTiming().duration ?? 0;
                return {
                  state: animation.playState,
                  time: typeof animation.currentTime === "number" ? animation.currentTime : null,
                  duration: typeof duration === "number" ? duration : String(duration),
                  keys:
                    animation.effect instanceof KeyframeEffect
                      ? animation.effect.getKeyframes()
                      : [],
                };
              }),
            };
          };
          const retired = [
            ...document.querySelectorAll<HTMLElement>(
              "[data-list-motion-retiring], [data-disclosure-retiring], [data-model-label-retiring]",
            ),
          ];
          const active = document.activeElement;
          (event ? events : frames).push({
            at,
            root: pose(container),
            slots: Object.fromEntries(
              Object.entries(selectors).map(([key, selector]) => [
                key,
                pose(document.querySelector<HTMLElement>(selector)),
              ]),
            ),
            retiring: retired.map((node) => ({
              kind: node.dataset.listMotionRetiring
                ? "list"
                : node.dataset.disclosureRetiring
                  ? "content"
                  : "model",
              text: node.textContent ?? "",
              opacity: Number(getComputedStyle(node).opacity),
              inert: node.inert,
              hidden: node.getAttribute("aria-hidden"),
              scrolls: [...node.querySelectorAll("pre")].map((pre) => pre.scrollTop),
            })),
            focus: {
              text: active?.textContent ?? "",
              label: active?.getAttribute("aria-label") ?? null,
              inRetiring: !!active?.closest(
                "[data-list-motion-retiring], [data-disclosure-retiring], [data-model-label-retiring]",
              ),
            },
          });
          if (event) return;
          if (at - began >= milliseconds) {
            observer.disconnect();
            removeEventListener("test-native-motion-observation", nativeObservation);
            resolve({ frames, events });
          } else requestAnimationFrame((at) => sample(at));
        };
        const nativeObservation = () => sample(performance.now(), true);
        addEventListener("test-native-motion-observation", nativeObservation);
        const observer = new MutationObserver(() => sample(performance.now(), true));
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        sample(performance.now());
      }),
    { root, selectors, milliseconds },
  );
  await action();
  const observed = await sampling;
  return { name, ...observed, native: await readNativeMotionProbe(page, true) };
}

async function attachRaw(
  info: TestInfo,
  page: Page,
  records: MotionRecord[],
  api: { requests: string[]; unexpected: string[] },
  after: unknown,
) {
  const inputs = await page.evaluate(
    () => (window as unknown as { __layoutMotionInputs: unknown[] }).__layoutMotionInputs,
  );
  const environment = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    devicePixelRatio,
    userAgent: navigator.userAgent,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  }));
  await info.attach("layout-motion-raw", {
    contentType: "application/json",
    body: JSON.stringify({
      classification: "explicit-fixture-normal-DOM-and-native-motion-regression",
      records,
      inputs,
      environment,
      after,
      requests: api.requests,
      unexpected: api.unexpected,
      newModelCalls: 0,
      pixelCadenceAcceptance: false,
    }),
  });
}

export function registerLayoutInteractionMotionTests(mode: "functional" | "display") {
  const test = mode === "display" ? displayTest : baseTest;
  test.afterEach(async ({ page }) => {
    await cleanupNativeMotionProbe(page);
  });
  const evidence = (record: MotionRecord) =>
    mode === "display"
      ? record.frames
      : [...record.frames, ...record.events].sort((left, right) => left.at - right.at);
  function nativeMovement(record: MotionRecord, name: string, axis: string) {
    const properties = axis === "x" || axis === "y" ? ["translate", "transform"] : [axis];
    const effects = record.native.filter(
      (entry) =>
        entry.slots.includes(name) &&
        entry.keys.some((key) => properties.some((property) => property in key)),
    );
    assertNativeMotion(effects);
    for (const entry of effects) {
      expect(entry.samples.some((sample) => sample.time !== null && sample.time > 0)).toBe(true);
      expect(
        entry.samples.some(
          (sample) => sample.reason === "finish" || sample.reason === "before-cancel",
        ),
      ).toBe(true);
    }
  }
  function moving(record: MotionRecord, name: string, axis: "x" | "y" | "width" | "height") {
    const points = evidence(record).flatMap((frame) =>
      frame.slots[name] ? [frame.slots[name]![axis]] : [],
    );
    const start = points[0];
    const end = points.at(-1)!;
    expect(Math.abs(end - start)).toBeGreaterThan(2);
    if (mode === "display")
      expect(
        points.some(
          (value) => value > Math.min(start, end) + 0.5 && value < Math.max(start, end) - 0.5,
        ),
      ).toBe(true);
    nativeMovement(record, name, axis);
    if (mode === "display")
      expect(
        record.frames.some((frame) =>
          frame.slots[name]?.effects.some(
            (effect) => effect.time !== null && effect.time > 0 && effect.state === "running",
          ),
        ),
      ).toBe(true);
  }

  function retiring(record: MotionRecord, text: string, kind: string) {
    const copies = evidence(record).flatMap((frame) =>
      frame.retiring.filter((copy) => copy.kind === kind && copy.text.includes(text)),
    );
    expect(copies.length).toBeGreaterThan(mode === "display" ? 1 : 0);
    expect(copies.every((copy) => copy.inert && copy.hidden === "true")).toBe(true);
    if (mode === "display")
      expect(copies.some((copy) => copy.opacity > 0 && copy.opacity < 1)).toBe(true);
    const effects = record.native.filter(
      (entry) => entry.text.includes(text) && entry.keys.some((key) => "opacity" in key),
    );
    assertNativeMotion(effects);
    expect(effects.some((entry) => Number(entry.keys.at(-1)!.opacity) === 0)).toBe(true);
    expect(record.frames.at(-1)!.retiring).toEqual([]);
  }

  function continuousOrStable(record: MotionRecord, name: string, axis: "x" | "y") {
    const points = evidence(record).flatMap((frame) =>
      frame.slots[name] ? [frame.slots[name]![axis]] : [],
    );
    expect(points.length).toBeGreaterThan(mode === "display" ? 2 : 0);
    const start = points[0];
    const end = points.at(-1)!;
    if (Math.abs(end - start) > 1) {
      nativeMovement(record, name, axis);
      if (mode === "display")
        expect(
          points.some(
            (value) => value > Math.min(start, end) + 0.25 && value < Math.max(start, end) - 0.25,
          ),
        ).toBe(true);
    } else expect(Math.max(...points) - Math.min(...points)).toBeLessThanOrEqual(1);
  }

  async function readyArena(page: Page, id: string) {
    await page.goto(`/?arena=${id}`);
    await page.locator(".c-board").first().waitFor();
    await page.waitForTimeout(550);
  }

  test("normal layout motion: model names carry their old text and adjoining tools continuously", async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const api = await installFixture(page);
    await page.goto("/");
    await page.getByLabel("你想做什么", { exact: true }).fill("测");
    const trigger = page.getByRole("button", { name: /^选择模型，当前/ });
    const records: MotionRecord[] = [];
    for (const label of ["DeepSeek V4.1 Flash", "GPT 6 Luna"]) {
      await trigger.click();
      await page.getByRole("option", { name: label, exact: true }).waitFor();
      records.push(
        await recordMotion(
          page,
          label,
          ".gi-composer-footer",
          {
            button: '.gi-tools button[aria-haspopup="listbox"]',
            tool: ".gi-tools .gi-tool",
            row: ".gi-tools",
            submit: ".gi-analyze",
          },
          () => page.getByRole("option", { name: label, exact: true }).click(),
        ),
      );
    }
    const after = {
      focus: await trigger.evaluate((node) => node === document.activeElement),
      label: await trigger.getAttribute("aria-label"),
    };
    await attachRaw(info, page, records, api, after);
    for (const record of records) {
      moving(record, "button", "width");
      for (const name of ["tool", "submit"])
        for (const axis of ["x", "y"] as const) continuousOrStable(record, name, axis);
    }
    retiring(records[0], MODEL_CATALOG[0].label, "model");
    retiring(records[1], "DeepSeek V4.1 Flash", "model");
    expect(after.focus).toBe(true);
    expect(after.label).toBe("选择模型，当前GPT 6 Luna");
    expect(api.unexpected).toEqual([]);
  });

  function materialDraft() {
    return fixtureIntake({
      goal: "【测试替身】材料与附件的正常动效检查",
      attachments: ["one", "two"].map((id) => ({
        id,
        name: `explicit-${id}.txt`,
        size: 100,
        state: "ready" as const,
        imageCount: 0,
        interpreted: false,
        locations: ["第1行"],
        warnings: [],
      })),
      sources: [
        {
          id: "source-one",
          attachmentId: "one",
          filename: "explicit-one.txt",
          location: "第1行",
          text: "【测试替身】第一段原文。\n".repeat(20),
          interpretation: false,
          origin: "document",
        },
        {
          id: "source-two",
          attachmentId: "two",
          filename: "explicit-two.txt",
          location: "第2行",
          text: "【测试替身】第二段较短原文。",
          interpretation: false,
          origin: "document",
        },
      ],
    });
  }

  test("normal layout motion: switching an open source preview carries the original text and scroll", async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const draft = materialDraft();
    const api = await installFixture(page, { draft });
    await page.goto("/");
    await page.getByRole("button", { name: /查看材料原文与位置/ }).click();
    await page.getByRole("button", { name: /explicit-one.txt.*第1行/ }).click();
    await page.waitForTimeout(500);
    const pre = page.locator(".gi-source-preview [data-source-preview-content] pre");
    await pre.hover();
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(100);
    const oldScroll = await pre.evaluate((node) => node.scrollTop);
    const record = await recordMotion(
      page,
      "switch-source",
      ".gi-sources",
      {
        preview: ".gi-source-preview",
        content: ".gi-source-preview [data-source-preview-content]",
      },
      () => page.getByRole("button", { name: /explicit-two.txt.*第2行/ }).click(),
    );
    const after = {
      text: await pre.textContent(),
      focused: await page
        .getByRole("button", { name: /explicit-two.txt.*第2行/ })
        .evaluate((node) => node === document.activeElement),
      oldScroll,
    };
    await attachRaw(info, page, [record], api, after);
    retiring(record, "第一段原文", "content");
    expect(
      evidence(record).some((frame) =>
        frame.retiring.some(
          (copy) => copy.kind === "content" && copy.scrolls.some((top) => top > 0),
        ),
      ),
    ).toBe(true);
    moving(record, "preview", "height");
    expect(after.text).toBe(draft.sources[1].text);
    expect(after.focused).toBe(true);
    expect(after.oldScroll).toBeGreaterThan(0);
    expect(api.unexpected).toEqual([]);
  });

  for (const width of [1440, 390]) {
    test(`normal layout motion: deleting the first and last attachment preserves the original list at ${width}px`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const api = await installFixture(page, { draft: materialDraft() });
      await page.goto("/");
      const first = page.getByRole("button", { name: "移除 explicit-one.txt", exact: true });
      await first.waitFor();
      await first.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      const records = [
        await recordMotion(
          page,
          "remove-first",
          ".guided-intake",
          {
            survivor: '.gi-attachments [data-motion-key="two"]',
            region: ".gi-attachments",
          },
          () => first.click(),
        ),
      ];
      records.push(
        await recordMotion(
          page,
          "remove-last",
          ".guided-intake",
          { region: ".gi-attachments", list: ".gi-attachments ul" },
          () => page.getByRole("button", { name: "移除 explicit-two.txt", exact: true }).click(),
        ),
      );
      const after = {
        rows: await page.locator(".gi-attachments li").count(),
        lists: await page.locator(".gi-attachments ul").count(),
      };
      await attachRaw(info, page, records, api, after);
      moving(records[0], "survivor", "y");
      retiring(records[0], "explicit-one.txt", "list");
      retiring(records[1], "explicit-two.txt", "list");
      moving(records[1], "region", "height");
      expect(after).toEqual({ rows: 0, lists: 1 });
      expect(
        records.every((record) => record.frames.every((frame) => !frame.focus.inRetiring)),
      ).toBe(true);
      expect(api.unexpected).toEqual([]);
    });

    test(`normal layout motion: condition rows retain identity when removing then adding at ${width}px`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      const api = await installFixture(page);
      await readyArena(page, api.snapshot.id);
      await page.getByRole("button", { name: "调整条件", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "调整条件", exact: true });
      await dialog.getByRole("button", { name: /完整编辑/ }).click();
      await dialog.getByLabel("备选方案 2", { exact: true }).waitFor();
      await page.waitForTimeout(500);
      const survivor = await dialog.getByLabel("备选方案 2", { exact: true }).elementHandle();
      const key = await survivor!.evaluate((node) =>
        node.closest("[data-motion-key]")!.getAttribute("data-motion-key"),
      );
      const selectors = {
        survivor: `[data-motion-key=${JSON.stringify(key)}]`,
        add: '[data-motion-key="option-add"]',
        model: '.condition-editor-complete button[aria-haspopup="listbox"]',
        complete: ".condition-editor-complete",
      };
      const model = dialog.getByRole("button", { name: /^选择模型，当前/ });
      if (width === 1440) {
        await model.click();
        await page.getByRole("option", { name: "DeepSeek V4.1 Flash", exact: true }).waitFor();
      }
      const records = [
        await recordMotion(
          page,
          "remove-option",
          ".condition-editor-complete",
          selectors,
          async () => {
            if (width === 1440) {
              await page.getByRole("option", { name: "DeepSeek V4.1 Flash", exact: true }).click();
              await dialog.getByRole("button", { name: "删除备选方案 1", exact: true }).focus();
              await page.keyboard.press("Enter");
            } else
              await dialog.getByRole("button", { name: "删除备选方案 1", exact: true }).click();
          },
        ),
      ];
      records.push(
        await recordMotion(
          page,
          "add-option",
          ".condition-editor-complete",
          { add: '[data-motion-key="option-add"]', newRow: ".option-row:last-of-type" },
          () => dialog.getByRole("button", { name: "添加一个选项", exact: true }).click(),
        ),
      );
      const after = {
        retained: await survivor!.evaluate((node) => node.isConnected),
        value: await dialog.getByLabel("备选方案 1", { exact: true }).inputValue(),
        focusedNew: await dialog
          .getByLabel("备选方案 2", { exact: true })
          .evaluate((node) => node === document.activeElement),
      };
      const modelAfter = await model.getAttribute("aria-label");
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await page.waitForTimeout(300);
      await attachRaw(info, page, records, api, { ...after, modelAfter });
      moving(records[0], "survivor", "y");
      retiring(records[0], "01", "list");
      moving(records[1], "add", "y");
      if (width === 1440) {
        const overlapped = evidence(records[0]).some(
          (frame) =>
            frame.slots.model?.effects.some(
              (effect) => effect.state === "running" && effect.keys.some((key) => "width" in key),
            ) &&
            frame.slots.survivor?.effects.some(
              (effect) =>
                effect.state === "running" && effect.keys.some((key) => "translate" in key),
            ),
        );
        if (mode === "display") expect(overlapped).toBe(true);
        else {
          nativeMovement(records[0], "model", "width");
          nativeMovement(records[0], "survivor", "y");
        }
        expect(modelAfter).toBe("选择模型，当前DeepSeek V4.1 Flash");
        expect(
          records[0].frames
            .at(-1)!
            .slots.complete!.effects.filter((effect) => effect.state === "running"),
        ).toEqual([]);
      }
      expect(after).toEqual({ retained: true, value: "【测试替身】方案乙", focusedNew: true });
      expect(api.requests.some((request) => request.startsWith("POST"))).toBe(false);
      expect(api.unexpected).toEqual([]);
    });
  }

  test("normal layout motion: pending supplement keeps submit and cancel geometry and preserves a failed draft", async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = await installFixture(page, {
      api: async (route, url, method) => {
        if (method !== "POST" || !url.pathname.endsWith("/versions")) return false;
        await gate;
        await route.fulfill({
          status: 500,
          json: { error: "【测试替身】保存失败，原输入仍可修改。" },
        });
        return true;
      },
    });
    await readyArena(page, api.snapshot.id);
    const opener = page.getByRole("button", { name: "查看第 1 步", exact: true });
    await opener.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").getByRole("button", { name: "补充或质疑", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "补充这一步", exact: true });
    const text = "【测试替身】检查提交反馈期间保留这段补充。";
    await dialog.getByRole("textbox").fill(text);
    await page.waitForTimeout(500);
    const record = await recordMotion(
      page,
      "pending-and-error",
      ".step-follow-up",
      {
        form: ".step-follow-up",
        submit: '.step-follow-up button[type="submit"]',
        cancel: ".step-follow-up-actions .text-button",
      },
      async () => {
        await dialog.getByRole("button", { name: "补充后重新推演", exact: true }).click();
        await expect(dialog.locator("form")).toHaveAttribute("aria-busy", "true");
        await page.waitForTimeout(250);
        release();
      },
      1000,
    );
    const retained = {
      text: await dialog.getByRole("textbox").inputValue(),
      error: await dialog.getByRole("alert").textContent(),
    };
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await page.waitForTimeout(300);
    const after = {
      ...retained,
      focusAfterCancel: await opener.evaluate((node) => {
        const active = document.activeElement as HTMLElement | null;
        return {
          original: active === node,
          tag: active?.tagName ?? "",
          role: active?.getAttribute("role"),
          label: active?.getAttribute("aria-label"),
          tabIndex: active?.tabIndex ?? -1,
          unavailable: !!active?.closest('[inert], [aria-hidden="true"]'),
        };
      }),
    };
    await attachRaw(info, page, [record], api, after);
    const pending = evidence(record).filter((frame) => frame.slots.form?.busy === "true");
    expect(pending.length).toBeGreaterThan(mode === "display" ? 2 : 0);
    const before = record.frames[0];
    for (const frame of pending)
      for (const control of ["submit", "cancel"])
        for (const axis of ["x", "y", "width", "height"] as const)
          expect(
            Math.abs(frame.slots[control]![axis] - before.slots[control]![axis]),
          ).toBeLessThanOrEqual(1);
    expect(after.text).toBe(text);
    expect(after.error).toContain("保存失败");
    expect(after.focusAfterCancel.original).toBe(true);
    expect(after.focusAfterCancel.unavailable).toBe(false);
    expect(after.focusAfterCancel.tabIndex).toBeGreaterThanOrEqual(0);
    expect(await dialog.count()).toBe(0);
    expect(api.unexpected).toEqual([]);
  });

  test("normal layout motion: history refresh and more carry records and the recovery section", async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    let pageCount = 0;
    const item = (id: string, goal: string) => ({
      id,
      goal,
      createdAt: "2026-11-06T00:00:00.000Z",
      activeVersionId: "fixture-version-1",
      status: "completed",
      stage: "judge",
      versionCount: 1,
    });
    const api = await installFixture(page, {
      api: async (route, url, method) => {
        if (method !== "GET" || url.pathname !== "/api/arenas") return false;
        await new Promise((resolve) => setTimeout(resolve, 120));
        const more = url.searchParams.has("cursor");
        if (!more) pageCount++;
        await route.fulfill({
          json: more
            ? { items: [item("three", "【测试替身】更多中的第三项")], nextCursor: null }
            : {
                items:
                  pageCount === 1
                    ? [item("one", "【测试替身】刷新前的第一项")]
                    : [
                        item("one", "【测试替身】刷新后的第一项"),
                        item("two", "【测试替身】刷新新增第二项"),
                      ],
                nextCursor: "motion-next",
              },
        });
        return true;
      },
    });
    await page.goto("/");
    await page.getByRole("button", { name: "我的历史", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "我的历史与恢复码", exact: true });
    await dialog.getByRole("button", { name: /刷新前的第一项/ }).waitFor();
    await page.waitForTimeout(500);
    const selectors = {
      recovery: '[data-motion-key="recovery-save"]',
      restore: '[data-motion-key="recovery-restore"]',
      first: '[data-motion-key="arena:one"]',
    };
    const records = [
      await recordMotion(page, "refresh-history", ".identity-history", selectors, () =>
        dialog.getByRole("button", { name: "刷新", exact: true }).click(),
      ),
    ];
    records.push(
      await recordMotion(page, "more-history", ".identity-history", selectors, async () => {
        await dialog.getByRole("button", { name: "更多讨论", exact: true }).focus();
        await page.keyboard.press("Enter");
      }),
    );
    const after = {
      titles: await dialog.locator(".identity-history-list li[data-motion-key]").allTextContents(),
      focusedNew: await dialog
        .locator('[data-motion-key="arena:three"] button')
        .evaluate((node) => node === document.activeElement),
    };
    await attachRaw(info, page, records, api, after);
    retiring(records[0], "刷新前的第一项", "list");
    for (const record of records) {
      moving(record, "recovery", "y");
      moving(record, "restore", "y");
    }
    expect(after.titles).toHaveLength(3);
    expect(after.focusedNew).toBe(true);
    expect(records.every((record) => record.frames.every((frame) => !frame.focus.inRetiring))).toBe(
      true,
    );
    expect(api.unexpected).toEqual([]);
  });
}
