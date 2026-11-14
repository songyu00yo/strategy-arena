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
