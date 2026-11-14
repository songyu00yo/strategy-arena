"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  FileText,
  LoaderCircle,
  Paperclip,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import {
  ChallengeSchema,
  type ArenaSnapshot,
  type Challenge,
  type ModelMode,
  type ModelOption,
} from "@/lib/contracts";
import type {
  IntakeAnswer,
  IntakeDraft,
  IntakeQuestion,
  MaterialSource,
} from "@/lib/intake-contracts";
import { DEFAULT_MODEL_ID } from "@/lib/model-catalog";
import { clearExamplePickerRequest, examplePickerRequested } from "@/lib/example-navigation";
import { routeModel } from "@/lib/model-routing";
import { DisclosureMotion } from "./disclosure-motion";
import { ModelSelector } from "./model-selector";
import { Modal } from "./modal";
import type { OverlayMotionHandle } from "./overlay-motion";
import { QuestionInput } from "./question-input";
import { useIntakeSummary } from "./use-intake-summary";
import { useListMotion } from "./use-list-motion";
import {
  ANSWER_JOURNAL_KEY,
  answerJournalScope,
  readAnswerJournal,
  historyAnswerJournalScope,
  readHistoricalAnswerJournal,
  readHistoricalAnswerConflict,
} from "./intake-answer-journal";
import {
  clearIntakeDraftPointer,
  readIntakeDraftPointer,
  saveIntakeDraftPointer,
} from "./intake-draft-pointer";
import "./guided-intake.css";

const MIB = 1024 * 1024;
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
// These inputs describe fictional situations. Selecting one only fills the editable goal.
const CHOICE_SCENARIOS = [
  {
    label: "个人网站",
    goal: "【模拟输入，可修改】我想做一个个人网站，但内容、用途和风格还没想清楚。",
  },
  {
    label: "PPT",
    goal: "【模拟输入，可修改】我想做一份PPT，但主题、受众、内容和风格还没想清楚。",
  },
  {
    label: "说明文档",
    goal: "【模拟输入，可修改】我想写一份说明文档，给谁看、写哪些内容还没想清楚。",
  },
];

const ACCEPT = ".pdf,.docx,.xlsx,.csv,.txt,.md,.png,.jpg,.jpeg,.webp";

export function parseIntakePages(input: string, pageCount: number): number[] {
  const pages = new Set<number>();
  if (!input.trim()) throw new Error("请填写要读取的页码，例如 1-5, 8。");
  for (const part of input.split(/[,，、\s]+/).filter(Boolean)) {
    const match = /^(\d+)(?:[-–](\d+))?$/.exec(part);
    if (!match) throw new Error("页码格式不正确，请使用 1-5, 8 这样的格式。");
    const from = Number(match[1]);
    const to = Number(match[2] ?? match[1]);
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < 1 ||
      to < from ||
      to > pageCount
    )
      throw new Error(`页码必须在 1 到 ${pageCount} 之间，范围请从小到大填写。`);
    if (to - from + 1 > 20) throw new Error("一次最多选择 20 页，请缩小范围。");
    for (let page = from; page <= to; page++) pages.add(page);
    if (pages.size > 20) throw new Error("一次最多选择 20 页，请缩小范围。");
  }
  return [...pages].sort((a, b) => a - b);
}

function sourceLabel(source: MaterialSource) {
  if (source.interpretation || source.origin === "model_interpretation") return "模型解读";
  if (source.origin === "model_transcription") return "模型转录，需核对原图";
  if (source.origin === "document") return "原文";
  return "来源待核对";
}

function sourceNotice(source: MaterialSource) {
  if (source.interpretation || source.origin === "model_interpretation")
    return "这是模型对图片或扫描页的解读，包含推测和不确定内容，请与原文件核对。";
  if (source.origin === "model_transcription")
    return "这是模型对图片或扫描页的转录，可能混入描述或推测，请核对原图。";
  if (source.origin === "document") return null;
  return "这段内容缺少明确的来源记录，请与原材料核对，不能当作已核实的原文。";
}

function answerOf(question: IntakeQuestion): IntakeAnswer {
  return {
    questionId: question.id,
    state: "answered",
    value: question.type === "multiple" ? [] : "",
  };
}

export function GuidedIntake({
  modelProviders,
  pending,
  disabled = false,
  restoreReady = true,
  onCreated,
}: {
  modelProviders?: ModelOption[];
  pending: boolean;
  disabled?: boolean;
  restoreReady?: boolean;
  onCreated: (snapshot: ArenaSnapshot) => void;
}) {
  const id = useId();
  const [goal, setGoal] = useState("");
  const [modelMode, setModelMode] = useState<ModelMode>(DEFAULT_MODEL_ID);
  const [draft, setDraft] = useState<IntakeDraft | null>(null);
  const { ref: attachmentRoot, capture: captureAttachments } = useListMotion<HTMLUListElement>(
    JSON.stringify(draft?.attachments.map((file) => file.id) ?? []),
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [questionIndex, setQuestionIndex] = useState(0);
  const dialogMotion = useRef<OverlayMotionHandle>(null);
  const [dialogTrigger, setDialogTrigger] = useState<HTMLButtonElement | null>(null);
  const [historyAnswerEdit, setHistoryAnswerEdit] = useState<IntakeAnswer | null>(null);
  const [historyConflict, setHistoryConflict] =
    useState<ReturnType<typeof readHistoricalAnswerConflict>>(null);
  const [historyJournalWarning, setHistoryJournalWarning] = useState("");
  const historyAnswerMemory = useRef<{
    draftId: string;
    answer: IntakeAnswer;
    revision: number;
    scope: string;
  } | null>(null);
  const [answers, setAnswers] = useState<IntakeAnswer[]>([]);
  const [answerSaveState, setAnswerSaveState] = useState<"server" | "local" | "memory" | "syncing">(
    "server",
  );
  const [busy, setBusy] = useState(false);
  const [analysisPending, setAnalysisPending] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [materialsOpen, setMaterialsOpen] = useState(false);
  const [recoveryDetailsOpen, setRecoveryDetailsOpen] = useState(false);
  const [reportPreviewOpen, setReportPreviewOpen] = useState(false);
  const [source, setSource] = useState<MaterialSource | null>(null);
  const [pageInputs, setPageInputs] = useState<Record<string, string>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const goalInput = useRef<HTMLTextAreaElement>(null);
  const current = useRef<IntakeDraft | null>(null);
  const alive = useRef(false);
  const generation = useRef(0);
  const locked = useRef(false);
  const saving = useRef<Promise<IntakeDraft> | null>(null);
  const controllers = useRef(new Set<AbortController>());
  const applyDraftRef = useRef<(next: IntakeDraft) => void>(() => {});
  const flushSummaryRef = useRef<() => Promise<void>>(async () => {});
  const onCreatedRef = useRef(onCreated);
  const goalRef = useRef(goal);
  const modeRef = useRef(modelMode);
  const answerValues = useRef<IntakeAnswer[]>([]);
  const answerScope = useRef("");
  const questionPane = useRef<HTMLDivElement>(null);
  const historyHeading = useRef<HTMLHeadingElement>(null);
  const answerUnsaved = useRef<"local" | "memory" | null>(null);

  const request = useCallback(
    async <T,>(url: string, method = "GET", body?: unknown): Promise<T> => {
      const epoch = generation.current;
      const controller = new AbortController();
      controllers.current.add(controller);
      try {
        const multipart = body instanceof FormData;
        const response = await fetch(url, {
          method,
          cache: "no-store",
          signal: controller.signal,
          headers:
            body !== undefined && !multipart ? { "Content-Type": "application/json" } : undefined,
          body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
        });
        const data = await response
          .json()
          .catch(() => ({ error: "服务返回了无法读取的响应，请稍后重试。" }));
        if (!alive.current || epoch !== generation.current)
          throw new DOMException("Aborted", "AbortError");
        if (!response.ok)
          throw new Error(
            typeof data.error === "string" ? data.error : "操作没有完成，请稍后重试。",
          );
        return (data.draft ?? data.snapshot ?? data) as T;
      } finally {
        controllers.current.delete(controller);
      }
    },
    [],
  );

  const summary = useIntakeSummary({
    current,
    alive,
    generation,
    request,
    applyDraft: applyDraftRef,
    busy,
    disabled: disabled || pending || restoring || analysisPending || draft?.status === "uncertain",
  });
  const {
    challenge,
    assumptions,
    applyServer: applySummaryServer,
    recover: recoverSummary,
    updateChallenge,
    updateAssumptions,
    reset: resetSummary,
  } = summary;
  const apply = useCallback(
    (next: IntakeDraft) => {
      if (
        !alive.current ||
        (current.current?.id === next.id && current.current.revision > next.revision)
      )
        return;
      let recovered: IntakeAnswer[] | null = null;
      let historyRecovered: IntakeAnswer | null = null;
      let historicalEntry: ReturnType<typeof readHistoricalAnswerConflict> = null;
      try {
        const raw = sessionStorage.getItem(ANSWER_JOURNAL_KEY);
        recovered = readAnswerJournal(raw, next);
        historyRecovered = readHistoricalAnswerJournal(raw, next);
        historicalEntry = readHistoricalAnswerConflict(raw, next);
      } catch {
        /* Keep in-memory answers when this tab cannot write a recovery journal. */
      }
      const memory = historyAnswerMemory.current;
      const sameMemoryDraft = memory?.draftId === next.id && next.workflow === "clarification";
      if (
        sameMemoryDraft &&
        memory.revision === next.revision &&
        memory.scope === historyAnswerJournalScope(next, memory.answer.questionId) &&
        !["submitted", "analyzing", "uncertain"].includes(next.status)
      )
        historyRecovered = memory.answer;
      if (!historyRecovered && sameMemoryDraft)
        historicalEntry = {
          scope: memory.scope,
          historicalRevision: memory.revision,
          historicalAnswer: memory.answer,
        };
      // This component is remounted on identity changes. Keep a same-draft conflict in memory
      // even when both storage operations fail, without rebasing its original revision.
      historyAnswerMemory.current = historyRecovered
        ? {
            draftId: next.id,
            answer: historyRecovered,
            revision: next.revision,
            scope: historyAnswerJournalScope(next, historyRecovered.questionId),
          }
        : sameMemoryDraft
          ? memory
          : null;
      setHistoryAnswerEdit(historyRecovered);
      setHistoryConflict(historyRecovered ? null : historicalEntry);
      if (historyRecovered || historicalEntry) setDialogOpen(true);
      const scope = answerJournalScope(next);
      if (
        (next.status === "questions" || next.status === "summary") &&
        (current.current?.status !== next.status || scope !== answerScope.current)
      ) {
        setQuestionIndex(0);
        setDialogOpen(true);
      }
      const memoryState = scope === answerScope.current ? answerUnsaved.current : null;
      const preferred = memoryState ? answerValues.current : (recovered ?? next.answers);
      const values = next.questions.map(
        (q) => preferred.find((a) => a.questionId === q.id) ?? answerOf(q),
      );
      answerScope.current = scope;
      answerValues.current = values;
      answerUnsaved.current = memoryState ?? (recovered ? "local" : null);
      setAnswers(values);
      setAnswerSaveState(answerUnsaved.current ?? "server");
      current.current = next;
      setDraft(next);
      applySummaryServer(next);
      saveIntakeDraftPointer(next.id);
    },
    [applySummaryServer],
  );
  useLayoutEffect(() => {
    applyDraftRef.current = apply;
    flushSummaryRef.current = summary.flush;
    onCreatedRef.current = onCreated;
  }, [apply, summary.flush, onCreated]);

  const operate = useCallback(
    async (action: (epoch: number) => Promise<void>) => {
      if (locked.current || disabled || pending) return;
      if (current.current?.status === "uncertain") {
        setError("这份草稿的调用状态和费用尚未确认，请等待管理员核账，不能再次发送模型请求。");
        return;
      }
      locked.current = true;
      const epoch = generation.current;
      setBusy(true);
      setError("");
      try {
        if (saving.current) await saving.current;
        await flushSummaryRef.current();
        await action(epoch);
      } catch (failure) {
        if (
          alive.current &&
          epoch === generation.current &&
          !(failure instanceof DOMException && failure.name === "AbortError")
        )
          setError(failure instanceof Error ? failure.message : "操作未完成，请重试。");
      } finally {
        if (alive.current && epoch === generation.current) {
          locked.current = false;
          setBusy(false);
          setAnalysisPending(false);
        }
      }
    },
    [disabled, pending],
  );

  useEffect(() => {
    if (!restoreReady) return;
    alive.current = true;
    const epoch = ++generation.current;
    let saved: string | null = null;
    try {
      // Opening free examples must not restore a submitted or running model task.
      // Keep its pointer intact so ordinary navigation can still restore it later.
      const explicitArena = new URL(window.location.href).searchParams.has("arena");
      if (!examplePickerRequested() && !explicitArena) saved = readIntakeDraftPointer();
    } catch {
      /* Storage is optional. */
    }
    if (saved && /^[a-zA-Z0-9_-]+$/.test(saved)) {
      request<IntakeDraft>(`/api/intakes/${saved}`)
        .then(async (next) => {
          if (!alive.current || epoch !== generation.current) return;
          saveIntakeDraftPointer(next.id);
          if (next.status === "submitted") {
            if (!next.arenaId) throw new Error("草稿已提交，但暂时找不到对应的擂台，请稍后重试。");
            const snapshot = await request<ArenaSnapshot>(`/api/arenas/${next.arenaId}`);
            if (!alive.current || epoch !== generation.current) return;
            onCreatedRef.current(snapshot);
            resetSummary();
            clearIntakeDraftPointer(next.id);
            return;
          }
          apply(next);
          recoverSummary(next);
          setGoal(next.goal);
          goalRef.current = next.goal;
          setModelMode(next.modelMode);
          modeRef.current = next.modelMode;
        })
        .catch((failure) => {
          if (alive.current && epoch === generation.current && failure.name !== "AbortError")
            setError(`未能恢复上次的草稿：${failure.message}`);
        })
        .finally(() => {
          if (alive.current && epoch === generation.current) setRestoring(false);
        });
    } else
      queueMicrotask(() => {
        if (alive.current && epoch === generation.current) setRestoring(false);
      });
    const activeControllers = controllers.current;
    return () => {
      alive.current = false;
      activeControllers.forEach((controller) => controller.abort());
    };
  }, [apply, request, recoverSummary, resetSummary, restoreReady]);

  // Polling only reads an explicitly started analysis; it never starts another model call.
  useEffect(() => {
    if (
      !analysisPending &&
      draft?.status !== "analyzing" &&
      !draft?.attachments.some((file) => file.state === "reading")
    )
      return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const epoch = generation.current;
    const poll = async () => {
      try {
        if (!draft?.id) return;
        const next = await request<IntakeDraft>(`/api/intakes/${draft.id}`);
        if (stopped || !alive.current || epoch !== generation.current) return;
        apply(next);
        if (
          analysisPending ||
          next.status === "analyzing" ||
          next.attachments.some((file) => file.state === "reading")
        )
          timer = setTimeout(poll, 1200);
      } catch (failure) {
        if (!stopped && alive.current && epoch === generation.current)
          setError(failure instanceof Error ? failure.message : "读取进度失败，请刷新恢复草稿。");
      }
    };
    timer = setTimeout(poll, 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [draft?.id, draft?.status, draft?.attachments, analysisPending, apply, request]);

  const saveDraft = async () => {
    let saved = current.current;
    if (!saved) {
      saved = await request<IntakeDraft>("/api/intakes", "POST", {
        goal: goalRef.current,
        modelMode: modeRef.current,
        workflow: "clarification",
      });
      if (!alive.current) throw new DOMException("Aborted", "AbortError");
      saveIntakeDraftPointer(saved.id, true);
      apply(saved);
    } else if (saved.goal !== goalRef.current || saved.modelMode !== modeRef.current) {
      saved = await request<IntakeDraft>(`/api/intakes/${saved.id}`, "PATCH", {
        revision: saved.revision,
        goal: goalRef.current,
        modelMode: modeRef.current,
      });
      apply(saved);
    }
    return saved;
  };
  const ensureDraft = async (): Promise<IntakeDraft> => {
    if (saving.current) await saving.current;
    const saved = current.current;
    if (saved && saved.goal === goalRef.current && saved.modelMode === modeRef.current)
      return saved;
    const operation = saveDraft();
    saving.current = operation;
    try {
      return await operation;
    } finally {
      if (saving.current === operation) saving.current = null;
    }
  };
  const baseChallenge = draft?.challenge ?? {
    ...EMPTY,
    goal,
    materials:
      draft?.sources
        .map((s) => s.text)
        .join("\n")
        .slice(0, 20000) ?? "",
  };
  const routing = routeModel(baseChallenge, modelMode);
  const provider =
    modelProviders?.find((option) => option.id === routing.modelId) ??
    modelProviders?.find((option) => option.provider === routing.provider);
  const unavailable = !provider?.configured;
  const uncertain = draft?.status === "uncertain";
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  // A file dropped beside the composer must not make the browser leave the page.
  useEffect(() => {
    const keep = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    window.addEventListener("dragover", keep);
    window.addEventListener("drop", keep);
    return () => {
      window.removeEventListener("dragover", keep);
      window.removeEventListener("drop", keep);
    };
  }, []);
  const analyzing = analysisPending || draft?.status === "analyzing";
  const reading = draft?.attachments.some((file) => file.state === "reading") ?? false;
  const blocked =
    disabled || pending || restoring || busy || analyzing || reading || !!summary.conflict;
  const questionsVisible = draft?.status === "questions";
  const summaryVisible = draft?.status === "summary" && !!draft.challenge;
  const summaryDirty =
    summaryVisible &&
    JSON.stringify([challenge, assumptions]) !==
      JSON.stringify([draft.challenge, draft.assumptions]);
  const reportAvailable =
    summaryVisible &&
    !!draft.clarification?.specification.trim() &&
    !!draft.clarification.executionPrompt.trim() &&
    !summaryDirty &&
    !historyAnswerEdit &&
    !historyConflict &&
    !blocked &&
    !uncertain &&
    goal === draft.goal;
  const historicalQuestion = draft?.answers.find(
    (answer) => answer.questionId === historyAnswerEdit?.questionId,
  )?.question;
  const historyVisible =
    draft?.workflow === "clarification" &&
    !questionsVisible &&
    !analyzing &&
    !uncertain &&
    draft.status !== "submitted";

  const historicalQuestionId = historyAnswerEdit?.questionId;
  useLayoutEffect(() => {
    if (!dialogOpen) return;
    if (historicalQuestionId) {
      historyHeading.current?.focus({ preventScroll: true });
      return;
    }
    if (!questionsVisible) return;
    questionPane.current?.querySelector<HTMLElement>("legend")?.setAttribute("tabindex", "-1");
    questionPane.current?.querySelector<HTMLElement>("legend")?.focus({ preventScroll: true });
  }, [dialogOpen, questionsVisible, questionIndex, draft?.round, historicalQuestionId]);
  const usage = draft?.usage ?? [];
  const usd = usage.reduce((sum, use) => sum + (use.estimatedUsd ?? 0), 0);
  const cny = usage.reduce((sum, use) => sum + use.estimatedCny, 0);
  const recordedCosts = [
    usage.some((use) => use.currency === "USD" || (!use.currency && use.estimatedUsd !== undefined))
      ? `USD $${usd.toFixed(4)}`
      : "",
    usage.some((use) => use.currency === "CNY" || (!use.currency && use.estimatedUsd === undefined))
      ? `CNY ¥${cny.toFixed(4)}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const conflictDetails = summary.conflict
    ? (() => {
        const local = summary.conflict.challenge;
        const server = draft?.challenge;
        const domains = {
          general: "不限领域",
          learning: "学习成长",
          life: "生活决策",
          work: "工作业务",
          creation: "内容创作",
        };
        const amount = (value: number | null | undefined) =>
          value == null ? "未说明" : `人民币 ${value} 元`;
        const hours = (value: number | null | undefined) =>
          value == null ? "未说明" : `${value} 小时`;
        const rows = [
          { label: "目标", server: server?.goal ?? "尚未生成摘要", local: local.goal || "未填写" },
          {
            label: "必须满足的限制",
            server: server?.constraints || "未填写",
            local: local.constraints || "未填写",
          },
          {
            label: "更在意的事",
            server: server?.preferences || "未填写",
            local: local.preferences || "未填写",
          },
          { label: "行动预算", server: amount(server?.budget), local: amount(local.budget) },
          { label: "可投入时间", server: hours(server?.timeHours), local: hours(local.timeHours) },
          {
            label: "备选方案",
            server: server?.options.join("\n") || "未填写",
            local: local.options.join("\n") || "未填写",
          },
          {
            label: "任务领域",
            server: server ? domains[server.domain] : "尚未生成摘要",
            local: domains[local.domain],
          },
          {
            label: "暂定假设",
            server: draft?.assumptions.join("\n") || "没有暂定假设",
            local: summary.conflict.assumptions.join("\n") || "没有暂定假设",
          },
        ];
        return rows.filter((row) => row.server !== row.local);
      })()
    : [];
  const tokens = usage.reduce((sum, use) => sum + use.inputTokens + use.outputTokens, 0);

  const downloadClarificationPreview = () => {
    const state = draft?.clarification;
    if (!state || !reportAvailable) return;
    const content = `${state.specification}\n\n---\n\n# 执行提示词（预览）\n\n${state.executionPrompt}`;
    const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `方案擂台-需求规划-预览-${draft?.revision ?? 0}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const saveQuestionAnswers = async (
    saved: IntakeDraft,
    finish: boolean,
    epoch: number,
    preserveUnanswered = false,
  ) => {
    if (saved.status !== "questions") return saved;
    const provided = answerValues.current.filter(
      (answer) =>
        answer.state !== "answered" ||
        (Array.isArray(answer.value) ? answer.value.length > 0 : !!answer.value.trim()),
    );
    // Changing models does not submit this round or declare an untouched answer unknown.
    if (preserveUnanswered && (!answerUnsaved.current || !provided.length)) return saved;
    const outgoing = provided;
    setAnswerSaveState("syncing");
    let next: IntakeDraft;
    try {
      // Saving answers and changing the model are separate revision-checked operations.
      next = await request<IntakeDraft>(`/api/intakes/${saved.id}`, "PATCH", {
        revision: saved.revision,
        answers: outgoing,
        answerMode: preserveUnanswered || finish ? "draft" : "complete",
      });
    } catch (failure) {
      setAnswerSaveState(answerUnsaved.current ?? "memory");
      throw failure;
    }
    if (epoch !== generation.current) throw new DOMException("Aborted", "AbortError");
    answerUnsaved.current = null;
    try {
      sessionStorage.removeItem(ANSWER_JOURNAL_KEY);
    } catch {}
    apply(next);
    return next;
  };

  const analyze = (finish = false) => {
    void operate(async (epoch) => {
      setDialogOpen(true);
      if (unavailable) throw new Error("所选模型尚未配置，请先选择可用模型。");
      if (goalRef.current.trim().length < 2) throw new Error("请用至少 2 个字描述你的目标。");
      clearExamplePickerRequest();
      const saved = await saveQuestionAnswers(await ensureDraft(), finish, epoch);
      setAnalysisPending(true);
      try {
        const next = await request<IntakeDraft>(`/api/intakes/${saved.id}/analyze`, "POST", {
          revision: saved.revision,
          operationId: crypto.randomUUID(),
          finish,
        });
        if (epoch === generation.current) apply(next);
      } finally {
        if (alive.current && epoch === generation.current) setAnalysisPending(false);
      }
    });
  };

  const clearHistoryEdit = () => {
    const memory = historyAnswerMemory.current;
    historyAnswerMemory.current = null;
    setHistoryAnswerEdit(null);
    setHistoryConflict(null);
    setHistoryJournalWarning("");
    let ownsJournal = !!memory && current.current?.id === memory.draftId;
    try {
      ownsJournal =
        !!current.current &&
        !!readHistoricalAnswerConflict(sessionStorage.getItem(ANSWER_JOURNAL_KEY), current.current);
    } catch {
      // When reads are blocked, this tab's in-memory edit still identifies its own journal.
    }
    if (ownsJournal) {
      try {
        sessionStorage.removeItem(ANSWER_JOURNAL_KEY);
      } catch {}
    }
  };
  const editHistoricalAnswer = (answer: IntakeAnswer) => {
    const saved = current.current;
    if (!saved || saved.status === "uncertain") return;
    const scope = historyAnswerJournalScope(saved, answer.questionId);
    historyAnswerMemory.current = { draftId: saved.id, answer, revision: saved.revision, scope };
    setHistoryAnswerEdit(answer);
    setHistoryConflict(null);
    setReportPreviewOpen(false);
    try {
      sessionStorage.setItem(
        ANSWER_JOURNAL_KEY,
        JSON.stringify({
          scope,
          answers: [],
          historicalDraftId: saved.id,
          historicalRevision: saved.revision,
          historicalAnswer: answer,
        }),
      );
      setHistoryJournalWarning("");
    } catch {
      setHistoryJournalWarning("历史回答修改暂存在内存，请保持此页打开，保存后再离开。");
    }
  };
  const openHistoricalAnswer = (questionId: string) =>
    void operate(async () => {
      const recorded = current.current?.answers.find((answer) => answer.questionId === questionId);
      if (!recorded) return;
      editHistoricalAnswer({ questionId, state: recorded.state, value: recorded.value });
      setDialogOpen(true);
    });
  const saveHistoricalAnswer = () =>
    void operate(async (epoch) => {
      const saved = current.current;
      const edit = historyAnswerMemory.current;
      if (!saved || !edit) return;
      if (
        edit.revision !== saved.revision ||
        edit.scope !== historyAnswerJournalScope(saved, edit.answer.questionId)
      )
        throw new Error("草稿已有更新，请重新核对本机历史回答修改。");
      if (
        edit.answer.state === "answered" &&
        (Array.isArray(edit.answer.value) ? !edit.answer.value.length : !edit.answer.value.trim())
      )
        throw new Error("请填写修改后的答案，或选择暂时不知道、跳过。");
      let updated: IntakeDraft;
      try {
        updated = await request<IntakeDraft>(`/api/intakes/${saved.id}`, "PATCH", {
          revision: saved.revision,
          answers: [edit.answer],
          answerMode: "draft",
        });
      } catch (failure) {
        try {
          const latest = await request<IntakeDraft>(`/api/intakes/${saved.id}`);
          if (epoch === generation.current) apply(latest);
        } catch {}
        throw failure;
      }
      if (epoch !== generation.current) return;
      clearHistoryEdit();
      apply(updated);
      setDialogOpen(true);
      setReportPreviewOpen(false);
      setAnalysisPending(true);
      try {
        const analyzed = await request<IntakeDraft>(`/api/intakes/${updated.id}/analyze`, "POST", {
          revision: updated.revision,
          operationId: crypto.randomUUID(),
          finish: false,
        });
        if (epoch === generation.current) apply(analyzed);
      } finally {
        if (alive.current && epoch === generation.current) setAnalysisPending(false);
      }
    });

  const upload = (files: File[]) =>
    void operate(async (epoch) => {
      if (files.length + (current.current?.attachments.length ?? 0) > 5)
        throw new Error("最多上传 5 个文件，请先移除不需要的材料。");
      if (files.some((file) => file.size > 10 * MIB))
        throw new Error("单个文件不能超过 10 MiB，请压缩或拆分后上传。");
      if (
        files.reduce(
          (sum, file) => sum + file.size,
          (current.current?.attachments ?? []).reduce((sum, file) => sum + file.size, 0),
        ) >
        30 * MIB
      )
        throw new Error("材料总量不能超过 30 MiB，请先移除不需要的文件。");
      let saved = await ensureDraft();
      for (const file of files) {
        const body = new FormData();
        body.append("file", file);
        saved = await request<IntakeDraft>(`/api/intakes/${saved.id}/attachments`, "POST", body);
        if (epoch !== generation.current) return;
        apply(saved);
      }
    });
  const reset = () => {
    const previousId = current.current?.id;
    generation.current += 1;
    controllers.current.forEach((controller) => controller.abort());
    locked.current = false;
    current.current = null;
    saving.current = null;
    resetSummary();
    setDraft(null);
    setDialogOpen(false);
    setQuestionIndex(0);
    setHistoryAnswerEdit(null);
    setHistoryConflict(null);
    setHistoryJournalWarning("");
    historyAnswerMemory.current = null;
    setGoal("");
    goalRef.current = "";
    setAnswers([]);
    answerValues.current = [];
    answerScope.current = "";
    answerUnsaved.current = null;
    setAnswerSaveState("server");
    setError("");

    setBusy(false);
    setAnalysisPending(false);
    setRestoring(false);
    setSource(null);
    setMaterialsOpen(false);
    setRecoveryDetailsOpen(false);
    setReportPreviewOpen(false);
    if (previousId) clearIntakeDraftPointer(previousId);
    try {
      sessionStorage.removeItem(ANSWER_JOURNAL_KEY);
    } catch {}
  };

  const recoveryFeedback = (
    <>
      {uncertain ? (
        <section className="gi-recovery" aria-label="分析暂停">
          <div className="gi-recovery-message" role="alert">
            <strong>暂时没有收到完整结果</strong>
            <p>本次分析是否完成还待确认。目标和材料已保留，不会自动重试。</p>
          </div>
          <p className="gi-recovery-next">
            可以保留目标另开草稿，材料需重新添加。新草稿会等待你点击“开始梳理”。
          </p>
          <div className="gi-recovery-actions">
            <button
              type="button"
              className="primary-button"
              disabled={busy || analyzing || reading || pending || disabled}
              onClick={() => {
                const previousGoal = goalRef.current;
                reset();
                setGoal(previousGoal);
                goalRef.current = previousGoal;
                requestAnimationFrame(() => goalInput.current?.focus());
              }}
            >
              准备新问题 <ArrowRight size={15} />
            </button>
            <button
              type="button"
              className="text-button gi-recovery-toggle"
              aria-expanded={recoveryDetailsOpen}
              aria-controls={`${id}-recovery-details`}
              onClick={() => setRecoveryDetailsOpen(!recoveryDetailsOpen)}
            >
              {recoveryDetailsOpen ? "收起调用与费用说明" : "查看调用与费用说明"}
              <ChevronDown size={14} />
            </button>
          </div>
          <DisclosureMotion open={recoveryDetailsOpen} id={`${id}-recovery-details`}>
            <div className="gi-recovery-details">
              <p>
                <strong>此草稿已暂停模型请求，等待核账。</strong>
                请等待管理员核对调用状态和费用，不要重试本次请求。
              </p>
              <p>
                你仍可查看目标和材料。切换模型不能解除暂停。准备新问题会另建草稿，原来的调用记录和预留额度仍会保留，新请求的状态和费用会单独记录。
              </p>
              {(error || draft?.error) && <p>原始提示：{error || draft?.error}</p>}
            </div>
          </DisclosureMotion>
        </section>
      ) : error || draft?.error ? (
        <div className="gi-error" role="alert">
          {error || draft?.error}
        </div>
      ) : null}
      {summary.conflict && (
        <div className="gi-error gi-summary-conflict" role="alert">
          <strong>本机还有尚未保存的摘要修改。</strong>
          <p>服务器版本已变化。本机记录会保留，选择恢复后才会保存到当前草稿。</p>
          <DisclosureMotion open>
            <div className="gi-conflict-differences" aria-label="摘要修改差异">
              {conflictDetails.length ? (
                conflictDetails.map((row) => (
                  <section key={row.label}>
                    <h4>{row.label}</h4>
                    <dl>
                      <div>
                        <dt>服务器当前版本</dt>
                        <dd>{row.server}</dd>
                      </div>
                      <div>
                        <dt>本机尚未保存</dt>
                        <dd>{row.local}</dd>
                      </div>
                    </dl>
                  </section>
                ))
              ) : (
                <p>
                  可编辑的内容没有变化，但草稿状态或参考材料已有更新。参考材料以服务器保存的内容为准。
                </p>
              )}
            </div>
          </DisclosureMotion>
          <div className="gi-step-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy || pending || disabled || draft?.status !== "summary"}
              onClick={() => summary.resolveConflict(true)}
            >
              恢复本机未保存的修改
            </button>
            <button
              type="button"
              className="text-button"
              disabled={busy || pending || disabled}
              onClick={() => summary.resolveConflict(false)}
            >
              保留服务器版本
            </button>
          </div>
        </div>
      )}
    </>
  );

  return (
    <section
      className="guided-intake"
      data-phase={
        uncertain
          ? "paused"
          : summaryVisible
            ? "summary"
            : questionsVisible
              ? "questions"
              : analyzing
                ? "analyzing"
                : "compose"
      }
      data-expanded={
        materialsOpen ||
        analyzing ||
        reading ||
        !!summary.conflict ||
        (unavailable && !pending && !restoring) ||
        !!draft?.attachments.length ||
        questionsVisible ||
        summaryVisible ||
        uncertain ||
        !!error ||
        !!draft?.error
      }
      aria-label="开始一次需求梳理"
      aria-busy={busy || analyzing || restoring}
    >
      <form
        className="gi-composer"
        data-dropping={dropping || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          analyze();
        }}
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          dragDepth.current += 1;
          if (!blocked && !uncertain) setDropping(true);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = blocked || uncertain ? "none" : "copy";
        }}
        onDragLeave={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDropping(false);
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          dragDepth.current = 0;
          setDropping(false);
          const files = [...event.dataTransfer.files];
          if (files.length && !blocked && !uncertain) upload(files);
        }}
      >
        <div className="gi-drop-veil" aria-hidden="true">
          <Paperclip size={22} />
          <span>松开即可添加材料</span>
        </div>
        <label htmlFor={`${id}-goal`}>你想做什么</label>
        <textarea
          ref={goalInput}
          id={`${id}-goal`}
          className="gi-goal"
          rows={3}
          maxLength={3000}
          value={goal}
          readOnly={uncertain}
          disabled={blocked}
          placeholder="先说说你想做的东西，没想清楚也没关系。可以添加文件或直接粘贴材料。"
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (!files.length) return;
            event.preventDefault();
            if (!blocked && !uncertain) upload(files);
          }}
          onChange={(event) => {
            setGoal(event.target.value);
            goalRef.current = event.target.value;
          }}
          onBlur={(event) => {
            if (
              event.relatedTarget instanceof Element &&
              event.relatedTarget.closest(".gi-scenarios")
            )
              return;
            setTimeout(() => {
              if (
                !alive.current ||
                disabled ||
                pending ||
                locked.current ||
                current.current?.status === "uncertain" ||
                goalRef.current.trim().length < 2
              )
                return;
              if (!current.current || current.current.goal !== goalRef.current) {
                void flushSummaryRef
                  .current()
                  .then(ensureDraft)
                  .catch((failure) => {
                    if (alive.current && failure.name !== "AbortError")
                      setError(
                        failure instanceof Error ? failure.message : "草稿尚未保存，请重试。",
                      );
                  });
              }
            }, 0);
          }}
        />
        <div className="gi-composer-footer">
          <div className="gi-tools">
            <button
              type="button"
              className="gi-tool"
              aria-label="上传参考材料"
              title="添加参考材料"
              aria-expanded={materialsOpen}
              aria-controls={`${id}-materials-picker`}
              disabled={blocked || uncertain}
              onClick={() => setMaterialsOpen(!materialsOpen)}
            >
              <Paperclip size={18} />
              <span>添加材料</span>
            </button>
            <ModelSelector
              compact
              mode={modelMode}
              providers={modelProviders}
              challenge={baseChallenge}
              disabled={blocked}
              selectionDisabled={uncertain}
              onChange={(mode) => {
                if (current.current?.status === "uncertain" || mode === modeRef.current) return;
                if (!current.current) {
                  setModelMode(mode);
                  modeRef.current = mode;
                  return;
                }
                void operate(async (epoch) => {
                  let saved = current.current!;
                  try {
                    saved = await saveQuestionAnswers(saved, false, epoch, true);
                  } catch (failure) {
                    if (failure instanceof DOMException && failure.name === "AbortError")
                      throw failure;
                    throw new Error(
                      `切换模型前未能保存本轮回答，原模型和回答已保留。${failure instanceof Error ? failure.message : "请稍后重试。"}`,
                    );
                  }
                  let next: IntakeDraft;
                  try {
                    next = await request<IntakeDraft>(`/api/intakes/${saved.id}`, "PATCH", {
                      revision: saved.revision,
                      modelMode: mode,
                    });
                  } catch (failure) {
                    if (failure instanceof DOMException && failure.name === "AbortError")
                      throw failure;
                    throw new Error(
                      `未能确认模型切换结果，页面保留原选择；已同步的回答仍保留。请刷新后核对。${failure instanceof Error ? failure.message : ""}`,
                    );
                  }
                  if (epoch !== generation.current) return;
                  try {
                    sessionStorage.removeItem(ANSWER_JOURNAL_KEY);
                  } catch {}
                  apply(next);
                  setModelMode(next.modelMode);
                  modeRef.current = next.modelMode;
                });
              }}
            />
            {draft && !uncertain && (
              <button
                type="button"
                className="gi-tool gi-reset"
                aria-label="准备新问题"
                title="准备新问题"
                disabled={busy || analyzing || reading}
                onClick={reset}
              >
                <RotateCcw size={16} />
              </button>
            )}
          </div>
          <button
            className="primary-button gi-analyze"
            type="submit"
            disabled={blocked || uncertain || unavailable || goal.trim().length < 2}
          >
            {busy || analyzing ? (
              <LoaderCircle size={17} className="gi-spin" />
            ) : (
              <ArrowRight size={17} />
            )}
            <span>
              {restoring
                ? "恢复草稿…"
                : analyzing
                  ? "正在梳理…"
                  : busy
                    ? "正在保存…"
                    : summaryVisible
                      ? "重新梳理"
                      : questionsVisible
                        ? "重新梳理目标"
                        : "开始梳理"}
            </span>
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          aria-label="选择参考材料"
          disabled={blocked || uncertain}
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            if (files.length) upload(files);
          }}
        />
      </form>

      {!draft && (
        <div className="gi-scenarios" aria-label="合成场景试填">
          <span>试填合成场景</span>
          <div role="group" aria-label="选择一个合成场景">
            {CHOICE_SCENARIOS.map((scenario) => (
              <button
                type="button"
                key={scenario.label}
                disabled={blocked || uncertain}
                onClick={() => {
                  setGoal(scenario.goal);
                  goalRef.current = scenario.goal;
                  goalInput.current?.focus();
                }}
              >
                {scenario.label}
              </button>
            ))}
          </div>
          <small>虚构问题，仅填入输入框。你也可以输入任何其他选择。</small>
        </div>
      )}

      {unavailable && !pending && !restoring && (
        <p className="gi-config" role="status">
          {provider?.error ?? "所选模型尚未配置，请在模型列表中选择已配置的模型。"}
        </p>
      )}
      <DisclosureMotion
        open={materialsOpen}
        id={`${id}-materials-picker`}
        className="gi-materials-picker"
      >
        <div>
          <p id={`${id}-materials-limits`}>
            支持 PDF、Word、表格、文本和图片。最多 5 个文件，单个不超过 10 MiB，总计不超过 30 MiB。
          </p>
          <button
            type="button"
            className="secondary-button"
            disabled={blocked || uncertain}
            aria-describedby={`${id}-materials-limits`}
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip size={15} /> 选择文件
          </button>
        </div>
      </DisclosureMotion>
      <DisclosureMotion open={!!draft?.attachments.length} className="gi-attachments">
        <ul ref={attachmentRoot}>
          {draft?.attachments.map((file) => (
            <li key={file.id} data-motion-key={file.id}>
              <div className="gi-file-heading">
                <FileText size={17} />
                <strong>{file.name}</strong>
                <span>{(file.size / MIB).toFixed(1)} MiB</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`移除 ${file.name}`}
                  disabled={blocked || uncertain}
                  onClick={() =>
                    void operate(async (epoch) => {
                      const next = await request<IntakeDraft>(
                        `/api/intakes/${draft.id}/attachments/${file.id}`,
                        "DELETE",
                      );
                      if (epoch === generation.current) {
                        captureAttachments();
                        apply(next);
                        if (source?.attachmentId === file.id) setSource(null);
                      }
                    })
                  }
                >
                  <X size={15} />
                </button>
              </div>
              <p className={`gi-file-state ${file.state === "failed" ? "failed" : ""}`}>
                {file.state === "ready"
                  ? `${file.interpreted ? "含模型读取的内容，请核对" : file.imageCount > 0 ? (draft.sources.some((item) => item.attachmentId === file.id && !item.interpretation && item.text.trim()) ? "文字已提取，图像待读取" : "图像等待模型读取") : "文字已提取"}${file.pageCount ? ` · ${file.pageCount} 页` : ""}`
                  : file.state === "reading"
                    ? "正在读取材料…"
                    : file.state === "needs_pages"
                      ? `共 ${file.pageCount ?? "多"} 页，请先选择最多 20 页`
                      : (file.error ?? "这份材料未能读取，请移除或换一个文件。")}
              </p>
              {file.warnings.map((warning, i) => (
                <p key={i} className="gi-file-warning">
                  {warning}
                </p>
              ))}
              {file.state === "needs_pages" && (
                <div className="gi-pages">
                  <label>
                    <span className="sr-only">{file.name} 的页码</span>
                    <input
                      value={pageInputs[file.id] ?? ""}
                      placeholder="例如 1-5, 8"
                      readOnly={uncertain}
                      disabled={blocked}
                      onChange={(event) =>
                        setPageInputs((old) => ({ ...old, [file.id]: event.target.value }))
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={blocked || uncertain}
                    onClick={() =>
                      void operate(async (epoch) => {
                        const pages = parseIntakePages(
                          pageInputs[file.id] ?? "",
                          file.pageCount ?? 20,
                        );
                        const next = await request<IntakeDraft>(
                          `/api/intakes/${draft.id}/attachments/${file.id}/pages`,
                          "POST",
                          { pages },
                        );
                        if (epoch === generation.current) apply(next);
                      })
                    }
                  >
                    读取所选页
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </DisclosureMotion>
      {!dialogOpen && recoveryFeedback}
      <DisclosureMotion open={analyzing || reading} className="gi-progress">
        <div>
          <LoaderCircle className="gi-spin" size={20} />
          <span>
            {reading
              ? "正在整理材料，原文和位置会一并保留。"
              : "正在分析你的目标，梳理影响选择的信息。"}
          </span>
        </div>
      </DisclosureMotion>
      {(questionsVisible ||
        summaryVisible ||
        analyzing ||
        uncertain ||
        draft?.status === "input" ||
        draft?.status === "failed" ||
        !!historyAnswerEdit ||
        !!historyConflict) && (
        <div className="gi-resume">
          <p>
            {questionsVisible
              ? `第${draft?.round ?? 1}轮 · ${draft?.questions.length ?? 0} 个待补充问题`
              : summaryVisible
                ? "摘要已整理，等待你确认。"
                : uncertain
                  ? "调用已暂停，等待核对。"
                  : "正在梳理你的目标。"}
          </p>
          <button
            ref={setDialogTrigger}
            type="button"
            className="secondary-button"
            aria-haspopup="dialog"
            onClick={() => setDialogOpen(true)}
          >
            {questionsVisible ? "继续回答" : summaryVisible ? "查看并确认摘要" : "查看梳理进度"}
          </button>
        </div>
      )}
      {dialogOpen && (
        <Modal
          title="需求梳理"
          trigger={dialogTrigger}
          motionRef={dialogMotion}
          onClose={() => {
            setDialogOpen(false);
            requestAnimationFrame(() => dialogTrigger?.focus({ preventScroll: true }));
          }}
        >
          <div className="gi-paper" aria-busy={busy || analyzing || reading}>
            <p tabIndex={-1} data-overlay-autofocus className="gi-paper-stage">
              {questionsVisible
                ? `第 ${draft?.round ?? 1} 轮 · 第 ${questionIndex + 1} / ${draft?.questions.length ?? 0} 题`
                : summaryVisible
                  ? "核对任务摘要"
                  : "梳理进度"}
            </p>
            {recoveryFeedback}
            {(busy || analyzing || reading) && (
              <p className="gi-paper-progress" role="status" aria-live="polite">
                <LoaderCircle className="gi-spin" size={18} />
                {answerSaveState === "syncing"
                  ? "正在保存本轮回答…"
                  : analyzing
                    ? "正在梳理下一步需要确认的内容…"
                    : "正在保存并核对你的要求…"}
              </p>
            )}
            <DisclosureMotion
              open={questionsVisible && !historyAnswerEdit}
              className="gi-questions"
            >
              <div ref={questionPane} className="gi-question-page">
                <div className="gi-section-title">
                  <div>
                    <span>补齐关键条件</span>
                    <h3 tabIndex={-1} data-disclosure-autofocus>
                      再了解你一点。
                    </h3>
                  </div>
                  <small>可以说不知道，也可以跳过</small>
                </div>
                {draft?.questions.slice(questionIndex, questionIndex + 1).map((question) => (
                  <QuestionInput
                    key={question.id}
                    question={question}
                    answer={
                      answers.find((answer) => answer.questionId === question.id) ??
                      answerOf(question)
                    }
                    disabled={blocked}
                    onChange={(answer) => {
                      const next = [
                        ...answerValues.current.filter(
                          (item) => item.questionId !== answer.questionId,
                        ),
                        answer,
                      ];
                      answerValues.current = next;
                      answerUnsaved.current = "memory";
                      setAnswers(next);
                      try {
                        sessionStorage.setItem(
                          ANSWER_JOURNAL_KEY,
                          JSON.stringify({
                            scope: answerScope.current,
                            answers: next,
                          }),
                        );
                        answerUnsaved.current = "local";
                        setAnswerSaveState("local");
                      } catch {
                        setAnswerSaveState("memory");
                      }
                    }}
                  />
                ))}
              </div>
              <p className="gi-save-state" role="status" aria-live="polite">
                {answerSaveState === "syncing"
                  ? "正在将本轮回答同步到服务器…"
                  : answerSaveState === "local"
                    ? "回答已保存在当前标签页，刷新可恢复；继续时同步到服务器。"
                    : answerSaveState === "memory"
                      ? "回答暂未保存，请保持此页打开，点击继续后同步到服务器。"
                      : "已同步的回答保存在服务器；新回答会先保存在当前标签页。"}
              </p>
              <div className="gi-step-actions gi-question-navigation">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={blocked || questionIndex === 0}
                  onClick={() => setQuestionIndex((index) => index - 1)}
                >
                  上一题
                </button>
                {questionIndex < (draft?.questions.length ?? 0) - 1 && (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={blocked}
                    onClick={() => setQuestionIndex((index) => index + 1)}
                  >
                    下一题
                    <ArrowRight size={16} />
                  </button>
                )}
              </div>
              <div className="gi-step-actions">
                <button
                  type="button"
                  className="text-button"
                  disabled={blocked || uncertain || unavailable}
                  onClick={() => analyze(true)}
                >
                  跳过本轮，整理摘要
                </button>
                {questionIndex >= (draft?.questions.length ?? 0) - 1 && (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={blocked || uncertain || unavailable}
                    onClick={() => analyze(false)}
                  >
                    确认本轮回答并继续
                    <ArrowRight size={16} />
                  </button>
                )}
              </div>
            </DisclosureMotion>
            <DisclosureMotion open={summaryVisible && !historyAnswerEdit} className="gi-summary">
              <div className="gi-section-title">
                <div>
                  <span>开始前，确认一下</span>
                  <h3 tabIndex={-1} data-disclosure-autofocus>
                    这是我们理解的任务。
                  </h3>
                </div>
                <Check size={23} />
              </div>
              <p className="gi-save-state" role="status" aria-live="polite">
                {summary.status}
              </p>
              {summary.journalWarning && (
                <p className="gi-error" role="alert">
                  {summary.journalWarning}
                </p>
              )}
              {summary.status.startsWith("摘要尚未保存") && !summary.conflict && (
                <button
                  type="button"
                  className="text-button"
                  disabled={blocked}
                  onClick={() => void operate(async () => {})}
                >
                  重试保存摘要
                </button>
              )}
              <div className="gi-summary-fields">
                <label>
                  要达到的目标
                  <textarea
                    rows={2}
                    maxLength={3000}
                    value={challenge.goal}
                    disabled={blocked}
                    onChange={(event) => updateChallenge("goal", event.target.value)}
                  />
                </label>
                <label>
                  必须满足的限制
                  <textarea
                    rows={2}
                    maxLength={3000}
                    value={challenge.constraints}
                    disabled={blocked}
                    placeholder="尚未说明硬性限制，可在这里补充。"
                    onChange={(event) => updateChallenge("constraints", event.target.value)}
                  />
                </label>
                <label>
                  你更在意的事
                  <textarea
                    rows={2}
                    maxLength={1500}
                    value={challenge.preferences}
                    disabled={blocked}
                    placeholder="尚未说明偏好，可在这里补充。"
                    onChange={(event) => updateChallenge("preferences", event.target.value)}
                  />
                </label>
              </div>
              <div className="gi-assumptions">
                <h4>暂定假设 · 请逐条核对</h4>
                {assumptions.length ? (
                  assumptions.map((assumption, i) => (
                    <label key={i}>
                      <span>{i + 1}</span>
                      <textarea
                        rows={2}
                        maxLength={500}
                        disabled={blocked}
                        value={assumption}
                        onChange={(event) => {
                          updateAssumptions((old) =>
                            old.map((value, index) => (index === i ? event.target.value : value)),
                          );
                        }}
                      />
                      <button
                        type="button"
                        className="icon-button"
                        disabled={blocked}
                        aria-label={`移除第 ${i + 1} 条假设`}
                        onClick={() => {
                          updateAssumptions((old) => old.filter((_, index) => index !== i));
                        }}
                      >
                        <X size={14} />
                      </button>
                    </label>
                  ))
                ) : (
                  <p>没有额外的暂定假设。</p>
                )}
              </div>
              {draft?.workflow === "clarification" && draft.clarification && (
                <section className="gi-report-preview" aria-label="规划报告预览">
                  <div className="gi-report-preview-heading">
                    <div>
                      <strong>详细规划报告 · 预览版</strong>
                      <small>
                        当前内容基于已记录回答和材料；未确认信息、AI 推论与工程验证缺口会单独标注。
                      </small>
                    </div>
                    <button
                      type="button"
                      className="text-button"
                      disabled={!reportAvailable}
                      onClick={() => setReportPreviewOpen(!reportPreviewOpen)}
                      aria-expanded={reportPreviewOpen && reportAvailable}
                    >
                      {reportPreviewOpen && reportAvailable ? "收起预览" : "查看完整预览"}
                    </button>
                  </div>
                  {!reportAvailable && (
                    <p className="gi-hint" role="status">
                      要求已有修改或报告已失效，请先保存并重新分析，再查看预览或导出。
                    </p>
                  )}
                  {reportPreviewOpen && reportAvailable && (
                    <>
                      <pre className="gi-report-preview-content">
                        {draft.clarification.specification}
                      </pre>
                      <h4>执行提示词</h4>
                      <pre className="gi-report-preview-content">
                        {draft.clarification.executionPrompt}
                      </pre>
                      <div className="gi-report-preview-actions">
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={downloadClarificationPreview}
                        >
                          导出 Markdown 预览
                        </button>
                      </div>
                    </>
                  )}
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={blocked || uncertain || unavailable || !!historyConflict}
                    onClick={() => analyze(false)}
                  >
                    根据当前摘要刷新分析
                  </button>
                </section>
              )}
              <button
                type="button"
                className="gi-disclosure-trigger"
                aria-controls={`${id}-advanced`}
                aria-expanded={advanced}
                onClick={() => setAdvanced(!advanced)}
              >
                {draft?.workflow === "clarification"
                  ? "预算、时间与已有想法"
                  : "预算、时间与备选方案"}
                <ChevronDown size={15} />
              </button>
              <DisclosureMotion open={advanced} id={`${id}-advanced`}>
                <div className="gi-advanced">
                  <label>
                    可投入金额（人民币）
                    <input
                      type="number"
                      min={0}
                      max={100000000}
                      value={challenge.budget ?? ""}
                      placeholder="未说明"
                      disabled={blocked}
                      onChange={(event) =>
                        updateChallenge(
                          "budget",
                          event.target.value === "" ? null : Number(event.target.value),
                        )
                      }
                    />
                  </label>
                  <label>
                    可投入时间（小时）
                    <input
                      type="number"
                      min={0.01}
                      max={100000}
                      step="any"
                      value={challenge.timeHours ?? ""}
                      placeholder="未说明"
                      disabled={blocked}
                      onChange={(event) =>
                        updateChallenge(
                          "timeHours",
                          event.target.value === "" ? null : Number(event.target.value),
                        )
                      }
                    />
                  </label>
                  <label className="gi-wide">
                    {draft?.workflow === "clarification"
                      ? "已有想法（每行一项，最多三项）"
                      : "已有备选方案（每行一个，最多三个）"}
                    <textarea
                      rows={3}
                      maxLength={902}
                      value={challenge.options.join("\n")}
                      disabled={blocked}
                      onChange={(event) =>
                        updateChallenge("options", event.target.value.split("\n").slice(0, 3))
                      }
                    />
                  </label>
                </div>
                <p className="gi-hint">
                  {draft?.workflow === "clarification"
                    ? "这里填写成果可用的预算和时间，模型调用费用另行记录。"
                    : "这里填写执行方案可用的金额和时间，模型调用费用另行记录。"}
                </p>
              </DisclosureMotion>
              <button
                type="button"
                className="primary-button gi-start"
                disabled={
                  blocked ||
                  uncertain ||
                  unavailable ||
                  goal !== draft?.goal ||
                  (draft?.workflow === "clarification" && !reportAvailable)
                }
                onClick={() =>
                  void operate(async (epoch) => {
                    await ensureDraft();
                    const parsed = ChallengeSchema.safeParse({
                      ...challenge,
                      options: challenge.options.map((option) => option.trim()).filter(Boolean),
                    });
                    if (!parsed.success)
                      throw new Error(
                        parsed.error.issues[0]?.message ?? "请检查摘要中的目标和资源限制。",
                      );
                    if (!current.current) return;
                    const submittedDraftId = current.current.id;
                    const result = await request<ArenaSnapshot | IntakeDraft>(
                      `/api/intakes/${submittedDraftId}/submit`,
                      "POST",
                      {
                        revision: current.current.revision,
                        challenge: parsed.data,
                        assumptions: assumptions.map((value) => value.trim()).filter(Boolean),
                      },
                    );
                    if (!alive.current || epoch !== generation.current) return;
                    if (!("versions" in result)) {
                      apply(result);
                      return;
                    }
                    onCreated(result);
                    resetSummary();
                    clearIntakeDraftPointer(submittedDraftId);
                  })
                }
              >
                {busy ? <LoaderCircle size={17} className="gi-spin" /> : <ArrowRight size={17} />}
                {draft?.workflow === "clarification" ? "确认要求并查漏交接" : "确认摘要并开始推演"}
              </button>
            </DisclosureMotion>

            {historyConflict && (
              <section className="gi-history-conflict" role="alert">
                <strong>草稿已在其他操作中更新，之前的修改没有自动覆盖。</strong>
                <p>请核对服务器当前回答与本机修改，选择后再保存。</p>
                <dl>
                  <dt>服务器当前回答</dt>
                  <dd>
                    {String(
                      draft?.answers.find(
                        (answer) =>
                          answer.questionId === historyConflict.historicalAnswer.questionId,
                      )?.value ?? "此问题已不在当前草稿中",
                    )}
                  </dd>
                  <dt>本机未保存的修改</dt>
                  <dd>
                    {Array.isArray(historyConflict.historicalAnswer.value)
                      ? historyConflict.historicalAnswer.value.join("、")
                      : historyConflict.historicalAnswer.value || "暂时不知道或跳过"}
                  </dd>
                </dl>
                <div className="gi-step-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={
                      blocked ||
                      uncertain ||
                      !draft?.answers.some(
                        (answer) =>
                          answer.questionId === historyConflict.historicalAnswer.questionId,
                      )
                    }
                    onClick={() => editHistoricalAnswer(historyConflict.historicalAnswer)}
                  >
                    恢复本机修改并重新核对
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={blocked || uncertain}
                    onClick={clearHistoryEdit}
                  >
                    保留服务器回答
                  </button>
                </div>
              </section>
            )}
            {historyAnswerEdit && historicalQuestion && (
              <section className="gi-history-edit" aria-label="修改历史回答">
                <h3 ref={historyHeading} tabIndex={-1}>
                  修改已记录的回答
                </h3>
                <QuestionInput
                  question={historicalQuestion}
                  answer={historyAnswerEdit}
                  disabled={blocked || uncertain}
                  onChange={editHistoricalAnswer}
                />
                <p role="status" className="gi-hint">
                  {historyJournalWarning ||
                    "修改已保存在当前标签页，刷新可恢复。保存后会重新核对修改项及其依赖。"}
                </p>
                <div className="gi-step-actions">
                  <button
                    type="button"
                    className="text-button"
                    disabled={blocked}
                    onClick={clearHistoryEdit}
                  >
                    取消修改
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={blocked || uncertain || unavailable}
                    onClick={saveHistoricalAnswer}
                  >
                    保存修改并重新梳理
                  </button>
                </div>
              </section>
            )}
            {historyVisible && !historyAnswerEdit && !!draft?.answers.length && (
              <section className="gi-history-answers" aria-label="已记录的回答">
                <h4>已记录的回答</h4>
                <ul>
                  {draft.answers.map((answer) => (
                    <li key={answer.questionId}>
                      <strong>{answer.question.title}</strong>
                      <p>
                        {answer.state === "answered"
                          ? Array.isArray(answer.value)
                            ? answer.value.join("、")
                            : answer.value
                          : answer.state === "unknown"
                            ? "暂时不知道"
                            : "跳过"}
                      </p>
                      <small>
                        {answer.confirmation === "confirmed" && !answer.needsReconfirmation
                          ? "已确认"
                          : "待重新确认"}
                      </small>
                      <button
                        type="button"
                        className="text-button"
                        disabled={blocked || !!historyConflict}
                        aria-label={`修改回答：${answer.question.title}`}
                        onClick={() => openHistoricalAnswer(answer.questionId)}
                      >
                        修改回答
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {!historyAnswerEdit &&
              !questionsVisible &&
              !analyzing &&
              !uncertain &&
              !summaryVisible &&
              draft && (
                <div className="gi-step-actions">
                  <p className="gi-hint">已保存的要求等待重新分析，旧报告暂不可用。</p>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={blocked || unavailable || !!historyConflict}
                    onClick={() => analyze(false)}
                  >
                    重新分析
                  </button>
                </div>
              )}
            <button
              type="button"
              className="text-button gi-paper-exit"
              onClick={() => dialogMotion.current?.close()}
            >
              暂存并退出
            </button>
          </div>
        </Modal>
      )}
      <DisclosureMotion open={!!draft?.sources.length} className="gi-sources">
        <button
          type="button"
          className="gi-disclosure-trigger"
          aria-expanded={sourcesOpen}
          aria-controls={`${id}-sources`}
          onClick={() => setSourcesOpen(!sourcesOpen)}
        >
          查看材料原文与位置<span>{draft?.sources.length ?? 0} 段</span>
          <ChevronDown size={15} />
        </button>
        <DisclosureMotion open={sourcesOpen} id={`${id}-sources`}>
          <div className="gi-source-list">
            {draft?.sources.map((item) => (
              <button
                key={item.id}
                type="button"
                className={source?.id === item.id ? "selected" : ""}
                onClick={() => setSource(item)}
              >
                <FileText size={15} />
                <span>
                  <strong>{item.filename}</strong>
                  <small>
                    {item.location}
                    {` · ${sourceLabel(item)}`}
                    {draft.usedSourceIds.includes(item.id) ? " · 已用于摘要" : ""}
                  </small>
                </span>
                <ArrowRight size={14} />
              </button>
            ))}
          </div>
          <DisclosureMotion
            open={!!source}
            className="gi-source-preview"
            contentKey={source?.id ?? ""}
          >
            <div data-source-preview-content>
              <div className="gi-file-heading">
                <strong>
                  {source?.filename} · {source?.location}
                </strong>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="收起材料预览"
                  onClick={() => setSource(null)}
                >
                  <X size={15} />
                </button>
              </div>
              {source && sourceNotice(source) && (
                <p className="gi-file-warning">{sourceNotice(source)}</p>
              )}
              <pre>{source?.text}</pre>
            </div>
          </DisclosureMotion>
        </DisclosureMotion>
      </DisclosureMotion>
      {(!!usage.length || draft?.reservedCny !== undefined || draft?.reservedUsd !== undefined) && (
        <div className="gi-usage">
          <span>准备阶段已记录费用</span>
          <strong>{recordedCosts || "暂无已记录费用"}</strong>
          {(draft?.reservedUsd !== undefined || draft?.reservedCny !== undefined) && (
            <small>
              调用预留额度：
              {[
                draft?.reservedUsd !== undefined ? `USD $${draft.reservedUsd.toFixed(4)}` : "",
                draft?.reservedCny !== undefined ? `CNY ¥${draft.reservedCny.toFixed(4)}` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
              （不与已记录费用重复相加）
            </small>
          )}
          <small>
            {tokens.toLocaleString()} Token · {usage.length} 次调用 · 以服务端费用记录为准
          </small>
        </div>
      )}
      {draft && (
        <div className="gi-draft-footer">
          <span>
            {uncertain
              ? "原草稿仍保存在服务器，准备新问题不会删除原记录。"
              : questionsVisible
                ? "问题已保存。本轮回答的保存状态见上方提示。"
                : summaryVisible
                  ? "摘要保存状态见上方提示。"
                  : "草稿已保存，在当前浏览器刷新可继续。"}
          </span>
          {!uncertain && (
            <button
              type="button"
              className="text-button"
              disabled={busy || analyzing || reading}
              onClick={reset}
            >
              <Plus size={13} />
              准备新问题
            </button>
          )}
        </div>
      )}
    </section>
  );
}
