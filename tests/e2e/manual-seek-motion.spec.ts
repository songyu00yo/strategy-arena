import { expect, test } from "@playwright/test";

// Saved real-model example with explicitly simulated answers. Every API request
// is blocked so seeking exercises browser-only playback without model or writes.
for (const width of [1440, 390]) {
  test(`manual seek keeps live controls and composed text at ${width}px`, async ({
    page,
  }, info) => {
    const requests: string[] = [];
    await page.route("**/api/**", (route) => {
      requests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      return route.abort();
    });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/examples/personal-website");
    await page.getByRole("button", { name: "暂停自动开始", exact: true }).click();
    await page.getByRole("button", { name: "开始回看", exact: true }).click();
    await expect(page.locator(".c-time [aria-current=step]")).toHaveAttribute(
      "aria-label",
      "第 1 步",
    );
    await page.getByRole("button", { name: "暂停放映", exact: true }).click();
    await page.keyboard.press("End");
    await expect(page.locator("[data-stage-retiring=true]")).toHaveCount(3);
    // Interrupt while the old text is still present. These are trusted keyboard
    // events, followed by a real mouse click on the live timeline.
    await page.keyboard.press("Home");
    await expect(page.locator(".c-time [aria-current=step]")).toHaveAttribute(
      "aria-label",
      "第 1 步",
    );
    const second = page.getByRole("button", { name: "第 2 步", exact: true });
    await second.scrollIntoViewIfNeeded();
    const box = await second.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(page.locator(".c-time [aria-current=step]")).toHaveAttribute(
      "aria-label",
      "第 2 步",
    );
    const copies = await page.locator("[data-stage-retiring=true]").evaluateAll((nodes) =>
      nodes.map((node) => ({
        inert: (node as HTMLElement).inert,
        hidden: node.getAttribute("aria-hidden"),
        pointer: getComputedStyle(node).pointerEvents,
        duplicateIds: node.querySelectorAll("[id]").length,
        activeControls: node.querySelectorAll("input:enabled,button:enabled,select:enabled").length,
      })),
    );
    expect(copies.length).toBeGreaterThan(0);
    expect(
      copies.every(
        (copy) =>
          copy.inert &&
          copy.hidden === "true" &&
          copy.pointer === "none" &&
          copy.duplicateIds === 0 &&
          copy.activeControls === 0,
      ),
    ).toBe(true);
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".c-time [aria-current=step]")).toHaveAttribute(
      "aria-label",
      "第 3 步",
    );
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".c-time [aria-current=step]")).toHaveAttribute(
      "aria-label",
      "第 2 步",
    );
    await expect(page.locator("[data-stage-retiring=true]")).toHaveCount(0);
    await expect(page.locator(".c-stage3 [data-board]")).toHaveCount(3);
    const settled = await page.locator(".c-stage3 [data-board]").evaluateAll((boards) =>
      boards.map((board) => ({
        height: (board as HTMLElement).style.height,
        textOpacity: [...board.querySelectorAll(":scope > header,:scope > .c-board-body")].map(
          (node) => Number(getComputedStyle(node).opacity),
        ),
      })),
    );
    expect(settled.every((board) => board.height === "")).toBe(true);
    expect(settled.every((board) => board.textOpacity.every((opacity) => opacity > 0))).toBe(true);
    expect(requests).toEqual([]);
    await info.attach("manual-seek-result", {
      body: JSON.stringify({ width, copies, settled, requests }),
      contentType: "application/json",
    });
    await page.screenshot({ path: info.outputPath("settled-seek.png") });
  });
}
