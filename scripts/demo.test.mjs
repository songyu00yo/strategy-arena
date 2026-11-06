import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { createDemoServer, DEMO_MODEL } from "./demo/server.mjs";
import { scenarioFor } from "./demo/scenarios.mjs";
import { tsImport } from "tsx/esm/api";
const { samples } = await tsImport("../src/lib/sample.ts", import.meta.url);
const { ChallengeSchema } = await tsImport("../src/lib/contracts.ts", import.meta.url);

test("every sample has its own scenario, distinct from the others", () => {
  const seen = new Set();
  for (const sample of samples) {
    const scenario = scenarioFor(sample.challenge);
    const title = scenario.strategies[0].title;
    assert.ok(!seen.has(title), `${sample.id} shares its content with another sample`);
    seen.add(title);
  }
});

test("a question typed by hand says plainly that it was not analysed", () => {
  const { verdict } = scenarioFor({ goal: "一个样例之外的问题，长度足够" });
  assert.equal(verdict.preferred, null);
  assert.match(verdict.headline, /未分析/);
});

test("scenarios are self-consistent: quotes, targets, sums and references", () => {
  const all = [...samples.map((s) => s.challenge), { goal: "其他问题" }].map(scenarioFor);
  for (const scenario of all) {
    assert.deepEqual(
      scenario.strategies.map((s) => s.id),
      ["A", "B", "C"],
    );
    for (const attack of scenario.attacks) {
      const route = scenario.strategies.find((s) => s.id === attack.targetStrategyId);
      const claim = route.claims.find((c) => c.id === attack.targetClaimId);
      assert.equal(claim.text, attack.claimQuote);
      assert.notEqual(attack.from, attack.targetStrategyId);
    }
    for (const item of scenario.evidence) {
      assert.ok(scenario.attacks.some((a) => a.id === item.attackId));
      if (item.expression) {
        const value = Function(`"use strict";return (${item.expression})`)();
        assert.ok(Math.abs(value - item.result) < 1e-9, item.title);
      }
    }
    for (const finding of scenario.verdict.attackFindings)
      assert.ok(scenario.attacks.some((a) => a.id === finding.attackId));
  }
});

let demo;
let upstream;
let forwarded = [];
const base = () => `http://127.0.0.1:${demo.address().port}`;

before(async () => {
  upstream = http.createServer((req, res) => {
    forwarded.push(req.url);
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>page</body></html>");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  demo = createDemoServer({ target: upstream.address().port, stepMs: 1 });
  await new Promise((resolve) => demo.listen(0, "127.0.0.1", resolve));
});
after(() => {
  demo.close();
  upstream.close();
  demo.closeAllConnections();
  upstream.closeAllConnections();
});

test("no /api request ever leaves the demo server", async () => {
  forwarded = [];
  const health = await (await fetch(`${base()}/api/health`)).json();
  assert.equal(health.version, "demo");
  assert.equal(health.model.id, DEMO_MODEL.id);
  for (const path of ["/api", "/api/anything/else", "/api/access", "/api/health?model=gpt"])
    await fetch(`${base()}${path}`, { method: "POST", body: "{}" });
  await fetch(`${base()}/api/arenas/none/advance`, { method: "POST", body: "{}" });
  assert.deepEqual(forwarded, []);
});

test("a game reveals step by step, shows the chosen question and never claims a model output", async () => {
  const chosen = samples[1].challenge;
  const post = (path, body) =>
    fetch(`${base()}${path}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
  let snapshot = await post("/api/arenas", { ...chosen, modelMode: "gpt" });
  assert.equal(snapshot.versions[0].challenge.goal, chosen.goal);
  assert.deepEqual(snapshot.versions[0].challenge, ChallengeSchema.parse(chosen));
  assert.equal(snapshot.versions[0].modelSelection, undefined);
  assert.equal(snapshot.versions[0].strategies.length, 0);
  const advance = () =>
    post(`/api/arenas/${snapshot.id}/advance`, { versionId: snapshot.activeVersionId });
  snapshot = await advance();
  assert.equal(snapshot.versions[0].strategies.length, 1);
  assert.equal(snapshot.versions[0].verdict, null);
  for (let i = 0; i < 20; i++) snapshot = await advance();
  const version = snapshot.versions[0];
  assert.equal(version.status, "completed");
  assert.equal(version.verdict.headline, scenarioFor(chosen).verdict.headline);
  assert.ok(snapshot.events.every((event) => !event.data.modelOutput));
  assert.ok(snapshot.events.every((event) => event.data.scripted === true));
});

test("create and rematch keep model selection out of saved challenges and preserve completed history", async () => {
  const post = (path, body) =>
    fetch(`${base()}${path}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
  let snapshot = await post("/api/arenas", { ...samples[0].challenge, modelMode: "auto" });
  const path = `/api/arenas/${snapshot.id}`;
  const originalId = snapshot.activeVersionId;
  for (let i = 0; i < 30 && snapshot.versions[0].status === "ready"; i++)
    snapshot = await post(`${path}/advance`, { versionId: originalId });
  const original = snapshot.versions[0];
  assert.equal(original.status, "completed");
  snapshot = await post(`${path}/versions`, {
    challenge: { ...samples[1].challenge, modelMode: "deepseek" },
    changeReason: "演示中修改条件",
    modelMode: "gpt",
  });
  assert.deepEqual(snapshot.versions[0], original);
  const rematch = snapshot.versions[1];
  assert.equal(rematch.parentVersionId, originalId);
  assert.equal(rematch.changeReason, "演示中修改条件");
  assert.deepEqual(rematch.challenge, ChallengeSchema.parse(samples[1].challenge));
  assert.equal(rematch.modelSelection, undefined);
  assert.equal(rematch.strategies.length, 0);
  snapshot = await post(`${path}/advance`, { versionId: snapshot.activeVersionId });
  assert.equal(
    snapshot.versions[1].strategies[0].title,
    scenarioFor(rematch.challenge).strategies[0].title,
  );
});

test("delayed advance and stop requests for an older version never mutate its replacement", async () => {
  const post = (path, body) =>
    fetch(`${base()}${path}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
  let snapshot = await post("/api/arenas", samples[0].challenge);
  const originalId = snapshot.activeVersionId;
  const path = `/api/arenas/${snapshot.id}`;
  snapshot = await post(`${path}/versions`, {
    challenge: samples[1].challenge,
    changeReason: "演示条件变化",
  });
  const replacementId = snapshot.activeVersionId;
  snapshot = await post(`${path}/advance`, { versionId: originalId });
  snapshot = await post(`${path}/stop`, { versionId: originalId });
  assert.equal(snapshot.activeVersionId, replacementId);
  assert.equal(snapshot.versions[0].status, "superseded");
  assert.equal(snapshot.versions[1].status, "ready");
  assert.equal(snapshot.versions[1].strategies.length, 0);
  snapshot = await post(`${path}/stop`, { versionId: replacementId });
  assert.equal(snapshot.versions[1].status, "paused");
  snapshot = await post(`${path}/advance`, { versionId: replacementId });
  assert.equal(snapshot.versions[1].strategies.length, 0);
  const unknown = await fetch(`${base()}${path}/advance`, {
    method: "POST",
    body: JSON.stringify({ versionId: "unknown-version" }),
  });
  assert.equal(unknown.status, 404);
});

test("interventions use an actual visible claim and retain the current challenge", async () => {
  const post = (path, body) =>
    fetch(`${base()}${path}`, { method: "POST", body: JSON.stringify(body) });
  let snapshot = await (await post("/api/arenas", samples[0].challenge)).json();
  const path = `/api/arenas/${snapshot.id}`;
  snapshot = await (await post(`${path}/advance`, { versionId: snapshot.activeVersionId })).json();
  const shown = snapshot.versions[0].strategies[0];
  const invalid = await post(`${path}/interventions`, {
    targetStrategyId: shown.id,
    targetClaimId: "missing-claim",
    text: "补充一条演示质疑",
  });
  assert.equal(invalid.status, 409);
  const oldId = snapshot.activeVersionId;
  snapshot = await (
    await post(`${path}/interventions`, {
      targetStrategyId: shown.id,
      targetClaimId: shown.claims[0].id,
      text: "补充一条演示质疑",
    })
  ).json();
  assert.equal(snapshot.versions[1].parentVersionId, oldId);
  assert.deepEqual(snapshot.versions[1].challenge, ChallengeSchema.parse(samples[0].challenge));
  assert.match(snapshot.versions[1].changeReason, /补充一条演示质疑/);
});

test("invalid create/rematch requests return contract errors without creating a version", async () => {
  const post = (path, body) =>
    fetch(`${base()}${path}`, { method: "POST", body: JSON.stringify(body) });
  assert.equal((await post("/api/arenas", { goal: "短" })).status, 400);
  const snapshot = await (await post("/api/arenas", { goal: "这是长度足够的演示问题" })).json();
  assert.deepEqual(
    snapshot.versions[0].challenge,
    ChallengeSchema.parse({ goal: "这是长度足够的演示问题" }),
  );
  const path = `/api/arenas/${snapshot.id}`;
  assert.equal((await post(`${path}/versions`, { challenge: samples[0].challenge })).status, 400);
  const unchanged = await (await fetch(`${base()}${path}`)).json();
  assert.equal(unchanged.versions.length, 1);
});

test("pages come through with the demo notice", async () => {
  const html = await (await fetch(`${base()}/`)).text();
  assert.match(html, /演示模式/);
  assert.match(html, /page/);
});
