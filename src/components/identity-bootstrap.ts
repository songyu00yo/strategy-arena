"use client";

import type { IdentityState } from "@/lib/identity-contracts";

export const IDENTITY_BOOTSTRAP_LOCK = "strategy-arena:identity-bootstrap";
let pending: Promise<IdentityState> | null = null;

async function readIdentity(): Promise<IdentityState> {
  const response = await fetch("/api/identity", {
    cache: "no-store",
    credentials: "same-origin",
    signal: AbortSignal.timeout(15000),
  });
  const value = await response.json().catch(() => null);
  if (
    !response.ok ||
    !value ||
    !/^[a-f0-9]{64}$/.test(value.identityTag) ||
    typeof value.hasRecoveryCode !== "boolean"
  )
    throw new Error("浏览器身份初始化未完成，请刷新后重试。");
  return value as IdentityState;
}

/** Serialize the first Set-Cookie across tabs. Never persist identity credentials in web storage. */
export function bootstrapIdentity(): Promise<IdentityState> {
  if (pending) return pending;
  const initialization =
    typeof navigator !== "undefined" && navigator.locks
      ? navigator.locks.request(IDENTITY_BOOTSTRAP_LOCK, readIdentity)
      : readIdentity();
  // A component unmount must not abort a request shared with another subscriber.
  pending = Promise.resolve(initialization).finally(() => {
    pending = null;
  });
  return pending;
}
