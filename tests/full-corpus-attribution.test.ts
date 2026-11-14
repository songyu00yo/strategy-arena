/** Synthetic full-document excerpts. No files, providers or factual price quotes are used. */
import { describe, expect, it } from "vitest";
import {
  ChallengeSchema,
  StrategySchema,
  type Revision,
  type StageInput,
  type Verdict,
} from "../src/lib/contracts";
import type { MaterialSource } from "../src/lib/intake-contracts";
import { freezeCorpus, retrieveCorpus } from "../src/lib/server/retrieval";
import {
  normalizeStrategyResources,
  proposedClaims,
  validateRevision,
  validateVerdict,
} from "../src/lib/server/tools";

const quote = "维修报价300元";
const source = (origin: MaterialSource["origin"], interpretation = false): MaterialSource => ({
  id: "S-full-document",
  attachmentId: "attachment",
  filename: "合成报价.txt",
  location: "完整正文",
  origin,
  interpretation,
  text: `${"附件中的普通说明。".repeat(1000)}\n${quote}`,
});
const route = () =>
  StrategySchema.parse({
    id: "A",
    title: "合成维修路线",
    thesis: "核实费用范围后决定",
    steps: ["先核实费用范围"],
    claims: [{ id: "A-claim-1", text: quote, status: "user", sourceIds: [] }],
    resources: "现有设备",
    firstAction: "核实报价适用条件",
    failureCondition: "范围未核实则停止",
    estimatedCost: null,
    estimatedHours: null,
    costPlan: {
      complete: false,
      items: [{ id: "repair", label: "维修报价", amount: 300, basis: "user", quote }],
    },
  });
const context = (): StageInput => ({
  challenge: ChallengeSchema.parse({
    goal: "比较合成维修路线及费用",
    materials: "附件预览仅显示前面的普通说明。",
    budget: 500,
  }),
  role: "A",
  strategies: [route(), { ...route(), id: "B" }],
  attacks: [],
  evidence: [],
  revisions: [],
  userChallenges: [],
});
const revision = (): Revision => ({
  strategyId: "A",
  strategy: route(),
  responses: [],
  summary: "保留文件原文报价并继续核实范围",
  changed: false,
});
const verdict = (): Verdict => ({
  outcome: "insufficient",
  preferred: null,
  headline: "尚需核实费用范围",
  rationale: "保留原文报价并继续核实",
  conditions: [],
  uncertainties: [],
  nextActions: ["核实费用范围"],
  exitCondition: "范围不明则停止",
  evidenceIds: [],
  attackFindings: [],
  comparisons: [
    { strategyId: "A", status: "unknown", reason: "原文中记录了这项报价", basis: "user", quote },
  ],
});
describe("literal attribution from the complete frozen document corpus", () => {
  it("accepts an explicit document quote omitted from the material preview across all validation entry points", () => {
    const input = context();
    expect(input.challenge.materials).not.toContain(quote);
    const corpus = freezeCorpus("version", input.challenge.materials, [source("document")]);
    expect(retrieveCorpus(corpus, "维修报价")[0].text).toBe(quote);
    const sources = corpus.sources;
    expect(
      normalizeStrategyResources(route(), input.challenge, sources).costPlan?.items[0],
    ).toMatchObject({ basis: "user", amount: 300, quote });
    expect(proposedClaims(route(), input.challenge, sources)[0].status).toBe("user");
    expect(validateRevision(revision(), input, sources).strategy.claims[0].status).toBe("user");
    expect(validateVerdict(verdict(), input, sources).comparisons[0].reason).toContain(quote);
  });
  it.each([
    { origin: "model_transcription" as const, interpretation: false },
    { origin: "model_interpretation" as const, interpretation: false },
    { origin: "document" as const, interpretation: true },
    { origin: undefined, interpretation: false },
  ])(
    "does not promote $origin with interpretation=$interpretation to a literal user fact",
    ({ origin, interpretation }) => {
      const input = context();
      const sources = [source(origin, interpretation)];
      expect(() => normalizeStrategyResources(route(), input.challenge, sources)).toThrow(
        "逐字引用",
      );
      expect(proposedClaims(route(), input.challenge, sources)[0].status).toBe("unknown");
      expect(() => validateRevision(revision(), input, sources)).toThrow("逐字引用");
      expect(() => validateVerdict(verdict(), input, sources)).toThrow("逐字引用");
    },
  );
});
