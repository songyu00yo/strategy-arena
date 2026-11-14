import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { ArenaError, atomic, db, sessionSecret } from "./db";

const COOKIE = "arena_owner";
const OWNER_MAX_AGE = 365 * 86400;
export interface OwnerCredential {
  owner: string;
  recovery_hash: string | null;
  auth_generation: number;
  allow_legacy_cookie: number;
}
export function ownerCredential(owner: string): OwnerCredential | undefined {
  return db()
    .prepare(
      "SELECT owner,recovery_hash,auth_generation,allow_legacy_cookie FROM owner_credentials WHERE owner=?",
    )
    .get(owner) as OwnerCredential | undefined;
}
export function ownerCookie(owner: string, generation: number) {
  const expires = Date.now() + OWNER_MAX_AGE * 1000;
  const payload = `${owner}.${generation}.${expires}`;
  const signature = createHmac("sha256", sessionSecret())
    .update(`owner-v2:${payload}`)
    .digest("base64url");
  return secureCookie(COOKIE, `${payload}.${signature}`, OWNER_MAX_AGE);
}
function sign(owner: string) {
  return createHmac("sha256", sessionSecret()).update(owner).digest("base64url");
}
export function ownerFromRequest(request: Request): string | null {
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!cookie || cookie.length > 180) return null;
  const parts = cookie.split(".");
  const owner = parts[0];
  if (!/^[a-f0-9-]{36}$/.test(owner || "")) return null;
  if (parts.length === 4) {
    const [, generation, expires, signature] = parts;
    if (!/^\d{1,12}$/.test(generation) || !/^\d{13}$/.test(expires)) return null;
    const expiry = Number(expires);
    if (expiry <= Date.now() || expiry > Date.now() + OWNER_MAX_AGE * 1000 + 60_000) return null;
    const expected = createHmac("sha256", sessionSecret())
      .update(`owner-v2:${owner}.${generation}.${expires}`)
      .digest("base64url");
    if (!equal(signature, expected)) return null;
    const credential = ownerCredential(owner);
    return credential?.auth_generation === Number(generation) ? owner : null;
  }
  if (parts.length !== 2) return null;
  const signature = parts[1];
  const expected = Buffer.from(sign(owner));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  const credential = ownerCredential(owner);
  return !credential || credential.allow_legacy_cookie === 1 ? owner : null;
}
export function requireOwner(request: Request) {
  requireArenaAccess(request);
  const owner = ownerFromRequest(request);
  if (!owner) throw new ArenaError("未找到这场讨论，或当前浏览器没有访问权限。", 404, "NOT_FOUND");
  return owner;
}
export function ensureOwner(request: Request) {
  requireArenaAccess(request);
  const existing = ownerFromRequest(request);
  const owner = existing || randomUUID();
  db()
    .prepare(
      "INSERT INTO owner_credentials(owner,auth_generation,allow_legacy_cookie,created_at) VALUES(?,?,?,?) ON CONFLICT(owner) DO NOTHING",
    )
    .run(owner, existing ? 0 : 1, existing ? 1 : 0, Date.now());
  const credential = ownerCredential(owner)!;
  const legacy =
    existing &&
    !request.headers.get("cookie")?.includes(`${COOKIE}=${owner}.${credential.auth_generation}.`);
  return {
    owner,
    cookie: !existing || legacy ? ownerCookie(owner, credential.auth_generation) : null,
  };
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  const configured = process.env.ARENA_PUBLIC_ORIGIN;
  let expected = url.origin;
  if (configured) {
    try {
      const publicUrl = new URL(configured);
      if (
        !["http:", "https:"].includes(publicUrl.protocol) ||
        publicUrl.username ||
        publicUrl.password ||
        publicUrl.pathname !== "/" ||
        publicUrl.search ||
        publicUrl.hash
      )
        throw new Error();
      expected = publicUrl.origin;
    } catch {
      throw new ArenaError(
        "服务的公开访问地址配置无效，请联系管理员。",
        503,
        "INVALID_PUBLIC_ORIGIN",
      );
    }
  } else {
    // Next may normalize request.url to localhost. Host is the browser's actual target;
    // forwarded headers are intentionally not trusted. HTTPS proxies set ARENA_PUBLIC_ORIGIN.
    const host = request.headers.get("host");
    if (host) {
      if (/[\s/@\\?#]/.test(host)) throw new ArenaError("请求主机无效。", 400, "INVALID_HOST");
      try {
        expected = new URL(`${url.protocol}//${host}`).origin;
      } catch {
        throw new ArenaError("请求主机无效。", 400, "INVALID_HOST");
      }
    }
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(expected).hostname))
      throw new ArenaError(
        "公开预览必须配置可信的 ARENA_PUBLIC_ORIGIN，请联系管理员。",
        503,
        "PUBLIC_ORIGIN_REQUIRED",
      );
  }
  if (origin !== expected)
    throw new ArenaError("请求来源校验失败，请从本站页面重新操作。", 403, "INVALID_ORIGIN");
}
function accessCode() {
  return process.env.ARENA_ACCESS_CODE?.trim() || "";
}
function secureCookie(name: string, value: string, maxAge: number) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
function accessSignature(expires: string) {
  return createHmac("sha256", sessionSecret())
    .update(`access:${expires}:${accessCode()}`)
    .digest("base64url");
}
function equal(a: string, b: string) {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function accessState(request?: Request) {
  const configured = Boolean(accessCode());
  const blocked =
    process.env.NODE_ENV === "production" &&
    !configured &&
    process.env.ARENA_PUBLIC_DEMO !== "true";
  if (!configured) return { requiresAccessCode: blocked, accessGranted: !blocked };
  const cookie = request?.headers
    .get("cookie")
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("arena_access="))
    ?.slice("arena_access=".length);
  const [expires, signature, extra] = (cookie || "").split(".");
  const accessGranted =
    !extra &&
    /^\d{13}$/.test(expires || "") &&
    Number(expires) > Date.now() &&
    Number(expires) < Date.now() + 8 * 86400000 &&
    Boolean(signature) &&
    equal(signature, accessSignature(expires));
  return { requiresAccessCode: true, accessGranted };
}
export function requireArenaAccess(request: Request) {
  const state = accessState(request);
  if (!state.requiresAccessCode || state.accessGranted) return;
  if (!accessCode())
    throw new ArenaError("预览服务尚未配置访问口令，请联系管理员。", 503, "ACCESS_NOT_CONFIGURED");
  throw new ArenaError("请输入预览访问口令。", 401, "ACCESS_REQUIRED");
}
export function grantAccess(code: string) {
  const configured = accessCode();
  if (!configured) throw new ArenaError("未配置预览访问口令。", 503, "ACCESS_NOT_CONFIGURED");
  atomic(() => {
    db()
      .prepare("DELETE FROM access_attempts WHERE created_at<?")
      .run(Date.now() - 60_000);
    const count = db().prepare("SELECT COUNT(*) AS count FROM access_attempts").get() as {
      count: number;
    };
    if (count.count >= 30)
      throw new ArenaError("口令尝试过于频繁，请一分钟后再试。", 429, "ACCESS_RATE_LIMIT");
    db().prepare("INSERT INTO access_attempts(created_at) VALUES(?)").run(Date.now());
  });
  const digest = (value: string) =>
    createHmac("sha256", sessionSecret()).update(value).digest("hex");
  if (!equal(digest(code), digest(configured)))
    throw new ArenaError("访问口令不正确。", 401, "INVALID_ACCESS_CODE");
  const expires = String(Date.now() + 7 * 86400000);
  return secureCookie("arena_access", `${expires}.${accessSignature(expires)}`, 7 * 86400);
}
