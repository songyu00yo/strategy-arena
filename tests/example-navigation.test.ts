import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearExamplePickerRequest,
  clearExplicitArenaRequest,
  examplePickerRequested,
} from "../src/lib/example-navigation";

afterEach(() => vi.unstubAllGlobals());

describe("free example navigation", () => {
  it("does not require a browser during server rendering", () => {
    expect(examplePickerRequested()).toBe(false);
    expect(() => clearExamplePickerRequest()).not.toThrow();
    expect(() => clearExplicitArenaRequest()).not.toThrow();
  });
  it.each([
    ["?examples=open", true],
    ["?examples=other", false],
    ["?arena=new", false],
  ])("detects only the explicit picker request %s", (search, expected) => {
    vi.stubGlobal("window", { location: { href: `https://example.test/${search}` } });
    expect(examplePickerRequested()).toBe(expected);
  });
  it("clears only the examples parameter and preserves navigation state", () => {
    const state = { scroll: 5 };
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: { href: "https://example.test/?examples=open&arena=new&filter=a#position" },
      history: { state, replaceState },
    });
    clearExamplePickerRequest();
    expect(replaceState).toHaveBeenCalledWith(state, "", "/?arena=new&filter=a#position");
  });
  it("clears only an explicit arena when returning to a new task", () => {
    const state = { scroll: 5 };
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: { href: "https://example.test/?arena=old&examples=open&filter=a#position" },
      history: { state, replaceState },
    });
    clearExplicitArenaRequest();
    expect(replaceState).toHaveBeenCalledWith(state, "", "/?examples=open&filter=a#position");
  });
  it("keeps an ordinary picker URL unchanged when no arena is specified", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: { href: "https://example.test/?examples=open#position" },
      history: { replaceState },
    });
    clearExplicitArenaRequest();
    expect(replaceState).not.toHaveBeenCalled();
  });
  it("does not rewrite an ordinary URL", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: { href: "https://example.test/?arena=new#position" },
      history: { replaceState },
    });
    clearExamplePickerRequest();
    expect(replaceState).not.toHaveBeenCalled();
  });
});
