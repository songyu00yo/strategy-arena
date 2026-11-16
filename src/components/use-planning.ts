"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CreatePlanningInput,
  PlanningAction,
  PlanningEvent,
  PlanningSnapshot,
} from "@/lib/planning-contracts";
import type { Health } from "./use-arena";
import { bootstrapIdentity } from "./identity-bootstrap";
import { acceptPlanningSnapshot, newPlanningEvents } from "./planning/client-utils";

export type PlanningCommand = PlanningAction extends infer Action
  ? Action extends PlanningAction
    ? Omit<Action, "operationId" | "revision">
    : never
  : never;
type Journal = { sessionId: string | null; body: PlanningAction | CreatePlanningInput };
export type PlanningHistory = { id: string; goal: string; updatedAt: string };
const POINTER = "strategy-arena:planning:last";
const JOURNAL = "strategy-arena:planning:pending";
const HISTORY = "strategy-arena:planning:history";

class PlanningRequestError extends Error {
  constructor(
    message: string,
    readonly code = "",
    readonly status = 0,
  ) {
    super(message);
  }
}
function readStorage<T>(key: string): T | null {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "null") as T | null;
  } catch {
    return null;
  }
}
function saveJournal(journal: Journal | null) {
  try {
    if (journal) sessionStorage.setItem(JOURNAL, JSON.stringify(journal));
    else sessionStorage.removeItem(JOURNAL);
  } catch {}
}
function operationObserved(snapshot: PlanningSnapshot, journal: Journal) {
  if (snapshot.session.id !== journal.sessionId) return false;
  return (
    snapshot.session.activeOperationId !== journal.body.operationId &&
    snapshot.events.some(
      (event) => event.operationId === journal.body.operationId && event.kind !== "agent_started",
    )
  );
}

export function usePlanning() {
  const [health, setHealth] = useState<Health | null>(null);
  const [snapshot, setSnapshot] = useState<PlanningSnapshot | null>(null);
  const [arrivals, setArrivals] = useState<PlanningEvent[]>([]);
  const [pendingAction, setPendingAction] = useState<PlanningAction["kind"] | "create" | null>(
    null,
  );
  const [stopPending, setStopPending] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [unknownRequest, setUnknownRequest] = useState<Journal | null>(null);
  const [history, setHistory] = useState<PlanningHistory[]>([]);
  const current = useRef<PlanningSnapshot | null>(null);
  const mounted = useRef(false);
  const epoch = useRef(0);
  const lock = useRef(false);
  const stopping = useRef(false);
  const cursor = useRef(0);
  const journalRef = useRef<Journal | null>(null);
  const registry = useRef(new Set<AbortController>());
  const operationRequests = useRef(new Map<string, AbortController>());

  const request = useCallback(async <T>(url: string, body?: unknown): Promise<T> => {
    const controller = new AbortController();
    registry.current.add(controller);
    const operationId =
      body &&
      typeof body === "object" &&
      "operationId" in body &&
      typeof body.operationId === "string"
        ? body.operationId
        : null;
    const longOperation =
      body &&
      typeof body === "object" &&
      "kind" in body &&
      ["advance", "preview"].includes(String(body.kind));
    if (operationId) operationRequests.current.set(operationId, controller);
    let timedOut = false;
    const deadline = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      body === undefined ? 15000 : longOperation ? 360000 : 30000,
    );
    try {
      const response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const value = await response.json().catch(() => null);
      if (!response.ok)
        throw new PlanningRequestError(
          value?.error || `请求未完成（${response.status}）。`,
          value?.code,
          response.status,
        );
      if (!value) throw new Error("服务响应未能读取，请核对保存状态。");
      return value as T;
    } catch (failure) {
      if (timedOut)
        throw new Error(
          body === undefined
            ? "读取状态超时，已有内容仍保留。"
            : "响应等待超时，请先核对原请求的保存状态。",
        );
      throw failure;
    } finally {
      clearTimeout(deadline);
      registry.current.delete(controller);
      if (operationId && operationRequests.current.get(operationId) === controller)
        operationRequests.current.delete(operationId);
    }
  }, []);

  const remember = useCallback((value: PlanningSnapshot) => {
    try {
      sessionStorage.setItem(POINTER, value.session.id);
      const old = JSON.parse(localStorage.getItem(HISTORY) ?? "[]") as PlanningHistory[];
      const next = [
        { id: value.session.id, goal: value.session.goal, updatedAt: value.session.updatedAt },
        ...old.filter((item) => item.id !== value.session.id),
      ].slice(0, 20);
      localStorage.setItem(HISTORY, JSON.stringify(next));
      setHistory(next);
    } catch {}
  }, []);

  const accept = useCallback(
    (value: PlanningSnapshot, generation: number, restore = false) => {
      if (!value?.session?.id || !Number.isFinite(value.snapshotVersion)) return false;
      if (
        !mounted.current ||
        generation !== epoch.current ||
        !acceptPlanningSnapshot(value, current.current)
      )
        return false;
      const fresh = restore ? [] : newPlanningEvents(value, cursor.current);
      cursor.current = Math.max(
        cursor.current,
        value.eventCursor,
        ...value.events.map((event) => event.seq),
      );
      current.current = value;
      setSnapshot(value);
      if (fresh.length) setArrivals((previous) => [...previous, ...fresh].slice(-80));
      if (journalRef.current && operationObserved(value, journalRef.current)) {
        const completedOperationId = journalRef.current.body.operationId;
        journalRef.current = null;
        saveJournal(null);
        setUnknownRequest(null);
        // A persisted completion is authoritative even if that POST's connection
        // never closes. Only its exact controller is interrupted; post() recognizes
        // the already-observed receipt and releases its lock as a normal success.
        operationRequests.current.get(completedOperationId)?.abort();
      }
      remember(value);
      return true;
    },
    [remember],
  );

  const read = useCallback(
    async (id: string, generation = epoch.current, restore = false) => {
      const value = await request<PlanningSnapshot>(`/api/planning/${encodeURIComponent(id)}`);
      accept(value, generation, restore);
      return value;
    },
    [request, accept],
  );

  const load = useCallback(
    async (id: string, initial = false) => {
      if (lock.current && !initial) return false;
      const generation = ++epoch.current;
      current.current = null;
      cursor.current = 0;
      setSnapshot(null);
      setArrivals([]);
      setError("");
      setRestoring(true);
      setBlocked(false);
      try {
        await read(id, generation, true);
        if (generation !== epoch.current || !mounted.current) return false;
        const url = new URL(location.href);
        url.searchParams.set("planning", id);
        url.searchParams.delete("arena");
        window.history.replaceState(null, "", url);
        return true;
      } catch (failure) {
        if (mounted.current && generation === epoch.current) {
          setError(failure instanceof Error ? failure.message : "未能恢复这个方案。");
          setBlocked(true);
        }
        return false;
      } finally {
        if (mounted.current && generation === epoch.current) setRestoring(false);
      }
    },
    [read],
  );

  const initialize = useCallback(async () => {
    try {
      const info = await request<Health>("/api/health");
      if (!mounted.current) return;
      setHealth(info);
      if (info.requiresAccessCode && !info.accessGranted) {
        setRestoring(false);
        return;
      }
      if (info.identityBootstrap) await bootstrapIdentity();
      if (!mounted.current) return;
      try {
        setHistory(JSON.parse(localStorage.getItem(HISTORY) ?? "[]"));
      } catch {}
      const pending = readStorage<Journal>(JOURNAL);
      if (pending?.body?.operationId) {
        journalRef.current = pending;
        setUnknownRequest(pending);
        setBlocked(true);
      }
      let saved: string | null = null;
      try {
        saved = sessionStorage.getItem(POINTER);
      } catch {}
      const explicit = new URL(location.href).searchParams.get("planning");
      const id = explicit || pending?.sessionId || saved;
      if (id) await load(id, true);
      else setRestoring(false);
    } catch (failure) {
      if (mounted.current) {
        setConnectionError(failure instanceof Error ? failure.message : "暂时无法连接服务。");
        setRestoring(false);
      }
    }
  }, [request, load]);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void initialize();
    });
    const controllers = registry.current;
    return () => {
      cancelled = true;
      mounted.current = false;
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
    };
  }, [initialize]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setConnectionError("");
    try {
      if (current.current) await read(current.current.session.id);
      else await initialize();
      return true;
    } catch (failure) {
      if (mounted.current)
        setConnectionError(failure instanceof Error ? failure.message : "状态暂时未能刷新。");
      return false;
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, [read, initialize]);

  const post = useCallback(
    async (journal: Journal, retry = false) => {
      if (lock.current || (journalRef.current && !retry)) return null;
      lock.current = true;
      const generation = epoch.current;
      const kind = "kind" in journal.body ? journal.body.kind : "create";
      journalRef.current = journal;
      saveJournal(journal);
      setPendingAction(kind);
      setError("");
      setConnectionError("");
      try {
        const value = await request<PlanningSnapshot>(
          journal.sessionId
            ? `/api/planning/${encodeURIComponent(journal.sessionId)}/actions`
            : "/api/planning",
          journal.body,
        );
        if (!mounted.current || generation !== epoch.current) return null;
        if (kind === "create") {
          current.current = null;
          cursor.current = 0;
          setArrivals([]);
        }
        accept(value, generation);
        journalRef.current = null;
        saveJournal(null);
        setUnknownRequest(null);
        if (kind === "create") {
          const url = new URL(location.href);
          url.searchParams.set("planning", value.session.id);
          window.history.replaceState(null, "", url);
        }
        return value;
      } catch (failure) {
        if (!mounted.current || generation !== epoch.current) return null;
        // A polling response can prove the write succeeded even if its POST response
        // was lost afterwards. Do not turn that verified receipt back into unknown.
        if (current.current && operationObserved(current.current, journal)) {
          journalRef.current = null;
          saveJournal(null);
          setUnknownRequest(null);
          return current.current;
        }
        setBlocked(true);
        const known =
          failure instanceof PlanningRequestError &&
          failure.status >= 400 &&
          failure.status < 500 &&
          failure.status !== 408;
        if (known) {
          journalRef.current = null;
          saveJournal(null);
          setUnknownRequest(null);
        } else {
          journalRef.current = journal;
          saveJournal(journal);
          setUnknownRequest(journal);
        }
        setError(failure instanceof Error ? failure.message : "请求未完成，请先核对状态。");
        if (journal.sessionId) await read(journal.sessionId, generation).catch(() => {});
        return null;
      } finally {
        lock.current = false;
        if (mounted.current && generation === epoch.current) setPendingAction(null);
      }
    },
    [request, accept, read],
  );

  const create = useCallback(
    async (goal: string, modelMode: string) => {
      if (journalRef.current) {
        setError("还有一项请求等待核对，请先检查它的结果。");
        return false;
      }
      setBlocked(false);
      return !!(await post({
        sessionId: null,
        body: { operationId: crypto.randomUUID(), goal: goal.trim(), modelMode },
      }));
    },
    [post],
  );

  const act = useCallback(
    async (command: PlanningCommand) => {
      const value = current.current;
      if (!value) return null;
      if (command.kind === "stop") {
        if (stopping.current || !value.session.capabilities.canStop) return null;
        stopping.current = true;
        setStopPending(true);
        setBlocked(true);
        const generation = epoch.current;
        try {
          const next = await request<PlanningSnapshot>(
            `/api/planning/${encodeURIComponent(value.session.id)}/actions`,
            {
              ...command,
              operationId: crypto.randomUUID(),
              revision: value.session.revision,
            },
          );
          accept(next, generation);
          return next;
        } catch (failure) {
          if (mounted.current)
            setError(failure instanceof Error ? failure.message : "未能确认暂停，请刷新状态。");
          return null;
        } finally {
          stopping.current = false;
          if (mounted.current) setStopPending(false);
        }
      }
      const allowed = {
        advance: "canAdvance",
        answer: "canAnswer",
        note: "canAddNote",
        preview: "canPreview",
        confirm: "canConfirm",
      } as const;
      if (!value.session.capabilities[allowed[command.kind]]) {
        setError(value.session.capabilities.reason || "当前状态暂时不能执行这项操作。");
        return null;
      }
      setBlocked(false);
      return post({
        sessionId: value.session.id,
        body: {
          ...command,
          operationId: crypto.randomUUID(),
          revision: value.session.revision,
        } as PlanningAction,
      });
    },
    [post, request, accept],
  );

  useEffect(() => {
    const session = snapshot?.session;
    if (
      !session ||
      restoring ||
      pendingAction ||
      blocked ||
      unknownRequest ||
      session.status !== "ready" ||
      session.nextAction !== "advance" ||
      !session.capabilities.canAdvance
    )
      return;
    // Schedule after the workbench is painted, independently of its decorative animation.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => void act({ kind: "advance" }), 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [snapshot, restoring, pendingAction, blocked, unknownRequest, act]);

  const sessionId = snapshot?.session.id;
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await read(sessionId);
        if (!cancelled && mounted.current) setConnectionError("");
      } catch (failure) {
        if (
          !cancelled &&
          mounted.current &&
          !(failure instanceof Error && failure.name === "AbortError")
        )
          setConnectionError("连接暂时中断，已保留现有内容；正在核对状态。");
      }
      if (!cancelled)
        timer = setTimeout(
          poll,
          document.hidden
            ? 8000
            : current.current?.session.status === "working" || lock.current
              ? 1100
              : 4000,
        );
    };
    timer = setTimeout(poll, 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionId, read]);

  const retryUnknown = useCallback(async () => {
    const pending = journalRef.current;
    if (!pending || lock.current) return;
    if (pending.sessionId) {
      if (!(await refresh())) return;
      if (
        !journalRef.current ||
        ["working", "uncertain"].includes(current.current?.session.status ?? "")
      )
        return;
    }
    await post(pending, true);
  }, [post, refresh]);

  const unlock = useCallback(
    async (code: string) => {
      try {
        await request("/api/access", { code });
        await initialize();
        setError("");
        return true;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "未能验证访问口令。");
        return false;
      }
    },
    [request, initialize],
  );

  const reset = useCallback(() => {
    if (lock.current || journalRef.current) return false;
    epoch.current += 1;
    current.current = null;
    cursor.current = 0;
    setSnapshot(null);
    setArrivals([]);
    setError("");
    setBlocked(false);
    try {
      sessionStorage.removeItem(POINTER);
    } catch {}
    const url = new URL(location.href);
    url.searchParams.delete("planning");
    window.history.replaceState(null, "", url);
    return true;
  }, []);

  return {
    health,
    snapshot,
    arrivals,
    pendingAction,
    stopPending,
    restoring,
    refreshing,
    error,
    connectionError,
    unknownRequest: !!unknownRequest,
    blocked,
    history,
    create,
    act,
    refresh,
    load,
    reset,
    unlock,
    retryUnknown,
    clearError: () => setError(""),
  };
}

export type PlanningController = ReturnType<typeof usePlanning>;
