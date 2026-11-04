import { readFileSync } from "node:fs";
const protocol = JSON.parse(readFileSync("evals/protocol.json", "utf8"));
if (
  JSON.stringify(protocol.modes) !== JSON.stringify(["strong-single", "independent", "arena"]) ||
  Object.values(protocol.normalModelCallsPerCondition).reduce((sum, value) => sum + value, 0) !==
    10 ||
  protocol.maximumKnownFormatRepairsPerStep !== 1
)
  throw new Error(
    "Evaluation protocol modes, call schedule or repair policy changed; review the runner and tests together.",
  );
const suite = JSON.parse(readFileSync("evals/cases.json", "utf8"));
if (suite.cases.filter((item) => item.partition === "development").length !== 4)
  throw new Error("Expected four development cases.");
const holdout = suite.cases.filter((item) => item.partition === "holdout");
if (holdout.length !== 8) throw new Error("Expected eight holdout cases.");
for (const domain of ["learning", "life", "work", "creation"])
  if (holdout.filter((item) => item.initial.domain === domain).length !== 2)
    throw new Error(`Expected two holdout cases for ${domain}.`);
const ids = new Set();
for (const item of suite.cases) {
  if (ids.has(item.id)) throw new Error(`Duplicate case ${item.id}`);
  ids.add(item.id);
  if (
    !item.initial.goal ||
    !item.changed.goal ||
    !item.changeReason ||
    !item.positiveChecks.length ||
    !item.negativeChecks.length
  )
    throw new Error(`Incomplete case ${item.id}`);
  if (JSON.stringify(item.initial) === JSON.stringify(item.changed))
    throw new Error(`No condition change: ${item.id}`);
}
console.log(`Validated ${suite.cases.length} case definitions. No model evaluation was run.`);
