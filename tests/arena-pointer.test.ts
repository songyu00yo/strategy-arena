import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ARENA_STORAGE_KEY,
  ARENA_TAB_STORAGE_KEY,
  clearArenaPointer,
  readArenaPointer,
  saveArenaPointer,
} from "../src/components/arena-pointer";
import {
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

describe("tab-owned arena restore target", () => {
  it("pins an accepted arena and ignores another tab's newer shared task during refresh", () => {
    shared.setItem(ARENA_STORAGE_KEY, "arena-a");
    expect(readArenaPointer()).toBe("arena-a");
    saveArenaPointer("arena-a");
    shared.setItem(ARENA_STORAGE_KEY, "arena-b");
    expect(readArenaPointer()).toBe("arena-a");
    saveArenaPointer("arena-a");
    expect(shared.getItem(ARENA_STORAGE_KEY)).toBe("arena-b");
  });
  it("starts a new question without clearing or restoring another tab's arena", () => {
    saveArenaPointer("arena-a", true);
    shared.setItem(ARENA_STORAGE_KEY, "arena-b");
    clearArenaPointer("arena-a");
    expect(tab.getItem(ARENA_TAB_STORAGE_KEY)).toBe("");
    expect(readArenaPointer()).toBeNull();
    expect(shared.getItem(ARENA_STORAGE_KEY)).toBe("arena-b");
    clearArenaPointer(null);
    expect(readArenaPointer()).toBeNull();
    expect(shared.getItem(ARENA_STORAGE_KEY)).toBe("arena-b");
  });
  it("keeps the independent pending intake target when the arena target is cleared", () => {
    saveArenaPointer("arena-a", true);
    saveIntakeDraftPointer("pending-draft", true);
    clearArenaPointer("arena-a");
    expect(readArenaPointer()).toBeNull();
    expect(readIntakeDraftPointer()).toBe("pending-draft");
  });
  it("tolerates unavailable optional storage", () => {
    const blocked = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    };
    vi.stubGlobal("sessionStorage", blocked);
    vi.stubGlobal("localStorage", blocked);
    expect(readArenaPointer()).toBeNull();
    expect(() => saveArenaPointer("accepted-arena")).not.toThrow();
    expect(() => clearArenaPointer("accepted-arena")).not.toThrow();
  });
});
