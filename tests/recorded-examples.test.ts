import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RECORDED_EXAMPLES, type RecordedExamplePayload } from "../src/lib/recorded-examples";
import { NEW_EXAMPLES, canonical, packageExample } from "../scripts/package-clarification-examples";

function readRecording(slug: string): RecordedExamplePayload {
  return JSON.parse(readFileSync(resolve("public/recorded-examples", `${slug}.json`), "utf8"));
}

function inspect(value: unknown) {
  if (Array.isArray(value)) return value.forEach(inspect);
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    expect([
      "owner",
      "ownerId",
      "sessionId",
      "billingAttemptId",
      "runConfiguration",
      "configurationHash",
      "apiKey",
      "baseUrl",
    ]).not.toContain(key);
    if (key === "responseId") expect(item).toBe("[redacted]");
    if (key === "operationId") expect(item).toMatch(/^recording-[a-f0-9]{20}$/);
    inspect(item);
  }
}

describe("completed real-model clarification simulations", () => {
  it("publishes only the three new cases and removes the four old public data files", () => {
    expect(RECORDED_EXAMPLES.map((item) => item.slug)).toEqual(
      NEW_EXAMPLES.map((item) => item.slug),
    );
    for (const slug of ["learning", "career", "creation", "course-site"])
      expect(existsSync(resolve("public/recorded-examples", `${slug}.json`))).toBe(false);
    expect(readRecording("personal-website").metadata.qualityNote).toContain("第8轮的一次冗余确认");
  });

  it("preserves complete questions, simulated answers, real role usage and a confirmed handoff", () => {
    for (const metadata of RECORDED_EXAMPLES) {
      const payload = readRecording(metadata.slug);
      const version = payload.arena.versions.find(
        (item) => item.id === payload.arena.activeVersionId,
      )!;
      const state = version.clarification!;
      expect(payload.metadata).toEqual(metadata);
      expect(metadata.caseType).toBe("simulated_real_model");
      expect(metadata.simulationActor).toBe("Codex");
      expect(metadata.inputProvenance).toBe("synthetic-task-input");
      expect(metadata.outputProvenance).toBe("real-provider-output");
      expect(metadata.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
      expect(metadata.sourceFileSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(metadata.qualityNote).toContain("尚无执行反馈");
      expect(payload.arena.model.configured).toBe(false);
      expect(version.workflow).toBe("clarification");
      expect(version.status).toBe("completed");
      expect(version.verdict).toBeNull();
      expect(state.next).toBe("completed");
      expect(state.draftOnly).toBe(false);
      expect(state.review?.ready).toBe(true);
      expect(state.review?.gaps).toEqual([]);
      expect(state.rounds.filter((round) => round.questions.length).length).toBeGreaterThanOrEqual(
        3,
      );
      expect(version.intake!.originalGoal).toBe(metadata.question);
      expect(version.intake!.answers.some((answer) => answer.confirmation === "confirmed")).toBe(
        true,
      );
      expect(version.intake!.confirmation?.summary?.challenge).toEqual(version.challenge);
      expect(version.intake!.confirmation?.pendingSummaryFields ?? []).toEqual([]);
      expect(version.requirements?.executionPrompt).toBe(state.executionPrompt);
      expect(state.specification).toContain("已确认需求说明");
      for (const role of ["A", "B", "C"])
        expect(
          state.runs.some(
            (run) =>
              run.role === role &&
              run.status === "completed" &&
              run.callIds?.length &&
              run.usage.some((usage) => usage.inputTokens > 0),
          ),
        ).toBe(true);
      expect(createHash("sha256").update(canonical(version)).digest("hex")).toBe(
        metadata.sourceVersionContentSha256,
      );
      expect(payload.arena.versions.map((item) => item.id)).toEqual(metadata.sourceVersionIds);
      const cost =
        (version.costUsd ?? 0) +
        version.intake!.usage.reduce((sum, usage) => sum + (usage.estimatedUsd ?? 0), 0);
      expect(metadata.recordedCostUsd).toBeCloseTo(cost, 8);
      inspect(payload.arena);
    }
  });

  it("refuses to package unfinished, stale or unconfirmed records", () => {
    const payload = readRecording("presentation");
    const record = {
      caseType: "simulated_real_model" as const,
      simulationActor: "Codex" as const,
      sourceCommit: payload.metadata.sourceCommit,
      originalGoal: payload.metadata.question,
      initialMaterials: "",
      snapshot: payload.arena,
    };
    const pack = (value: typeof record) =>
      packageExample(value, NEW_EXAMPLES[1], "explicit-test-record.json", "a".repeat(64));
    expect(() => pack(record)).not.toThrow();
    const unfinished = structuredClone(record);
    unfinished.snapshot.versions[0].status = "paused";
    expect(() => pack(unfinished)).toThrow("尚未完成");
    const stale = structuredClone(record);
    stale.snapshot.versions[0].clarification!.review!.fingerprint = "0".repeat(64);
    expect(() => pack(stale)).toThrow("不一致");
    const unconfirmed = structuredClone(record);
    delete unconfirmed.snapshot.versions[0].intake!.confirmation!.summary;
    expect(() => pack(unconfirmed)).toThrow("明确确认");
    const missingRole = structuredClone(record);
    missingRole.snapshot.versions[0].clarification!.runs =
      missingRole.snapshot.versions[0].clarification!.runs.filter((run) => run.role !== "C");
    expect(() => pack(missingRole)).toThrow("C");
  });

  it("omits transport configuration while retaining the actual requirements", () => {
    const payload = readRecording("user-guide");
    const source = structuredClone(payload.arena);
    Object.assign(source, { owner: "private-owner" });
    source.versions[0].runConfiguration = { apiKey: "private-key" };
    const packed = packageExample(
      {
        caseType: "simulated_real_model",
        simulationActor: "Codex",
        sourceCommit: payload.metadata.sourceCommit,
        originalGoal: payload.metadata.question,
        initialMaterials: "",
        snapshot: source,
      },
      NEW_EXAMPLES[2],
      "explicit-test-record.json",
      "b".repeat(64),
    );
    expect(JSON.stringify(packed)).not.toContain("private-key");
    expect(JSON.stringify(packed)).not.toContain("private-owner");
    expect(packed.arena.versions[0].clarification!.specification).toBe(
      source.versions[0].clarification!.specification,
    );
  });
});
