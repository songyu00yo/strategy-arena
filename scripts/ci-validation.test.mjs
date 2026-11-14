import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("CI selects the explicit Bash shell with fail-fast pipeline semantics", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /defaults:\s*\n\s+run:\s*\n\s+shell:\s*bash\s*\n/);
});

test("a failed command through tee stops before a passing artifact can be recorded", () => {
  const directory = mkdtempSync(join(tmpdir(), "arena-ci-pipeline-"));
  const marker = join(directory, "incorrect-passing-artifact");
  try {
    const result = spawnSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-e",
        "-o",
        "pipefail",
        "-c",
        'false | tee /dev/null\nnode -e \'require("node:fs").writeFileSync(process.env.ARENA_CI_FAILURE_MARKER, "incorrect")\'',
      ],
      { env: { ...process.env, ARENA_CI_FAILURE_MARKER: marker }, encoding: "utf8" },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CI runs independent checks after failures and collects their actual outcomes", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  for (const id of ["secrets", "typecheck", "lint", "unit", "scripts", "evals", "build"]) {
    assert.match(
      workflow,
      new RegExp(`id: ${id}\\n\\s+if: always\\(\\) && steps\\.install\\.outcome == 'success'`),
    );
    assert.equal(workflow.split(`CI_STEP_${id.toUpperCase()}:`).length - 1, 2);
  }
  assert.match(workflow, /name: Write truthful functional CI receipt\n\s+if: always\(\)/);
  assert.match(workflow, /name: Package validated build and its evidence\n\s+if: success\(\)/);
  assert.match(
    workflow,
    /rm -f test-results\/e2e\.json test-results\/e2e\.xml\n\s+pnpm exec playwright install/,
  );
  assert.ok(
    workflow.indexOf("ci-validation-report.mjs --assert-ready") <
      workflow.indexOf("node scripts/package-release.mjs"),
  );
  assert.doesNotMatch(workflow, /writeFileSync\([^\n]*checks\.json/);
  assert.match(workflow, /test-results\/\*\.json/);
});
