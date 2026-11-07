"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ChallengeSchema, type Challenge } from "@/lib/contracts";
import type { IntakeDraft } from "@/lib/intake-contracts";
import {
  clearStoredSummaryJournal,
  readStoredSummaryJournal,
  writeStoredSummaryJournal,
  type SummaryJournal,
} from "./intake-summary-journal";
export {
  SUMMARY_JOURNAL_KEY,
  SUMMARY_TAB_JOURNAL_KEY,
  readSummaryJournal,
  type SummaryJournal,
} from "./intake-summary-journal";
const EMPTY: Challenge = {
  goal: "",
  constraints: "",
  preferences: "",
  options: [],
  materials: "",
  domain: "general",
  budget: null,
  timeHours: null,
};
type Summary = { challenge: Challenge; assumptions: string[] };
const same = (a: Summary, b: Summary) =>
  JSON.stringify([a.challenge, a.assumptions]) === JSON.stringify([b.challenge, b.assumptions]);

/** Save one draft's editable summary in order, keeping a small journal of its unsaved tail. */
export function useIntakeSummary({
  current,
  alive,
  generation,
  request,
  applyDraft,
  busy,
  disabled,
}: {
  current: RefObject<IntakeDraft | null>;
  alive: RefObject<boolean>;
  generation: RefObject<number>;
  request: <T>(url: string, method?: string, body?: unknown) => Promise<T>;
  applyDraft: RefObject<(draft: IntakeDraft) => void>;
  busy: boolean;
  disabled: boolean;
}) {
  const [challenge, setChallenge] = useState<Challenge>(EMPTY);
  const [assumptions, setAssumptions] = useState<string[]>([]);
  const [status, setStatus] = useState("尚未修改摘要");
  const [conflict, setConflict] = useState<SummaryJournal | null>(null);
  const [editCount, setEditCount] = useState(0);
  const [journalWarning, setJournalWarning] = useState("");
  const values = useRef<Summary>({ challenge: EMPTY, assumptions: [] });
  const dirty = useRef(false);
  const version = useRef(0);
  const pending = useRef<Promise<void> | null>(null);
  const conflictRef = useRef<SummaryJournal | null>(null);
  const journal = useRef<SummaryJournal | null>(null);
  const lastServer = useRef("");

  const clearJournal = useCallback(() => {
    const draftId = journal.current?.draftId ?? current.current?.id;
    journal.current = null;
    if (draftId) clearStoredSummaryJournal(draftId);
  }, [current]);
  const writeJournal = useCallback((entry: SummaryJournal) => {
    journal.current = entry;
    try {
      writeStoredSummaryJournal(entry);
      setJournalWarning("");
    } catch {
      setJournalWarning("未能在本机保存恢复记录，请保持此页打开，等待服务器保存成功。");
    }
  }, []);
  const show = useCallback((summary: Summary) => {
    values.current = summary;
    setChallenge(summary.challenge);
    setAssumptions(summary.assumptions);
  }, []);
  const applyServer = useCallback(
    (draft: IntakeDraft) => {
      const next = { challenge: draft.challenge ?? EMPTY, assumptions: draft.assumptions };
      const encoded = JSON.stringify(next);
      if (encoded !== lastServer.current) {
        lastServer.current = encoded;
        if (!dirty.current && !conflictRef.current) show(next);
      }
    },
    [show],
  );
  const recover = useCallback(
    (draft: IntakeDraft) => {
      const saved = readStoredSummaryJournal(draft.id);
      if (!saved) return;
      journal.current = saved;
      if (
        draft.challenge &&
        same(saved, { challenge: draft.challenge, assumptions: draft.assumptions })
      ) {
        clearJournal();
        setStatus("摘要已保存");
        return;
      }
      if (draft.status === "summary" && saved.baseRevision === draft.revision) {
        show(saved);
        dirty.current = true;
        version.current++;
        setEditCount((count) => count + 1);
        setStatus("已恢复本机尚未保存的修改，等待保存…");
      } else {
        conflictRef.current = saved;
        setConflict(saved);
        setStatus("本机修改与服务器版本不同，请选择要保留的版本。");
      }
    },
    [clearJournal, show],
  );
  const edit = useCallback(
    (next: Summary) => {
      const draft = current.current;
      if (!draft || draft.status !== "summary") return;
      show(next);
      dirty.current = true;
      version.current++;
      writeJournal({
        draftId: draft.id,
        baseRevision: draft.revision,
        ...next,
        updatedAt: new Date().toISOString(),
      });
      setStatus("摘要修改等待保存…");
      setEditCount((count) => count + 1);
    },
    [current, show, writeJournal],
  );
  const updateChallenge = useCallback(
    <K extends keyof Challenge>(key: K, value: Challenge[K]) => {
      edit({
        challenge: { ...values.current.challenge, [key]: value },
        assumptions: values.current.assumptions,
      });
    },
    [edit],
  );
  const updateAssumptions = useCallback(
    (update: (old: string[]) => string[]) => {
      edit({
        challenge: values.current.challenge,
        assumptions: update(values.current.assumptions),
      });
    },
    [edit],
  );

  const flush = useCallback(async () => {
    while (pending.current) await pending.current;
    if (conflictRef.current) throw new Error("请先处理本机摘要与服务器版本的冲突。");
    if (!dirty.current) return;
    const epoch = generation.current;
    const save = async () => {
      while (dirty.current) {
        const draft = current.current;
        if (!draft || draft.status !== "summary")
          throw new Error("草稿状态已变化，尚未保存的摘要仍保留在本机，请先核对草稿。");
        const atVersion = version.current;
        const summary = structuredClone(values.current);
        const parsed = ChallengeSchema.safeParse({
          ...summary.challenge,
          options: summary.challenge.options.map((item) => item.trim()).filter(Boolean),
        });
        if (!parsed.success)
          throw new Error(parsed.error.issues[0]?.message ?? "请检查摘要后再保存。");
        setStatus("摘要保存中…");
        const next = await request<IntakeDraft>(`/api/intakes/${draft.id}`, "PATCH", {
          revision: draft.revision,
          summary: { challenge: parsed.data, assumptions: summary.assumptions },
        });
        if (!alive.current || generation.current !== epoch) return;
        if (
          current.current?.id === next.id &&
          current.current.revision > next.revision &&
          journal.current
        ) {
          conflictRef.current = journal.current;
          setConflict(journal.current);
          setStatus("保存过程中服务器已有更新，本机修改仍保留，请选择版本。");
          throw new Error("服务器已有更新，未自动覆盖新版本。");
        }
        applyDraft.current(next);
        if (version.current === atVersion) {
          dirty.current = false;
          clearJournal();
          setStatus("摘要已保存");
        } else {
          writeJournal({
            draftId: next.id,
            baseRevision: next.revision,
            ...values.current,
            updatedAt: new Date().toISOString(),
          });
        }
      }
    };
    const operation = save();
    pending.current = operation;
    try {
      await operation;
    } catch (failure) {
      if (alive.current && generation.current === epoch) {
        const message = failure instanceof Error ? failure.message : "摘要未能保存。";
        setStatus(`摘要尚未保存：${message}`);
        // A newer canonical revision is a conflict, never permission to overwrite it automatically.
        try {
          const previous = current.current;
          if (previous) {
            const latest = await request<IntakeDraft>(`/api/intakes/${previous.id}`);
            if (latest.revision !== previous.revision && journal.current) {
              applyDraft.current(latest);
              conflictRef.current = journal.current;
              setConflict(journal.current);
              setStatus("服务器已有更新，本机未保存的摘要仍保留，请选择版本。");
            }
          }
        } catch {
          /* The journal remains intact when the network is unavailable. */
        }
      }
      throw failure;
    } finally {
      if (pending.current === operation) pending.current = null;
    }
  }, [alive, applyDraft, clearJournal, current, generation, request, writeJournal]);

  useEffect(() => {
    if (busy || disabled || conflict || !editCount) return;
    const timer = setTimeout(() => {
      void flush().catch(() => {});
    }, 650);
    return () => clearTimeout(timer);
  }, [busy, disabled, conflict, editCount, flush]);
  const resolveConflict = useCallback(
    (restoreLocal: boolean) => {
      const draft = current.current;
      const saved = conflictRef.current;
      if (!draft || !saved) return;
      if (restoreLocal && draft.status !== "summary") return;
      conflictRef.current = null;
      setConflict(null);
      if (restoreLocal) edit({ challenge: saved.challenge, assumptions: saved.assumptions });
      else {
        dirty.current = false;
        version.current++;
        clearJournal();
        show({ challenge: draft.challenge ?? EMPTY, assumptions: draft.assumptions });
        setStatus("已保留服务器摘要");
      }
    },
    [clearJournal, current, edit, show],
  );
  const reset = useCallback(() => {
    pending.current = null;
    dirty.current = false;
    version.current++;
    conflictRef.current = null;
    setConflict(null);
    clearJournal();
    show({ challenge: EMPTY, assumptions: [] });
    lastServer.current = "";
    setStatus("尚未修改摘要");
  }, [clearJournal, show]);
  return {
    challenge,
    assumptions,
    status,
    journalWarning,
    conflict,
    applyServer,
    recover,
    updateChallenge,
    updateAssumptions,
    flush,
    resolveConflict,
    reset,
  };
}
