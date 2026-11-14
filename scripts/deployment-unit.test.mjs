import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertDeploymentUnit } from "./deployment-unit.mjs";

const node = "/opt/strategy-arena/node-v24.19.0-linux-x64/bin/node";
const template = readFileSync(
  new URL("../docs/strategy-arena.service.example", import.meta.url),
  "utf8",
);
const valid = template.replace("ExecStart=/usr/bin/node ", `ExecStart=${node} `);

test("accepts the complete dedicated unit with its isolated Node runtime", () => {
  assert.doesNotThrow(() => assertDeploymentUnit(valid, node));
  assert.doesNotThrow(() => assertDeploymentUnit("# Reviewed unit\n" + valid, node));
});

for (const [name, directive] of [
  ["environment file reset", "EnvironmentFile="],
  ["another ledger environment file", "EnvironmentFile=/etc/another-project/arena.env"],
  ["public listener override", "Environment=HOSTNAME=0.0.0.0"],
  ["billing path override", "Environment=ARENA_BILLING_DATABASE_PATH=/tmp/fresh.sqlite"],
  ["second executable", "ExecStart=/bin/true"],
  ["startup hook", "ExecStartPre=/bin/true"],
  ["stop hook", "ExecStop=/bin/true"],
  ["another project conflict", "Conflicts=another-project.service"],
]) {
  test(`rejects ${name} even when all required lines are still present`, () => {
    const modified = valid.replace("[Install]", directive + "\n\n[Install]");
    assert.throws(() => assertDeploymentUnit(modified, node), /complete allowed service contract/);
  });
}

test("rejects missing hardening, repeated sections and altered executable arguments", () => {
  for (const modified of [
    valid.replace("ProtectSystem=strict\n", ""),
    valid.replace("[Install]", "[Service]\n\n[Install]"),
    valid.replace("/current/server.js", "/current/server.js --inspect=0.0.0.0"),
  ])
    assert.throws(() => assertDeploymentUnit(modified, node));
});

test("apply takes its project lock before service, receipt and previous-release checks", () => {
  const script = readFileSync(new URL("./deploy-arena.sh", import.meta.url), "utf8");
  const lock = script.indexOf("flock -n 9");
  for (const check of ["ActiveState --value", "const record =", "previous=$(realpath"])
    assert.ok(lock >= 0 && lock < script.indexOf(check));
  assert.match(script, /chmod 0755 "\$root\/releases"/);
  assert.match(script, /mkdir -m 0755 "\$release"/);
});
