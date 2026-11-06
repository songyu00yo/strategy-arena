/** Structural acceptance-tool tests only. No provider, runtime or billing calls. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { videoChallenge } from "../src/lib/sample";
import {
  assertResumeIdentity,
  assertResumeExecution,
  acquireOutputLock,
  FixtureSchema,
  planCases,
  resumeDecision,
  unresolvedBilling,
  sha256,
} from "../scripts/live-acceptance-plan";

const text = readFileSync(new URL("../evals/live-acceptance.json", import.meta.url), "utf8");
const fixture = FixtureSchema.parse(JSON.parse(text));

describe("frozen live acceptance inputs", () => {
  it("contains five initial/changed domains plus two single boundary cases", () => {
    const plan = planCases(fixture);
    expect(plan).toHaveLength(7);
    expect(plan.flatMap((item) => item.versions)).toHaveLength(12);
    expect(
      plan
        .filter((item) => item.category !== "boundary")
        .every((item) => item.versions.length === 2),
    ).toBe(true);
    expect(plan.find((item) => item.id === "creation")?.versions[0].challenge).toEqual(
      videoChallenge,
    );
    const changedCreation = plan.find((item) => item.id === "creation")!.versions[1].challenge;
    expect(changedCreation.budget).toBe(videoChallenge.budget);
    expect(changedCreation.timeHours).toBe(videoChallenge.timeHours);
    expect(changedCreation.materials).toBe(videoChallenge.materials);
    expect(
      plan
        .flatMap((item) => item.versions)
        .every((version) => version.semanticReview.status === "not-reviewed"),
    ).toBe(true);
  });
  it("freezes planned routes including the actual changed creation auto-to-GPT branch", () => {
    const plan = planCases(fixture);
    const providers = (id: string) =>
      plan.find((item) => item.id === id)!.versions.map((version) => version.plannedRoute.provider);
    expect(providers("learning")).toEqual(["deepseek", "deepseek"]);
    expect(providers("career")).toEqual(["openai", "openai"]);
    expect(providers("creation")).toEqual(["deepseek", "openai"]);
    expect(providers("team")).toEqual(["openai", "openai"]);
    expect(providers("consumption")).toEqual(["deepseek", "deepseek"]);
  });
  it("labels explicit overrides without rewriting the frozen plan or pretending to test auto/GPT", () => {
    const plan = planCases(fixture, ["career", "team"], [], "deepseek");
    for (const version of plan.flatMap((item) => item.versions)) {
      expect(version.plannedRoute.provider).toBe("openai");
      expect(version.executionRoute.provider).toBe("deepseek");
      expect(version.validationLabel).toBe(
        "supplemental-explicit-override-not-planned-mode-validation",
      );
    }
    expect(fixture.cases.find((item) => item.id === "career")?.plannedMode).toBe("gpt");
  });
  it("selects/excludes cases and refuses typos before execution", () => {
    expect(planCases(fixture, undefined, ["creation"])).toHaveLength(6);
    expect(planCases(fixture, ["learning"])).toHaveLength(1);
    expect(() => planCases(fixture, ["learnng"])).toThrow("Unknown case");
  });
  it("rejects fixture, execution-plan or database drift on resume", () => {
    const identity = {
      fixtureSha256: sha256(text),
      planSha256: sha256(JSON.stringify(planCases(fixture))),
      databaseIdentity: "isolated-db",
    };
    expect(() => assertResumeIdentity(identity, identity)).not.toThrow();
    for (const key of Object.keys(identity) as (keyof typeof identity)[]) {
      expect(() => assertResumeIdentity(identity, { ...identity, [key]: "changed" })).toThrow();
    }
    expect(sha256(`${text}\n`)).not.toBe(identity.fixtureSha256);
  });
});

describe("safe paid-attempt resumption", () => {
  it("rejects changed HEAD, source, clean state or effective configuration before resuming", () => {
    const source = {
      commit: "frozen-sha",
      dirty: false,
      sourceDiffSha256: "empty",
      sourceFiles: [{ path: "runtime", sha256: "frozen" }],
    };
    expect(() => assertResumeExecution(source, { ...source }, "source")).not.toThrow();
    for (const changed of [
      { ...source, commit: "other-sha" },
      { ...source, dirty: true },
      { ...source, sourceFiles: [{ path: "runtime", sha256: "changed" }] },
    ])
      expect(() => assertResumeExecution(source, changed, "source")).toThrow("source drift");
    const configuration = [
      { provider: "deepseek", id: "frozen-model", configured: true, maxOutputTokens: 2000 },
    ];
    expect(() =>
      assertResumeExecution(
        configuration,
        [{ ...configuration[0], maxOutputTokens: 3000 }],
        "configuration",
      ),
    ).toThrow("configuration drift");
  });
  it("permits only one output writer and never automatically removes existing or replaced locks", () => {
    const directory = mkdtempSync(join(tmpdir(), "acceptance-lock-test-"));
    const output = join(directory, "run.json");
    try {
      const release = acquireOutputLock(output);
      expect(() => acquireOutputLock(output)).toThrow();
      release();
      release();
      const releaseNext = acquireOutputLock(output);
      writeFileSync(`${output}.lock`, "other-owner");
      expect(() => releaseNext()).toThrow("ownership changed");
      expect(readFileSync(`${output}.lock`, "utf8")).toBe("other-owner");
      expect(() => acquireOutputLock(output)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("stops the entire batch for any held or reserved central billing attempt", () => {
    expect(unresolvedBilling({ heldRequests: 0, reservedUsdMicros: 0 })).toBe(false);
    expect(unresolvedBilling({ heldRequests: 1, reservedUsdMicros: 0 })).toBe(true);
    expect(unresolvedBilling({ heldRequests: 0, reservedUsdMicros: 1 })).toBe(true);
  });
  it("advances only resumable ready versions and never reruns running, uncertain or terminal attempts", () => {
    expect(resumeDecision("ready", ["completed", "pending"])).toBe("advance");
    expect(resumeDecision("running", ["running", "pending"])).toBe("wait-existing-request");
    expect(resumeDecision("ready", ["uncertain"])).toBe("manual-reconciliation");
    expect(resumeDecision("uncertain", [])).toBe("manual-reconciliation");
    for (const status of ["completed", "failed", "paused", "superseded"])
      expect(resumeDecision(status, [])).toBe("terminal");
  });
});
