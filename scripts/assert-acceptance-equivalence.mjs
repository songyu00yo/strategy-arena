import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const schemas = [
  "src/lib/clarification-contracts.ts",
  "src/lib/intake-contracts.ts",
  "src/lib/contracts.ts",
  "src/lib/server/strict-schema.ts",
];
const dependencies = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];
const configuration = [...dependencies, "next.config.ts", "tsconfig.json", "postcss.config.mjs"];
const application = [
  "src",
  "prompts",
  "config",
  "migrations",
  "public",
  ...configuration,
  "scripts/build.mjs",
  "scripts/package-release.mjs",
  "scripts/release-safety.mjs",
  "scripts/export-clarification-case.mjs",
];
const pipeline = ["src/lib", "src/app/api", "prompts", "config", "migrations", ...configuration];
const formatterPath = "src/lib/server/clarification.ts";
const fingerprintFields = [
  "protocolHash",
  "schemaFingerprint",
  "dependencyFingerprint",
  "modelPipelineFingerprint",
];
const fingerprint = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const commitId = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const git = (directory, ...args) =>
  execFileSync("git", args, { cwd: directory, stdio: ["pipe", "pipe", "pipe"] });

/** Derive component identities from committed bytes, excluding only the named report formatter. */
export function modelEvidenceComponents(commit, { directory = process.cwd() } = {}) {
  assert(commitId(commit), "A full model-runtime commit is required.");
  assert.equal(git(directory, "rev-parse", `${commit}^{commit}`).toString().trim(), commit);
  const bytes = new Map();
  const filesFor = (paths, omitFormatter = false) =>
    git(directory, "ls-tree", "-r", "-z", "--full-tree", commit, "--", ...paths)
      .toString()
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf("\t");
        const [mode, type, blob] = entry.slice(0, separator).split(" ");
        const path = entry.slice(separator + 1);
        assert(
          type === "blob" && ["100644", "100755"].includes(mode),
          "Unsupported committed model component.",
        );
        if (!bytes.has(path)) bytes.set(path, git(directory, "cat-file", "blob", blob));
        let contents = bytes.get(path);
        if (omitFormatter && path === formatterPath) {
          const text = contents.toString();
          const source = ts.createSourceFile(
            path,
            text,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
          );
          const functions = source.statements.filter(
            (node) => ts.isFunctionDeclaration(node) && node.name?.text === "formatClarification",
          );
          assert.equal(
            functions.length,
            1,
            "The report formatter must have a single AST function range.",
          );
          contents = Buffer.from(
            text.slice(0, functions[0].getStart(source)) +
              "/* separately validated report formatter */" +
              text.slice(functions[0].end),
          );
        }
        return { path, sha256: digest(contents), executable: mode === "100755" };
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const applicationFiles = filesFor(application);
  const schemaFiles = filesFor(schemas);
  const dependencyFiles = filesFor(dependencies);
  assert.equal(schemaFiles.length, schemas.length, "Model schema component files are missing.");
  assert.equal(
    dependencyFiles.length,
    dependencies.length,
    "Runtime dependency component files are missing.",
  );
  const prompt = bytes.get("prompts/clarification.ts")?.toString();
  assert(prompt, "Clarification prompts are missing.");
  const source = ts.createSourceFile(
    "prompts/clarification.ts",
    prompt,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  function literal(node) {
    if (ts.isAsExpression(node)) return literal(node.expression);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    assert(
      ts.isObjectLiteralExpression(node),
      "Protocol declarations must remain static literals.",
    );
    return Object.fromEntries(
      node.properties.map((property) => {
        assert(ts.isPropertyAssignment(property), "Unsupported protocol property.");
        return [property.name.text, literal(property.initializer)];
      }),
    );
  }
  const declarations = new Map(
    source.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) =>
        statement.declarationList.declarations.map((declaration) => [
          declaration.name.getText(source),
          declaration.initializer,
        ]),
      ),
  );
  const promptProtocol = {
    protocol: literal(declarations.get("CLARIFICATION_PROTOCOL")),
    system: literal(declarations.get("CLARIFICATION_SYSTEM")),
    roles: literal(declarations.get("CLARIFICATION_ROLES")),
  };
  const runtimeSource = ts.createSourceFile(
    formatterPath,
    bytes.get(formatterPath)?.toString() ?? "",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const hashFunction = runtimeSource.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "clarificationProtocolHash",
  );
  let hashVersion;
  const inspectHashVersion = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(runtimeSource) === "version" &&
      ts.isStringLiteral(node.initializer) &&
      node.initializer.text.startsWith("clarification-schema-")
    )
      hashVersion = node.initializer.text;
    ts.forEachChild(node, inspectHashVersion);
  };
  if (hashFunction) inspectHashVersion(hashFunction);
  let protocol = promptProtocol;
  if (hashVersion) {
    assert.equal(hashVersion, "clarification-schema-2", "Unsupported protocol hash version.");
    // Evaluate only the committed, pure schema modules. Runtime, database and environment
    // modules are unavailable to this loader, including through relative imports.
    const allowedModules = new Set([
      "src/lib/clarification-contracts.ts",
      "src/lib/intake-contracts.ts",
      "src/lib/contracts.ts",
      "src/lib/answer-options.ts",
      "src/lib/model-catalog.ts",
    ]);
    const loaded = new Map();
    const loadSchema = (path) => {
      assert(allowedModules.has(path), `Unsupported schema dependency: ${path}`);
      if (loaded.has(path)) return loaded.get(path).exports;
      const contents = bytes.get(path);
      assert(contents, `Committed schema dependency is missing: ${path}`);
      const schemaModule = { exports: {} };
      loaded.set(path, schemaModule);
      const compiled = ts.transpileModule(contents.toString(), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      runInNewContext(
        compiled,
        {
          module: schemaModule,
          exports: schemaModule.exports,
          require(specifier) {
            if (specifier === "zod") return { z };
            assert(specifier.startsWith("."), "Only relative schema imports are supported.");
            return loadSchema(posix.join(posix.dirname(path), specifier) + ".ts");
          },
        },
        { filename: path, timeout: 1000 },
      );
      return schemaModule.exports;
    };
    const schema = loadSchema("src/lib/clarification-contracts.ts");
    protocol = {
      version: hashVersion,
      ...promptProtocol,
      schemas: {
        decomposition: z.toJSONSchema(schema.DecompositionSchema),
        options: z.toJSONSchema(schema.OptionReviewSchema),
        handoff: z.toJSONSchema(schema.HandoffReviewSchema),
      },
    };
  }
  return {
    commit,
    applicationSelectionFingerprint: digest(JSON.stringify(applicationFiles)),
    protocolHash: digest(JSON.stringify(protocol)),
    schemaFingerprint: digest(JSON.stringify(schemaFiles)),
    dependencyFingerprint: digest(JSON.stringify(dependencyFiles)),
    modelPipelineFingerprint: digest(JSON.stringify(filesFor(pipeline, true))),
  };
}

/** The model-input scope deliberately makes no claim that changed UI/report bytes are equivalent. */
export function assertModelEvidenceEquivalent(
  previous,
  current,
  { scope = "whole-application" } = {},
) {
  assert.equal(previous.status, "passed");
  assert.equal(previous.humanAcceptance, "not_claimed");
  assert.equal(previous.workingTreeDirty, false);
  assert.equal(current.workingTreeDirty, false);
  for (const key of fingerprintFields) {
    assert(fingerprint(previous[key]) && fingerprint(current[key]), `${key} is missing.`);
    assert.equal(previous[key], current[key], `${key} changed.`);
  }
  const wholeApplicationEquivalent =
    previous.applicationSelectionFingerprint === current.applicationSelectionFingerprint;
  assert(
    fingerprint(previous.applicationSelectionFingerprint) &&
      fingerprint(current.applicationSelectionFingerprint),
  );
  assert(["whole-application", "model-inputs"].includes(scope));
  if (scope === "whole-application")
    assert(wholeApplicationEquivalent, "Application selection changed.");
  return {
    scope,
    wholeApplicationEquivalent,
    testedRuntimeCommit: previous.commit,
    finalSourceCommit: current.commit,
    previousApplicationSelectionFingerprint: previous.applicationSelectionFingerprint,
    finalApplicationSelectionFingerprint: current.applicationSelectionFingerprint,
  };
}

export function verifyModelAcceptanceLineage(
  receipt,
  { directory = process.cwd(), finalCommit } = {},
) {
  assert(
    commitId(finalCommit) &&
      receipt.source?.commit === finalCommit &&
      receipt.source.workingTreeDirty === false,
  );
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.humanAcceptance, "not_claimed");
  assert.equal(receipt.simulationOnly, true);
  assert.equal(receipt.publicCasePublished, false);
  const identities = new Map();
  const identity = (commit) => {
    if (!identities.has(commit))
      identities.set(commit, modelEvidenceComponents(commit, { directory }));
    return identities.get(commit);
  };
  const evidence = (entry) => {
    assert(
      entry &&
        typeof entry.path === "string" &&
        entry.path.endsWith(".json") &&
        fingerprint(entry.sha256),
      "JSON lineage evidence is missing.",
    );
    const bytes = readFileSync(resolve(directory, entry.path));
    assert.equal(digest(bytes), entry.sha256, "Model lineage evidence hash changed.");
    return JSON.parse(bytes);
  };
  const ids = ["negative-conflict", "paper-story-circle", "reading-club"];
  assert(
    Array.isArray(receipt.scenarios) && receipt.scenarios.length === ids.length,
    "All three model scenarios are required.",
  );
  assert.deepEqual(receipt.scenarios.map((scenario) => scenario.id).sort(), [...ids].sort());
  const current = identity(finalCommit);
  return receipt.scenarios.map((scenario) => {
    assert.equal(scenario.status, "passed");
    const raw = scenario.rawModelCalls;
    assert(raw && commitId(raw.testedRuntimeCommit), "Original model-runtime identity is missing.");
    git(directory, "merge-base", "--is-ancestor", raw.testedRuntimeCommit, finalCommit);
    const previous = identity(raw.testedRuntimeCommit);
    for (const key of ["protocolHash", "schemaFingerprint", "dependencyFingerprint"])
      assert.equal(
        raw[key],
        previous[key],
        `Recorded ${key} does not match committed model components.`,
      );
    const original = evidence(raw.evidence);
    if (original.source?.commit !== undefined)
      assert.equal(original.source.commit, raw.testedRuntimeCommit);
    if (original.expectedSha !== undefined)
      assert.equal(original.expectedSha, raw.testedRuntimeCommit);
    if (original.source?.workingTreeDirty !== undefined)
      assert.equal(original.source.workingTreeDirty, false);
    if (original.healthVerified?.sourceDirty !== undefined)
      assert.equal(original.healthVerified.sourceDirty, false);
    if (original.promptHashes !== undefined)
      assert.deepEqual(original.promptHashes, [raw.protocolHash]);
    const proof = assertModelEvidenceEquivalent(
      {
        ...previous,
        status: scenario.status,
        workingTreeDirty: false,
        humanAcceptance: receipt.humanAcceptance,
      },
      { ...current, workingTreeDirty: false },
      { scope: "model-inputs" },
    );
    const historical = raw.testedRuntimeCommit !== finalCommit;
    if (scenario.id === "reading-club" && historical)
      assert(
        proof.wholeApplicationEquivalent,
        "Changed application requires a fresh reading-club validation.",
      );
    let kind = historical ? "historical-model-inputs" : "fresh-model-calls";
    if (scenario.id === "paper-story-circle" && historical && !proof.wholeApplicationEquivalent) {
      const formatting = scenario.reportFormatting;
      assert(
        formatting?.source?.commit === finalCommit && formatting.source.workingTreeDirty === false,
        "Paper report formatting must be validated on the final clean commit.",
      );
      const formatted = evidence(formatting.evidence);
      assert.equal(formatted.source?.commit, formatting.source.commit);
      assert.equal(formatted.source?.workingTreeDirty, false);
      for (const key of [
        "inputDraftSha256",
        "originalCReviewSha256",
        "reportSha256",
        "executionPromptSha256",
      ]) {
        assert(fingerprint(formatting[key]), `Report formatting ${key} is missing.`);
        assert.equal(
          formatted[key],
          formatting[key],
          `Report formatting ${key} differs from its proof.`,
        );
      }
      for (const entry of [formatting, formatted]) {
        assert.equal(entry.validation?.status, "passed");
        assert.equal(entry.validation.rawRunsAndUsageUnchanged, true);
        assert.equal(entry.validation.unknownResourcesPreserved, true);
      }
      kind = "historical-model-inputs-with-final-report-formatting";
    }
    return {
      id: scenario.id,
      kind,
      ...proof,
      protocolHash: current.protocolHash,
      schemaFingerprint: current.schemaFingerprint,
      dependencyFingerprint: current.dependencyFingerprint,
      modelPipelineFingerprint: current.modelPipelineFingerprint,
      rawEvidence: raw.evidence,
      reportFormattingEvidence: scenario.reportFormatting?.evidence ?? null,
    };
  });
}
