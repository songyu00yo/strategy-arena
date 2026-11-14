import { createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, db } from "../src/lib/server/db";
import { ownerFromRequest, requireOwner } from "../src/lib/server/auth";
import {
  getIdentity,
  listArenaHistory,
  listIntakeHistory,
  recoverIdentity,
  prepareRecoveryCode,
  activateRecoveryCode,
} from "../src/lib/server/identity";
import { createIntake } from "../src/lib/server/intakes";
import { GET as identityGet } from "../src/app/api/identity/route";
import { POST as recoveryCodePost } from "../src/app/api/identity/recovery-code/route";
import { POST as activateCodePost } from "../src/app/api/identity/recovery-code/activate/route";
import { POST as recoverPost } from "../src/app/api/identity/recover/route";
import { GET as arenasGet } from "../src/app/api/arenas/route";
import { GET as intakesGet } from "../src/app/api/intakes/route";

const secret = "synthetic-identity-test-session-secret-only";
function request(cookie?: string, path = "/api/identity") {
  return new Request(`http://localhost${path}`, { headers: cookie ? { cookie } : {} });
}
function cookieValue(cookie: string) {
  return cookie.split(";")[0];
}
function identity() {
  const result = getIdentity(request());
  const cookie = cookieValue(result.cookie!);
  return { ...result.value, cookie, owner: ownerFromRequest(request(cookie))! };
}
function rotateRecoveryCode(currentRequest: Request, expectedTag: string) {
  const prepared = prepareRecoveryCode(currentRequest, expectedTag);
  const activated = activateRecoveryCode(currentRequest, expectedTag, prepared.value.recoveryCode);
  return { ...activated, value: { ...activated.value, recoveryCode: prepared.value.recoveryCode } };
}
function arena(owner: string, goal: string, createdAt: string) {
  const id = randomUUID();
  const versionId = randomUUID();
  db()
    .prepare("INSERT INTO arenas(id,owner,active_version_id,created_at) VALUES(?,?,?,?)")
    .run(id, owner, versionId, createdAt);
  db()
    .prepare("INSERT INTO versions(id,arena_id,number,body) VALUES(?,?,1,?)")
    .run(
      versionId,
      id,
      JSON.stringify({
        challenge: { goal, materials: "synthetic private material" },
        status: "ready",
        stage: "propose",
      }),
    );
  return id;
}
function post(path: string, cookie: string, body: unknown, origin = "http://localhost") {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  closeDb();
  vi.stubEnv("ARENA_DATABASE_PATH", ":memory:");
  vi.stubEnv("ARENA_SESSION_SECRET", secret);
  vi.stubEnv("ARENA_ACCESS_CODE", "");
  vi.stubEnv("ARENA_PUBLIC_ORIGIN", "");
  vi.stubEnv("NODE_ENV", "test");
});
afterEach(() => {
  closeDb();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("anonymous identity recovery with synthetic credentials", () => {
  it("uses the existing generated development session secret without nested transactions", () => {
    vi.stubEnv("ARENA_SESSION_SECRET", "");
    const current = identity();
    const active = rotateRecoveryCode(request(current.cookie), current.identityTag);
    expect(ownerFromRequest(request(cookieValue(active.cookie)))).toBe(current.owner);
    expect(recoverIdentity(request(), active.value.recoveryCode, null).value.hasRecoveryCode).toBe(
      true,
    );
  });
  it("keeps existing credentials valid until the newly saved code is activated", () => {
    const current = identity();
    const active = rotateRecoveryCode(request(current.cookie), current.identityTag);
    const activeCookie = cookieValue(active.cookie);
    const pending = prepareRecoveryCode(request(activeCookie), active.value.identityTag);
    expect(ownerFromRequest(request(activeCookie))).toBe(current.owner);
    expect(recoverIdentity(request(), active.value.recoveryCode, null).value.identityTag).toBe(
      active.value.identityTag,
    );
    expect(() => recoverIdentity(request(), pending.value.recoveryCode, null)).toThrow(
      "恢复码无效",
    );
    // Dropping the prepare response leaves the old credential and browser access intact.
    expect(getIdentity(request(activeCookie)).value.hasRecoveryCode).toBe(true);
    activateRecoveryCode(
      request(activeCookie),
      active.value.identityTag,
      pending.value.recoveryCode,
    );
    expect(ownerFromRequest(request(activeCookie))).toBeNull();
    // If the activation response is lost, the already saved new code still recovers the identity.
    expect(
      ownerFromRequest(
        request(cookieValue(recoverIdentity(request(), pending.value.recoveryCode, null).cookie)),
      ),
    ).toBe(current.owner);
  });
  it("expires a pending code without invalidating the active code or current browser", () => {
    vi.useFakeTimers();
    const current = identity();
    const active = rotateRecoveryCode(request(current.cookie), current.identityTag);
    const activeCookie = cookieValue(active.cookie);
    const pending = prepareRecoveryCode(request(activeCookie), active.value.identityTag);
    vi.advanceTimersByTime(15 * 60_000 + 1);
    expect(() =>
      activateRecoveryCode(
        request(activeCookie),
        active.value.identityTag,
        pending.value.recoveryCode,
      ),
    ).toThrow("待启用");
    expect(ownerFromRequest(request(activeCookie))).toBe(current.owner);
    expect(recoverIdentity(request(), active.value.recoveryCode, null).value.identityTag).toBe(
      active.value.identityTag,
    );
  });
  it("issues a private one-year cookie and exposes only a non-authorizing identity tag", () => {
    const result = getIdentity(request());
    expect(result.cookie).toContain("HttpOnly; SameSite=Lax; Max-Age=31536000");
    expect(result.value).toEqual({
      identityTag: expect.stringMatching(/^[a-f0-9]{64}$/),
      hasRecoveryCode: false,
    });
    const cookie = cookieValue(result.cookie!);
    expect(ownerFromRequest(request(cookie))).toBeTruthy();
    expect(ownerFromRequest(request(cookie + "x"))).toBeNull();
    expect(getIdentity(request(cookie))).toMatchObject({ value: result.value, cookie: null });
    const owner = ownerFromRequest(request(cookie))!;
    expect(JSON.stringify(result.value)).not.toContain(owner);
  });
  it("adds Secure in production and rejects expired signed cookies on the server", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ARENA_PUBLIC_DEMO", "true");
    vi.useFakeTimers();
    const start = Date.now();
    const result = getIdentity(request());
    expect(result.cookie).toContain("; Secure");
    vi.setSystemTime(start + 365 * 86400 * 1000 + 1);
    expect(ownerFromRequest(request(cookieValue(result.cookie!)))).toBeNull();
  });
  it("lazily upgrades a valid legacy cookie without reassigning historical owner data", () => {
    const owner = randomUUID();
    const signature = createHmac("sha256", secret).update(owner).digest("base64url");
    const legacy = `arena_owner=${owner}.${signature}`;
    const id = arena(owner, "synthetic legacy goal", "2026-11-07T12:00:00.000Z");
    expect(ownerFromRequest(request(legacy))).toBe(owner);
    const upgraded = getIdentity(request(legacy));
    expect(upgraded.cookie).toBeTruthy();
    expect(ownerFromRequest(request(cookieValue(upgraded.cookie!)))).toBe(owner);
    expect(listArenaHistory(owner, new URL("http://localhost/api/arenas")).items[0].id).toBe(id);
    const rotated = rotateRecoveryCode(
      request(cookieValue(upgraded.cookie!)),
      upgraded.value.identityTag,
    );
    expect(ownerFromRequest(request(legacy))).toBeNull();
    expect(ownerFromRequest(request(cookieValue(upgraded.cookie!)))).toBeNull();
    expect(ownerFromRequest(request(cookieValue(rotated.cookie)))).toBe(owner);
    expect(db().prepare("SELECT owner FROM arenas WHERE id=?").get(id)).toEqual({ owner });
  });
  it("stores only a random recovery hash and revokes old recovery codes and cookies on rotation", () => {
    const original = identity();
    const first = rotateRecoveryCode(request(original.cookie), original.identityTag);
    expect(first.value.recoveryCode).toMatch(/^ARENA1-(?:[A-F0-9]{8}-){7}[A-F0-9]{8}$/);
    expect(ownerFromRequest(request(original.cookie))).toBeNull();
    const firstCookie = cookieValue(first.cookie);
    const normalized = first.value.recoveryCode.toLowerCase().replace(/-/g, " ");
    expect(recoverIdentity(request(), normalized, null).value.identityTag).toBe(
      first.value.identityTag,
    );
    const stored = db().prepare("SELECT * FROM owner_credentials").all();
    expect(JSON.stringify(stored)).not.toContain(first.value.recoveryCode);
    expect(JSON.stringify(stored)).not.toContain(first.value.recoveryCode.replace(/-/g, ""));
    const second = rotateRecoveryCode(request(firstCookie), first.value.identityTag);
    expect(second.value.recoveryCode).not.toBe(first.value.recoveryCode);
    expect(ownerFromRequest(request(firstCookie))).toBeNull();
    expect(() => recoverIdentity(request(), first.value.recoveryCode, null)).toThrow("恢复码无效");
    expect(
      ownerFromRequest(
        request(cookieValue(recoverIdentity(request(), second.value.recoveryCode, null).cookie)),
      ),
    ).toBe(original.owner);
  });
  it("switches identities without merging arenas, drafts, quotas or existing recovery credentials", () => {
    const alice = identity();
    const aliceCode = rotateRecoveryCode(request(alice.cookie), alice.identityTag);
    const bob = identity();
    const aliceArena = arena(alice.owner, "synthetic Alice goal", "2026-11-07T12:00:00.000Z");
    const bobArena = arena(bob.owner, "synthetic Bob goal", "2026-11-07T12:00:00.000Z");
    const bobDraft = createIntake(bob.owner, {
      goal: "synthetic Bob unfinished goal",
      modelMode: "auto",
    });
    db()
      .prepare("INSERT INTO visitor_runs(owner,day,count) VALUES(?,?,?)")
      .run(bob.owner, "2026-11-07", 4);
    const recovered = recoverIdentity(
      request(bob.cookie),
      aliceCode.value.recoveryCode,
      bob.identityTag,
    );
    expect(ownerFromRequest(request(cookieValue(recovered.cookie)))).toBe(alice.owner);
    expect(
      listArenaHistory(alice.owner, new URL("http://localhost/api/arenas")).items.map(
        (item) => item.id,
      ),
    ).toEqual([aliceArena]);
    expect(
      listArenaHistory(bob.owner, new URL("http://localhost/api/arenas")).items.map(
        (item) => item.id,
      ),
    ).toEqual([bobArena]);
    expect(db().prepare("SELECT owner FROM intake_drafts WHERE id=?").get(bobDraft.id)).toEqual({
      owner: bob.owner,
    });
    expect(db().prepare("SELECT count FROM visitor_runs WHERE owner=?").get(bob.owner)).toEqual({
      count: 4,
    });
    expect(ownerFromRequest(request(bob.cookie))).toBe(bob.owner);
  });
  it("rejects stale-tab mutations and history reads after another tab changes the cookie", () => {
    const alice = identity();
    const bob = identity();
    const bobCode = rotateRecoveryCode(request(bob.cookie), bob.identityTag);
    expect(() => rotateRecoveryCode(request(alice.cookie), bob.identityTag)).toThrow("身份已");
    expect(() =>
      recoverIdentity(request(alice.cookie), bobCode.value.recoveryCode, bob.identityTag),
    ).toThrow("身份已");
    expect(() =>
      listArenaHistory(
        alice.owner,
        new URL(`http://localhost/api/arenas?identityTag=${bob.identityTag}`),
      ),
    ).toThrow("身份已");
    expect(() => recoverIdentity(request(alice.cookie), bobCode.value.recoveryCode, null)).toThrow(
      "身份已",
    );
  });
  it("keeps recovery attempts rate limited independently from preview access attempts", () => {
    for (let index = 0; index < 30; index++)
      expect(() => recoverIdentity(request(), "synthetic invalid code", null)).toThrow(
        "恢复码无效",
      );
    expect(() => recoverIdentity(request(), "synthetic invalid code", null)).toThrow("过于频繁");
    expect(db().prepare("SELECT COUNT(*) AS count FROM access_attempts").get()).toEqual({
      count: 0,
    });
    expect(
      JSON.stringify(db().prepare("SELECT * FROM identity_recovery_attempts").all()),
    ).not.toContain("synthetic invalid code");
  });
});

describe("owner history lists with synthetic persisted data", () => {
  it("paginates all discussions with stable ordering and excludes other owners and private material", () => {
    const current = identity();
    const stranger = identity();
    const first = arena(current.owner, "synthetic first goal", "2026-11-07T12:00:00.000Z");
    const second = arena(current.owner, "synthetic second goal", "2026-11-08T12:00:00.000Z");
    arena(stranger.owner, "synthetic other owner secret goal", "2026-11-09T12:00:00.000Z");
    const page = listArenaHistory(current.owner, new URL("http://localhost/api/arenas?limit=1"));
    expect(page.items.map((item) => item.id)).toEqual([second]);
    const next = listArenaHistory(
      current.owner,
      new URL(`http://localhost/api/arenas?limit=1&cursor=${page.nextCursor}`),
    );
    expect(next.items.map((item) => item.id)).toEqual([first]);
    expect(next.nextCursor).toBeNull();
    expect(JSON.stringify(page)).not.toContain("synthetic private material");
    expect(JSON.stringify(page)).not.toContain("synthetic other owner secret goal");
    expect(() =>
      listArenaHistory(current.owner, new URL("http://localhost/api/arenas?cursor=invalid")),
    ).toThrow("页码无效");
  });
  it("lists only resumable owned drafts and applies existing expiry handling", () => {
    const current = identity();
    const stranger = identity();
    const keep = createIntake(current.owner, { goal: "synthetic active draft", modelMode: "auto" });
    const expired = createIntake(current.owner, {
      goal: "synthetic expired draft",
      modelMode: "auto",
    });
    const submitted = createIntake(current.owner, {
      goal: "synthetic submitted draft",
      modelMode: "auto",
    });
    createIntake(stranger.owner, { goal: "synthetic private stranger draft", modelMode: "auto" });
    db()
      .prepare("UPDATE intake_drafts SET updated_at=? WHERE id=?")
      .run(Date.now() - 25 * 3600000, expired.id);
    db()
      .prepare("UPDATE intake_drafts SET submitted_arena_id=? WHERE id=?")
      .run(randomUUID(), submitted.id);
    const page = listIntakeHistory(current.owner, new URL("http://localhost/api/intakes"));
    expect(page.items.map((item) => item.id)).toEqual([keep.id]);
    expect(db().prepare("SELECT id FROM intake_drafts WHERE id=?").get(expired.id)).toBeUndefined();
    expect(page.items[0]).toEqual({
      id: keep.id,
      goal: keep.goal,
      status: "input",
      updatedAt: expect.any(Number),
    });
    expect(JSON.stringify(page)).not.toContain("private stranger");
    expect(JSON.stringify(page)).not.toContain("sources");
  });
  it("retains an expired uncertain draft and its reservation in history without replaying a call", () => {
    const current = identity();
    const draft = createIntake(current.owner, {
      goal: "synthetic uncertain draft",
      modelMode: "auto",
    });
    db()
      .prepare("UPDATE intake_drafts SET updated_at=?,body=? WHERE id=?")
      .run(
        Date.now() - 25 * 3600000,
        JSON.stringify({ ...draft, status: "uncertain", reservedUsd: 0.3 }),
        draft.id,
      );
    const page = listIntakeHistory(current.owner, new URL("http://localhost/api/intakes"));
    expect(page.items).toEqual([
      { id: draft.id, goal: draft.goal, status: "uncertain", updatedAt: expect.any(Number) },
    ]);
    const stored = db().prepare("SELECT body FROM intake_drafts WHERE id=?").get(draft.id) as {
      body: string;
    };
    expect(JSON.parse(stored.body)).toMatchObject({ status: "uncertain", reservedUsd: 0.3 });
    expect(db().prepare("SELECT COUNT(*) AS count FROM intake_calls").get()).toEqual({ count: 0 });
  });
});

describe("identity API entry points", () => {
  it("requires the preview gate and a valid owner for historical lists", async () => {
    expect((await arenasGet(request(undefined, "/api/arenas"))).status).toBe(404);
    expect((await intakesGet(request(undefined, "/api/intakes"))).status).toBe(404);
    vi.stubEnv("ARENA_ACCESS_CODE", "synthetic-invite");
    expect((await identityGet(request())).status).toBe(401);
    expect(
      (
        await recoverPost(
          post("/api/identity/recover", "", { code: "invalid", expectedIdentityTag: null }),
        )
      ).status,
    ).toBe(401);
  });
  it("uses JSON POST with origin validation, no-store responses and a fresh signed cookie", async () => {
    const first = await identityGet(request());
    const body = await first.json();
    const cookie = cookieValue(first.headers.get("set-cookie")!);
    const input = { expectedIdentityTag: body.identityTag };
    const crossOrigin = await recoveryCodePost(
      post("/api/identity/recovery-code", cookie, input, "https://elsewhere.invalid"),
    );
    expect(crossOrigin.status).toBe(403);
    const generated = await recoveryCodePost(post("/api/identity/recovery-code", cookie, input));
    expect(generated.status).toBe(200);
    expect(generated.headers.get("cache-control")).toBe("no-store");
    const result = await generated.json();
    expect(result.recoveryCode).toMatch(/^ARENA1-/);
    expect(result.identityTag).toBe(body.identityTag);
    expect(generated.headers.get("set-cookie")).toBeNull();
    const activation = await activateCodePost(
      post("/api/identity/recovery-code/activate", cookie, { ...input, code: result.recoveryCode }),
    );
    expect(activation.status).toBe(200);
    const activated = await activation.json();
    expect(activated.identityTag).not.toBe(body.identityTag);
    const recovery = await recoverPost(
      post("/api/identity/recover", "", { code: result.recoveryCode, expectedIdentityTag: null }),
    );
    expect(recovery.status).toBe(200);
    expect(recovery.headers.get("set-cookie")).toContain("HttpOnly");
    expect(await recovery.json()).toEqual({
      identityTag: activated.identityTag,
      hasRecoveryCode: true,
    });
    expect(() => requireOwner(request(cookie))).toThrow();
  });
});
