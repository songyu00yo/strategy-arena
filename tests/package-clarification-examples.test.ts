import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IntakeDraft } from "../src/lib/intake-contracts";
import type { ReplayAction } from "../src/lib/replay-contracts";
import { clarificationFingerprint } from "../src/lib/server/clarification";
import {
  NEW_EXAMPLES,
  canonical,
  packageExample,
  replayActionsFromRecords,
} from "../scripts/package-clarification-examples";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((path) => rmSync(path, { recursive: true })));
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type CaseRecord = Parameters<typeof packageExample>[0];

/** Test-only API trace double. No provider request is made or represented as a new real run. */
function apiTraceDouble(mode: "draft" | "complete" = "complete") {
  const payload = JSON.parse(
    readFileSync(resolve("public/recorded-examples/presentation.json"), "utf8"),
  );
  const record: CaseRecord = {
    caseType: "simulated_real_model",
    simulationActor: "Codex",
    sourceCommit: payload.metadata.sourceCommit,
    originalGoal: payload.metadata.question,
    initialMaterials: "",
    snapshot: structuredClone(payload.arena),
  };
  const version = record.snapshot.versions[0];
  const state = version.clarification!;
  const first = state.runs.slice(0, 2);
  const final = state.runs.slice(-3).map((run) => ({ ...run, round: 2, basedOnRevision: 4 }));
  const questions = state.rounds[0].questions;
  const answers = version.intake!.answers.filter((answer) =>
    questions.some((question) => question.id === answer.questionId),
  );
  version.intake!.answers = answers;
  version.createdAt = "2026-01-01T00:00:05.000Z";
  const summary = version.intake!.confirmation!.summary!;
  summary.revision = 4;
  summary.confirmedAt = "2026-01-01T00:00:05.002Z";
  state.runs = [...first, ...final];
  state.rounds = [
    state.rounds[0],
    { ...state.rounds.at(-1)!, round: 2, revision: 4, runIds: final.map((run) => run.id) },
  ];
  state.review!.fingerprint = clarificationFingerprint({
    goal: record.originalGoal,
    answers,
    sources: version.intake!.usedSources,
    challenge: version.challenge,
    confirmation: version.intake!.confirmation,
  } as IntakeDraft);
  const directory = mkdtempSync(join(tmpdir(), "clarification-replay-test-double-"));
  directories.push(directory);
  mkdirSync(join(directory, "raw"));
  const file = join(directory, "completed-record.json");
  const bytes = JSON.stringify(record);
  writeFileSync(file, bytes);
  const draft = {
    id: version.intake!.id,
    revision: 2,
    round: 1,
    status: "questions",
    questions,
    answers: [],
    updatedAt: "2026-01-01T00:00:02.000Z",
    clarification: { ...state, runs: first },
  };
  const path = `/api/intakes/${draft.id}`;
  const inputAnswers = answers.map(({ questionId, value, state }) => ({
    questionId,
    value,
    state,
  }));
  const entries = [
    { method: "POST", path: `${path}/analyze`, input: { revision: 0 }, response: draft },
    {
      method: "PATCH",
      path,
      input: { revision: 2, answerMode: mode, answers: inputAnswers },
      response: { ...draft, revision: 3, status: "input", questions: [], answers },
    },
    {
      method: "POST",
      path: `${path}/submit`,
      input: { revision: 3, challenge: version.challenge, assumptions: [] },
      response: record.snapshot,
    },
  ];
  const requests = entries.map(({ response, ...request }, index) => {
    const prefix = String(index + 1).padStart(3, "0");
    const saved = {
      ...request,
      index: index + 1,
      intentAt: `2026-01-01T00:00:0${index + 1}.100Z`,
      httpStatus: 200,
      responseFile: `raw/${prefix}-response.json`,
      responseSha256: digest(JSON.stringify(response)),
    };
    writeFileSync(join(directory, `raw/${prefix}-request.json`), JSON.stringify(saved));
    writeFileSync(join(directory, saved.responseFile), JSON.stringify(response));
    return saved;
  });
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ intakeId: draft.id, requests }));
  const extract = () =>
    replayActionsFromRecords(record, directory, "test-double/completed-record.json", digest(bytes));
  return { record, version, directory, requests, extract };
}

describe("API-evidenced clarification action packaging", () => {
  it("uses the actual submit intent before the new A run and keeps state timestamps separate", () => {
    const trace = apiTraceDouble();
    const actions = trace.extract();
    const submit = actions.find((action) => action.kind === "summary_submit")!;
    expect(submit.createdAt).toBe(trace.requests[2].intentAt);
    expect(submit.sourceRunId).toBe(trace.version.clarification!.runs[2].id);
    expect(submit.summary).toEqual({ challenge: trace.version.challenge, assumptions: [] });
    expect(actions.slice(-2).map((action) => action.kind)).toEqual(["summary_confirm", "handoff"]);
    expect(actions.at(-2)!.createdAt).toBe("2026-01-01T00:00:05.002Z");
    expect(actions.at(-1)!.createdAt).toBe("2026-01-01T00:00:05.000Z");
    for (const action of actions) expect(action.source?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps the whole question group while accepting one answer action at a time", () => {
    const trace = apiTraceDouble();
    const actions = trace.extract();
    const group = actions.find((action) => action.kind === "questions")!.questions;
    const answers = actions.filter((action) => action.kind === "answer");
    expect(answers).toHaveLength(group!.length);
    for (const action of answers) {
      expect(action.questions).toEqual(group);
      expect(action.answers).toHaveLength(1);
      expect(action.sourceRunId).toBe(trace.version.clarification!.runs[1].id);
    }
    const confirmed = actions.find((action) => action.kind === "round_confirm")!;
    expect(confirmed.questions).toEqual(group);
    expect(confirmed.answers).toHaveLength(group!.length);
  });

  it("keeps draft autosaves separate from an explicit round confirmation", () => {
    const actions = apiTraceDouble("draft").extract();
    expect(actions.some((action) => action.kind === "answer")).toBe(true);
    expect(actions.some((action) => action.kind === "round_confirm")).toBe(false);
  });

  it("rejects response changes that do not match the saved source digest", () => {
    const trace = apiTraceDouble();
    writeFileSync(join(trace.directory, "raw/001-response.json"), JSON.stringify({ revision: 99 }));
    expect(trace.extract).toThrow("响应与来源摘要不一致");
  });

  it("uses only provable snapshot states when the original request is missing", () => {
    const trace = apiTraceDouble();
    rmSync(join(trace.directory, "raw/002-request.json"));
    const actions = trace.extract();
    expect(actions.every((action) => action.source?.kind === "snapshot")).toBe(true);
    expect(actions.map((action) => action.kind)).not.toContain("summary_submit");
    expect(actions.map((action) => action.kind)).not.toContain("round_confirm");
    expect(actions.map((action) => action.kind)).not.toContain("answer");
    expect(actions.at(-1)!.kind).toBe("handoff");
  });

  it("whitelists nested action fields while keeping the recorded Arena canonical", () => {
    const trace = apiTraceDouble();
    const action = trace.extract().find((item) => item.kind === "answer")!;
    const unsafe = structuredClone(action);
    Object.assign(unsafe, { owner: "private-owner", config: { apiKey: "private-api-key" } });
    Object.assign(unsafe.source!, { headers: { Cookie: "private-cookie" } });
    Object.assign(unsafe.questions![0], { owner: "private-question-owner" });
    Object.assign(unsafe.answers![0], { config: "private-answer-config" });
    const packed = packageExample(
      trace.record,
      NEW_EXAMPLES[1],
      "test-double/completed-record.json",
      "a".repeat(64),
      [],
      [unsafe as ReplayAction],
    );
    expect(JSON.stringify(packed.replayActions)).not.toMatch(/private-|headers|Cookie|apiKey/);
    expect(canonical(packed.arena)).toBe(canonical(trace.record.snapshot));
  });
});
