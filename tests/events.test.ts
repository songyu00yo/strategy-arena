/** Synthetic records through the real SQLite store and HTTP handlers. No provider requests. */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChallengeSchema, type ArenaEvent, type ModelDraft } from "../src/lib/contracts";
import { addVersion, closeDb, db, event } from "../src/lib/server/db";
import { ownerFromRequest } from "../src/lib/server/auth";
import { activateRecoveryCode, getIdentity, prepareRecoveryCode } from "../src/lib/server/identity";
import { GET as arenaGet } from "../src/app/api/arenas/[id]/route";
import { GET as eventsGet } from "../src/app/api/arenas/[id]/events/route";

function request(
  cookie?: string,
  path = "/api/identity",
  signal?: AbortSignal,
  lastEventId?: string,
) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (lastEventId !== undefined) headers.set("last-event-id", lastEventId);
  return new Request(`http://localhost${path}`, { headers, signal });
}
function seedArena() {
  const identity = getIdentity(request());
  const cookie = identity.cookie!.split(";")[0];
  const owner = ownerFromRequest(request(cookie))!;
  const arenaId = randomUUID();
  db()
    .prepare("INSERT INTO arenas(id,owner,active_version_id,created_at) VALUES(?,?,?,?)")
    .run(arenaId, owner, "", new Date().toISOString());
  const version = addVersion(
    arenaId,
    ChallengeSchema.parse({ goal: "事件恢复的合成测试目标，不调用真实模型" }),
    "synthetic test",
    null,
  );
  const step = db()
    .prepare("SELECT id FROM steps WHERE version_id=? AND role='A' AND stage='propose'")
    .get(version.id) as { id: string };
  return { arenaId, versionId: version.id, stepId: step.id, cookie, identity: identity.value };
}
function cursor(arenaId: string) {
  return (
    db()
      .prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE arena_id=?")
      .get(arenaId) as { seq: number }
  ).seq;
}
function draftRecord(
  arena: ReturnType<typeof seedArena>,
  revision: number,
  status: ModelDraft["status"] = "generating",
): ModelDraft {
  return {
    stepId: arena.stepId,
    versionId: arena.versionId,
    stage: "propose",
    role: "A",
    revision,
    fields: { title: `synthetic current draft ${revision}`, "steps.0": "合成草稿，只用于恢复检查" },
    status,
  };
}
function saveDraft(draft: ModelDraft) {
  db()
    .prepare(
      "INSERT INTO model_drafts(step_id,version_id,body) VALUES(?,?,?) ON CONFLICT(step_id) DO UPDATE SET body=excluded.body",
    )
    .run(draft.stepId, draft.versionId, JSON.stringify(draft));
}
async function openEvents(
  arena: ReturnType<typeof seedArena>,
  afterSeq: number,
  signal?: AbortSignal,
  lastEventId?: string,
) {
  const response = await eventsGet(
    request(
      arena.cookie,
      `/api/arenas/${arena.arenaId}/events?afterSeq=${afterSeq}`,
      signal,
      lastEventId,
    ),
    { params: Promise.resolve({ id: arena.arenaId }) },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");
  return reader;
}
async function packet(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const chunk = await reader.read();
  expect(chunk.done).toBe(false);
  const text = new TextDecoder().decode(chunk.value);
  const id = Number(/^id: (\d+)/m.exec(text)![1]);
  const events = (JSON.parse(/^data: (.*)$/m.exec(text)![1]) as { events: ArenaEvent[] }).events;
  return { id, events };
}
beforeEach(() => {
  closeDb();
  vi.stubEnv("ARENA_DATABASE_PATH", ":memory:");
  vi.stubEnv("ARENA_SESSION_SECRET", "synthetic-event-session-secret-never-use-in-production");
  vi.stubEnv("ARENA_ACCESS_CODE", "");
  vi.stubEnv("ARENA_PUBLIC_ORIGIN", "");
  vi.stubEnv("MODEL_API_KEY", "");
  vi.stubEnv("DEEPSEEK_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("NODE_ENV", "test");
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  closeDb();
  vi.unstubAllEnvs();
});

describe("real owner snapshot event recovery with synthetic records", () => {
  it("retains the latest 500 structural events, the full current cursor and current draft after more than 500 events", async () => {
    const arena = seedArena();
    for (let index = 0; index < 610; index++)
      event(
        arena.arenaId,
        arena.versionId,
        "step_completed",
        `synthetic completed ${index}`,
        "propose",
        "A",
      );
    const latestStructural = cursor(arena.arenaId);
    for (let revision = 1; revision <= 1200; revision++)
      event(
        arena.arenaId,
        arena.versionId,
        "draft_updated",
        "synthetic partial update",
        "propose",
        "A",
        draftRecord(arena, revision),
      );
    const currentDraft = draftRecord(arena, 1200);
    saveDraft(currentDraft);
    const response = await arenaGet(request(arena.cookie, `/api/arenas/${arena.arenaId}`), {
      params: Promise.resolve({ id: arena.arenaId }),
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.events).toHaveLength(500);
    expect(result.events.every((entry: ArenaEvent) => entry.type === "step_completed")).toBe(true);
    expect(result.events[0].message).toBe("synthetic completed 110");
    expect(result.events.at(-1)).toMatchObject({
      seq: latestStructural,
      message: "synthetic completed 609",
    });
    expect(result.eventCursor).toBe(cursor(arena.arenaId));
    expect(result.eventCursor).toBeGreaterThan(latestStructural);
    expect(result.drafts).toEqual([currentDraft]);
  });
  it("keeps current interrupted drafts and recent lifecycle events when thousands of partial events dominate the log", async () => {
    const arena = seedArena();
    const other = seedArena();
    saveDraft(draftRecord(other, 1));
    for (let revision = 1; revision <= 1100; revision++)
      event(
        arena.arenaId,
        arena.versionId,
        "draft_updated",
        "synthetic partial update",
        "propose",
        "A",
        draftRecord(arena, revision),
      );
    const interrupted = draftRecord(arena, 1101, "interrupted");
    saveDraft(interrupted);
    event(
      arena.arenaId,
      arena.versionId,
      "draft_finished",
      "synthetic interrupted draft",
      "propose",
      "A",
      interrupted,
    );
    event(
      arena.arenaId,
      arena.versionId,
      "step_failed",
      "synthetic lifecycle failure",
      "propose",
      "A",
    );
    const response = await arenaGet(request(arena.cookie, `/api/arenas/${arena.arenaId}`), {
      params: Promise.resolve({ id: arena.arenaId }),
    });
    const result = await response.json();
    expect(result.events.map((entry: ArenaEvent) => entry.type)).toEqual([
      "version_created",
      "draft_finished",
      "step_failed",
    ]);
    expect(result.eventCursor).toBe(cursor(arena.arenaId));
    expect(result.drafts).toEqual([interrupted]);
    expect(JSON.stringify(result)).not.toContain(other.stepId);
    expect(
      (
        await arenaGet(request(other.cookie, `/api/arenas/${arena.arenaId}`), {
          params: Promise.resolve({ id: arena.arenaId }),
        })
      ).status,
    ).toBe(404);
  });
});

describe("real SSE handler lifecycle and replay with synthetic records", () => {
  it("uses Last-Event-ID before the original URL cursor and drains a backlog in bounded pages without gaps", async () => {
    const arena = seedArena();
    for (let revision = 1; revision <= 1200; revision++)
      event(
        arena.arenaId,
        arena.versionId,
        "draft_updated",
        "synthetic replay",
        "propose",
        "A",
        draftRecord(arena, revision),
      );
    const initial = await openEvents(arena, 0);
    const first = await packet(initial);
    expect(first.events).toHaveLength(500);
    await initial.cancel();
    expect(vi.getTimerCount()).toBe(0);
    const reconnected = await openEvents(arena, 0, undefined, String(first.id));
    const second = await packet(reconnected);
    expect(second.events).toHaveLength(500);
    expect(second.events[0].seq).toBeGreaterThan(first.id);
    await vi.advanceTimersByTimeAsync(150);
    const third = await packet(reconnected);
    expect(third.events).toHaveLength(201);
    const received = [...first.events, ...second.events, ...third.events].map((entry) => entry.seq);
    const expected = db()
      .prepare("SELECT seq FROM events WHERE arena_id=? ORDER BY seq")
      .all(arena.arenaId) as { seq: number }[];
    expect(received).toEqual(expected.map((entry) => entry.seq));
    expect(third.id).toBe(cursor(arena.arenaId));
    await reconnected.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("uses the URL cursor when there is no reconnect header", async () => {
    const arena = seedArena();
    const boundary = cursor(arena.arenaId);
    event(arena.arenaId, arena.versionId, "step_started", "synthetic later event", "propose", "A");
    const reader = await openEvents(arena, boundary);
    const current = await packet(reader);
    expect(current.events).toHaveLength(1);
    expect(current.events[0].type).toBe("step_started");
    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("clears polling and closes pending reads when the request disconnects", async () => {
    const arena = seedArena();
    const controller = new AbortController();
    const reader = await openEvents(arena, cursor(arena.arenaId), controller.signal);
    expect(vi.getTimerCount()).toBe(1);
    const waiting = reader.read();
    controller.abort();
    expect(await waiting).toEqual({ value: undefined, done: true });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await reader.read()).toEqual({ value: undefined, done: true });
  });
  it("clears polling when the reader cancels and after the connection lifetime ends", async () => {
    const arena = seedArena();
    const cancelled = await openEvents(arena, cursor(arena.arenaId));
    const waiting = cancelled.read();
    await cancelled.cancel();
    expect(await waiting).toEqual({ value: undefined, done: true });
    expect(vi.getTimerCount()).toBe(0);
    const expires = await openEvents(arena, cursor(arena.arenaId));
    await vi.advanceTimersByTimeAsync(55_050);
    expect(vi.getTimerCount()).toBe(0);
    const remaining: string[] = [];
    for (;;) {
      const chunk = await expires.read();
      if (chunk.done) break;
      remaining.push(new TextDecoder().decode(chunk.value));
    }
    expect(remaining).toEqual([": heartbeat\n\n", ": heartbeat\n\n", ": heartbeat\n\n"]);
  });
  it("closes an old SSE connection after recovery-code rotation before delivering further private events", async () => {
    const arena = seedArena();
    const reader = await openEvents(arena, cursor(arena.arenaId));
    const waiting = reader.read();
    const prepared = prepareRecoveryCode(request(arena.cookie), arena.identity.identityTag);
    const activated = activateRecoveryCode(
      request(arena.cookie),
      arena.identity.identityTag,
      prepared.value.recoveryCode,
    );
    event(
      arena.arenaId,
      arena.versionId,
      "step_completed",
      "synthetic event after credential revocation",
      "propose",
      "A",
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(await waiting).toEqual({ value: undefined, done: true });
    expect(vi.getTimerCount()).toBe(0);
    expect(ownerFromRequest(request(arena.cookie))).toBeNull();
    const current = { ...arena, cookie: activated.cookie.split(";")[0] };
    const resumed = await openEvents(current, cursor(arena.arenaId));
    await resumed.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });
});
