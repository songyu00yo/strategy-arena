import { describe, expect, it } from "vitest";
import { isDialogBackdropClick } from "../src/components/modal";

// Explicit geometry doubles exercise the shared hit test without simulating browser animation.
const dialog = {
  getBoundingClientRect: () => ({ left: 100, top: 80, right: 500, bottom: 380 }),
} as unknown as HTMLElement;
const click = (clientX: number, clientY: number, target: EventTarget | null = dialog) => ({
  target,
  clientX,
  clientY,
});

describe("dialog backdrop hit testing", () => {
  it("preserves clicks on the paper's own padding and edges", () => {
    for (const [x, y] of [
      [104, 230],
      [100, 80],
      [500, 380],
      [300, 200],
    ])
      expect(isDialogBackdropClick(click(x, y), dialog)).toBe(false);
  });

  it("closes only outside the current paper rectangle", () => {
    for (const [x, y] of [
      [99, 230],
      [501, 230],
      [300, 79],
      [300, 381],
    ])
      expect(isDialogBackdropClick(click(x, y), dialog)).toBe(true);
  });

  it("keeps events from child controls and missing dialogs out of the backdrop path", () => {
    const child = {} as EventTarget;
    expect(isDialogBackdropClick(click(0, 0, child), dialog)).toBe(false);
    expect(isDialogBackdropClick(click(0, 0), null)).toBe(false);
    expect(isDialogBackdropClick(click(0, 0), undefined)).toBe(false);
  });

  it("measures the currently visible rectangle on every event", () => {
    let left = 100;
    const moving = {
      getBoundingClientRect: () => ({ left, top: 80, right: left + 400, bottom: 380 }),
    } as unknown as HTMLElement;
    const event = click(104, 230, moving);
    expect(isDialogBackdropClick(event, moving)).toBe(false);
    left = 120;
    expect(isDialogBackdropClick(event, moving)).toBe(true);
  });
});
