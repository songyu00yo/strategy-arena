import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INTAKE_DRAFT_STORAGE_KEY,
  INTAKE_TAB_STORAGE_KEY,
  clearIntakeDraftPointer,
  readIntakeDraftPointer,
  saveIntakeDraftPointer,
} from "../src/components/intake-draft-pointer";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
let shared: ReturnType<typeof storage>, tab: ReturnType<typeof storage>;
beforeEach(() => {
  shared = storage();
  tab = storage();
  vi.stubGlobal("localStorage", shared);
  vi.stubGlobal("sessionStorage", tab);
});
afterEach(() => vi.unstubAllGlobals());

describe("tab-owned intake restore target", () => {
  it("falls back to legacy storage until the authorized draft is pinned to this tab", () => {
    shared.setItem(INTAKE_DRAFT_STORAGE_KEY, "draft-a");
    expect(readIntakeDraftPointer()).toBe("draft-a");
    saveIntakeDraftPointer("draft-a");
    shared.setItem(INTAKE_DRAFT_STORAGE_KEY, "draft-b");
    expect(readIntakeDraftPointer()).toBe("draft-a");
    saveIntakeDraftPointer("draft-a");
    expect(shared.getItem(INTAKE_DRAFT_STORAGE_KEY)).toBe("draft-b");
  });
  it("clears only its matching ID and does not revive a different tab's legacy target", () => {
    saveIntakeDraftPointer("draft-a", true);
    shared.setItem(INTAKE_DRAFT_STORAGE_KEY, "draft-b");
    clearIntakeDraftPointer("draft-a");
    expect(readIntakeDraftPointer()).toBeNull();
    expect(shared.getItem(INTAKE_DRAFT_STORAGE_KEY)).toBe("draft-b");
    expect(tab.getItem(INTAKE_TAB_STORAGE_KEY)).toBe("");
  });
  it("ignores a stale completion and publishes an explicitly created draft", () => {
    saveIntakeDraftPointer("draft-b", true);
    clearIntakeDraftPointer("draft-a");
    expect(readIntakeDraftPointer()).toBe("draft-b");
    expect(shared.getItem(INTAKE_DRAFT_STORAGE_KEY)).toBe("draft-b");
    saveIntakeDraftPointer("draft-c", true);
    expect(readIntakeDraftPointer()).toBe("draft-c");
    expect(shared.getItem(INTAKE_DRAFT_STORAGE_KEY)).toBe("draft-c");
  });
  it("clears an unchanged legacy pointer after a failed authorized lookup", () => {
    shared.setItem(INTAKE_DRAFT_STORAGE_KEY, "missing");
    clearIntakeDraftPointer("missing");
    expect(readIntakeDraftPointer()).toBeNull();
    expect(shared.getItem(INTAKE_DRAFT_STORAGE_KEY)).toBeNull();
  });
  it("keeps the session target usable when optional shared storage fails", () => {
    tab.setItem(INTAKE_TAB_STORAGE_KEY, "draft-a");
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("blocked");
      },
    });
    expect(readIntakeDraftPointer()).toBe("draft-a");
    clearIntakeDraftPointer("draft-a");
    expect(readIntakeDraftPointer()).toBeNull();
  });
});
