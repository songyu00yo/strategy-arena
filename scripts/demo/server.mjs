// Demo mode (pnpm demo). Every /api request is answered here with scripted content. None is forwarded,
// so demo mode cannot reach a model or spend money. Pages and assets come from the production build.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { scenarioFor } from "./scenarios.mjs";

export const DEMO_MODEL = {
  id: "demo-no-model",
  configured: true,
  promptVersion: "demo",
  schemaVersion: "1.0.0",
};
const BANNER_TEXT = "演示模式 · 全部是预设内容，未调用模型";
const BANNER = `<script>setTimeout(()=>{const b=document.createElement('div');b.textContent=${JSON.stringify(BANNER_TEXT)};b.setAttribute('role','note');b.style.cssText='position:fixed;left:50%;bottom:8px;transform:translateX(-50%);z-index:9999;padding:3px 12px;border-radius:99px;background:#0b0d10;color:#fff;font:12px/1.5 system-ui;pointer-events:none';document.body.appendChild(b)},0)</script>`;
const DEFAULT_CHALLENGE = {
  goal: "演示问题：比较三条可执行路线。",
  constraints: "",
  preferences: "",
  options: [],
  materials: "",
  domain: "general",
  budget: null,
  timeHours: null,
};

/** Builds the record as it stands after a number of reveals, in the runtime's stage order. */
function planOf(full) {
  const plan = [];
  for (const s of full.strategies) plan.push({ stage: "propose", role: s.id, s });
  for (const a of full.attacks) plan.push({ stage: "attack", role: a.from, a });
  plan.push({ stage: "verify", role: "verifier" });
  for (const r of full.revisions) plan.push({ stage: "revise", role: r.strategyId, r });
  plan.push({ stage: "judge", role: "judge" });
  return plan;
}

function view(run) {
  const { full, done, status } = run;
  const plan = planOf(full);
  const seen = plan.slice(0, done);
  const verified = seen.some((p) => p.stage === "verify");
  return {
    ...full,
    status: status ?? (done >= plan.length ? "completed" : "ready"),
    stage: plan[done]?.stage ?? "judge",
    strategies: seen.filter((p) => p.s).map((p) => p.s),
    attacks: seen.filter((p) => p.a).map((p) => (verified ? p.a : { ...p.a, status: "pending" })),
    evidence: verified ? full.evidence : [],
    revisions: seen.filter((p) => p.r).map((p) => p.r),
    verdict: done >= plan.length ? full.verdict : null,
    costCny: done * 0.012,
    error: null,
  };
}

function snapshot(arena, stepMs) {
  const steps = [];
  const events = [];
  let seq = 0;
  for (const run of arena.runs) {
    planOf(run.full).forEach((p, i) => {
      const finished = i < run.done;
      const at = new Date(run.started + i * stepMs).toISOString();
      steps.push({
        id: `${run.full.id}-${i}`,
        versionId: run.full.id,
        stage: p.stage,
        role: p.role,
        status: finished ? "completed" : "pending",
        error: null,
        startedAt: finished ? at : null,
        finishedAt: finished ? at : null,
      });
      if (!finished) return;
      const usage =
        p.stage === "verify"
          ? null
          : {
              inputTokens: 3000 + i * 110,
              outputTokens: 520 + i * 27,
              cachedInputTokens: 800,
              estimatedCny: 0.012,
              model: DEMO_MODEL.id,
              responseId: `demo-${i}`,
              durationMs: stepMs,
            };
      events.push({
        seq: ++seq,
        arenaId: arena.id,
        versionId: run.full.id,
        type: "step_completed",
        stage: p.stage,
        actor: p.role,
        message: `${p.role} 已完成（演示）。`,
        data: { usage },
        createdAt: at,
      });
    });
  }
  return {
    id: arena.id,
    activeVersionId: arena.runs.at(-1).full.id,
    createdAt: new Date(arena.runs[0].started).toISOString(),
    versions: arena.runs.map(view),
    steps,
    events,
    model: DEMO_MODEL,
  };
}

function addRun(arena, overrides = {}) {
  const previous = arena.runs.at(-1);
  if (previous) previous.status = "superseded";
  const challenge = overrides.challenge ?? previous?.full.challenge ?? DEFAULT_CHALLENGE;
  arena.runs.push({
    full: {
      id: randomUUID(),
      number: arena.runs.length + 1,
      status: "completed",
      stage: "judge",
      costCny: 0,
      reservedCny: 0,
      createdAt: new Date().toISOString(),
      changeReason: "",
      parentVersionId: previous?.full.id ?? null,
      error: null,
      ...scenarioFor(challenge),
      ...overrides,
      challenge,
    },
    done: 0,
    started: Date.now(),
  });
}

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
  });

/** Creates the demo server. `target` is the port of the production build that serves pages. */
export function createDemoServer({ target, stepMs = 3000 }) {
  const arenas = new Map();
  async function api(req, res, path) {
    if (path === "/api/health")
      return json(res, 200, {
        status: "ok",
        version: "demo",
        commit: "demo",
        sourceDirty: false,
        model: DEMO_MODEL,
        requiresAccessCode: false,
        accessGranted: true,
      });
    if (path === "/api/arenas" && req.method === "POST") {
      const sent = await readBody(req);
      const arena = { id: randomUUID(), runs: [] };
      addRun(arena, sent?.goal ? { challenge: sent } : {});
      arenas.set(arena.id, arena);
      return json(res, 201, snapshot(arena, stepMs));
    }
    const match = path.match(/^\/api\/arenas\/([^/]+)(?:\/(\w+))?$/);
    const arena = match && arenas.get(match[1]);
    if (!arena)
      return json(res, 404, { error: "没有找到这场演示，请刷新后重新开始。", code: "NOT_FOUND" });
    const action = match[2];
    const current = arena.runs.at(-1);
    if (action === "events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write(": demo\n\n");
      const timer = setInterval(() => res.write(": keep-alive\n\n"), 15000);
      req.on("close", () => clearInterval(timer));
      return;
    }
    if (action === "advance") {
      await readBody(req);
      const steps = planOf(current.full).length;
      if (!current.status && current.done < steps) {
        await new Promise((resolve) => setTimeout(resolve, stepMs));
        if (!current.status) current.done += 1;
      }
      return json(res, 200, snapshot(arena, stepMs));
    }
    if (action === "stop") {
      await readBody(req);
      current.status = "paused";
    } else if (action === "versions") {
      const { challenge, changeReason } = await readBody(req);
      addRun(arena, { challenge, changeReason });
    } else if (action === "interventions") {
      const { text } = await readBody(req);
      addRun(arena, { changeReason: `你的质疑：${text}` });
    }
    return json(res, 200, snapshot(arena, stepMs));
  }
  return http.createServer((req, res) => {
    const path = new URL(req.url, "http://demo").pathname;
    if (path === "/api" || path.startsWith("/api/")) return void api(req, res, path);
    const headers = { ...req.headers, host: `127.0.0.1:${target}`, "accept-encoding": "identity" };
    const upstream = http.request(
      { host: "127.0.0.1", port: target, path: req.url, method: req.method, headers },
      (reply) => {
        const type = reply.headers["content-type"] ?? "";
        if (!type.includes("text/html")) {
          res.writeHead(reply.statusCode, reply.headers);
          return void reply.pipe(res);
        }
        let html = "";
        reply.setEncoding("utf8");
        reply.on("data", (chunk) => (html += chunk));
        reply.on("end", () => {
          const rest = { ...reply.headers };
          delete rest["content-length"];
          res.writeHead(reply.statusCode, rest);
          res.end(html.replace("</body>", `${BANNER}</body>`));
        });
      },
    );
    upstream.on("error", () => {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("页面服务还没准备好，请稍等几秒后刷新。");
    });
    req.pipe(upstream);
  });
}
