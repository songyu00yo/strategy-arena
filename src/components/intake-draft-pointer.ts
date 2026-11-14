import { tabOwnedPointer } from "./tab-owned-pointer";

export const INTAKE_DRAFT_STORAGE_KEY = "strategy-arena:intake-id";
export const INTAKE_TAB_STORAGE_KEY = "strategy-arena:intake-tab-id";
const pointer = tabOwnedPointer(INTAKE_DRAFT_STORAGE_KEY, INTAKE_TAB_STORAGE_KEY);
export const readIntakeDraftPointer = pointer.read;
// Save only after server acceptance or an authorized GET; created publishes a genuinely new draft.
export const saveIntakeDraftPointer = pointer.save;
export const clearIntakeDraftPointer = pointer.clear;
