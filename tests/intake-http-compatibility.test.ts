/** Real loopback HTTP routes and isolated SQLite. Stored questions are explicit legacy fixtures. */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET, PATCH } from "../src/app/api/intakes/[id]/route";
import { ensureOwner } from "../src/lib/server/auth";
import { closeDb, db } from "../src/lib/server/db";
import { createIntake } from "../src/lib/server/intakes";
import type { IntakeDraft } from "../src/lib/intake-contracts";

let directory: string;
let server: Server;
let origin: string;

beforeEach(async () => {
  closeDb();
  directory = mkdtempSync(join(tmpdir(), "arena-legacy-http-"));
  vi.stubEnv("ARENA_DATABASE_PATH", join(directory, "application.sqlite"));
  vi.stubEnv("ARENA_SESSION_SECRET", "explicit-http-compatibility-fixture-secret-only");
  vi.stubEnv("ARENA_ACCESS_CODE", "");
  vi.stubEnv("ARENA_PUBLIC_ORIGIN", "");
  vi.stubEnv("MODEL_API_KEY", "");
  vi.stubEnv("DEEPSEEK_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("NODE_ENV", "test");
  server = createServer(async (incoming, outgoing) => {
    try {
      const id = incoming.url?.match(/^\/api\/intakes\/([^/]+)$/)?.[1];
      if (!id || !["GET", "PATCH"].includes(incoming.method ?? "")) {
        outgoing.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const request = new Request(origin + incoming.url, {
        method: incoming.method,
        headers: incoming.headers as Record<string, string>,
        ...(incoming.method === "PATCH" ? { body: Buffer.concat(chunks) } : {}),
      });
      const context = { params: Promise.resolve({ id }) };
      const response = await (incoming.method === "GET" ? GET : PATCH)(request, context);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP fixture did not listen.");
  origin = `http://127.0.0.1:${address.port}`;
  vi.stubEnv("ARENA_PUBLIC_ORIGIN", origin);
});

afterEach(async () => {
  server?.closeAllConnections();
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  if (directory) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it.each([
  ["single", "其他，下一步由我描述"],
  ["single", "Other (please describe)"],
  ["multiple", "其他，下一步由我描述"],
  ["multiple", "Other (please describe)"],
] as const)(
  "saves, reopens and confirms legacy %s Other through HTTP for %s",
  async (type, label) => {
    const session = ensureOwner(new Request(origin));
    const cookie = session.cookie!.split(";", 1)[0];
    const draft = createIntake(session.owner, {
      goal: "Explicit synthetic legacy choice persistence fixture",
      modelMode: "gpt-6.1-terra",
    });
    const stored = JSON.parse(
      (db().prepare("SELECT body FROM intake_drafts WHERE id=?").get(draft.id) as { body: string })
        .body,
    );
    stored.status = "questions";
    stored.round = 1;
    stored.questions = [
      {
        id: "legacy-choice",
        title: "Legacy stored choice fixture",
        reason: "Explicit compatibility test",
        type,
        options: ["方案 A", label],
        placeholder: "",
        unit: "",
      },
    ];
    db()
      .prepare("UPDATE intake_drafts SET body=? WHERE id=?")
      .run(JSON.stringify(stored), draft.id);
    const url = `${origin}/api/intakes/${draft.id}`;
    async function patch(revision: number, value: string | string[], answerMode: string) {
      return fetch(url, {
        method: "PATCH",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify({
          revision,
          answerMode,
          answers: [{ questionId: "legacy-choice", state: "answered", value }],
        }),
      });
    }
    const incomplete = type === "multiple" ? ["方案 A", label] : label;
    const savedResponse = await patch(draft.revision, incomplete, "draft");
    expect(savedResponse.status).toBe(200);
    const saved = (await savedResponse.json()) as IntakeDraft;
    expect(saved.answers[0]).toMatchObject({ value: incomplete, confirmation: "pending" });
    closeDb();
    const restoredResponse = await fetch(url, { headers: { cookie } });
    expect(restoredResponse.status).toBe(200);
    const restored = (await restoredResponse.json()) as IntakeDraft;
    expect(restored.answers).toEqual(saved.answers);
    const invalidResponse = await patch(restored.revision, incomplete, "complete");
    expect(invalidResponse.status).toBe(400);
    const unchanged = (await (await fetch(url, { headers: { cookie } })).json()) as IntakeDraft;
    expect(unchanged.revision).toBe(restored.revision);
    expect(unchanged.answers).toEqual(restored.answers);
    const detail = `${label}:保留空格  和换行\n下一步由本人确认`;
    const complete = type === "multiple" ? ["方案 A", detail] : detail;
    const completedResponse = await patch(restored.revision, complete, "complete");
    expect(completedResponse.status).toBe(200);
    const completed = (await completedResponse.json()) as IntakeDraft;
    expect(completed.answers[0]).toMatchObject({ value: complete, confirmation: "confirmed" });
    closeDb();
    const reopened = (await (await fetch(url, { headers: { cookie } })).json()) as IntakeDraft;
    expect(reopened.answers).toEqual(completed.answers);
    expect(reopened.usage).toEqual([]);
    expect((await fetch(url)).status).toBe(404);
  },
);
