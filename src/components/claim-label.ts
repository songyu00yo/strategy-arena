import type { ArenaVersion } from "@/lib/contracts";

/** Keep display numbering stable when a revision adds, withdraws or reorders a claim. */
export function claimLabel(version: ArenaVersion, strategyId: string, claimId: string) {
  const claims = [
    ...(version.strategies.find((strategy) => strategy.id === strategyId)?.claims ?? []),
    ...version.revisions
      .filter((revision) => revision.strategyId === strategyId)
      .flatMap((revision) => revision.strategy.claims),
  ];
  const index = [...new Set(claims.map((claim) => claim.id))].indexOf(claimId);
  return index < 0 ? `路线 ${strategyId} 的这条判断` : `路线 ${strategyId} 的判断 ${index + 1}`;
}

/** Only change visible references. Stored IDs and original interaction payloads stay intact. */
export function readableClaimText(version: ArenaVersion, text: string) {
  const labels = new Map<string, string>();
  for (const strategy of [
    ...version.strategies,
    ...version.revisions.map((revision) => revision.strategy),
  ]) {
    for (const claim of strategy.claims) {
      labels.set(claim.id, claimLabel(version, strategy.id, claim.id));
    }
  }
  if (!labels.size) return text;
  const ids = [...labels.keys()].sort((a, b) => b.length - a.length);
  const pattern = ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return text.replace(
    new RegExp(`(?<![\\w-])(?:${pattern})(?![\\w-])`, "g"),
    (id) => labels.get(id)!,
  );
}
