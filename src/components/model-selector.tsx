"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Check, ChevronDown } from "lucide-react";
import type { Challenge, ModelMode, ModelOption } from "@/lib/contracts";
import { MODEL_CATALOG, isModelId } from "@/lib/model-catalog";
import { routeModel } from "@/lib/model-routing";
import { capturePaperContents, DisclosureMotion } from "./disclosure-motion";
import { createMotionScope } from "./console/motion-runtime";
import { reducedMotion } from "./console/effects";
import { moveScroll } from "./motion-scroll";
import styles from "./model-selector.module.css";

/** Keep keyboard navigation inside the floating menu's own scroll container. */
function revealOption(host: HTMLElement, option: HTMLElement) {
  let top = 0;
  let node: HTMLElement | null = option;
  while (node && node !== host) {
    top += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  if (top < host.scrollTop + 8) moveScroll(host, { top: Math.max(0, top - 8) }, { duration: 180 });
  else if (top + option.offsetHeight > host.scrollTop + host.clientHeight - 8)
    moveScroll(host, { top: top + option.offsetHeight - host.clientHeight + 8 }, { duration: 180 });
}

type LabelCapture = {
  width: number;
  height: number;
  rows: { node: HTMLElement; height: number }[];
  positions: { node: HTMLElement; x: number; y: number }[];
  contents: ReturnType<typeof capturePaperContents>;
};

/** Read the currently composed button and its original flex-row neighbours. */
function captureModelLabel(button: HTMLButtonElement, field: HTMLFieldSetElement): LabelCapture {
  const parent = field.parentElement;
  const row =
    parent && ["flex", "inline-flex"].includes(getComputedStyle(parent).display) ? parent : null;
  const parentFooter = row?.parentElement;
  const footer =
    parentFooter && getComputedStyle(parentFooter).display === "flex" ? parentFooter : null;
  const nodes = row ? [...row.children] : [field];
  if (footer) nodes.push(...[...footer.children].filter((node) => node !== row));
  return {
    width: parseFloat(getComputedStyle(button).width),
    height: parseFloat(getComputedStyle(button).height),
    rows: [row, footer]
      .filter((node): node is HTMLElement => !!node)
      .map((node) => ({
        node,
        height: parseFloat(getComputedStyle(node).height),
      })),
    positions: nodes
      .filter((node): node is HTMLElement => node instanceof HTMLElement)
      .map((node) => {
        const box = node.getBoundingClientRect();
        return { node, x: box.left, y: box.top };
      }),
    contents: capturePaperContents(button),
  };
}

export function ModelSelector({
  mode,
  onChange,
  challenge,
  providers,
  disabled = false,
  compact = true,
  selectionDisabled = false,
}: {
  mode: ModelMode;
  onChange: (mode: ModelMode) => void;
  challenge: Challenge;
  providers?: ModelOption[];
  disabled?: boolean;
  compact?: boolean;
  selectionDisabled?: boolean;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [showReason, setShowReason] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const selector = useRef<HTMLFieldSetElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const flight = useRef<Animation | null>(null);
  const wantsOpen = useRef(false);
  const focusOnOpen = useRef(0);
  const returnFocus = useRef(false);
  const reason = useRef<HTMLDivElement>(null);
  const followReason = useRef(false);
  const route = routeModel(challenge, mode);
  const selectedId = isModelId(mode) ? mode : route.modelId;
  const selectedModel = MODEL_CATALOG.find((model) => model.id === selectedId)!;
  const label = mode === "auto" ? "自动选择" : selectedModel.label;
  const labelCapture = useRef<LabelCapture | null>(null);
  const [shownLabel, setShownLabel] = useState({ label, revision: 0 });
  useLayoutEffect(() => {
    const button = trigger.current;
    const field = selector.current;
    if (shownLabel.label === label || !button || !field) return;
    labelCapture.current = reducedMotion() ? null : captureModelLabel(button, field);
    setShownLabel({ label, revision: shownLabel.revision + 1 });
  }, [label, shownLabel.label, shownLabel.revision]);
  useLayoutEffect(() => {
    const button = trigger.current;
    const field = selector.current;
    const captured = labelCapture.current;
    if (!button || !field) return;
    const name = button.querySelector<HTMLElement>("[data-model-label]");
    // The old keyed CSS entrance is consumed by this native content handoff.
    if (shownLabel.revision && name) name.style.animation = "none";
    if (!captured) return;
    const scope = createMotionScope("interaction");
    const original = {
      fieldWidth: field.style.width,
      buttonWidth: button.style.width,
      buttonMinWidth: button.style.minWidth,
      buttonMaxWidth: button.style.maxWidth,
      buttonFlexShrink: button.style.flexShrink,
    };
    const rows = captured.rows.map(({ node, height }) => ({
      node,
      height,
      original: node.style.height,
      target: parseFloat(getComputedStyle(node).height),
    }));
    const target = {
      fieldWidth: parseFloat(getComputedStyle(field).width),
      buttonWidth: parseFloat(getComputedStyle(button).width),
    };
    let disposed = false;
    const finish = () => {
      if (disposed) return;
      disposed = true;
      media.removeEventListener("change", preference);
      removeEventListener("resize", resize);
      scope.dispose();
      field.style.width = original.fieldWidth;
      button.style.width = original.buttonWidth;
      button.style.minWidth = original.buttonMinWidth;
      button.style.maxWidth = original.buttonMaxWidth;
      button.style.flexShrink = original.buttonFlexShrink;
      rows.forEach(({ node, original }) => {
        node.style.height = original;
      });
      delete button.dataset.modelLabelMotion;
      if (labelCapture.current === captured) labelCapture.current = null;
    };
    function resize() {
      if (disposed) return;
      labelCapture.current = captureModelLabel(button!, field!);
      setShownLabel((current) => ({ ...current, revision: current.revision + 1 }));
    }
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const preference = () => {
      if (media.matches) finish();
    };
    if (media.matches) return finish;
    // Reserve this switch's natural destination while its visible button resizes.
    // Flex sizing must not clamp a retiring wider button to the narrow destination.
    field.style.width = `${target.fieldWidth}px`;
    button.style.minWidth = "0";
    button.style.maxWidth = "none";
    button.style.flexShrink = "0";
    button.style.width = `${captured.width}px`;
    rows.forEach(({ node, height }) => {
      node.style.height = `${height}px`;
    });
    const positions = captured.positions
      .filter(({ node }) => node.isConnected)
      .map((before) => {
        const box = before.node.getBoundingClientRect();
        return { ...before, dx: before.x - box.left, dy: before.y - box.top };
      });
    const copy = scope.own(captured.contents.copy);
    copy.dataset.modelLabelRetiring = "true";
    Object.assign(copy.style, {
      position: "absolute",
      left: "0",
      top: "0",
      margin: "0",
      minWidth: "0",
      maxWidth: "none",
      width: `${captured.width}px`,
      height: `${captured.height}px`,
      borderColor: "transparent",
      background: "transparent",
      boxShadow: "none",
      transform: "none",
      translate: "none",
      opacity: "1",
      pointerEvents: "none",
      zIndex: "1",
    });
    button.appendChild(copy);
    captured.contents.restoreScroll();
    button.dataset.modelLabelMotion = "true";
    const timing: KeyframeAnimationOptions = {
      duration: 220,
      easing: "cubic-bezier(.22,1,.3,1)",
      fill: "both",
    };
    const animations = [
      scope.animate(
        button,
        [{ width: `${captured.width}px` }, { width: `${target.buttonWidth}px` }],
        timing,
      ),
      scope.animate(copy, [{ opacity: 1 }, { opacity: 0 }], timing),
      ...positions
        .filter(({ dx, dy }) => Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05)
        .map(({ node, dx, dy }) =>
          scope.animate(node, [{ translate: `${dx}px ${dy}px` }, { translate: "none" }], timing),
        ),
    ];
    rows.forEach(({ node, height, target }) => {
      animations.push(
        scope.animate(node, [{ height: `${height}px` }, { height: `${target}px` }], timing),
      );
    });
    for (const node of [name, button.querySelector<HTMLElement>(":scope > svg")])
      if (node) animations.push(scope.animate(node, [{ opacity: 0 }, { opacity: 1 }], timing));
    media.addEventListener("change", preference);
    addEventListener("resize", resize);
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(finish);
    return finish;
  }, [shownLabel.revision]);
  const selectedIndex =
    mode === "auto"
      ? MODEL_CATALOG.length
      : MODEL_CATALOG.findIndex((model) => model.id === selectedId);
  const availability = (modelId: string, provider: ModelOption["provider"]) =>
    providers?.find((option) => option.id === modelId) ??
    providers?.find((option) => option.provider === provider);
  const selected = availability(selectedId, route.provider);

  const restoreFocus = useCallback(() => {
    if (!returnFocus.current) return;
    const button = trigger.current;
    if (!button || button.disabled) return;
    const focused = document.activeElement;
    if (focused === document.body || focused === button || panel.current?.contains(focused))
      button.focus({ preventScroll: true });
    returnFocus.current = false;
  }, []);
  const requestOpen = useCallback((open: boolean, restore = false, index = 0) => {
    wantsOpen.current = open;
    returnFocus.current = !open && restore;
    if (open) {
      focusOnOpen.current = index;
      setActiveIndex(index);
    }
    setExpanded(open);
    if (!open) followReason.current = false;
  }, []);
  const stop = useCallback(() => {
    if (flight.current) {
      flight.current.onfinish = null;
      flight.current.cancel();
      flight.current = null;
    }
  }, []);
  const finish = useCallback(
    (open: boolean) => {
      const el = panel.current;
      if (!el) return;
      if (!open && el.matches(":popover-open")) el.hidePopover();
      stop();
      el.inert = !open;
      if (!open) restoreFocus();
    },
    [restoreFocus, stop],
  );

  const fly = useCallback(
    (open: boolean) => {
      const el = panel.current;
      const button = trigger.current;
      if (!el || !button) return;
      const wasVisible = el.matches(":popover-open");
      const currentBox = wasVisible ? el.getBoundingClientRect() : null;
      const opacity = wasVisible ? getComputedStyle(el).opacity : "0";
      stop();
      if (!wasVisible && !open) return;
      if (!wasVisible) el.showPopover();
      el.inert = !open;
      const source = button.getBoundingClientRect();
      const width = Math.min(348, innerWidth - 24);
      const below = innerHeight - source.bottom - 9 - 12;
      const above = source.top - 9 - 12;
      const useBelow = below >= Math.min(380, el.scrollHeight) || below >= above;
      const room = Math.max(96, Math.min(innerHeight - 24, useBelow ? below : above));
      Object.assign(el.style, {
        width: `${width}px`,
        maxHeight: `${room}px`,
        left: `${Math.max(12, Math.min(innerWidth - width - 12, source.left))}px`,
        top: useBelow ? `${Math.max(12, source.bottom + 9)}px` : "auto",
        bottom: useBelow ? "auto" : `${Math.max(12, innerHeight - source.top + 9)}px`,
      });
      const target = el.getBoundingClientRect();
      const transformFrom = (box: DOMRect) =>
        `translate(${box.left - target.left}px,${useBelow ? box.top - target.top : box.bottom - target.bottom}px) scale(${box.width / target.width},${box.height / target.height})`;
      const start = currentBox ? transformFrom(currentBox) : transformFrom(source);
      if (reducedMotion()) return finish(open);
      // Unfolds from the trigger's corner on one expo-out curve: no stretching, no overshoot.
      el.style.transformOrigin = useBelow ? "left top" : "left bottom";
      const rest = `translateY(${useBelow ? -10 : 10}px) scale(0.94)`;
      const animation = el.animate(
        open
          ? [
              { transform: currentBox ? start : rest, opacity },
              { transform: "none", opacity: 1 },
            ]
          : [
              { transform: currentBox ? start : "none", opacity },
              { transform: rest, opacity: 0 },
            ],
        {
          duration: open ? 260 : 180,
          easing: open ? "cubic-bezier(.16,1,.3,1)" : "cubic-bezier(.4,0,1,1)",
          fill: "both",
        },
      );
      flight.current = animation;
      animation.onfinish = () => {
        if (flight.current === animation) finish(open);
      };
    },
    [finish, stop],
  );

  useLayoutEffect(() => {
    fly(expanded);
    if (expanded) {
      const options = panel.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
      const option = options?.[focusOnOpen.current];
      option?.focus({ preventScroll: true });
      if (panel.current && option) revealOption(panel.current, option);
    }
  }, [expanded, fly]);
  useLayoutEffect(() => {
    const host = panel.current;
    const content = reason.current;
    if (!expanded || !showReason || !followReason.current || !host || !content) return;
    const reveal = () => {
      if (followReason.current)
        moveScroll(
          host,
          { top: Math.max(0, host.scrollHeight - host.clientHeight) },
          { duration: 180 },
        );
    };
    const observer = new ResizeObserver(reveal);
    observer.observe(content);
    observer.observe(host);
    reveal();
    return () => observer.disconnect();
  }, [expanded, showReason]);
  useEffect(() => {
    const el = panel.current;
    const button = trigger.current;
    if (!el || !button) return;
    let frame = 0;
    const outside = (event: PointerEvent) => {
      if (
        !wantsOpen.current ||
        !(event.target instanceof Node) ||
        el.contains(event.target) ||
        button.contains(event.target)
      )
        return;
      requestOpen(false);
    };
    const focusOutside = (event: FocusEvent) => {
      if (
        wantsOpen.current &&
        event.target instanceof Node &&
        !el.contains(event.target) &&
        !button.contains(event.target)
      )
        requestOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || !wantsOpen.current) return;
      event.preventDefault();
      event.stopPropagation();
      requestOpen(false, true);
    };
    const reposition = (event: Event) => {
      if (
        !el.matches(":popover-open") ||
        (event.target instanceof Node && el.contains(event.target))
      )
        return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fly(wantsOpen.current));
    };
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const preference = () => {
      if (media.matches) finish(wantsOpen.current);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", focusOutside);
    document.addEventListener("keydown", escape, true);
    addEventListener("resize", reposition);
    document.addEventListener("scroll", reposition, true);
    media.addEventListener("change", preference);
    return () => {
      cancelAnimationFrame(frame);
      stop();
      if (el.matches(":popover-open")) el.hidePopover();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", focusOutside);
      document.removeEventListener("keydown", escape, true);
      removeEventListener("resize", reposition);
      document.removeEventListener("scroll", reposition, true);
      media.removeEventListener("change", preference);
    };
  }, [finish, fly, requestOpen, stop]);
  useEffect(() => {
    if (disabled && wantsOpen.current) queueMicrotask(() => requestOpen(false));
    if (!disabled && !flight.current && !panel.current?.matches(":popover-open")) restoreFocus();
  }, [disabled, requestOpen, restoreFocus]);

  const choose = (next: ModelMode) => {
    if (selectionDisabled) return;
    onChange(next);
    requestOpen(false, true);
  };
  const focusOption = (index: number) => {
    const options = panel.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
    if (!options?.length) return;
    const target = (index + options.length) % options.length;
    setActiveIndex(target);
    options[target].focus({ preventScroll: true });
    if (panel.current) revealOption(panel.current, options[target]);
  };
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    const options = [
      ...(panel.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []),
    ];
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key))
      event.preventDefault();
    if (event.key === "ArrowDown") focusOption(index + 1);
    else if (event.key === "ArrowUp") focusOption(index - 1);
    else if (event.key === "Home") focusOption(0);
    else if (event.key === "End") focusOption(options.length - 1);
    else if (event.key === "Enter" || event.key === " ") options[index].click();
  };
  return (
    <fieldset
      ref={selector}
      className={`${styles.selector} ${compact ? styles.compact : ""}`}
      disabled={disabled}
    >
      <legend className={compact ? styles.visuallyHidden : ""}>本轮使用的模型</legend>
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        aria-label={`选择模型，当前${label}`}
        aria-haspopup="listbox"
        aria-expanded={expanded}
        aria-controls={`${id}-models`}
        onClick={() => requestOpen(!wantsOpen.current, true, selectedIndex)}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const index =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? mode === "auto"
                    ? MODEL_CATALOG.length
                    : MODEL_CATALOG.length - 1
                  : selectedIndex;
            if (wantsOpen.current) focusOption(index);
            else requestOpen(true, false, index);
          }
        }}
      >
        {/* Keyed by the model: each switch remounts the label and its glint so both replay. */}
        <span key={`glint-${shownLabel.label}`} className={styles.glint} aria-hidden="true" />
        <span key={shownLabel.label} className={styles.label} data-model-label>
          {shownLabel.label}
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <div ref={panel} popover="manual" className={styles.popover} inert={!expanded}>
        <div className={styles.heading}>
          选择模型<span>服务商参考价（原币）</span>
        </div>
        <div
          id={`${id}-models`}
          role="listbox"
          aria-label="本轮使用的模型"
          className={styles.options}
          onKeyDown={navigate}
        >
          {MODEL_CATALOG.map((model, index) => {
            const option = availability(model.id, model.provider);
            const checked = mode !== "auto" && selectedId === model.id;
            return (
              <button
                key={model.id}
                type="button"
                id={`${id}-${model.id}`}
                role="option"
                aria-label={model.label}
                aria-describedby={`${id}-${model.id}-note`}
                aria-selected={checked}
                aria-disabled={selectionDisabled || undefined}
                tabIndex={activeIndex === index ? 0 : -1}
                className={`${styles.option} ${checked ? styles.selected : ""}`}
                onClick={() => choose(model.id)}
                onFocus={() => setActiveIndex(index)}
              >
                <span>
                  <strong>{model.label}</strong>
                  <small id={`${id}-${model.id}-note`}>
                    {option?.configured === false ? "尚未配置 · " : ""}
                    {model.currency === "USD" ? "USD $" : "CNY ¥"}
                    {model.inputPrice} / {model.outputPrice} · 输入 / 输出每百万 Token
                  </small>
                </span>
                {checked && <Check size={16} aria-hidden="true" />}
              </button>
            );
          })}
          {mode === "auto" && (
            <button
              type="button"
              role="option"
              aria-label="自动选择"
              aria-selected
              aria-disabled={selectionDisabled || undefined}
              tabIndex={activeIndex === MODEL_CATALOG.length ? 0 : -1}
              className={`${styles.option} ${styles.selected}`}
              onClick={() => choose("auto")}
              onFocus={() => setActiveIndex(MODEL_CATALOG.length)}
            >
              <span>
                <strong>自动选择</strong>
                <small>保留当前版本的选择规则</small>
              </span>
              <Check size={16} aria-hidden="true" />
            </button>
          )}
        </div>
        <p className={styles.detail}>
          {selectionDisabled
            ? "当前只能查看模型信息，暂时不能更改选择。"
            : "本轮各角色使用同一模型。"}
        </p>
        {selected?.configured === false && (
          <p className={styles.unavailable} role="status">
            {selected.error || "当前模型尚未配置，请选择已配置的模型。"}
          </p>
        )}
        <button
          type="button"
          className={styles.reasonToggle}
          aria-expanded={showReason}
          aria-controls={`${id}-reason`}
          onClick={() => {
            followReason.current = !showReason;
            setShowReason(!showReason);
          }}
        >
          查看选择依据
          <ChevronDown size={13} aria-hidden="true" />
        </button>
        <div ref={reason}>
          <DisclosureMotion open={showReason} id={`${id}-reason`}>
            <p className={styles.detail}>
              {route.reason}
              {mode === "auto"
                ? "材料达到 6000 字符，或限制条件连同预算、时间合计达到 4 项时，选择 GPT；其他任务选择 DeepSeek。这一规则不代表模型质量评估。"
                : "你可以根据任务需要和参考费用更换模型，后续调用会使用新选择。"}
            </p>
          </DisclosureMotion>
        </div>
      </div>
    </fieldset>
  );
}
