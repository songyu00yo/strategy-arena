// Explicit API failures and delayed responses exercise request lifetime. No model provider is contacted.
import { expect, test, type Locator, type Page } from "@playwright/test";

type Kind = "supplement" | "conditions";
type AbortRecord = {
  path: string;
  method: string;
  aborted: boolean;
  abortDialogOpen?: boolean;
  abortPhase?: string | null;
};

async function prepare(page: Page, holdSubmit = false) {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    const records: AbortRecord[] = [];
    Object.assign(window, { __dialogAbortRequests: records });
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const path = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        location.href,
      ).pathname;
      const record: AbortRecord = { path, method: init?.method ?? "GET", aborted: false };
      records.push(record);
      init?.signal?.addEventListener(
        "abort",
        () => {
          const dialog = document.querySelector<HTMLElement>("dialog[open].overlay-motion");
          record.aborted = true;
          record.abortDialogOpen = !!dialog;
          record.abortPhase = dialog?.dataset.overlayMotionPhase ?? null;
        },
        { once: true },
      );
      return original(input, init);
    };
  });
  let releaseHealth = () => {};
  let releaseSubmit = () => {};
  const healthReady = new Promise<void>((resolve) => {
    releaseHealth = resolve;
  });
  const submitReady = new Promise<void>((resolve) => {
    releaseSubmit = resolve;
  });
  const state = {
    healthCalls: 0,
    submissions: 0,
    unexpected: [] as string[],
    errors: [] as string[],
    releaseHealth,
    releaseSubmit,
  };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/health") {
      state.healthCalls++;
      await healthReady;
      try {
        await route.fulfill({
          json: {
            status: "ok",
            model: { configured: false, models: [], providers: [], tools: {} },
            accessGranted: true,
            requiresAccessCode: false,
          },
        });
      } catch {
        // A deliberately aborted request can finish after its browser context has released it.
      }
      return;
    }
    if (path === "/api/intakes" && request.method() === "POST") {
      state.submissions++;
      if (holdSubmit) await submitReady;
      try {
        await route.fulfill({
          status: 503,
          json: { error: "【测试替身】已收到提交，保留表单供检查。" },
        });
      } catch {
        // Closing the paper deliberately aborts the delayed fixture response.
      }
      return;
    }
    state.unexpected.push(request.method() + " " + path);
    await route.abort();
  });
  return state;
}

async function open(page: Page, kind: Kind) {
  await page.goto("/examples/personal-website");
  await page.getByRole("button", { name: "暂停自动开始", exact: true }).click();
  await page.getByRole("button", { name: "开始回看", exact: true }).click();
  await page.getByRole("button", { name: "第 1 步", exact: true }).click();
  await expect(page.locator(".initial-paper-transfer")).toHaveCount(0);
  await page.getByRole("button", { name: "查看第 1 步", exact: true }).click();
  const detail = page.locator(".c-pull");
  await expect(detail).toBeVisible();
  await detail
    .getByRole("button", { name: kind === "supplement" ? "补充或质疑" : "调整条件", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: kind === "supplement" ? "补充这一步" : "调整条件",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toHaveAttribute("data-overlay-motion-active", "true");
  return dialog;
}

async function fill(dialog: Locator, kind: Kind) {
  if (kind === "supplement") {
    await dialog
      .getByRole("textbox", { name: "你想补充或询问什么？", exact: true })
      .fill("【测试替身输入】请保留我填写的要求并继续核对。");
    return dialog.getByRole("button", { name: "确认并准备需求草稿", exact: true });
  }
  await dialog.getByRole("spinbutton", { name: /预算上限/ }).fill("12345");
  return dialog.getByRole("button", { name: "按这些条件准备草稿", exact: true });
}

async function padding(page: Page, dialog: Locator) {
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  const point = { x: box!.x + 4, y: box!.y + box!.height / 2 };
  expect(
    await dialog.evaluate(
      (node, point) => document.elementFromPoint(point.x, point.y) === node,
      point,
    ),
  ).toBe(true);
  await page.mouse.click(point.x, point.y);
  await expect(dialog).toBeVisible();
}

async function records(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __dialogAbortRequests: AbortRecord[] }).__dialogAbortRequests,
  );
}

for (const width of [1440, 390]) {
  for (const kind of ["supplement", "conditions"] as const) {
    for (const phase of ["before health", "after health"]) {
      test(`explicit UI fixture: padding ${phase} preserves ${kind} submission at ${width}px`, async ({
        page,
      }, info) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        const state = await prepare(page);
        try {
          const dialog = await open(page, kind);
          await expect.poll(() => state.healthCalls).toBe(1);
          if (phase === "before health") await padding(page, dialog);
          state.releaseHealth();
          const submit = await fill(dialog, kind);
          await expect(submit).toBeEnabled();
          if (phase === "after health") await padding(page, dialog);
          await submit.click();
          await expect.poll(() => state.submissions).toBe(1);
          await expect(dialog.getByRole("alert")).toContainText("【测试替身】已收到提交");
          const requests = await records(page);
          await info.attach("request-lifetime", {
            body: JSON.stringify({
              requests,
              ...state,
              releaseHealth: undefined,
              releaseSubmit: undefined,
            }),
            contentType: "application/json",
          });
          expect(
            requests
              .filter((entry) => entry.path === "/api/health")
              .every((entry) => !entry.aborted),
          ).toBe(true);
          expect(state.unexpected).toEqual([]);
          expect(state.errors).toEqual([]);
        } finally {
          state.releaseHealth();
          state.releaseSubmit();
        }
      });
    }
  }
}

for (const kind of ["supplement", "conditions"] as const) {
  for (const pending of ["health", "submit"] as const) {
    for (const action of ["backdrop", "close", "Escape"] as const) {
      test(`explicit UI fixture: ${action} immediately aborts pending ${pending} in ${kind}`, async ({
        page,
      }, info) => {
        const state = await prepare(page, true);
        try {
          const dialog = await open(page, kind);
          await expect.poll(() => state.healthCalls).toBe(1);
          if (pending === "submit") {
            state.releaseHealth();
            await (await fill(dialog, kind)).click();
            await expect.poll(() => state.submissions).toBe(1);
          }
          if (action === "backdrop") await page.mouse.click(2, 2);
          else if (action === "close")
            await dialog.getByRole("button", { name: "关闭弹窗", exact: true }).click();
          else await page.keyboard.press("Escape");
          const requests = await records(page);
          const request = requests.findLast(
            (entry) => entry.path === (pending === "health" ? "/api/health" : "/api/intakes"),
          );
          await info.attach("immediate-request-abort", {
            body: JSON.stringify({ action, pending, request, requests }),
            contentType: "application/json",
          });
          expect(request?.aborted).toBe(true);
          expect(request?.abortDialogOpen).toBe(true);
          expect(request?.abortPhase).not.toBe("closing");
          await expect(dialog).toHaveAttribute("data-overlay-motion-phase", "closing");
          await expect(dialog).toBeHidden();
          state.releaseHealth();
          state.releaseSubmit();
          await expect(page).toHaveURL(/\/examples\/personal-website$/);
          expect(state.unexpected).toEqual([]);
          expect(state.errors).toEqual([]);
        } finally {
          state.releaseHealth();
          state.releaseSubmit();
        }
      });
    }
  }
}
