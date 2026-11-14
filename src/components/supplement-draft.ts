import type { ModelMode } from "@/lib/contracts";

export type SupplementDraft = { text: string; modelMode?: ModelMode };

// Kept only by the owning page, never browser-wide or persisted with private input.
export function supplementDraftKey(versionId: string, sourceId: string, quote: string) {
  return JSON.stringify([versionId, sourceId, quote]);
}
