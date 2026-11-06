"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ArenaSnapshot, Challenge, ModelMode } from "@/lib/contracts";
import type { IntakeDraft } from "@/lib/intake-contracts";

export interface Health {
  status: string;
  version: string;
  commit: string;
  model: ArenaSnapshot["model"];
  requiresAccessCode?: boolean;
  accessGranted?: boolean;
}
class ApiError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}
async function api<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({ error: "服务返回了无法读取的响应" }));
  if (!response.ok) throw new ApiError(data.error ?? "请求未完成，请稍后重试", data.code);
  return data;
}
const storageKey = "strategy-arena:last-id";
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function revisionOf(value: ArenaSnapshot) {
  return {
    version: value.versions.find((v) => v.id === value.activeVersionId)?.number ?? 0,
    seq: value.events.at(-1)?.seq ?? 0,
  };
}
/** Reject both pre-mutation responses and snapshots read before a newer server event. */
export function snapshotIsOlder(incoming: ArenaSnapshot, current: ArenaSnapshot) {
  if (incoming.id !== current.id) return false;
  const a = revisionOf(incoming);
  const b = revisionOf(current);
  return a.version < b.version || (a.version === b.version && a.seq < b.seq);
}
export function useArena() {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState("");
  const [snapshot, setSnapshot] = useState<ArenaSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(true);
  const [driverRevision, setDriverRevision] = useState(0);
  const [restoring, setRestoring] = useState(true);
  const mounted = useRef(true);
  const latest = useRef<ArenaSnapshot | null>(null);
  const generation = useRef(0);
  const mutationBusy = useRef(false);
  const advanceBusy = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const request = useCallback(async <T>(url: string, body?: unknown): Promise<T> => {
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      return await api<T>(url, body, controller.signal);
    } finally {
      controllers.current.delete(controller);
    }
  }, []);
  const accept = useCallback((value: ArenaSnapshot, expectedGeneration: number) => {
    if (!mounted.current || expectedGeneration !== generation.current) return false;
    if (latest.current && snapshotIsOlder(value, latest.current)) return false;
    latest.current = value;
    setSnapshot(value);
    localStorage.setItem(storageKey, value.id);
    return true;
  }, []);
  const refresh = useCallback(
    async (id: string) => {
      const epoch = generation.current;
      const value = await request<ArenaSnapshot>(`/api/arenas/${id}`);
      accept(value, epoch);
      return value;
    },
    [request, accept],
  );
  const restore = useCallback(async () => {
    const epoch = generation.current;
    let id: string | null = null;
    let restoringPreviousArena = false;
    try {
      id = localStorage.getItem(storageKey);
      const draftId = localStorage.getItem("strategy-arena:intake-id");
      if (draftId) {
        let draft: IntakeDraft | null = null;
        try {
          draft = await request<IntakeDraft>(`/api/intakes/${encodeURIComponent(draftId)}`);
        } catch (failure) {
          if (failure instanceof ApiError && failure.code === "NOT_FOUND")
            localStorage.removeItem("strategy-arena:intake-id");
          else throw failure;
        }
        if (draft) {
          // The server may have committed submit even when the browser lost its response.
          if (draft.status === "submitted" && draft.arenaId) {
            const committed = await request<ArenaSnapshot>(`/api/arenas/${draft.arenaId}`);
            if (accept(committed, epoch)) localStorage.removeItem("strategy-arena:intake-id");
          }
          // A pending draft takes precedence over an older discussion in this browser.
          return;
        }
      }
      if (!id) return;
      restoringPreviousArena = true;
      const value = await request<ArenaSnapshot>(`/api/arenas/${encodeURIComponent(id)}`);
      accept(value, epoch);
    } catch (e) {
      if (mounted.current && !(e instanceof Error && e.name === "AbortError")) {
        if (restoringPreviousArena && !(e instanceof ApiError && e.code === "ACCESS_REQUIRED"))
          localStorage.removeItem(storageKey);
        setError(
          e instanceof ApiError && (e.code === "NOT_FOUND" || e.code === "FORBIDDEN")
            ? "上次的擂台无法在当前浏览器身份下打开。你可以开始新一轮。"
            : "未能恢复上次的擂台，你可以重新开始。",
        );
      }
    } finally {
      if (mounted.current) setRestoring(false);
    }
  }, [request, accept]);
  useEffect(() => {
    mounted.current = true;
    request<Health>("/api/health")
      .then(async (value) => {
        if (!mounted.current) return;
        setHealth(value);
        if (!value.requiresAccessCode || value.accessGranted) await restore();
        else setRestoring(false);
      })
      .catch((e) => {
        if (mounted.current && !(e instanceof Error && e.name === "AbortError")) {
          setHealthError("暂时无法连接服务。请确认本地服务已启动。");
          setRestoring(false);
        }
      });
    const registry = controllers.current;
    return () => {
      mounted.current = false;
      registry.forEach((c) => c.abort());
      registry.clear();
    };
  }, [request, restore]);
  const arenaId = snapshot?.id;
  const activeId = snapshot?.activeVersionId;
  useEffect(() => {
    if (!arenaId) return;
    const source = new EventSource(
      `/api/arenas/${arenaId}/events?afterSeq=${latest.current?.events.at(-1)?.seq ?? 0}`,
    );
    let refreshing = false;
    let queued = false;
    let closed = false;
    const onEvent = async () => {
      if (refreshing) {
        queued = true;
        return;
      }
      refreshing = true;
      do {
        queued = false;
        await refresh(arenaId).catch(() => {});
      } while (queued && !closed);
      refreshing = false;
    };
    source.addEventListener("arena", onEvent);
    return () => {
      closed = true;
      source.close();
    };
  }, [arenaId, refresh]);
  useEffect(() => {
    if (!arenaId || !activeId || !auto) return;
    let cancelled = false;
    const drive = async () => {
      let capacityRetries = 0;
      // This loop owns its scheduling. Snapshot renders and SSE events do not cancel it.
      while (!cancelled && mounted.current) {
        if (mutationBusy.current || advanceBusy.current) {
          await delay(150);
          continue;
        }
        const current = latest.current;
        const active = current?.versions.find((v) => v.id === current.activeVersionId);
        if (
          !current ||
          current.id !== arenaId ||
          !active ||
          active.id !== activeId ||
          !["ready", "running"].includes(active.status)
        )
          return;
        const epoch = generation.current;
        advanceBusy.current = true;
        try {
          const value = await request<ArenaSnapshot>(`/api/arenas/${arenaId}/advance`, {
            versionId: active.id,
          });
          if (!cancelled) accept(value, epoch);
          capacityRetries = 0;
        } catch (e) {
          if (
            cancelled ||
            epoch !== generation.current ||
            (e instanceof Error && e.name === "AbortError")
          )
            return;
          if (e instanceof ApiError && e.code === "CONCURRENCY_LIMIT" && capacityRetries < 3) {
            capacityRetries++;
            await delay(1000 * 2 ** capacityRetries);
            if (!cancelled) await refresh(arenaId).catch(() => {});
          } else if (
            e instanceof ApiError &&
            ["STEP_BUSY", "RUN_BUSY", "BUSY"].includes(e.code ?? "")
          ) {
            await refresh(arenaId).catch(() => {});
          } else {
            setAuto(false);
            setError(
              e instanceof Error
                ? `${e.message}。为避免重复计费，自动推进已停止；请先刷新状态。`
                : "请求状态不明，已停止自动推进。请先刷新状态。",
            );
            return;
          }
        } finally {
          advanceBusy.current = false;
        }
        await delay(
          latest.current?.versions.find((v) => v.id === activeId)?.status === "running"
            ? 1800
            : 300,
        );
      }
    };
    void drive();
    return () => {
      cancelled = true;
    };
  }, [arenaId, activeId, auto, driverRevision, request, accept, refresh]);
  const mutate = useCallback(
    async (path: string, body: unknown, keepDriving = true) => {
      mutationBusy.current = true;
      const epoch = ++generation.current;
      setBusy(true);
      setError("");
      try {
        const value = await request<ArenaSnapshot>(path, body);
        accept(value, epoch);
        setAuto(keepDriving);
        setDriverRevision((v) => v + 1);
        return true;
      } catch (e) {
        if (!(e instanceof Error && e.name === "AbortError")) {
          setAuto(false);
          setError(e instanceof Error ? e.message : "操作未完成，请重试");
        }
        return false;
      } finally {
        mutationBusy.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [request, accept],
  );
  const active = snapshot?.versions.find((v) => v.id === snapshot.activeVersionId);
  return {
    health,
    healthError,
    snapshot,
    active,
    error,
    busy,
    restoring,
    auto,
    unlock: async (code: string) => {
      setBusy(true);
      setError("");
      try {
        await request("/api/access", { code });
        const next = await request<Health>("/api/health");
        setHealth(next);
        await restore();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "访问码验证失败");
        return false;
      } finally {
        setBusy(false);
      }
    },
    clearError: () => setError(""),
    adopt: (value: ArenaSnapshot) => {
      const epoch = ++generation.current;
      setError("");
      accept(value, epoch);
      setAuto(true);
      setDriverRevision((revision) => revision + 1);
    },
    create: (challenge: Challenge, modelMode: ModelMode = "auto") =>
      mutate("/api/arenas", { ...challenge, modelMode }),
    rematch: (challenge: Challenge, changeReason: string, modelMode?: ModelMode) =>
      latest.current
        ? mutate(`/api/arenas/${latest.current.id}/versions`, {
            challenge,
            changeReason,
            modelMode,
          })
        : Promise.resolve(false),
    intervene: (targetStrategyId: string, targetClaimId: string, text: string) =>
      latest.current
        ? mutate(`/api/arenas/${latest.current.id}/interventions`, {
            targetStrategyId,
            targetClaimId,
            text,
          })
        : Promise.resolve(false),
    stop: async () => {
      const current = latest.current;
      if (!current) return;
      setAuto(false);
      await mutate(`/api/arenas/${current.id}/stop`, { versionId: current.activeVersionId }, false);
    },
    sync: async () => {
      if (!latest.current) return;
      setBusy(true);
      try {
        await refresh(latest.current.id);
        setError("");
      } catch (e) {
        setError(e instanceof Error ? e.message : "刷新失败");
      } finally {
        setBusy(false);
      }
    },
    resume: () => {
      setError("");
      setAuto(true);
      setDriverRevision((v) => v + 1);
    },
    reset: () => {
      generation.current++;
      latest.current = null;
      setAuto(false);
      setSnapshot(null);
      setError("");
      localStorage.removeItem(storageKey);
    },
  };
}
