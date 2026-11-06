import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type {
  ArenaEvent,
  ArenaSnapshot,
  ArenaStep,
  ArenaVersion,
  Challenge,
  Stage,
} from "@/lib/contracts";

let database: DatabaseSync | undefined;
export function db(): DatabaseSync {
  if (!database) {
    const path = process.env.ARENA_DATABASE_PATH || "./data/arena.sqlite";
    if (path !== ":memory:")
      mkdirSync(dirname(resolve(/* turbopackIgnore: true */ path)), { recursive: true });
    database = new DatabaseSync(path);
    database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    database.exec(readFileSync(resolve(process.cwd(), "migrations/001_initial.sql"), "utf8"));
    database.exec(readFileSync(resolve(process.cwd(), "migrations/002_intakes.sql"), "utf8"));
    database.exec(
      readFileSync(resolve(process.cwd(), "migrations/003_decision_reviews.sql"), "utf8"),
    );
  }
  return database;
}
export function closeDb() {
  database?.close();
  database = undefined;
}
export function atomic<T>(fn: () => T): T {
  db().exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db().exec("COMMIT");
    return value;
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
}
export class ArenaError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "INVALID_REQUEST",
  ) {
    super(message);
  }
}
export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export function positiveEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
export function sessionSecret() {
  if (process.env.ARENA_SESSION_SECRET && process.env.ARENA_SESSION_SECRET.length >= 32)
    return process.env.ARENA_SESSION_SECRET;
  if (process.env.NODE_ENV === "production")
    throw new ArenaError("服务尚未配置安全会话密钥，请联系管理员。", 503, "SESSION_NOT_CONFIGURED");
  return atomic(() => {
    const row = db().prepare("SELECT value FROM metadata WHERE key='session_secret'").get() as
      | { value: string }
      | undefined;
    if (row) return row.value;
    const value = randomBytes(32).toString("hex");
    db().prepare("INSERT INTO metadata(key,value) VALUES('session_secret',?)").run(value);
    return value;
  });
}
export function assertOwner(arenaId: string, owner: string) {
  const row = db()
    .prepare("SELECT id, active_version_id, created_at FROM arenas WHERE id=? AND owner=?")
    .get(arenaId, owner) as
    | { id: string; active_version_id: string; created_at: string }
    | undefined;
  if (!row) throw new ArenaError("未找到这场讨论，或当前浏览器没有访问权限。", 404, "NOT_FOUND");
  return row;
}
export function getVersion(versionId: string): ArenaVersion {
  const row = db().prepare("SELECT body FROM versions WHERE id=?").get(versionId) as
    | { body: string }
    | undefined;
  if (!row) throw new ArenaError("未找到这个版本。", 404, "NOT_FOUND");
  return JSON.parse(row.body) as ArenaVersion;
}
export function saveVersion(version: ArenaVersion) {
  db().prepare("UPDATE versions SET body=? WHERE id=?").run(JSON.stringify(version), version.id);
}
export function event(
  arenaId: string,
  versionId: string,
  type: string,
  message: string,
  stage: Stage | null = null,
  actor: string | null = null,
  data: unknown = null,
) {
  db()
    .prepare(
      "INSERT INTO events(arena_id,version_id,type,stage,actor,message,data,created_at) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(arenaId, versionId, type, stage, actor, message, JSON.stringify(data), now());
}
export function getEvents(arenaId: string, afterSeq = 0): ArenaEvent[] {
  const rows = db()
    .prepare("SELECT * FROM events WHERE arena_id=? AND seq>? ORDER BY seq LIMIT 500")
    .all(arenaId, afterSeq) as unknown as {
    seq: number;
    arena_id: string;
    version_id: string;
    type: string;
    stage: Stage | null;
    actor: string | null;
    message: string;
    data: string;
    created_at: string;
  }[];
  return rows.map((r) => ({
    seq: r.seq,
    arenaId: r.arena_id,
    versionId: r.version_id,
    type: r.type,
    stage: r.stage,
    actor: r.actor,
    message: r.message,
    data: JSON.parse(r.data),
    createdAt: r.created_at,
  }));
}
export function snapshot(
  arenaId: string,
  owner: string,
  model: ArenaSnapshot["model"],
): ArenaSnapshot {
  const arena = assertOwner(arenaId, owner);
  const versions = db()
    .prepare("SELECT body FROM versions WHERE arena_id=? ORDER BY number")
    .all(arenaId) as { body: string }[];
  const rows = db()
    .prepare("SELECT * FROM steps WHERE arena_id=? ORDER BY version_id,ordinal")
    .all(arenaId) as unknown as StepRow[];
  return {
    id: arenaId,
    activeVersionId: arena.active_version_id,
    createdAt: arena.created_at,
    versions: versions.map((r) => JSON.parse(r.body)),
    steps: rows.map(stepPublic),
    events: getEvents(arenaId),
    model,
  };
}
export interface StepRow {
  id: string;
  arena_id: string;
  version_id: string;
  stage: Stage;
  role: string;
  ordinal: number;
  status: ArenaStep["status"];
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  lease_until: number | null;
  reservation: number;
  usage: string | null;
}
function stepPublic(row: StepRow): ArenaStep {
  return {
    id: row.id,
    versionId: row.version_id,
    stage: row.stage,
    role: row.role,
    status: row.status,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
export function consumeRun(owner: string) {
  const day = now().slice(0, 10);
  const row = db()
    .prepare("SELECT count FROM visitor_runs WHERE owner=? AND day=?")
    .get(owner, day) as { count: number } | undefined;
  if ((row?.count || 0) >= positiveEnv("ARENA_DAILY_VISITOR_LIMIT", 6))
    throw new ArenaError("今天的讨论次数已用完，请明天再试。", 429, "DAILY_LIMIT");
  db()
    .prepare(
      "INSERT INTO visitor_runs(owner,day,count) VALUES(?,?,1) ON CONFLICT(owner,day) DO UPDATE SET count=count+1",
    )
    .run(owner, day);
}
export function addVersion(
  arenaId: string,
  challenge: Challenge,
  changeReason: string,
  parentVersionId: string | null,
): ArenaVersion {
  const row = db()
    .prepare("SELECT COALESCE(MAX(number),0)+1 AS number FROM versions WHERE arena_id=?")
    .get(arenaId) as { number: number };
  const version: ArenaVersion = {
    id: id(),
    number: row.number,
    challenge,
    status: "ready",
    stage: "propose",
    strategies: [],
    attacks: [],
    evidence: [],
    revisions: [],
    verdict: null,
    costCny: 0,
    reservedCny: 0,
    createdAt: now(),
    changeReason,
    parentVersionId,
    error: null,
  };
  db()
    .prepare("INSERT INTO versions(id,arena_id,number,body) VALUES(?,?,?,?)")
    .run(version.id, arenaId, version.number, JSON.stringify(version));
  const insert = db().prepare(
    "INSERT INTO steps(id,arena_id,version_id,stage,role,ordinal) VALUES(?,?,?,?,?,?)",
  );
  for (const [stage, roles, base] of [
    ["propose", ["A", "B", "C"], 0],
    ["attack", ["A", "B", "C"], 10],
    ["verify", ["tools"], 20],
    ["revise", ["A", "B", "C"], 30],
    ["judge", ["judge"], 40],
  ] as const) {
    roles.forEach((role, index) =>
      insert.run(id(), arenaId, version.id, stage, role, base + index),
    );
  }
  db().prepare("UPDATE arenas SET active_version_id=? WHERE id=?").run(version.id, arenaId);
  event(
    arenaId,
    version.id,
    "version_created",
    `已创建第 ${version.number} 个版本。`,
    "propose",
    null,
    { changeReason },
  );
  return version;
}
