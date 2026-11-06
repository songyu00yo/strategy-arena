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
import { routeModel } from "@/lib/model-routing";
import { DisclosureMotion } from "./disclosure-motion";
import { ModelSelector } from "./model-selector";
import { useIntakeSummary } from "./use-intake-summary";
import "./guided-intake.css";

const STORAGE_KEY = "strategy-arena:intake-id";
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

function answerOf(question: IntakeQuestion): IntakeAnswer {
  return {
    questionId: question.id,
    state: "answered",
    value: question.type === "multiple" ? [] : "",
  };
}

function QuestionInput({
  question,
  answer,
  onChange,
  disabled,
}: {
  question: IntakeQuestion;
  answer: IntakeAnswer;
  onChange: (answer: IntakeAnswer) => void;
  disabled: boolean;
}) {
  const id = useId();
  const active = answer.state === "answered";
  const setValue = (value: IntakeAnswer["value"]) =>
    onChange({ ...answer, state: "answered", value });
  return (
    <fieldset className="gi-question" disabled={disabled}>
      <legend>{question.title}</legend>
      <p id={`${id}-reason`}>{question.reason}</p>
      <div className="gi-answer-states" role="group" aria-label="回答方式">
        {(
          [
            ["answered", "我来补充"],
            ["unknown", "暂时不知道"],
            ["skipped", "跳过"],
          ] as const
        ).map(([state, label]) => (
          <button
            key={state}
            type="button"
            aria-pressed={answer.state === state}
            onClick={() => onChange({ ...answer, state })}
          >
            {label}
          </button>
        ))}
      </div>
      <DisclosureMotion open={active} id={`${id}-answer`}>
        {question.type === "single" || question.type === "multiple" ? (
          <div className="gi-answer-options" aria-describedby={`${id}-reason`}>
            {question.options.map((option) => {
              const chosen = Array.isArray(answer.value)
                ? answer.value.includes(option)
                : answer.value === option;
              return (
                <label key={option} className={chosen ? "selected" : ""}>
                  <input
                    type={question.type === "single" ? "radio" : "checkbox"}
                    name={id}
                    checked={chosen}
                    onChange={() =>
                      setValue(
                        question.type === "single"
                          ? option
                          : chosen
                            ? (Array.isArray(answer.value) ? answer.value : []).filter(
                                (v) => v !== option,
                              )
                            : [...(Array.isArray(answer.value) ? answer.value : []), option],
                      )
                    }
                  />
                  <span>{option}</span>
                </label>
              );
            })}
          </div>
        ) : (
          <label className="gi-answer-field">
            <span className="sr-only">{question.title}</span>
            {question.type === "number" ? (
              <input
                type="number"
                value={String(answer.value)}
                placeholder={question.placeholder}
                aria-describedby={`${id}-reason`}
                onChange={(e) => setValue(e.target.value)}
              />
            ) : (
              <textarea
                rows={2}
                maxLength={3000}
                value={String(answer.value)}
                placeholder={question.placeholder}
                aria-describedby={`${id}-reason`}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
            {question.unit && <small>{question.unit}</small>}
          </label>
        )}
      </DisclosureMotion>
    </fieldset>
  );
}

export function GuidedIntake({
  modelProviders,
  pending,
  disabled = false,
  onCreated,
}: {
  modelProviders?: ModelOption[];
  pending: boolean;
  disabled?: boolean;
  onCreated: (snapshot: ArenaSnapshot) => void;
}) {
  const id = useId();
  const [goal, setGoal] = useState("");
  const [modelMode, setModelMode] = useState<ModelMode>(DEFAULT_MODEL_ID);
  const [draft, setDraft] = useState<IntakeDraft | null>(null);
  const [answers, setAnswers] = useState<IntakeAnswer[]>([]);
  const [busy, setBusy] = useState(false);
  const [analysisPending, setAnalysisPending] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [source, setSource] = useState<MaterialSource | null>(null);
  const [pageInputs, setPageInputs] = useState<Record<string, string>>({});
  const fileInput = useRef<HTMLInputElement>(null);
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
      current.current = next;
      setDraft(next);
      setAnswers((previous) =>
        next.questions.map(
          (q) =>
            previous.find((a) => a.questionId === q.id) ??
            next.answers.find((a) => a.questionId === q.id) ??
            answerOf(q),
        ),
      );
      applySummaryServer(next);
      try {
        localStorage.setItem(STORAGE_KEY, next.id);
      } catch {
        /* A draft remains usable without browser storage. */
      }
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
        setError("此草稿的调用状态与费用尚未确认，请等待运行者核账，不能再次发送模型请求。");
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
    alive.current = true;
    const epoch = ++generation.current;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* Storage is optional. */
    }
    if (saved && /^[a-zA-Z0-9_-]+$/.test(saved)) {
      request<IntakeDraft>(`/api/intakes/${saved}`)
        .then(async (next) => {
          if (!alive.current || epoch !== generation.current) return;
          if (next.status === "submitted") {
            if (!next.arenaId)
              throw new Error("草稿已提交，但还没有可恢复的擂台标识，请稍后重试。");
            const snapshot = await request<ArenaSnapshot>(`/api/arenas/${next.arenaId}`);
            if (!alive.current || epoch !== generation.current) return;
            onCreatedRef.current(snapshot);
            resetSummary();
            try {
              localStorage.removeItem(STORAGE_KEY);
            } catch {}
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
            setError(`未能恢复准备中的草稿：${failure.message}`);
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
  }, [apply, request, recoverSummary, resetSummary]);

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
      });
      if (!alive.current) throw new DOMException("Aborted", "AbortError");
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
  const analyzing = analysisPending || draft?.status === "analyzing";
  const reading = draft?.attachments.some((file) => file.state === "reading") ?? false;
  const blocked =
    disabled || pending || restoring || busy || analyzing || reading || !!summary.conflict;
  const questionsVisible = draft?.status === "questions";
  const summaryVisible = draft?.status === "summary" && !!draft.challenge;
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

  const analyze = (finish = false) =>
    void operate(async (epoch) => {
      if (unavailable) throw new Error("所选模型尚未配置，请先选择可用模型。");
      if (goalRef.current.trim().length < 2)
        throw new Error("再多说一点吧，请用至少 2 个字描述你的目标。");
      let saved = await ensureDraft();
      if (saved.status === "questions") {
        const outgoing = answers.map((answer) =>
          answer.state === "answered" &&
          (Array.isArray(answer.value) ? !answer.value.length : !answer.value.trim())
            ? { ...answer, state: finish ? ("skipped" as const) : ("unknown" as const) }
            : answer,
        );
        saved = await request<IntakeDraft>(`/api/intakes/${saved.id}`, "PATCH", {
          revision: saved.revision,
          answers: outgoing,
        });
        if (epoch !== generation.current) return;
        apply(saved);
      }
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
    generation.current += 1;
    controllers.current.forEach((controller) => controller.abort());
    locked.current = false;
    current.current = null;
    saving.current = null;
    resetSummary();
    setDraft(null);
    setGoal("");
    goalRef.current = "";
    setAnswers([]);
    setError("");

    setBusy(false);
    setAnalysisPending(false);
    setRestoring(false);
    setSource(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
  };

  return (
    <section
      className="guided-intake"
      aria-label="准备一场推演"
      aria-busy={busy || analyzing || restoring}
    >
      <form
        className="gi-composer"
        onSubmit={(event) => {
          event.preventDefault();
          analyze();
        }}
      >
        <label htmlFor={`${id}-goal`}>你想解决什么问题？</label>
        <textarea
          id={`${id}-goal`}
          className="gi-goal"
          rows={3}
          maxLength={3000}
          value={goal}
          readOnly={uncertain}
          disabled={blocked}
          placeholder="比如：还有两个月毕业，我该先找工作，还是集中准备考研？"
          onChange={(event) => {
            setGoal(event.target.value);
            goalRef.current = event.target.value;
          }}
          onBlur={() => {
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
              title="上传参考材料"
              disabled={blocked || uncertain}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip size={18} />
              <span>添材料</span>
            </button>
            <ModelSelector
              compact
              mode={modelMode}
              providers={modelProviders}
              challenge={baseChallenge}
              disabled={blocked}
              selectionDisabled={uncertain}
              onChange={(mode) => {
                if (current.current?.status === "uncertain") return;
                setModelMode(mode);
                modeRef.current = mode;
                if (current.current)
                  void operate(async () => {
                    await ensureDraft();
                  });
              }}
            />
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
                  ? "正在理解…"
                  : busy
                    ? "正在保存…"
                    : summaryVisible
                      ? "重新梳理"
                      : questionsVisible
                        ? "重新分析目标"
                        : "开始分析"}
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

      {unavailable && !pending && !restoring && (
        <p className="gi-config" role="status">
          {provider?.error ?? "所选模型尚未配置。请打开模型选择，选择已配置的模型。"}
        </p>
      )}
      <p className="gi-hint">
        先说目标，接着最多补充两轮问题。文件可选：PDF、Word、表格、文字或图片；最多 5 个，每个 10
        MiB，总计 30 MiB。
      </p>
      <DisclosureMotion open={!!draft?.attachments.length} className="gi-attachments">
        <ul>
          {draft?.attachments.map((file) => (
            <li key={file.id}>
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
                  ? `${file.interpreted ? "含模型辨读，请核对" : file.imageCount > 0 ? (draft.sources.some((item) => item.attachmentId === file.id && !item.interpretation && item.text.trim()) ? "文字已提取，图像待读取" : "图像等待模型读取") : "文字已提取"}${file.pageCount ? ` · ${file.pageCount} 页` : ""}`
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
      {(error || draft?.error || uncertain) && (
        <div className="gi-error" role="alert">
          {error || draft?.error}
          {uncertain && (
            <>
              <p>
                <strong>此草稿已暂停模型请求，等待核账。</strong>
                请等待运行者核对调用状态与费用，不要重试本次请求。
              </p>
              <p>
                目标和材料仍可查看。切换模型不能解除暂停；准备新问题会另建草稿，原调用和预留仍保留，新请求继续受共享预算限制。
              </p>
            </>
          )}
        </div>
      )}
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
                  可编辑字段内容一致，草稿状态或参考材料已有更新。参考材料以服务器保存的内容为准。
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
      <DisclosureMotion open={analyzing || reading} className="gi-progress">
        <div>
          <LoaderCircle className="gi-spin" size={20} />
          <span>
            {reading
              ? "正在整理材料，原文和位置会一并保留。"
              : "正在理解你的目标，找出真正影响选择的信息。"}
          </span>
        </div>
      </DisclosureMotion>
      <DisclosureMotion
        open={questionsVisible || summaryVisible}
        contentKey={summaryVisible ? "summary" : `questions:${draft?.round ?? 0}`}
        className="gi-phase"
      >
        <DisclosureMotion open={questionsVisible} className="gi-questions">
          <div className="gi-section-title">
            <div>
              <span>补齐关键条件</span>
              <h3 tabIndex={-1} data-disclosure-autofocus>
                再了解你一点。
              </h3>
            </div>
            <small>第 {draft?.round ?? 1} / 2 轮 · 可以说不知道</small>
          </div>
          {draft?.questions.slice(0, 3).map((question) => (
            <QuestionInput
              key={question.id}
              question={question}
              answer={
                answers.find((answer) => answer.questionId === question.id) ?? answerOf(question)
              }
              disabled={blocked}
              onChange={(answer) =>
                setAnswers((previous) => [
                  ...previous.filter((item) => item.questionId !== answer.questionId),
                  answer,
                ])
              }
            />
          ))}
          <div className="gi-step-actions">
            <button
              type="button"
              className="text-button"
              disabled={blocked || uncertain || unavailable}
              onClick={() => analyze(true)}
            >
              跳过本轮，整理摘要
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={blocked || uncertain || unavailable}
              onClick={() => analyze(false)}
            >
              继续梳理
              <ArrowRight size={16} />
            </button>
          </div>
        </DisclosureMotion>
        <DisclosureMotion open={summaryVisible} className="gi-summary">
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
          <button
            type="button"
            className="gi-disclosure-trigger"
            aria-controls={`${id}-advanced`}
            aria-expanded={advanced}
            onClick={() => setAdvanced(!advanced)}
          >
            预算、时间与备选方案
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
                已有备选方案（每行一个，最多三个）
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
            <p className="gi-hint">这里是行动方案的资源限制，模型调用费用单独记录。</p>
          </DisclosureMotion>
          <button
            type="button"
            className="primary-button gi-start"
            disabled={blocked || uncertain || unavailable || goal !== draft?.goal}
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
                const snapshot = await request<ArenaSnapshot>(
                  `/api/intakes/${current.current.id}/submit`,
                  "POST",
                  {
                    revision: current.current.revision,
                    challenge: parsed.data,
                    assumptions: assumptions.map((value) => value.trim()).filter(Boolean),
                  },
                );
                if (!alive.current || epoch !== generation.current) return;
                onCreated(snapshot);
                resetSummary();
                try {
                  localStorage.removeItem(STORAGE_KEY);
                } catch {}
              })
            }
          >
            {busy ? <LoaderCircle size={17} className="gi-spin" /> : <ArrowRight size={17} />}
            开始推演
          </button>
        </DisclosureMotion>
      </DisclosureMotion>
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
                    {item.interpretation ? " · 模型辨读" : " · 原文"}
                    {draft.usedSourceIds.includes(item.id) ? " · 已用于摘要" : ""}
                  </small>
                </span>
                <ArrowRight size={14} />
              </button>
            ))}
          </div>
          <DisclosureMotion open={!!source} className="gi-source-preview">
            <div>
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
              {source?.interpretation && (
                <p className="gi-file-warning">这是模型对图片或扫描页的辨读，请与原文件核对。</p>
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
          <span>草稿已保存在当前浏览器，刷新可继续。</span>
          <button
            type="button"
            className="text-button"
            disabled={busy || analyzing || reading}
            onClick={reset}
          >
            <Plus size={13} />
            准备新问题
          </button>
        </div>
      )}
    </section>
  );
}
