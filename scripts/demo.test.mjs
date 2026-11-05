import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { createDemoServer, DEMO_MODEL } from "./demo/server.mjs";
import { scenarioFor } from "./demo/scenarios.mjs";
import { samples } from "../src/lib/sample.ts";

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
  await fetch(`${base()}/api/anything/else`);
  await fetch(`${base()}/api/arenas/none/advance`, { method: "POST", body: "{}" });
  assert.deepEqual(forwarded, []);
});

test("a game reveals step by step, shows the chosen question and never claims a model output", async () => {
  const chosen = samples[1].challenge;
  const post = (path, body) =>
    fetch(`${base()}${path}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
  let snapshot = await post("/api/arenas", chosen);
  assert.equal(snapshot.versions[0].challenge.goal, chosen.goal);
  assert.equal(snapshot.versions[0].strategies.length, 0);
  snapshot = await post(`/api/arenas/${snapshot.id}/advance`, {});
  assert.equal(snapshot.versions[0].strategies.length, 1);
  assert.equal(snapshot.versions[0].verdict, null);
  for (let i = 0; i < 20; i++) snapshot = await post(`/api/arenas/${snapshot.id}/advance`, {});
  const version = snapshot.versions[0];
  assert.equal(version.status, "completed");
  assert.equal(version.verdict.headline, scenarioFor(chosen).verdict.headline);
  assert.ok(snapshot.events.every((event) => !event.data.modelOutput));
});

test("pages come through with the demo notice", async () => {
  const html = await (await fetch(`${base()}/`)).text();
  assert.match(html, /演示模式/);
  assert.match(html, /page/);
});
