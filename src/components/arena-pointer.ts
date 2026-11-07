import { tabOwnedPointer } from "./tab-owned-pointer";

export const ARENA_STORAGE_KEY = "strategy-arena:last-id";
export const ARENA_TAB_STORAGE_KEY = "strategy-arena:tab-arena-id";
const pointer = tabOwnedPointer(ARENA_STORAGE_KEY, ARENA_TAB_STORAGE_KEY);
export const readArenaPointer = pointer.read;
// Save only an accepted server snapshot; restore/refresh cannot replace another tab's shared target.
export const saveArenaPointer = pointer.save;
export const clearArenaPointer = pointer.clear;
