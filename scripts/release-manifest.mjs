import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { sourceIdentity } from "./build.mjs";
import { summarizePlaywright, VALIDATION_STEPS } from "./ci-validation-report.mjs";

const args = process.argv.slice(2);
const values = (key) => args.flatMap((arg, index) => (arg === key ? [args[index + 1]] : []));
const value = (key) => values(key)[0];
const kind = value("--kind");
const checksFile = value("--checks");
const receiptFile = value("--receipt");
const displayReceiptFile = value("--display-receipt");
const modelReceiptFile = value("--model-receipt");
const sourceManifestFile = value("--source-manifest");
const output = value("--output");
const artifacts = values("--artifact");
if (!["ci", "candidate", "deployed"].includes(kind) || !checksFile || !output || !artifacts.length)
  throw new Error(
    "Usage: node scripts/release-manifest.mjs --kind ci|candidate|deployed --checks checks.json --receipt ci-receipt.json --artifact file [--artifact file] --output manifest.json [--display-receipt file --model-receipt file] [--source-manifest file] [--deploy-url https://...]",
  );
if (!receiptFile) throw new Error("A manifest requires a machine-generated functional CI receipt.");
if (kind !== "ci" && (!displayReceiptFile || !modelReceiptFile))
  throw new Error("Candidate/deployed manifests require display and model acceptance receipts.");
const checks = JSON.parse(readFileSync(checksFile, "utf8"));
const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
const currentSource = sourceIdentity();
const { commit, workingTreeDirty } = currentSource;
if (workingTreeDirty)
  throw new Error("Commit or remove source changes before producing a validated manifest.");
for (const key of VALIDATION_STEPS) {
  if (
    checks[key] !== "passed" ||
    receipt.checks?.[key] !== "passed" ||
    receipt.steps?.[key]?.outcome !== "success" ||
    receipt.steps[key].status !== "passed"
  )
    throw new Error(`Missing successful validation evidence: ${key}`);
}
if (
  receipt.receiptVersion !== 1 ||
  receipt.sourceScope !== "full-repository" ||
  receipt.functionalReady !== true ||
  receipt.functional?.status !== "passed" ||
  receipt.functional.scope !== "functional-ci" ||
  receipt.sourceClean !== true ||
  !isDeepStrictEqual(receipt.source, currentSource) ||
  !isDeepStrictEqual(checks.source, receipt.source) ||
  !isDeepStrictEqual(checks.buildIdentity, receipt.build?.identity)
)
  throw new Error("Functional CI receipt, checks and current clean source differ.");
const ciBuild = receipt.build.identity;
const isFingerprint = (input) => typeof input === "string" && /^[a-f0-9]{64}$/.test(input);
if (
  ciBuild?.commit !== commit ||
  ciBuild.workingTreeDirty !== false ||
  ciBuild.sourceFingerprint !== currentSource.sourceFingerprint ||
  !isFingerprint(ciBuild.outputFingerprint) ||
  !ciBuild.platform ||
  !ciBuild.arch ||
  !ciBuild.node
)
  throw new Error("CI build and source identities differ or are incomplete.");
const deployUrl = value("--deploy-url") ?? null;
if (kind === "deployed" && !deployUrl)
  throw new Error("A deployed manifest requires a verified deployment URL.");
if (deployUrl && new URL(deployUrl).protocol !== "https:")
  throw new Error("Deployment URL must use HTTPS.");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashes = new Map();
const hash = (file) => {
  if (!hashes.has(file)) hashes.set(file, { path: file, sha256: digest(readFileSync(file)) });
  return hashes.get(file);
};
const reportEvidence = receipt.playwright?.report;
if (!reportEvidence || !isFingerprint(reportEvidence.sha256))
  throw new Error("CI receipt lacks the original Playwright JSON hash.");
const reportFile = artifacts.find((file) => hash(file).sha256 === reportEvidence.sha256);
if (!reportFile)
  throw new Error("The original Playwright JSON report is missing or its hash differs.");
const summary = summarizePlaywright(JSON.parse(readFileSync(reportFile, "utf8")));
if (
  receipt.playwright.outcome !== "success" ||
  summary.status !== "passed" ||
  summary.failed !== 0 ||
  summary.flaky !== 0 ||
  summary.skipped !== 0 ||
  summary.notRun !== 0 ||
  summary.errors !== 0 ||
  !summary.statsMatch ||
  !summary.caseStatusesMatch ||
  summary.testsDiscovered === 0 ||
  summary.testsDiscovered !== summary.casesExecuted ||
  !isDeepStrictEqual(summary, receipt.playwright.summary) ||
  !isDeepStrictEqual(checks.playwright, summary) ||
  !isDeepStrictEqual(checks.playwrightReport, reportEvidence)
)
  throw new Error("E2E report is incomplete, inconsistent or contains unstable tests.");
const archives = artifacts.filter((file) => file.endsWith(".tar.gz"));
if (archives.length !== 1) throw new Error("Exactly one standalone .tar.gz artifact is required.");
const releaseInfo = JSON.parse(
  execFileSync("tar", ["-xOf", archives[0], "./release-info.json"], { encoding: "utf8" }),
);
if (
  releaseInfo.commit !== commit ||
  releaseInfo.workingTreeDirty !== false ||
  !isFingerprint(releaseInfo.sourceFingerprint) ||
  !isFingerprint(releaseInfo.outputFingerprint) ||
  !releaseInfo.platform ||
  !releaseInfo.arch ||
  !releaseInfo.node
)
  throw new Error("Archive source/platform metadata is missing or differs from this clean commit.");
let archiveScope = "full-repository-build";
let selectionProof = null;
if (releaseInfo.sourceSelection) {
  archiveScope = "git-commit-application-selection-build";
  if (!sourceManifestFile)
    throw new Error("An application-selection archive requires its original source manifest.");
  const source = JSON.parse(readFileSync(sourceManifestFile, "utf8"));
  const selection = source.selection;
  if (
    source.commit !== commit ||
    source.workingTreeDirty !== false ||
    source.exportedSnapshotClean !== true ||
    source.sourceFingerprint !== releaseInfo.sourceFingerprint ||
    !isDeepStrictEqual(selection, releaseInfo.sourceSelection) ||
    !Array.isArray(selection?.completeRoots) ||
    !selection.completeRoots.length ||
    !Array.isArray(selection.explicitFiles) ||
    !Array.isArray(source.files)
  )
    throw new Error("Application source manifest differs from the archive identity or selection.");
  const paths = [...selection.completeRoots, ...selection.explicitFiles];
  if (
    paths.some(
      (path) =>
        typeof path !== "string" ||
        !path ||
        isAbsolute(path) ||
        path.split("/").some((part) => ["..", ".git"].includes(part) || part.startsWith(".env")),
    )
  )
    throw new Error("Unsafe application source selection.");
  const entries = execFileSync(
    "git",
    ["ls-tree", "-r", "-z", "--full-tree", commit, "--", ...paths],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const files = entries
    .map((entry) => {
      const separator = entry.indexOf("\t");
      const [mode, type, object] = entry.slice(0, separator).split(" ");
      if (type !== "blob" || !["100644", "100755"].includes(mode))
        throw new Error("Unsupported Git application source entry.");
      return {
        path: entry.slice(separator + 1),
        sha256: digest(execFileSync("git", ["cat-file", "blob", object])),
        executable: mode === "100755",
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (
    !files.length ||
    !isDeepStrictEqual(files, source.files) ||
    digest(JSON.stringify(files)) !== source.sourceFingerprint
  )
    throw new Error("Application source hashes differ from the exact committed Git objects.");
  selectionProof = {
    evidence: hash(sourceManifestFile),
    filesVerified: files.length,
    commit,
    scope: "git-commit-application-selection",
  };
} else if (releaseInfo.sourceFingerprint !== currentSource.sourceFingerprint) {
  throw new Error("Archive and full-repository source fingerprints differ.");
}
if (
  kind === "ci" &&
  (archiveScope !== "full-repository-build" ||
    releaseInfo.outputFingerprint !== ciBuild.outputFingerprint)
)
  throw new Error("CI receipt and packaged CI build output identities differ.");
function acceptance(file, name) {
  if (!file) return { status: "not_run" };
  const accepted = JSON.parse(readFileSync(file, "utf8"));
  if (
    accepted.status !== "passed" ||
    accepted.source?.commit !== commit ||
    accepted.source.workingTreeDirty !== false
  )
    throw new Error(`${name} acceptance is missing or belongs to another clean commit.`);
  if (
    name === "Model" &&
    (accepted.humanAcceptance !== "not_claimed" ||
      accepted.publicCasePublished !== false ||
      accepted.simulationOnly !== true)
  )
    throw new Error("Model acceptance must identify unpublished technical simulation evidence.");
  return hash(file);
}
const displayAcceptance = acceptance(displayReceiptFile, "Physical display");
const modelAcceptance = acceptance(modelReceiptFile, "Model");
const model = JSON.parse(readFileSync("config/model.json", "utf8"));
const manifest = {
  manifestVersion: 1,
  kind,
  commit,
  workingTreeDirty,
  createdAt: new Date().toISOString(),
  version: JSON.parse(readFileSync("package.json", "utf8")).version,
  runtime: {
    node: releaseInfo.node,
    packageManager: releaseInfo.packageManager,
    platform: releaseInfo.platform,
    arch: releaseInfo.arch,
  },
  archiveSource: { commit: releaseInfo.commit, workingTreeDirty: releaseInfo.workingTreeDirty },
  buildIdentities: {
    ci: { scope: "full-repository-ci-build", source: receipt.source, identity: ciBuild },
    archive: {
      scope: archiveScope,
      commit,
      sourceFingerprint: releaseInfo.sourceFingerprint,
      outputFingerprint: releaseInfo.outputFingerprint,
      sourceSelectionProof: selectionProof,
    },
  },
  manifestProducer: { node: process.version, platform: process.platform, arch: process.arch },
  modelDefaults: model,
  modelConfigurationScope:
    "Repository defaults only. Verify production runtime overrides and provider-returned model identities separately.",
  modelIdentityNote:
    "The provider model alias may change upstream; it is not an immutable model snapshot.",
  configurations: ["config/model.json", "pnpm-lock.yaml"].map(hash),
  validation: {
    checks,
    evidence: hash(checksFile),
    receipt: hash(receiptFile),
    functional: { status: "passed", scope: "functional-ci" },
    playwright: receipt.playwright,
    displayAcceptance,
    modelAcceptance,
  },
  releaseReady: kind !== "ci",
  artifacts: artifacts.map(hash),
  deploymentUrl: deployUrl,
  limitations:
    "CI covers functional and native-motion checks. Display and model acceptance are independently scoped receipts. A candidate manifest does not prove deployment. Hashes bind files to recorded identities and outcomes.",
};
mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Manifest written: ${resolve(output)}`);
