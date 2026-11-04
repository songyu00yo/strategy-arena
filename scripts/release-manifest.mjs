import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const values = (key) => args.flatMap((arg, index) => arg === key ? [args[index + 1]] : []);
const value = (key) => values(key)[0];
const kind = value("--kind");
const checksFile = value("--checks");
const output = value("--output");
const artifacts = values("--artifact");
if (!["ci", "candidate", "deployed"].includes(kind) || !checksFile || !output || artifacts.length === 0) {
  throw new Error("Usage: node scripts/release-manifest.mjs --kind ci|candidate|deployed --checks checks.json --artifact file [--artifact file] --output manifest.json [--deploy-url https://...]");
}
const checks = JSON.parse(readFileSync(checksFile, "utf8"));
for (const key of ["typecheck", "lint", "unit", "build", "e2e"]) {
  if (checks[key] !== "passed") throw new Error(`Missing successful validation evidence: ${key}`);
}
const deployUrl = value("--deploy-url") ?? null;
if (kind === "deployed" && !deployUrl) throw new Error("A deployed manifest requires a verified deployment URL.");
if (deployUrl && new URL(deployUrl).protocol !== "https:") throw new Error("Deployment URL must use HTTPS.");
const hash = (file) => ({ path: file, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") });
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const workingTreeDirty = Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim());
if (kind !== "ci" && workingTreeDirty) throw new Error("Commit or remove working tree changes before producing a release candidate.");
const model = JSON.parse(readFileSync("config/model.json", "utf8"));
const manifest = {
  manifestVersion: 1, kind, commit, workingTreeDirty, createdAt: new Date().toISOString(),
  version: JSON.parse(readFileSync("package.json", "utf8")).version,
  runtime: { node: process.version, packageManager: JSON.parse(readFileSync("package.json", "utf8")).packageManager },
  modelDefaults: model, modelConfigurationScope: "Repository defaults only. Verify production runtime overrides and provider-returned model identities separately.", modelIdentityNote: "The provider model alias may change upstream; it is not an immutable model snapshot.",
  configurations: ["config/model.json", "pnpm-lock.yaml"].map(hash),
  validation: { checks, evidence: hash(checksFile) }, artifacts: artifacts.map(hash), deploymentUrl: deployUrl,
  limitations: "A CI/candidate manifest does not prove deployment, live model quality, or P1 completion. Hashes bind files; they do not certify the truth of manually supplied checks.",
};
mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Manifest written: ${resolve(output)}`);
