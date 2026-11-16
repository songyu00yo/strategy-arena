import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RECORDED_EXAMPLES, type RecordedExamplePayload } from "../src/lib/recorded-examples";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function inspect(value: unknown) {
  if (Array.isArray(value)) return value.forEach(inspect);
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    expect([
      "owner",
      "ownerId",
      "sessionId",
      "operationId",
      "billingAttemptId",
      "runConfiguration",
      "configurationHash",
      "baseUrl",
      "apiKey",
    ]).not.toContain(key);
    if (key === "responseId") expect(item).toBe("[redacted]");
    inspect(item);
  }
}

describe("recorded real examples", () => {
  it("ships distinct static recordings with traceable unchanged result content", () => {
    expect(new Set(RECORDED_EXAMPLES.map((example) => example.slug)).size).toBe(
      RECORDED_EXAMPLES.length,
    );
    for (const metadata of RECORDED_EXAMPLES) {
      const payload = JSON.parse(
        readFileSync(resolve("public/recorded-examples", `${metadata.slug}.json`), "utf8"),
      ) as RecordedExamplePayload;
      expect(payload.metadata).toEqual(metadata);
      expect(metadata.inputProvenance).toBe("synthetic-task-input");
      expect(metadata.outputProvenance).toBe("real-provider-output");
      expect(metadata.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
      expect(metadata.sourceFileSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(payload.arena.model.configured).toBe(false);
      expect(payload.arena.versions.map((version) => version.id)).toEqual(
        metadata.sourceVersionIds,
      );
      const version = payload.arena.versions[0];
      expect(version.status).toBe("completed");
      expect(createHash("sha256").update(canonical(version)).digest("hex")).toBe(
        metadata.sourceVersionContentSha256,
      );
      expect(payload.arena.events.every((event) => event.versionId === version.id)).toBe(true);
      expect(payload.arena.steps.every((step) => step.versionId === version.id)).toBe(true);
      expect(
        payload.arena.events.some(
          (event) => event.data && typeof event.data === "object" && "usage" in event.data,
        ),
      ).toBe(true);
      inspect(payload.arena);
    }
  });
});
