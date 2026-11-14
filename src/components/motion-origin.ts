"use client";

export interface MotionOrigin {
  element: HTMLElement;
  x: number;
  y: number;
  width: number;
  height: number;
  relativeX: number;
  relativeY: number;
  time: number;
}
let latest: MotionOrigin | null = null;
const pressed = new WeakMap<HTMLElement, MotionOrigin>();

export function recordMotionOrigin(element: HTMLElement, x: number, y: number, rect: DOMRect) {
  latest = {
    element,
    x,
    y,
    width: rect.width,
    height: rect.height,
    relativeX: rect.width ? (x - rect.left) / rect.width : 0.5,
    relativeY: rect.height ? (y - rect.top) / rect.height : 0.5,
    time: performance.now(),
  };
  pressed.set(element, latest);
}

export function readMotionOrigin(element?: HTMLElement | null): MotionOrigin | null {
  const origin = element ? pressed.get(element) : latest;
  if (origin && performance.now() - origin.time < 2500) return { ...origin };
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    element,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    width: rect.width,
    height: rect.height,
    relativeX: 0.5,
    relativeY: 0.5,
    time: performance.now(),
  };
}

export function currentMotionOrigin(origin: MotionOrigin | null) {
  if (!origin) return null;
  if (!origin.element.isConnected) return origin;
  const rect = origin.element.getBoundingClientRect();
  if (!rect.width || !rect.height) return origin;
  return {
    ...origin,
    x: rect.left + rect.width * origin.relativeX,
    y: rect.top + rect.height * origin.relativeY,
    width: rect.width,
    height: rect.height,
  };
}
