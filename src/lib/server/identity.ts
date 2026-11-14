import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type {
  ArenaHistoryItem,
  HistoryPage,
  IdentityState,
  IntakeHistoryItem,
  RecoveryCodeResult,
} from "../identity-contracts";
import {
  ensureOwner,
  ownerCookie,
  ownerCredential,
  ownerFromRequest,
  requireArenaAccess,
  requireOwner,
} from "./auth";
import { ArenaError, atomic, db } from "./db";
import { getIntake } from "./intakes";

function tag(owner: string, generation: number) {
  return createHash("sha256").update(`identity:${owner}:${generation}`).digest("hex");
}
function state(owner: string): IdentityState {
  const credential = ownerCredential(owner);
  return {
    identityTag: tag(owner, credential?.auth_generation ?? 0),
    hasRecoveryCode: Boolean(credential?.recovery_hash),
  };
}
export function getIdentity(request: Request) {
  const { owner, cookie } = ensureOwner(request);
  return { value: state(owner), cookie };
}
function assertIdentityTag(owner: string | null, expectedTag: string | null) {
  const actualTag = owner ? state(owner).identityTag : null;
  if (actualTag !== expectedTag)
    throw new ArenaError(
      "浏览器身份已在其他页面发生变化，请刷新后再操作。",
      409,
      "IDENTITY_CHANGED",
    );
}
function recoveryHash(code: string) {
  const normalized = code.replace(/[\s-]/g, "").toUpperCase();
  if (!/^ARENA1[A-F0-9]{64}$/.test(normalized)) return null;
  return createHash("sha256").update(`recovery-v1:${normalized}`).digest("hex");
}
export function prepareRecoveryCode(request: Request, expectedTag: string) {
  const owner = requireOwner(request);
  const hex = randomBytes(32).toString("hex").toUpperCase();
  const recoveryCode = `ARENA1-${hex.match(/.{8}/g)!.join("-")}`;
  atomic(() => {
    assertIdentityTag(owner, expectedTag);
    const credential = ownerCredential(owner);
    db()
      .prepare(
        "INSERT INTO owner_credentials(owner,pending_recovery_hash,pending_created_at,auth_generation,allow_legacy_cookie,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(owner) DO UPDATE SET pending_recovery_hash=excluded.pending_recovery_hash,pending_created_at=excluded.pending_created_at",
      )
      .run(
        owner,
        recoveryHash(recoveryCode),
        Date.now(),
        credential?.auth_generation ?? 0,
        credential?.allow_legacy_cookie ?? 1,
        Date.now(),
      );
  });
  return {
    value: { ...state(owner), recoveryCode } satisfies RecoveryCodeResult,
  };
}
export function activateRecoveryCode(request: Request, expectedTag: string, code: string) {
  const owner = requireOwner(request);
  const hash = recoveryHash(code);
  const generation = atomic(() => {
    assertIdentityTag(owner, expectedTag);
    const pending = db()
      .prepare(
        "SELECT pending_recovery_hash,pending_created_at FROM owner_credentials WHERE owner=?",
      )
      .get(owner) as
      | { pending_recovery_hash: string | null; pending_created_at: number | null }
      | undefined;
    if (
      !hash ||
      pending?.pending_recovery_hash !== hash ||
      !pending.pending_created_at ||
      pending.pending_created_at < Date.now() - 15 * 60_000
    )
      throw new ArenaError(
        "待启用的恢复码已失效，请重新生成并保存。",
        409,
        "PENDING_RECOVERY_EXPIRED",
      );
    db()
      .prepare(
        "UPDATE owner_credentials SET recovery_hash=?,pending_recovery_hash=NULL,pending_created_at=NULL,auth_generation=auth_generation+1,allow_legacy_cookie=0,rotated_at=? WHERE owner=?",
      )
      .run(hash, Date.now(), owner);
    return ownerCredential(owner)!.auth_generation;
  });
  return { value: state(owner), cookie: ownerCookie(owner, generation) };
}
function recordRecoveryAttempt() {
  atomic(() => {
    db()
      .prepare("DELETE FROM identity_recovery_attempts WHERE created_at<?")
      .run(Date.now() - 60_000);
    const row = db().prepare("SELECT COUNT(*) AS count FROM identity_recovery_attempts").get() as {
      count: number;
    };
    if (row.count >= 30)
      throw new ArenaError("恢复尝试过于频繁，请一分钟后再试。", 429, "RECOVERY_RATE_LIMIT");
    db().prepare("INSERT INTO identity_recovery_attempts(created_at) VALUES(?)").run(Date.now());
  });
}
export function recoverIdentity(request: Request, code: string, expectedTag: string | null) {
  requireArenaAccess(request);
  assertIdentityTag(ownerFromRequest(request), expectedTag);
  recordRecoveryAttempt();
  const hash = recoveryHash(code);
  const credential = hash
    ? (db()
        .prepare("SELECT owner,auth_generation FROM owner_credentials WHERE recovery_hash=?")
        .get(hash) as { owner: string; auth_generation: number } | undefined)
    : undefined;
  if (!credential)
    throw new ArenaError("恢复码无效，请核对保存的完整恢复码。", 401, "INVALID_RECOVERY_CODE");
  return {
    value: state(credential.owner),
    cookie: ownerCookie(credential.owner, credential.auth_generation),
  };
}

const CursorSchema = z.object({ id: z.string().uuid(), sort: z.union([z.string(), z.number()]) });
function historyQuery(url: URL, kind: "arena" | "intake") {
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .parse(url.searchParams.get("limit") ?? 10);
  const raw = url.searchParams.get("cursor");
  if (!raw) return { limit, cursor: null };
  try {
    if (raw.length > 400) throw new Error();
    const cursor = CursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    if (
      (kind === "arena" &&
        (typeof cursor.sort !== "string" || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(cursor.sort))) ||
      (kind === "intake" &&
        (typeof cursor.sort !== "number" || !Number.isSafeInteger(cursor.sort) || cursor.sort < 0))
    )
      throw new Error();
    return { limit, cursor };
  } catch {
    throw new ArenaError("历史列表页码无效，请重新打开列表。", 400, "INVALID_CURSOR");
  }
}
function cursorFor(id: string, sort: string | number) {
  return Buffer.from(JSON.stringify({ id, sort })).toString("base64url");
}
function assertHistoryIdentity(owner: string, url: URL) {
  const expected = url.searchParams.get("identityTag");
  if (expected !== null && expected !== state(owner).identityTag)
    throw new ArenaError("浏览器身份已变化，请刷新历史列表。", 409, "IDENTITY_CHANGED");
}
export function listArenaHistory(owner: string, url: URL): HistoryPage<ArenaHistoryItem> {
  assertHistoryIdentity(owner, url);
  const { limit, cursor } = historyQuery(url, "arena");
  const rows = db()
    .prepare(
      `SELECT a.id,a.created_at,a.active_version_id,
       json_extract(v.body,'$.challenge.goal') AS goal,
       json_extract(v.body,'$.status') AS status,json_extract(v.body,'$.stage') AS stage,
       (SELECT COUNT(*) FROM versions WHERE arena_id=a.id) AS version_count
       FROM arenas a JOIN versions v ON v.id=a.active_version_id
       WHERE a.owner=? ${cursor ? "AND (a.created_at<? OR (a.created_at=? AND a.id<?))" : ""}
       ORDER BY a.created_at DESC,a.id DESC LIMIT ?`,
    )
    .all(owner, ...(cursor ? [cursor.sort, cursor.sort, cursor.id] : []), limit + 1) as unknown as {
    id: string;
    created_at: string;
    active_version_id: string;
    goal: string;
    status: string;
    stage: string;
    version_count: number;
  }[];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      id: row.id,
      goal: row.goal.slice(0, 180),
      createdAt: row.created_at,
      activeVersionId: row.active_version_id,
      status: row.status,
      stage: row.stage,
      versionCount: row.version_count,
    })),
    nextCursor: rows.length > limit && last ? cursorFor(last.id, last.created_at) : null,
  };
}
export function listIntakeHistory(owner: string, url: URL): HistoryPage<IntakeHistoryItem> {
  assertHistoryIdentity(owner, url);
  const { limit, cursor } = historyQuery(url, "intake");
  const rows = db()
    .prepare(
      `SELECT id,updated_at FROM intake_drafts WHERE owner=? AND submitted_arena_id IS NULL
       ${cursor ? "AND (updated_at<? OR (updated_at=? AND id<?))" : ""}
       ORDER BY updated_at DESC,id DESC LIMIT ?`,
    )
    .all(owner, ...(cursor ? [cursor.sort, cursor.sort, cursor.id] : []), limit + 1) as {
    id: string;
    updated_at: number;
  }[];
  const page = rows.slice(0, limit);
  const items: IntakeHistoryItem[] = [];
  for (const row of page) {
    try {
      // Reuse retention and interrupted-call recovery before exposing a resumable draft.
      const draft = getIntake(row.id, owner);
      items.push({
        id: draft.id,
        goal: draft.goal.slice(0, 180),
        updatedAt: row.updated_at,
        status: draft.status,
      });
    } catch (error) {
      if (!(error instanceof ArenaError && error.code === "NOT_FOUND")) throw error;
    }
  }
  const last = page.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last ? cursorFor(last.id, last.updated_at) : null,
  };
}
