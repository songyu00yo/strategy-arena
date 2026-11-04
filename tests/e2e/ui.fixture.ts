// Explicit synthetic UI fixture. These are not model outputs or evaluation results.
import type { ArenaSnapshot, ArenaVersion, Challenge, Stage, Strategy } from "../../src/lib/contracts";
export const fixtureChallenge: Challenge = { goal: "测试任务：在七天内完成一支知识视频并比较可执行路线。", constraints: "只有一人执行，不购买新设备。", preferences: "优先准确。", options: [], materials: "测试材料：每天可投入 1 小时，音乐预算最多 50 元。", domain: "creation", budget: 300, timeHours: 7 };
const date = "2026-11-04T00:00:00.000Z";
const stages: Stage[] = ["propose", "attack", "verify", "revise", "judge"];
const strategies: Strategy[] = (["A", "B", "C"] as const).map((id, index) => ({ id, title: `测试路线 ${id}`, thesis: "UI fixture：先制作最小样片，再根据核验结果修订。", steps: ["先写大纲", "制作样片并检查"], claims: [{ id: `${id}-claim`, text: `测试判断 ${id}：预计需要 ${index + 4} 小时。`, status: "estimate", sourceIds: [] }], resources: "自有设备；所有数字均为测试数据。", firstAction: "写一份测试大纲。", failureCondition: "投入超过可用时间时暂停。", estimatedCost: 50, estimatedHours: index + 4 }));
export function fixtureVersion(number = 1, challenge: Challenge = fixtureChallenge): ArenaVersion {
  return { id: `fixture-version-${number}`, number, challenge, status: "ready", stage: "propose", strategies: [], attacks: [], evidence: [], revisions: [], verdict: null, costCny: 0, reservedCny: 0, createdAt: date, changeReason: number > 1 ? "测试条件改变" : "", parentVersionId: number > 1 ? `fixture-version-${number - 1}` : null, error: null };
}
export function fixtureSnapshot(): ArenaSnapshot { return { id: "fixture-arena", activeVersionId: "fixture-version-1", createdAt: date, versions: [fixtureVersion()], steps: [], events: [], model: { id: "fixture-not-a-model", configured: true, promptVersion: "test-fixture", schemaVersion: "1.0.0" } }; }
export function advanceFixture(snapshot: ArenaSnapshot) {
  const version = snapshot.versions.find(item => item.id === snapshot.activeVersionId)!;
  const stage = version.stage;
  if (stage === "propose") version.strategies = structuredClone(strategies);
  if (stage === "attack") version.attacks = [{ id: "attack-fixture", from: "B", targetStrategyId: "A", targetClaimId: "A-claim", claimQuote: strategies[0].claims[0].text, reason: "测试质疑：尚未核算总投入。", impact: "可能超过可用时间。", verification: "把准备和制作时间相加。", requests: [{ tool: "calculate", expression: "2+3", assumptions: "测试假设：准备 2 小时，制作 3 小时。" }], status: "pending" }];
  if (stage === "verify") { version.evidence = [{ id: "evidence-fixture", attackId: "attack-fixture", tool: "calculate", status: "calculated", title: "测试计算证据", content: "2 + 3 = 5 小时；这是合成测试证据。", source: "fixture calculator", sourceIds: [], expression: "2+3", result: 5, assumptions: "测试假设：准备 2 小时，制作 3 小时。", createdAt: date }]; version.attacks[0].status = "supported"; }
  if (stage === "revise") version.revisions = strategies.map(strategy => ({ strategyId: strategy.id, strategy: { ...structuredClone(strategy), firstAction: "修订后先写最小样片大纲。" }, responses: strategy.id === "A" ? [{ attackId: "attack-fixture", decision: "accept", reason: "依据测试计算补充准备时间。", evidenceIds: ["evidence-fixture"], change: "把总时长修订为 5 小时。" }] : [], summary: "这是测试修订记录。", changed: strategy.id === "A" }));
  if (stage === "judge") { version.status = "completed"; version.verdict = { outcome: "recommendation", preferred: "A", headline: "测试裁决：先做最小样片", rationale: "此结论仅用于界面测试。", conditions: ["总投入不超过可用时间。"], uncertainties: ["真实制作速度待验证。"], nextActions: ["完成测试大纲。"], exitCondition: "样片超时则缩减范围。", evidenceIds: ["evidence-fixture"], comparisons: strategies.map(strategy => ({ strategyId: strategy.id, status: "eligible", reason: "测试比较结果。" })), attackFindings: [{ attackId: "attack-fixture", status: "supported", reason: "测试计算支持修订。", evidenceIds: ["evidence-fixture"] }] }; }
  else version.stage = stages[stages.indexOf(stage) + 1];
  version.costCny += 0.001;
  snapshot.steps.push({ id: `${version.id}-${stage}`, versionId: version.id, stage, role: "fixture", status: "completed", error: null, startedAt: date, finishedAt: date });
  snapshot.events.push({ seq: snapshot.events.length + 1, arenaId: snapshot.id, versionId: version.id, type: "stage_completed", stage, actor: "fixture", message: `测试事件：${stage} 完成`, data: null, createdAt: date });
}
