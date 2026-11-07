import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assertPortFree, prepareLivePreview, proxyEnvironment } from "./start-live-preview.mjs";

// Only temporary synthetic release/ledger files; no models or real credentials.
const billingFixture = {
  usdLimitMicros: 10_000_000,
  requestLimit: 300,
  tokenLimit: 5_000_000,
  hardTotalUsdMicros: 200_000_000,
  developmentMaxUsdMicros: 120_000_000,
  finalReserveUsdMicros: 80_000_000,
  revision: 1,
  activeStage: { id: "fixture" },
  committedUsdMicros: 100,
  requests: 1,
  tokens: 20,
};
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "arena-live-launcher-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const release = join(directory, "release");
  mkdirSync(release);
  const info = {
    commit: "a".repeat(40),
    workingTreeDirty: false,
    sourceFingerprint: "b".repeat(64),
    outputFingerprint: "c".repeat(64),
    builtAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  };
  writeFileSync(join(release, "release-info.json"), JSON.stringify(info));
  for (const file of [
    "server.js",
    ".next/BUILD_ID",
    ".next/static/fixture",
    "migrations/001_initial.sql",
    "migrations/002_intakes.sql",
    "migrations/003_decision_reviews.sql",
    "migrations/billing/002_limit_audit.sql",
  ]) {
    mkdirSync(dirname(join(release, file)), { recursive: true });
    writeFileSync(join(release, file), "fixture");
  }
  const options = {
    release,
    envFile: join(directory, "private.env"),
    database: join(directory, "data/arena.sqlite"),
    billingDatabase: join(directory, "billing.sqlite"),
    check: true,
  };
  writeFileSync(options.envFile, "DEEPSEEK_API_KEY=private-fixture-never-printed\n");
  const deps = { readBillingStatus: () => billingFixture, assertPortFree: async () => {} };
  return { directory, options, deps, info };
}

test("check validates identities and runtime caps without creating data or reading environment contents", async (t) => {
  const { directory, options, deps } = fixture(t);
  const envBefore = readFileSync(options.envFile);
  const config = await prepareLivePreview(options, deps);
  assert.equal(config.commit, "a".repeat(40));
  assert.equal(config.env.HOSTNAME, "127.0.0.1");
  assert.equal(config.env.ARENA_PUBLIC_ORIGIN, "http://127.0.0.1:3340");
  assert.equal(config.env.ARENA_BILLING_USD_LIMIT, "10");
  assert.equal(config.env.ARENA_BILLING_REQUEST_LIMIT, "300");
  assert.equal(config.env.ARENA_BILLING_TOKEN_LIMIT, "5000000");
  assert.equal(config.env.ARENA_RUN_BUDGET_USD, "2");
  assert.equal(config.env.ARENA_RUN_BUDGET_CNY, "12");
  assert.equal(config.env.ARENA_GLOBAL_BUDGET_USD, "10");
  assert.equal(config.env.ARENA_GLOBAL_BUDGET_CNY, "60");
  assert.equal(config.env.ARENA_WORKER_ENABLED, "false");
  assert.equal(config.env.ARENA_PUBLIC_DEMO, "true");
  for (const key of ["MODEL_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "NODE_OPTIONS"])
    assert.equal(config.env[key], undefined);
  assert.equal(existsSync(join(directory, "data")), false);
  assert.equal(existsSync(options.database), false);
  assert.equal(existsSync(config.sessionFile), false);
  assert.deepEqual(readFileSync(options.envFile), envBefore);
});

test("passes only trusted proxy variables and appends loopback bypasses for both cases", async (t) => {
  const { options, deps } = fixture(t);
  const inheritedEnv = {
    PATH: "/fixture/bin",
    HTTPS_PROXY: "http://upper-proxy.fixture:8080",
    HTTP_PROXY: "http://upper-http.fixture:8080",
    https_proxy: "http://lower-proxy.fixture:8081",
    http_proxy: "http://lower-http.fixture:8081",
    NO_PROXY: "internal.fixture, localhost",
    no_proxy: "other.fixture,127.0.0.1",
    NODE_OPTIONS: "--import /fixture/untrusted-preload.mjs",
    OPENAI_API_KEY: "synthetic-must-not-cross-wrapper",
    MODEL_API_KEY: "synthetic-must-not-cross-wrapper",
    ALL_PROXY: "http://unrelated.fixture:8080",
  };
  const config = await prepareLivePreview(options, { ...deps, inheritedEnv });
  for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"])
    assert.equal(config.env[key], inheritedEnv[key]);
  const bypasses = config.env.NO_PROXY.split(",");
  for (const host of ["internal.fixture", "other.fixture", "127.0.0.1", "localhost", "::1"])
    assert.ok(bypasses.includes(host));
  assert.equal(config.env.no_proxy, config.env.NO_PROXY);
  for (const key of ["NODE_OPTIONS", "OPENAI_API_KEY", "MODEL_API_KEY", "ALL_PROXY"])
    assert.equal(config.env[key], undefined);
  assert.equal(config.args[0], "--use-env-proxy");
  assert.equal(config.args[1], `--env-file=${options.envFile}`);
  assert.equal(config.args.at(-1), join(options.release, "server.js"));
  assert.deepEqual(proxyEnvironment({}), {
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
  });
});

test("uses audited 300, 400, 650 or 700 request caps without adjusting the ledger or other ceilings", async (t) => {
  const { directory, options, deps } = fixture(t);
  for (const requestLimit of [300, 400, 650, 700]) {
    let reads = 0;
    const summary = { ...billingFixture, requestLimit, requests: 243 };
    const before = structuredClone(summary);
    const config = await prepareLivePreview(options, {
      ...deps,
      readBillingStatus: () => {
        reads++;
        return summary;
      },
    });
    assert.equal(reads, 1);
    assert.equal(config.env.ARENA_BILLING_REQUEST_LIMIT, String(requestLimit));
    assert.equal(config.env.ARENA_BILLING_USD_LIMIT, "10");
    assert.equal(config.env.ARENA_BILLING_TOKEN_LIMIT, "5000000");
    assert.deepEqual(summary, before);
    assert.equal(existsSync(join(directory, "data")), false);
  }
  for (const requestLimit of [299, 701, 300.5])
    await assert.rejects(
      prepareLivePreview(options, {
        ...deps,
        readBillingStatus: () => ({ ...billingFixture, requestLimit }),
      }),
      /already have audited/,
    );
});

test("sessions are persistent, private and never overwrite an existing unsafe file", async (t) => {
  const { options, deps } = fixture(t);
  options.check = false;
  const first = await prepareLivePreview(options, deps);
  const second = await prepareLivePreview(options, deps);
  assert.match(first.env.ARENA_SESSION_SECRET, /^[a-f0-9]{64}$/);
  assert.equal(second.env.ARENA_SESSION_SECRET, first.env.ARENA_SESSION_SECRET);
  assert.equal(existsSync(options.database), false);
  chmodSync(first.sessionFile, 0o644);
  const before = readFileSync(first.sessionFile);
  await assert.rejects(prepareLivePreview(options, deps), /permissions 0600/);
  assert.deepEqual(readFileSync(first.sessionFile), before);
});

test("rejects dirty or incomplete build identities, unsupported Node and reserved ports", async (t) => {
  const { options, deps, info } = fixture(t);
  await assert.rejects(
    prepareLivePreview(options, { ...deps, nodeVersion: "22.0.0" }),
    /Node.js 24/,
  );
  for (const port of [3302, 3303, 3200, 3000, 3100, "3340x", "", 0, 65536])
    await assert.rejects(prepareLivePreview({ ...options, port }, deps), /nonreserved/);
  for (const change of [
    { workingTreeDirty: true },
    { commit: "abc123" },
    { outputFingerprint: "" },
    { platform: "wrong" },
  ]) {
    writeFileSync(
      join(options.release, "release-info.json"),
      JSON.stringify({ ...info, ...change }),
    );
    await assert.rejects(prepareLivePreview(options, deps), /clean full SHA/);
  }
});

test("never silently raises existing ledger caps or launches when shared allowance is exhausted", async (t) => {
  const { options, deps } = fixture(t);
  for (const change of [
    { usdLimitMicros: 2_000_000 },
    { usdLimitMicros: 10_000_001 },
    { requestLimit: 100 },
    { tokenLimit: 2_000_000 },
    { tokenLimit: 5_000_001 },
    { revision: 0 },
    { activeStage: null },
  ])
    await assert.rejects(
      prepareLivePreview(options, {
        ...deps,
        readBillingStatus: () => ({ ...billingFixture, ...change }),
      }),
      /already have audited/,
    );
  for (const change of [
    { committedUsdMicros: 10_000_000 },
    { requests: 300 },
    { tokens: 5_000_000 },
  ])
    await assert.rejects(
      prepareLivePreview(options, {
        ...deps,
        readBillingStatus: () => ({ ...billingFixture, ...change }),
      }),
      /exhausted/,
    );
});

test("keeps writable data outside the release and rejects colliding paths", async (t) => {
  const { options, deps } = fixture(t);
  await assert.rejects(
    prepareLivePreview({ ...options, database: join(options.release, "arena.sqlite") }, deps),
    /outside the release/,
  );
  await assert.rejects(
    prepareLivePreview({ ...options, database: options.billingDatabase }, deps),
    /distinct/,
  );
  await assert.rejects(
    prepareLivePreview(
      { ...options, sessionFile: join(dirname(options.database), "session.txt") },
      deps,
    ),
    /ignored .key suffix/,
  );
});

test("occupied loopback ports are refused without stopping their owner", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(assertPortFree(server.address().port), /unavailable/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("CLI check uses the actual read-only billing API and never starts the synthetic server", async (t) => {
  const { directory, options } = fixture(t);
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  writeFileSync(
    join(options.release, "server.js"),
    `require('node:fs').writeFileSync(${JSON.stringify(join(directory, "unexpected-spawn"))}, 'bad');`,
  );
  const setup = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import {openBillingLedger, changeBillingLimits} from './src/lib/server/billing.ts';
    const databasePath = process.argv[1]; openBillingLedger({databasePath}).close();
    changeBillingLimits({databasePath, expected:{revision:0,usdLimit:2,requestLimit:100,tokenLimit:2000000},
      limits:{usdLimit:10,requestLimit:300,tokenLimit:5000000}, stage:{id:'fixture',usdLimit:10,requestLimit:300,tokenLimit:5000000},reason:'temporary CLI fixture'});
  `,
      options.billingDatabase,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(setup.status, 0, setup.stderr);
  const result = spawnSync(
    process.execPath,
    [
      "scripts/start-live-preview.mjs",
      "--release",
      options.release,
      "--env-file",
      options.envFile,
      "--database",
      options.database,
      "--billing-database",
      options.billingDatabase,
      "--port",
      String(port),
      "--check",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Validated real local preview/);
  assert.equal((result.stdout + result.stderr).includes("private-fixture"), false);
  assert.equal(existsSync(join(directory, "unexpected-spawn")), false);
  assert.equal(existsSync(join(directory, "data")), false);
});

for (const migration of ["002_intakes.sql", "003_decision_reviews.sql"])
  test(`rejects a bundle missing ${migration} before starting or creating data`, async (t) => {
    const { directory, options, deps } = fixture(t);
    rmSync(join(options.release, "migrations", migration));
    await assert.rejects(prepareLivePreview(options, deps), /Standalone release is incomplete/);
    assert.equal(existsSync(join(directory, "data")), false);
  });
