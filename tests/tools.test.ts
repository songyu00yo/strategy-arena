import { describe, expect, it } from "vitest";
import { calculate, chunkMaterials, searchMaterials, executeAttackTools } from "../src/lib/server/tools";
import type { Attack } from "../src/lib/contracts";

describe("deterministic arithmetic without code execution", () => {
  it("recomputes the retry assumption and preserves small-sample caveat", () => {
    expect(calculate("18 * 8 + 120")).toBe(264);
    expect(calculate("18 * ((2+3+4)/3) * 8 + 120")).toBe(552);
    expect(calculate("-(2+3) * 2 + .5")).toBe(-9.5);
  });
  it.each(["process.exit()", "1/0", "1 +", "2**3", "(1+2", "1 2", "1..2", "Math.random()", "Infinity", "2;3"])("rejects invalid/unsafe expression %s", value => expect(() => calculate(value)).toThrow());
});
describe("material retrieval provenance", () => {
  const materials = "预算上限三百元。\n三个合格镜头分别重试 2、3、4 次，每次八分钟。\n后期处理估计 120 分钟。";
  it("returns actual original slices with stable references", () => {
    const chunks = chunkMaterials(materials);
    for (const chunk of chunks) expect(materials.slice(chunk.start, chunk.end)).toBe(chunk.text);
    expect(searchMaterials(materials, "镜头重试次数")[0].text).toContain("2、3、4");
    expect(chunkMaterials(materials)).toEqual(chunks);
    expect(chunkMaterials(materials + "x")[0].id).not.toBe(chunks[0].id);
  });
  it("does not invent evidence when material is missing", () => {
    expect(searchMaterials(materials, "azxyquark")).toEqual([]);
    const attack = { id: "K1", requests: [{ tool: "search_materials", query: "重试" }, { tool: "calculate", expression: "18*3*8+120", assumptions: "仅使用 3 个样本平均值做情景估计" }] } as Attack;
    const evidence = executeAttackTools(attack, materials);
    expect(evidence[0].status).toBe("found");
    expect(evidence[1].result).toBe(552);
    expect(evidence[1].content).toContain("不能证明");
    expect(executeAttackTools(attack, "")[0].status).toBe("unavailable");
  });
});
