import assert from "node:assert/strict";
import test from "node:test";
import { developmentConfig } from "./dev-local.mjs";
import { e2eAddress } from "./test-address.mjs";

test("local launcher overrides inherited live credentials, worker and database", () => {
  const { env } = developmentConfig("claude", "/tmp/arena frontend", {
    MODEL_API_KEY: "inherited-private-value",
    ARENA_SESSION_SECRET: "production-secret",
    ARENA_DATABASE_PATH: "/production/arena.sqlite",
    ARENA_WORKER_ENABLED: "true",
    PATH: "/bin",
  });
  assert.equal(env.MODEL_API_KEY, "");
  assert.equal(env.ARENA_SESSION_SECRET, "");
  assert.equal(env.ARENA_DATABASE_PATH, "/tmp/arena frontend/work/dev/claude.sqlite");
  assert.equal(env.ARENA_WORKER_ENABLED, "false");
  assert.equal(env.PATH, "/bin");
});

test("roles use distinct databases and fixed ports and reject unknown roles", () => {
  const a = developmentConfig("codex", "/tmp/arena", {});
  const b = developmentConfig("claude", "/tmp/arena", {});
  assert.equal(a.port, 3000);
  assert.equal(b.port, 3001);
  assert.notEqual(a.env.ARENA_DATABASE_PATH, b.env.ARENA_DATABASE_PATH);
  assert.throws(() => developmentConfig("preview"));
});

test("E2E addresses default to 3100 and cannot target real preview or arbitrary hosts", () => {
  assert.equal(e2eAddress().port, Number(process.env.E2E_PORT || 3100));
  assert.equal(e2eAddress("3101").origin, "http://127.0.0.1:3101");
  for (const value of ["3200", "3001", "", "http://remote", "NaN"]) {
    assert.throws(() => e2eAddress(value));
  }
});
