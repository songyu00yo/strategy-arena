"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Download, History, KeyRound, RefreshCw } from "lucide-react";
import type {
  ArenaHistoryItem,
  HistoryPage,
  IdentityState,
  IntakeHistoryItem,
  RecoveryCodeResult,
} from "@/lib/identity-contracts";
import { Modal } from "./modal";
import { bootstrapIdentity } from "./identity-bootstrap";
import "./identity-history.css";

const IDENTITY_CHANGE_KEY = "strategy-arena:identity-changed";
const statusLabels: Record<string, string> = {
  ready: "待开始",
  running: "进行中",
  completed: "已完成",
  paused: "已暂停",
  failed: "需要处理",
  uncertain: "请求待核对",
  superseded: "已有新版本",
  input: "填写中",
  analyzing: "整理中",
  questions: "待补充",
  summary: "待确认摘要",
};
async function identityRequest<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error ?? "暂时无法读取历史，请稍后重试。");
  return data as T;
}
function historyUrl(path: string, identityTag: string, cursor?: string | null) {
  const query = new URLSearchParams({ identityTag });
  if (cursor) query.set("cursor", cursor);
  return `${path}?${query}`;
}
function formatDate(value: string | number) {
  return new Date(value).toLocaleDateString("zh-CN");
}
function mergeItems<T extends { id: string }>(previous: T[], next: T[]) {
  return [...new Map([...previous, ...next].map((item) => [item.id, item])).values()];
}

export interface IdentityHistoryProps {
  onIdentityChanged: () => void | Promise<void>;
  onOpenArena: (id: string) => void | Promise<void>;
  onOpenIntake: (id: string) => void | Promise<void>;
  disabled?: boolean;
}
export function IdentityHistory({
  onIdentityChanged,
  onOpenArena,
  onOpenIntake,
  disabled = false,
}: IdentityHistoryProps) {
  const [open, setOpen] = useState(false);
  const [identity, setIdentity] = useState<IdentityState | null>(null);
  const [arenas, setArenas] = useState<HistoryPage<ArenaHistoryItem>>({
    items: [],
    nextCursor: null,
  });
  const [intakes, setIntakes] = useState<HistoryPage<IntakeHistoryItem>>({
    items: [],
    nextCursor: null,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [codePending, setCodePending] = useState(false);
  const [enteredCode, setEnteredCode] = useState("");
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [confirmRotation, setConfirmRotation] = useState(false);
  const epoch = useRef(0);
  const identityTag = useRef<string | null>(null);
  const changeChannel = useRef<BroadcastChannel | null>(null);
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const codeId = useId();
  const hasHistory = arenas.items.length > 0 || intakes.items.length > 0;
  const refresh = useCallback(async () => {
    const current = ++epoch.current;
    setBusy(true);
    setError("");
    try {
      const next = await bootstrapIdentity();
      if (current !== epoch.current) return;
      if (identityTag.current && identityTag.current !== next.identityTag) {
        setRecoveryCode("");
        setCodePending(false);
        setConfirmRotation(false);
        setConfirmSwitch(false);
        setArenas({ items: [], nextCursor: null });
        setIntakes({ items: [], nextCursor: null });
        try {
          if (changeChannel.current) changeChannel.current.postMessage("changed");
          else localStorage.setItem(IDENTITY_CHANGE_KEY, crypto.randomUUID());
        } catch {}
        await onIdentityChanged();
        if (current !== epoch.current) return;
      }
      identityTag.current = next.identityTag;
      setIdentity(next);
      const [arenaPage, intakePage] = await Promise.all([
        identityRequest<HistoryPage<ArenaHistoryItem>>(historyUrl("/api/arenas", next.identityTag)),
        identityRequest<HistoryPage<IntakeHistoryItem>>(
          historyUrl("/api/intakes", next.identityTag),
        ),
      ]);
      if (current !== epoch.current) return;
      setArenas(arenaPage);
      setIntakes(intakePage);
    } catch (failure) {
      if (current === epoch.current)
        setError(failure instanceof Error ? failure.message : "历史读取未完成，请重试。");
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  }, [onIdentityChanged]);
  useEffect(() => {
    const lifecycle = epoch;
    return () => {
      lifecycle.current++;
    };
  }, []);
  useEffect(() => {
    const changed = () => {
      epoch.current++;
      identityTag.current = null;
      setIdentity(null);
      setArenas({ items: [], nextCursor: null });
      setIntakes({ items: [], nextCursor: null });
      setRecoveryCode("");
      setCodePending(false);
      setEnteredCode("");
      setConfirmSwitch(false);
      setConfirmRotation(false);
      setNotice("身份已在另一页面更新，打开历史后可重新读取。");
      void Promise.resolve(onIdentityChanged())
        .then(() => {
          if (open) return refresh();
        })
        .catch(() => setError("身份已更新，请刷新页面重新读取。"));
    };
    const storageChanged = (event: StorageEvent) => {
      if (event.key === IDENTITY_CHANGE_KEY) changed();
    };
    const channel =
      typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(IDENTITY_CHANGE_KEY) : null;
    changeChannel.current = channel;
    if (channel) channel.onmessage = changed;
    window.addEventListener("storage", storageChanged);
    return () => {
      window.removeEventListener("storage", storageChanged);
      channel?.close();
      changeChannel.current = null;
    };
  }, [onIdentityChanged, open, refresh]);

  const identityChanged = async (next: IdentityState) => {
    epoch.current++;
    identityTag.current = next.identityTag;
    setIdentity(next);
    setArenas({ items: [], nextCursor: null });
    setIntakes({ items: [], nextCursor: null });
    try {
      if (changeChannel.current) changeChannel.current.postMessage("changed");
      else localStorage.setItem(IDENTITY_CHANGE_KEY, crypto.randomUUID());
    } catch {}
    await onIdentityChanged();
    await refresh();
  };
  const recheckAfterFailure = async (message: string) => {
    const pending = refresh();
    const checkEpoch = epoch.current;
    await pending;
    if (checkEpoch !== epoch.current) return;
    setError(message);
    setNotice("请核对下方历史。需要时可使用已保存的恢复码再次恢复。");
  };
  const rotate = async () => {
    if (!identity || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    setRecoveryCode("");
    setCodePending(false);
    const current = epoch.current;
    try {
      const result = await identityRequest<RecoveryCodeResult>("/api/identity/recovery-code", {
        expectedIdentityTag: identity.identityTag,
      });
      if (current !== epoch.current) return;
      setRecoveryCode(result.recoveryCode);
      setCodePending(true);
      setConfirmRotation(false);
      setNotice("新恢复码等待启用。请先下载或复制保存，再确认启用，15 分钟内有效。");
    } catch (failure) {
      if (current === epoch.current)
        setError(failure instanceof Error ? failure.message : "恢复码生成未完成，请重试。");
    } finally {
      setBusy(false);
    }
  };
  const activate = async () => {
    if (!identity || busy || !codePending || !confirmRotation) return;
    setBusy(true);
    setError("");
    const current = epoch.current;
    try {
      const result = await identityRequest<IdentityState>("/api/identity/recovery-code/activate", {
        expectedIdentityTag: identity.identityTag,
        code: recoveryCode,
      });
      if (current !== epoch.current) return;
      setCodePending(false);
      setConfirmRotation(false);
      setNotice("新恢复码已启用。旧恢复码与其他设备的访问已失效。");
      await identityChanged(result);
    } catch (failure) {
      if (current === epoch.current) {
        await recheckAfterFailure(
          failure instanceof Error ? failure.message : "启用结果待确认，可用已保存的新码恢复。",
        );
      }
    } finally {
      setBusy(false);
    }
  };
  const recover = async () => {
    if (busy || !enteredCode.trim() || (hasHistory && !confirmSwitch)) return;
    setBusy(true);
    setError("");
    setNotice("");
    const current = epoch.current;
    try {
      const result = await identityRequest<IdentityState>("/api/identity/recover", {
        code: enteredCode,
        expectedIdentityTag: identity?.identityTag ?? null,
      });
      if (current !== epoch.current) return;
      setEnteredCode("");
      setRecoveryCode("");
      setCodePending(false);
      setConfirmSwitch(false);
      setNotice("已恢复对应身份，下面显示该身份的历史。");
      await identityChanged(result);
    } catch (failure) {
      if (current === epoch.current)
        await recheckAfterFailure(
          failure instanceof Error ? failure.message : "恢复结果待确认，请核对历史。",
        );
    } finally {
      setBusy(false);
    }
  };
  const more = async (kind: "arena" | "intake") => {
    if (!identity || busy) return;
    const cursor = kind === "arena" ? arenas.nextCursor : intakes.nextCursor;
    if (!cursor) return;
    setBusy(true);
    setError("");
    const current = epoch.current;
    try {
      if (kind === "arena") {
        const page = await identityRequest<HistoryPage<ArenaHistoryItem>>(
          historyUrl("/api/arenas", identity.identityTag, cursor),
        );
        if (current === epoch.current)
          setArenas((previous) => ({ ...page, items: mergeItems(previous.items, page.items) }));
      } else {
        const page = await identityRequest<HistoryPage<IntakeHistoryItem>>(
          historyUrl("/api/intakes", identity.identityTag, cursor),
        );
        if (current === epoch.current)
          setIntakes((previous) => ({ ...page, items: mergeItems(previous.items, page.items) }));
      }
    } catch (failure) {
      if (current === epoch.current)
        setError(failure instanceof Error ? failure.message : "读取下一页失败，请重试。");
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  };
  const downloadCode = () => {
    const blob = new Blob(
      [
        `方案擂台恢复码\n\n${recoveryCode}\n\n请私下保管。持有码的人可以读取和操作对应身份的讨论与材料。\n`,
      ],
      { type: "text/plain;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "方案擂台恢复码.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const openItem = async (kind: "arena" | "intake", id: string) => {
    setBusy(true);
    setError("");
    try {
      await (kind === "arena" ? onOpenArena(id) : onOpenIntake(id));
      setOpen(false);
      setRecoveryCode("");
      setEnteredCode("");
      setCodePending(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "打开未完成，请重试。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className="secondary-button identity-history-trigger"
        disabled={disabled}
        onClick={(event) => {
          setTrigger(event.currentTarget);
          setRecoveryCode("");
          setCodePending(false);
          setOpen(true);
          void refresh();
        }}
      >
        <History size={16} aria-hidden="true" /> 我的历史
      </button>
      {open && (
        <Modal
          title="我的历史与恢复码"
          trigger={trigger}
          onClose={() => {
            setOpen(false);
            setRecoveryCode("");
            setEnteredCode("");
            setCodePending(false);
            setConfirmSwitch(false);
            setConfirmRotation(false);
          }}
          wide
        >
          <div className="identity-history" aria-busy={busy}>
            <p className="identity-history-intro">
              此浏览器会记住你的身份。保存恢复码后，可在清除浏览器数据或更换设备时找回历史。
            </p>
            {error && (
              <p role="alert" className="identity-history-error">
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className="identity-history-notice">
                {notice}
              </p>
            )}
            <div className="identity-history-heading">
              <h3>已创建的讨论</h3>
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => void refresh()}
              >
                <RefreshCw size={14} aria-hidden="true" /> 刷新
              </button>
            </div>
            {arenas.items.length === 0 && (
              <p className="identity-history-empty">
                {busy ? "正在读取历史…" : "当前身份还没有讨论记录。"}
              </p>
            )}
            <ul className="identity-history-list">
              {arenas.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void openItem("arena", item.id)}
                  >
                    <span>{item.goal}</span>
                    <small>
                      {statusLabels[item.status] ?? "状态待确认"} · {item.versionCount} 个版本 ·{" "}
                      {formatDate(item.createdAt)}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
            {arenas.nextCursor && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => void more("arena")}
              >
                更多讨论
              </button>
            )}
            <h3>未完成的任务草稿</h3>
            {intakes.items.length === 0 && (
              <p className="identity-history-empty">
                {busy ? "正在读取草稿…" : "没有可继续的草稿。"}
              </p>
            )}
            <ul className="identity-history-list">
              {intakes.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void openItem("intake", item.id)}
                  >
                    <span>{item.goal || "尚未填写目标的草稿"}</span>
                    <small>
                      {statusLabels[item.status] ?? "状态待确认"} · {formatDate(item.updatedAt)}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
            {intakes.nextCursor && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => void more("intake")}
              >
                更多草稿
              </button>
            )}
            <section className="identity-history-recovery" aria-label="保存恢复码">
              <h3>
                <KeyRound size={16} aria-hidden="true" /> 保存当前身份
              </h3>
              <p>
                恢复码可读取和操作此身份的全部讨论与材料，请私下保存。服务器只保存校验摘要，关闭此窗口后无法再次查看原码。
              </p>
              <button
                type="button"
                className="secondary-button"
                disabled={busy || !identity}
                onClick={() => void rotate()}
              >
                {identity?.hasRecoveryCode ? "重新生成恢复码" : "生成恢复码"}
              </button>
              {recoveryCode && (
                <div className="identity-history-code">
                  <label htmlFor={`${codeId}-saved`}>本次新生成的恢复码</label>
                  <textarea
                    id={`${codeId}-saved`}
                    value={recoveryCode}
                    readOnly
                    rows={3}
                    spellCheck={false}
                  />
                  <button type="button" className="secondary-button" onClick={downloadCode}>
                    <Download size={16} aria-hidden="true" /> 下载保存
                  </button>
                  {codePending && (
                    <>
                      <label className="identity-history-check">
                        <input
                          type="checkbox"
                          checked={confirmRotation}
                          disabled={busy}
                          onChange={(event) => setConfirmRotation(event.target.checked)}
                        />
                        我已保存新码。启用后旧恢复码与其他设备的访问失效。
                      </label>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy || !confirmRotation}
                        onClick={() => void activate()}
                      >
                        已保存，启用新码
                      </button>
                    </>
                  )}
                </div>
              )}
            </section>
            <form
              className="identity-history-recovery"
              onSubmit={(event) => {
                event.preventDefault();
                void recover();
              }}
            >
              <h3>恢复另一个身份</h3>
              <p>
                恢复后切换到该恢复码的历史。两个身份各自保留。若要回到当前身份，请先保存当前恢复码。
              </p>
              <label htmlFor={codeId}>输入已保存的完整恢复码</label>
              <textarea
                id={codeId}
                value={enteredCode}
                onChange={(event) => setEnteredCode(event.target.value)}
                rows={3}
                maxLength={160}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
              {hasHistory && (
                <label className="identity-history-check">
                  <input
                    type="checkbox"
                    checked={confirmSwitch}
                    disabled={busy}
                    onChange={(event) => setConfirmSwitch(event.target.checked)}
                  />
                  我已保存当前身份的恢复码，确认切换。
                </label>
              )}
              <button
                type="submit"
                className="secondary-button"
                disabled={busy || !enteredCode.trim() || (hasHistory && !confirmSwitch)}
              >
                恢复历史
              </button>
            </form>
          </div>
        </Modal>
      )}
    </>
  );
}
