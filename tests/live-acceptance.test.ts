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
  heldAcknowledgement,
  assertBillingAttemptsReviewed,
  sha256,
} from "../scripts/live-acceptance-plan";

import {
  parseLiveAcceptanceOptions,
  resolveLiveAcceptanceExecutionOptions,
} from "../scripts/live-acceptance";

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
  it("keeps the default twelve-version plan shape and hash unchanged", () => {
    const plan = planCases(fixture);
    expect(plan.flatMap((item) => item.versions)).toHaveLength(12);
    expect(sha256(JSON.stringify(plan))).toBe(
      "b4df1def92a0ba3c0189f1195c870cb8b997e45a57c4daa1c35466ce6ec3f634",
    );
    expect(planCases(fixture, undefined, [], undefined, false)).toEqual(plan);
  });
  it("plans only initial inputs without claiming changed-version or chain coverage", () => {
    const before = JSON.stringify(fixture);
    const full = planCases(fixture);
    const partial = planCases(fixture, undefined, [], undefined, true);
    expect(partial).toHaveLength(7);
    expect(partial.flatMap((item) => item.versions)).toHaveLength(7);
    for (const item of partial) {
      expect(item.versions).toHaveLength(1);
      const { validationLabel, ...version } = item.versions[0];
      const { validationLabel: fullLabel, ...initial } = full.find(
        (candidate) => candidate.id === item.id,
      )!.versions[0];
      expect(version.name).toBe("initial");
      expect(validationLabel).toBe("partial-initial-only-not-change-chain-validation");
      expect(fullLabel).toBe("planned-mode-validation");
      expect(version).toEqual(initial);
    }
    expect(partial.flatMap((item) => item.versions).filter((v) => v.name === "changed")).toEqual(
      [],
    );
    expect(JSON.stringify(fixture)).toBe(before);
  });
  it("retains planned and execution routes plus input for an initial-only explicit override", () => {
    const partial = planCases(fixture, ["career"], [], "deepseek", true);
    const fullInitial = planCases(fixture, ["career"], [], "deepseek")[0].versions[0];
    expect(partial[0].versions).toHaveLength(1);
    expect(partial[0].versions[0]).toEqual({
      ...fullInitial,
      validationLabel:
        "partial-initial-only-explicit-override-not-planned-mode-or-change-chain-validation",
    });
    expect(partial[0].versions[0].plannedRoute.provider).toBe("openai");
    expect(partial[0].versions[0].executionRoute.provider).toBe("deepseek");
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
  it("labels combined CLI initial-only and override as neither planned GPT nor change-chain validation", () => {
    const opts = resolveLiveAcceptanceExecutionOptions(
      parseLiveAcceptanceOptions([
        "--cases",
        "career",
        "--initial-only",
        "--model-mode",
        "deepseek",
      ]),
    );
    const version = planCases(fixture, opts.cases, opts.exclude, opts.override, opts.initialOnly)[0]
      .versions[0];
    expect(version.plannedMode).toBe("gpt");
    expect(version.plannedRoute.provider).toBe("openai");
    expect(version.executionRoute.provider).toBe("deepseek");
    expect(version.validationLabel).toBe(
      "partial-initial-only-explicit-override-not-planned-mode-or-change-chain-validation",
    );
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
  it("persists initial-only only when requested and preserves saved options on resume", () => {
    const defaults = resolveLiveAcceptanceExecutionOptions(parseLiveAcceptanceOptions([]));
    expect(defaults).not.toHaveProperty("initialOnly");
    const partial = resolveLiveAcceptanceExecutionOptions(
      parseLiveAcceptanceOptions(["--cases", "creation", "--initial-only"]),
    );
    expect(partial.initialOnly).toBe(true);
    const resume = parseLiveAcceptanceOptions(["--run", "--resume", "artifacts/saved.json"]);
    expect(resolveLiveAcceptanceExecutionOptions(resume, partial)).toBe(partial);
    expect(resolveLiveAcceptanceExecutionOptions(resume, defaults)).toBe(defaults);
    expect(resolveLiveAcceptanceExecutionOptions(resume, defaults)).not.toHaveProperty(
      "initialOnly",
    );
    const restored = resolveLiveAcceptanceExecutionOptions(resume, partial);
    expect(
      planCases(
        fixture,
        restored.cases,
        restored.exclude,
        restored.override,
        restored.initialOnly,
      )[0].versions.map((version) => version.name),
    ).toEqual(["initial"]);
    for (const selection of [
      ["--initial-only"],
      ["--cases", "creation"],
      ["--exclude", "creation"],
      ["--model-mode", "deepseek"],
    ]) {
      const replacement = parseLiveAcceptanceOptions([
        "--resume",
        "artifacts/saved.json",
        ...selection,
      ]);
      expect(() => resolveLiveAcceptanceExecutionOptions(replacement, partial)).toThrow(
        "Resume retains saved",
      );
      expect(() => resolveLiveAcceptanceExecutionOptions(replacement, defaults)).toThrow(
        "Resume retains saved",
      );
    }
    expect(() => parseLiveAcceptanceOptions(["--changed-only"])).toThrow("Unknown option");
  });
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
  it("requires an exact reviewed held-ID startup set and a recorded reason", () => {
    const held = { attemptId: "previous-call", state: "held" as const, reservedUsdMicros: 22700 };
    const acknowledgement = heldAcknowledgement(
      [held.attemptId],
      "Operator reviewed connect timeout; independent new run only",
    );
    expect(() => assertBillingAttemptsReviewed([], undefined, true)).not.toThrow();
    expect(() => assertBillingAttemptsReviewed([held], undefined, true)).toThrow();
    expect(() => assertBillingAttemptsReviewed([held], acknowledgement, true)).not.toThrow();
    expect(() => assertBillingAttemptsReviewed([], acknowledgement, true)).toThrow();
    expect(() => heldAcknowledgement([held.attemptId])).toThrow();
    expect(() => heldAcknowledgement([held.attemptId], " ")).toThrow();
    expect(() => heldAcknowledgement([held.attemptId, held.attemptId], "reviewed")).toThrow();
  });
  it("allows reviewed old holds to settle but stops on new identities even when counts match", () => {
    const oldHold = { attemptId: "old-held", state: "held" as const, reservedUsdMicros: 22700 };
    const newHold = { attemptId: "new-held", state: "held" as const, reservedUsdMicros: 22700 };
    const acknowledgement = heldAcknowledgement([oldHold.attemptId], "Reviewed prior failure");
    expect(() => assertBillingAttemptsReviewed([oldHold], acknowledgement)).not.toThrow();
    expect(() => assertBillingAttemptsReviewed([], acknowledgement)).not.toThrow();
    expect(() => assertBillingAttemptsReviewed([newHold], acknowledgement)).toThrow();
    expect(() => assertBillingAttemptsReviewed([oldHold, newHold], acknowledgement)).toThrow();
    expect(oldHold).toEqual({ attemptId: "old-held", state: "held", reservedUsdMicros: 22700 });
  });
  it("never acknowledges reserved attempts, even with the same approved ID", () => {
    const acknowledgement = heldAcknowledgement(["old-held"], "Reviewed prior failure");
    expect(() =>
      assertBillingAttemptsReviewed(
        [{ attemptId: "old-held", state: "reserved", reservedUsdMicros: 22700 }],
        acknowledgement,
      ),
    ).toThrow();
    expect(() =>
      assertBillingAttemptsReviewed(
        [{ attemptId: "active-request", state: "reserved", reservedUsdMicros: 100 }],
        acknowledgement,
      ),
    ).toThrow();
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
