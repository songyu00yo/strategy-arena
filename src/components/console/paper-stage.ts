import type { Beat } from "./beats";

export const PAPER_MOTION = {
  feedback: 120,
  settle: 140,
  open: 280,
  fold: 300,
  transfer: 420,
  seal: 220,
} as const;
export type PaperRole = "A" | "B" | "C";

export function paperBackgroundIndex(beats: readonly Beat[], index: number, held: boolean) {
  return held ? beats.slice(0, index + 1).findLastIndex((beat) => beat.clarificationRun) : index;
}

export function nextRecordedRole(beats: readonly Beat[], index: number): PaperRole | undefined {
  return beats.slice(index + 1).find((beat) => beat.clarificationRun)?.clarificationRun?.role;
}

/** A user-action step interrupts model-to-model transfer until its own paper is submitted. */
export function adjacentPaperTransfer(beats: readonly Beat[], index: number) {
  const from = beats[index]?.clarificationRun?.role;
  const to = beats[index + 1]?.clarificationRun?.role;
  return from && to && from !== to ? { from, to } : null;
}

export function paperTransferPath(
  source: Pick<DOMRect, "left" | "right" | "top" | "width" | "height">,
  target: Pick<DOMRect, "left" | "right" | "top" | "width" | "height">,
  origin: Pick<DOMRect, "left" | "top">,
) {
  if (source.width <= 0 || source.height <= 0 || target.width <= 0 || target.height <= 0)
    return null;
  const direction = target.left > source.left ? 1 : -1;
  const sx = (direction > 0 ? source.right : source.left) - origin.left;
  const tx = (direction > 0 ? target.left : target.right) - origin.left;
  const sy = source.top + Math.min(28, source.height / 2) - origin.top;
  const ty = target.top + Math.min(28, target.height / 2) - origin.top;
  const bend = Math.max(12, Math.abs(tx - sx) * 0.45) * direction;
  return `M${sx},${sy} C${sx + bend},${sy} ${tx - bend},${ty} ${tx},${ty}`;
}

export function initialPaperFrames(
  source: Pick<DOMRect, "left" | "top" | "width" | "height">,
  target: Pick<DOMRect, "left" | "top" | "width" | "height">,
): Keyframe[] | null {
  if (source.width <= 0 || source.height <= 0 || target.width <= 0 || target.height <= 0)
    return null;
  const x = target.left + target.width / 2 - source.left - source.width / 2;
  const y = target.top + Math.min(28, target.height / 2) - source.top - source.height / 2;
  const scale = Math.min(0.55, target.width / source.width);
  return [
    { transform: "none", opacity: 1 },
    { transform: `translate3d(${x}px,${y}px,0) scale(${scale})`, opacity: 0 },
  ];
}

/** An empty board shell cannot receive the input. Wait for the first recorded A output to be visible. */
export function initialPaperReceiverReady(target: HTMLElement | null, activeStep: Element | null) {
  if (!target || activeStep?.getAttribute("aria-label") !== "第 1 步") return false;
  const body = target.querySelector<HTMLElement>(".c-board-body");
  if (!body?.querySelector("h3") || !body.querySelector(".est")?.textContent?.trim()) return false;
  const rect = target.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  for (let node: HTMLElement | null = body; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      Number(style.opacity) < 0.98
    )
      return false;
  }
  return true;
}

/** The short clarification impression holds its ink. The permanent conclusion tag remains afterward. */
export const CLARIFICATION_SEAL_FRAMES: Keyframe[] = [
  { transform: "translate(-50%,-50%) rotate(-10deg) scale(1.6)", opacity: 0 },
  { transform: "translate(-50%,-50%) rotate(-7deg) scale(.98)", opacity: 1, offset: 0.45 },
  { transform: "translate(-50%,-50%) rotate(-7deg) scale(1)", opacity: 1 },
];

/** Keep the whole impression inside the viewport, including its largest rotated entry. */
export function paperSealPosition(
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
) {
  const angle = (10 * Math.PI) / 180;
  const halfWidth = (size.width * Math.cos(angle) + size.height * Math.sin(angle)) * 0.8;
  const halfHeight = (size.height * Math.cos(angle) + size.width * Math.sin(angle)) * 0.8;
  return {
    x: Math.max(halfWidth + 12, Math.min(viewport.width - halfWidth - 12, anchor.x)),
    y: Math.max(halfHeight + 12, Math.min(viewport.height - halfHeight - 12, anchor.y)),
  };
}
