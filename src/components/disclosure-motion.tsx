"use client";

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { reducedMotion } from "./console/effects";

/** CSSOM used heights retain layout fractions without inheriting ancestor transforms. */
function layoutHeight(element: HTMLElement, target?: number) {
  if (typeof getComputedStyle !== "function") return target ?? element.offsetHeight;
  const style = getComputedStyle(element);
  if (
    style.display === "none" ||
    (typeof element.getClientRects === "function" && !element.getClientRects().length)
  )
    return 0;
  const height = target ?? Number.parseFloat(style.height);
  if (!Number.isFinite(height) || (target === undefined && !style.height.endsWith("px")))
    return element.offsetHeight;
  const edges = [
    style.paddingTop,
    style.paddingBottom,
    style.borderTopWidth,
    style.borderBottomWidth,
  ].reduce((sum, value) => sum + (Number.parseFloat(value) || 0), 0);
  return style.boxSizing === "border-box" ? Math.max(edges, height) : height + edges;
}

/** Predict the settled height while nested disclosures animate their own layout. */
export function disclosureTargetHeight(inner: HTMLElement) {
  let height = layoutHeight(inner);
  for (const child of inner.querySelectorAll<HTMLElement>(
    '[data-disclosure-motion-active="height"]',
  )) {
    const parent = child.parentElement?.closest<HTMLElement>(
      '[data-disclosure-motion-active="height"]',
    );
    if (parent && inner.contains(parent)) continue;
    const target = Number(child.dataset.disclosureTargetHeight);
    if (Number.isFinite(target)) height += layoutHeight(child, target) - layoutHeight(child);
  }
  return Math.max(0, height);
}

/** Animate the height the paper can display before its existing scroll limits take over. */
export function disclosureHeightRange(host: HTMLElement, target: number) {
  const from = host.getBoundingClientRect().height;
  const paper = host.closest<HTMLElement>("dialog[open]");
  if (!paper || paper.dataset.overlayMotionActive === "true") return { from, to: target };
  const originalHeight = host.style.height;
  const currentPaperHeight = paper.getBoundingClientRect().height;
  const scrollPositions: { node: HTMLElement; top: number; left: number }[] = [];
  for (let node = host.parentElement; node; node = node.parentElement) {
    scrollPositions.push({ node, top: node.scrollTop, left: node.scrollLeft });
    if (node === paper) break;
  }
  try {
    host.style.height = "0px";
    const collapsedPaperHeight = paper.getBoundingClientRect().height;
    host.style.height = `${target}px`;
    const targetPaperHeight = paper.getBoundingClientRect().height;
    const visibleFrom = Math.max(0, currentPaperHeight - collapsedPaperHeight);
    const visibleTarget = Math.max(0, targetPaperHeight - collapsedPaperHeight);
    // A disclosure entirely inside an already full scroll region does not resize its paper.
    if (Math.max(visibleFrom, visibleTarget) < 0.5) return { from, to: target };
    return { from: Math.min(from, visibleFrom), to: Math.min(target, visibleTarget) };
  } finally {
    host.style.height = originalHeight;
    scrollPositions.forEach(({ node, top, left }) => {
      node.scrollTop = top;
      node.scrollLeft = left;
    });
  }
}

/** Capture current text and field values without adding another live control surface. */
export function capturePaperContents(source: HTMLElement) {
  const copy = source.cloneNode(true) as HTMLElement;
  const controls = [
    ...source.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement
    >("input, textarea, select, button"),
  ];
  copy
    .querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement
    >("input, textarea, select, button")
    .forEach((field, index) => {
      const original = controls[index];
      field.value = original.value;
      if (field instanceof HTMLInputElement && original instanceof HTMLInputElement)
        field.checked = original.checked;
      const appearance = getComputedStyle(original);
      for (const property of ["opacity", "color", "background-color", "border-color", "box-shadow"])
        field.style.setProperty(property, appearance.getPropertyValue(property));
      field.disabled = true;
    });
  copy.removeAttribute("id");
  copy.querySelectorAll("[id]").forEach((child) => child.removeAttribute("id"));
  const sourceNodes = [source, ...source.querySelectorAll<HTMLElement>("*")];
  const copiedNodes = [copy, ...copy.querySelectorAll<HTMLElement>("*")];
  const scrollPositions = sourceNodes.map((node, index) => ({
    copy: copiedNodes[index],
    top: node.scrollTop,
    left: node.scrollLeft,
  }));
  const animated = new Set(
    source
      .getAnimations({ subtree: true })
      .map((animation) => (animation.effect as KeyframeEffect | null)?.target),
  );
  sourceNodes.forEach((source, index) => {
    const captured = copiedNodes[index];
    captured.removeAttribute("data-board");
    captured.removeAttribute("data-claim");
    captured.removeAttribute("data-step-source");
    captured.removeAttribute("data-disclosure-motion-active");
    captured.removeAttribute("data-disclosure-target-height");
    captured.style.transition = "none";
    if (!animated.has(source)) return;
    const style = getComputedStyle(source);
    captured.style.animation = "none";
    for (const property of [
      "transform",
      "translate",
      "scale",
      "rotate",
      "opacity",
      "height",
      "width",
    ])
      captured.style.setProperty(property, style.getPropertyValue(property));
  });
  copy.inert = true;
  copy.setAttribute("aria-hidden", "true");
  copy.style.pointerEvents = "none";
  return {
    copy,
    restoreScroll: () =>
      scrollPositions.forEach(({ copy, top, left }) => {
        if (top) copy.scrollTop = top;
        if (left) copy.scrollLeft = left;
      }),
  };
}

/** A reversible disclosure: its own interaction clock is independent of story playback. */
export function DisclosureMotion({
  open,
  children,
  id,
  className,
  contentKey,
}: {
  open: boolean;
  children: ReactNode;
  id?: string;
  className?: string;
  contentKey?: string | number;
}) {
  const generatedId = useId();
  const regionId = id ?? generatedId;
  const host = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const outer = host.current;
    const inner = content.current;
    if (!outer || !inner) return;
    let animations: Animation[] = [];
    let target = -1;
    let finishCurrent = () => {};
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const freeze = () => {
      const height = outer.getBoundingClientRect().height;
      const style = getComputedStyle(inner);
      const pose = { opacity: style.opacity, transform: style.transform };
      animations.forEach((animation) => {
        animation.onfinish = null;
        animation.cancel();
      });
      animations = [];
      outer.style.height = `${height}px`;
      Object.assign(inner.style, pose);
    };
    if (!open && outer.contains(document.activeElement)) {
      document
        .querySelector<HTMLElement>(`[aria-controls="${CSS.escape(regionId)}"]`)
        ?.focus({ preventScroll: true });
    }
    const resize = () => {
      const next = open ? disclosureTargetHeight(inner) : 0;
      if (Math.abs(target - next) < 0.5) return;
      // A settled parent follows a child's one layout animation without adding another.
      if (
        open &&
        outer.style.height === "auto" &&
        inner.querySelector('[data-disclosure-motion-active="height"]')
      ) {
        target = next;
        return;
      }
      // An auto-sized host has already followed the new content by the time ResizeObserver runs.
      // Restore the last settled height before measuring the start pose of a phase/line-wrap change.
      if (open && outer.style.height === "auto" && target >= 0) outer.style.height = `${target}px`;
      target = next;
      freeze();
      outer.style.visibility = "visible";
      const overlayOwnsHeight = !!outer.closest('[data-overlay-motion-active="true"]');
      const heightRange = disclosureHeightRange(outer, next);
      outer.dataset.disclosureMotionActive = overlayOwnsHeight ? "content" : "height";
      outer.dataset.disclosureTargetHeight = String(heightRange.to);
      const settle = () => {
        outer.style.height = open ? "auto" : "0px";
        outer.style.visibility = open ? "visible" : "hidden";
        delete outer.dataset.disclosureMotionActive;
        delete outer.dataset.disclosureTargetHeight;
        Object.assign(inner.style, {
          opacity: open ? "1" : "0",
          transform: open ? "none" : "translateY(-6px)",
        });
        animations.forEach((animation) => animation.cancel());
        animations = [];
      };
      finishCurrent = settle;
      if (reducedMotion() || (next === 0 && parseFloat(outer.style.height) === 0)) return settle();
      const timing = {
        duration: open ? 220 : 180,
        easing: open ? "cubic-bezier(.16,1,.3,1)" : "cubic-bezier(.4,0,.2,1)",
        fill: "both",
      } as const;
      outer.style.height = `${heightRange.from}px`;
      if (overlayOwnsHeight) outer.style.height = open ? "auto" : "0px";
      animations = [
        ...(!overlayOwnsHeight
          ? [
              outer.animate(
                [{ height: `${heightRange.from}px` }, { height: `${heightRange.to}px` }],
                timing,
              ),
            ]
          : []),
        inner.animate(
          [
            {
              opacity: inner.style.opacity,
              transform: inner.style.transform,
            },
            {
              opacity: open ? 1 : 0,
              transform: open ? "none" : "translateY(-6px)",
            },
          ],
          timing,
        ),
      ];
      animations[0].onfinish = settle;
    };
    resize();
    const onPreference = () => {
      if (media.matches) finishCurrent();
    };
    media.addEventListener("change", onPreference);
    const observer = new ResizeObserver(resize);
    observer.observe(inner);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", onPreference);
      freeze();
      delete outer.dataset.disclosureMotionActive;
      delete outer.dataset.disclosureTargetHeight;
    };
  }, [open, regionId]);
  return (
    <div
      id={regionId}
      ref={host}
      className={className}
      data-disclosure-region=""
      inert={!open}
      aria-hidden={!open}
      style={{ height: 0, overflow: "clip", visibility: "hidden" }}
    >
      <div
        ref={content}
        style={{ display: "flow-root", opacity: 0, transformOrigin: "top center" }}
      >
        {contentKey === undefined ? (
          children
        ) : (
          <TransitionContents contentKey={contentKey}>{children}</TransitionContents>
        )}
      </div>
    </div>
  );
}

/** Keep the retiring text visible while the next phase takes over its position. */
function TransitionContents({
  contentKey,
  children,
}: {
  contentKey: string | number;
  children: ReactNode;
}) {
  const [shown, setShown] = useState({ key: contentKey, children });
  if (shown.key === contentKey && shown.children !== children)
    setShown({ key: contentKey, children });
  const stage = useRef<HTMLDivElement>(null);
  const node = useRef<HTMLDivElement>(null);
  const requested = useRef({ key: contentKey, children });
  const retired = useRef(new Map<HTMLElement, Animation | null>());
  useLayoutEffect(() => {
    requested.current = { key: contentKey, children };
  });
  useLayoutEffect(() => {
    const el = node.current;
    const host = stage.current;
    if (!el || !host || shown.key === contentKey) return;
    if (!reducedMotion()) {
      const pose = getComputedStyle(el);
      host.style.height = `${host.getBoundingClientRect().height}px`;
      const captured = capturePaperContents(el);
      const copy = captured.copy;
      copy.dataset.disclosureRetiring = "true";
      Object.assign(copy.style, {
        position: "absolute",
        inset: "0 auto auto 0",
        width: `${el.offsetWidth}px`,
        height: `${el.offsetHeight}px`,
        overflow: "clip",
        pointerEvents: "none",
        opacity: pose.opacity,
        transform: pose.transform,
        zIndex: "1",
      });
      host.appendChild(copy);
      captured.restoreScroll();
      retired.current.set(copy, null);
    }
    setShown(requested.current);
  }, [contentKey, shown.key]);
  useLayoutEffect(() => {
    const el = node.current;
    const host = stage.current;
    if (!el || !host || shown.key !== requested.current.key) return;
    el.querySelector<HTMLElement>("[data-disclosure-autofocus]")?.focus({ preventScroll: true });
    const clearCopies = () => {
      retired.current.forEach((animation, copy) => {
        if (animation) animation.onfinish = null;
        animation?.cancel();
        copy.remove();
      });
      retired.current.clear();
    };
    if (reducedMotion()) {
      host.style.height = "auto";
      clearCopies();
      return;
    }
    const target = disclosureTargetHeight(el);
    const overlayOwnsHeight = !!host.closest('[data-overlay-motion-active="true"]');
    const heightRange = disclosureHeightRange(host, target);
    const changesHeight = !overlayOwnsHeight && Math.abs(heightRange.from - heightRange.to) >= 0.5;
    if (overlayOwnsHeight) host.style.height = "auto";
    else if (changesHeight) host.style.height = `${heightRange.from}px`;
    host.dataset.disclosureMotionActive = changesHeight ? "height" : "content";
    if (changesHeight) host.dataset.disclosureTargetHeight = String(heightRange.to);
    const timing: KeyframeAnimationOptions = {
      duration: 220,
      easing: "cubic-bezier(.2,.8,.2,1)",
      fill: "both",
    };
    let disposed = false;
    const animation = el.animate(
      [
        { opacity: 0, transform: "translateY(8px)" },
        { opacity: 1, transform: "none" },
      ],
      timing,
    );
    const parts = [animation];
    if (changesHeight)
      parts.push(
        host.animate(
          [{ height: `${heightRange.from}px` }, { height: `${heightRange.to}px` }],
          timing,
        ),
      );
    const synchronized: Animation[] = [...parts];
    retired.current.forEach((flight, copy) => {
      if (flight) return;
      const leaving = copy.animate(
        [
          { opacity: copy.style.opacity, transform: copy.style.transform },
          { opacity: 0, transform: "translateY(-6px)" },
        ],
        timing,
      );
      synchronized.push(leaving);
      retired.current.set(copy, leaving);
      leaving.onfinish = () => {
        retired.current.delete(copy);
        copy.remove();
      };
    });
    // Pending native effects start together on the next rendered frame, after mounting work.
    void animation.ready
      .then(() => {
        if (disposed || typeof animation.startTime !== "number") return;
        synchronized.forEach((part) => {
          part.startTime = animation.startTime;
        });
      })
      .catch(() => {});
    const settle = () => {
      delete host.dataset.disclosureMotionActive;
      delete host.dataset.disclosureTargetHeight;
      host.style.height = "auto";
      el.style.opacity = "1";
      el.style.transform = "none";
      parts.forEach((part) => {
        part.onfinish = null;
        part.cancel();
      });
    };
    animation.onfinish = settle;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const onPreference = () => {
      if (!media.matches) return;
      settle();
      clearCopies();
    };
    media.addEventListener("change", onPreference);
    return () => {
      disposed = true;
      media.removeEventListener("change", onPreference);
      const pose = getComputedStyle(el);
      host.style.height = `${host.getBoundingClientRect().height}px`;
      el.style.opacity = pose.opacity;
      el.style.transform = pose.transform;
      parts.forEach((part) => {
        part.onfinish = null;
        part.cancel();
      });
      delete host.dataset.disclosureMotionActive;
      delete host.dataset.disclosureTargetHeight;
    };
  }, [shown.key]);
  useLayoutEffect(() => {
    const copies = retired.current;
    return () => {
      copies.forEach((animation, copy) => {
        if (animation) animation.onfinish = null;
        animation?.cancel();
        copy.remove();
      });
      copies.clear();
    };
  }, []);
  return (
    <div ref={stage} style={{ position: "relative", display: "flow-root" }}>
      {/* Keep child margins inside the box measured for the stage destination. */}
      <div ref={node} style={{ display: "flow-root" }}>
        {shown.children}
      </div>
    </div>
  );
}
