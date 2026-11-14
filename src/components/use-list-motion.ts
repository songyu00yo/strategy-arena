"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { capturePaperContents } from "./disclosure-motion";
import { createMotionScope } from "./console/motion-runtime";

type ItemPose = {
  node: HTMLElement;
  parent: HTMLElement | null;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: string;
  text: string;
  contents: ReturnType<typeof capturePaperContents>;
};
type ListPose = {
  height: number;
  nodes: Map<string | HTMLElement, ItemPose>;
};

function positionWithin(node: HTMLElement, root: HTMLElement) {
  const layoutPoint = (element: HTMLElement) => {
    let x = 0;
    let y = 0;
    for (let at: HTMLElement | null = element; at; at = at.offsetParent as HTMLElement | null) {
      x += at.offsetLeft;
      y += at.offsetTop;
      const parent = at.offsetParent as HTMLElement | null;
      x += parent?.clientLeft ?? 0;
      y += parent?.clientTop ?? 0;
    }
    return { x, y };
  };
  const origin = layoutPoint(root);
  const point = layoutPoint(node);
  for (let at = node.parentElement; at && at !== root; at = at.parentElement) {
    point.x -= at.scrollLeft;
    point.y -= at.scrollTop;
  }
  return { x: point.x - origin.x - root.clientLeft, y: point.y - origin.y - root.clientTop };
}

/** Existing rows keep their DOM identity. Retiring copies are inert and short-lived. */
export function useListMotion<T extends HTMLElement>(revision: unknown) {
  const ref = useRef<T>(null);
  const pending = useRef<{ pose: ListPose; ticket: number } | null>(null);
  const nextTicket = useRef(0);
  const [ticket, setTicket] = useState(0);
  const activeAnimations = useRef<Animation[]>([]);
  const stop = useRef<(() => void) | null>(null);
  const play = useRef<(pose?: ListPose) => void>(() => {});

  const read = useCallback((root: HTMLElement): ListPose => {
    const marked = [...root.querySelectorAll<HTMLElement>("[data-motion-key]")].filter(
      (node) => !node.closest("[data-list-motion-retiring]"),
    );
    const retiring = [...root.querySelectorAll<HTMLElement>("[data-list-motion-retiring]")].filter(
      (node) => !node.parentElement?.closest("[data-list-motion-retiring]"),
    );
    const nodes = [
      ...new Set([
        ...marked,
        ...retiring,
        ...[...root.children].filter(
          (node): node is HTMLElement =>
            node instanceof HTMLElement &&
            !node.hasAttribute("data-list-motion-retiring") &&
            !node.querySelector("[data-motion-key], [data-list-motion-retiring]"),
        ),
      ]),
    ];
    return {
      height: parseFloat(getComputedStyle(root).height),
      nodes: new Map(
        nodes.map((node) => {
          const key = node.dataset.motionKey ?? node;
          const position = positionWithin(node, root);
          const style = getComputedStyle(node);
          const translation = style.translate === "none" ? [] : style.translate.split(/\s+/);
          return [
            key,
            {
              node,
              parent: node.parentElement,
              x: position.x + (parseFloat(translation[0]) || 0),
              y: position.y + (parseFloat(translation[1]) || 0),
              width: node.offsetWidth,
              height: node.offsetHeight,
              opacity: style.opacity,
              text:
                node.textContent +
                JSON.stringify(
                  [node, ...node.querySelectorAll<HTMLElement>("input, textarea, select, button")]
                    .filter((field) => field.matches("input, textarea, select, button"))
                    .map((field) => [
                      (field as HTMLInputElement).value,
                      field.matches(":disabled"),
                      field instanceof HTMLInputElement ? field.checked : false,
                    ]),
                ),
              contents: capturePaperContents(node),
            },
          ];
        }),
      ),
    };
  }, []);
  const capture = useCallback(() => {
    const root = ref.current;
    if (!root || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      pending.current = null;
      return;
    }
    const capturedTicket = ++nextTicket.current;
    pending.current = { pose: read(root), ticket: capturedTicket };
    activeAnimations.current.forEach((animation) => {
      if (animation.playState === "running") animation.pause();
    });
    // The ticket and the immediately following mutation share React's update
    // priority. A rejected mutation still commits this ticket and clears its pose.
    setTicket(capturedTicket);
  }, [read]);

  useLayoutEffect(() => {
    play.current = (resizedPose) => {
      const root = ref.current;
      if (!root) {
        pending.current = null;
        stop.current?.();
        return;
      }
      if (!resizedPose && pending.current?.ticket !== ticket) return;
      const before = resizedPose ?? pending.current?.pose;
      if (!resizedPose) pending.current = null;
      if (!before) return;
      stop.current?.();
      const media = matchMedia("(prefers-reduced-motion: reduce)");
      if (media.matches) return;
      const after = read(root);
      const scope = createMotionScope("interaction");
      const original = {
        height: root.style.height,
        position: root.style.position,
        alignContent: root.style.alignContent,
      };
      const previousOwner = root.dataset.disclosureMotionActive;
      const previousTarget = root.dataset.disclosureTargetHeight;
      const outerOwner = root.parentElement?.closest(
        '[data-disclosure-motion-active="height"], [data-disclosure-region][aria-hidden="true"], [data-overlay-motion-active="true"]',
      );
      const ownsHeight = !outerOwner && Math.abs(before.height - after.height) >= 0.5;
      if (getComputedStyle(root).position === "static") root.style.position = "relative";
      root.style.alignContent = "start";
      const timing: KeyframeAnimationOptions = {
        duration: 220,
        easing: "cubic-bezier(.22,1,.3,1)",
        fill: "both",
      };
      const animations: Animation[] = [];
      const retiring = (pose: ItemPose, next?: { x: number; y: number }) => {
        const copy = scope.own(pose.contents.copy);
        if (
          copy instanceof HTMLButtonElement ||
          copy instanceof HTMLInputElement ||
          copy instanceof HTMLTextAreaElement ||
          copy instanceof HTMLSelectElement
        )
          copy.disabled = true;
        copy.dataset.listMotionRetiring = "true";
        copy.removeAttribute("data-motion-key");
        copy
          .querySelectorAll("[data-motion-key]")
          .forEach((node) => node.removeAttribute("data-motion-key"));
        Object.assign(copy.style, {
          position: "absolute",
          left: `${pose.x}px`,
          top: `${pose.y}px`,
          right: "auto",
          bottom: "auto",
          width: `${pose.width}px`,
          height: `${pose.height}px`,
          margin: "0",
          minHeight: "0",
          maxHeight: "none",
          translate: "none",
          pointerEvents: "none",
          zIndex: "2",
        });
        (pose.parent?.isConnected && root.contains(pose.parent) ? pose.parent : root).appendChild(
          copy,
        );
        // Preserve the original selector context, then convert the root-relative
        // capture to the copy's real positioned ancestor, including scroll offsets.
        const parent = copy.offsetParent as HTMLElement | null;
        const parentOrigin =
          parent && parent !== root ? positionWithin(parent, root) : { x: 0, y: 0 };
        if (parent && parent !== root) {
          parentOrigin.x += parent.clientLeft;
          parentOrigin.y += parent.clientTop;
        }
        for (let at = copy.parentElement; at && at !== root; at = at.parentElement) {
          parentOrigin.x -= at.scrollLeft;
          parentOrigin.y -= at.scrollTop;
          if (at === parent) break;
        }
        copy.style.left = `${pose.x - parentOrigin.x}px`;
        copy.style.top = `${pose.y - parentOrigin.y}px`;
        pose.contents.restoreScroll();
        animations.push(
          scope.animate(
            copy,
            [
              { opacity: pose.opacity, translate: "0px 0px" },
              {
                opacity: 0,
                translate: `${next ? next.x - pose.x : 0}px ${next ? next.y - pose.y : 0}px`,
              },
            ],
            timing,
          ),
        );
      };
      before.nodes.forEach((pose, key) => {
        if (!after.nodes.has(key)) retiring(pose);
      });
      after.nodes.forEach((pose, key) => {
        const previous = before.nodes.get(key);
        const x = previous ? previous.x - pose.x : 0;
        const y = previous ? previous.y - pose.y : 6;
        const changed = previous && previous.text !== pose.text;
        if (changed) retiring(previous, pose);
        if (Math.abs(x) >= 0.1 || Math.abs(y) >= 0.1)
          animations.push(
            scope.animate(
              pose.node,
              [{ translate: `${x}px ${y}px` }, { translate: "0px 0px" }],
              timing,
            ),
          );
        if (!previous || changed || previous.opacity !== pose.opacity)
          animations.push(
            scope.animate(
              pose.node,
              [{ opacity: !previous || changed ? 0 : previous.opacity }, { opacity: pose.opacity }],
              timing,
            ),
          );
      });
      if (ownsHeight) {
        root.dataset.disclosureMotionActive = "height";
        root.dataset.disclosureTargetHeight = String(after.height);
        animations.push(
          scope.animate(
            root,
            [{ height: `${before.height}px` }, { height: `${after.height}px` }],
            timing,
          ),
        );
      }
      let disposed = false;
      const finish = () => {
        if (disposed) return;
        disposed = true;
        scope.dispose();
        if (activeAnimations.current === animations) activeAnimations.current = [];
        root.style.height = original.height;
        root.style.position = original.position;
        root.style.alignContent = original.alignContent;
        if (ownsHeight) {
          if (previousOwner === undefined) delete root.dataset.disclosureMotionActive;
          else root.dataset.disclosureMotionActive = previousOwner;
          if (previousTarget === undefined) delete root.dataset.disclosureTargetHeight;
          else root.dataset.disclosureTargetHeight = previousTarget;
        }
        window.removeEventListener("resize", resize);
        observer.disconnect();
        if (stop.current === finish) stop.current = null;
      };
      const resize = () => {
        if (disposed) return;
        const pose = read(root);
        if (pending.current) pending.current.pose = pose;
        play.current(pose);
      };
      const rootWidth = root.offsetWidth;
      const sizes = new Map(
        [...after.nodes.values()].map((pose) => [
          pose.node,
          { width: pose.width, height: pose.height },
        ]),
      );
      const observer = new ResizeObserver((entries) => {
        const changed = entries.some(({ target }) => {
          const node = target as HTMLElement;
          if (node === root) return node.offsetWidth !== rootWidth;
          const size = sizes.get(node);
          return size && (node.offsetWidth !== size.width || node.offsetHeight !== size.height);
        });
        if (changed) resize();
      });
      observer.observe(root);
      sizes.forEach((_, node) => observer.observe(node));
      stop.current = finish;
      activeAnimations.current = animations;
      if (pending.current) animations.forEach((animation) => animation.pause());
      window.addEventListener("resize", resize);
      void Promise.allSettled(animations.map((animation) => animation.finished)).then(finish);
    };
    play.current();
  }, [revision, ticket, read]);
  useLayoutEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const settle = () => {
      if (!media.matches) return;
      pending.current = null;
      stop.current?.();
    };
    media.addEventListener("change", settle);
    return () => {
      media.removeEventListener("change", settle);
      pending.current = null;
      stop.current?.();
    };
  }, []);
  return { ref, capture };
}
