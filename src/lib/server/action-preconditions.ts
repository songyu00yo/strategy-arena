import type { Strategy } from "../contracts";

const trial = /试用|试骑|试驾|试运行/g;
const check = /检查|检测|检验|复检|验收|评估|判断|结论/;
const professional = /专业|独立|第三方|技师|工程师|维修方|检测机构|检验机构/;
const optional = /可选|非必需|并非必需|不是必需|仅供参考|仅作建议|只是建议|如有需要|必要时可/;

function ownText(text: string): string {
  return text
    .replace(/^\s*>.*$/gm, (quote) => " ".repeat(quote.length))
    .replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'|`[^`]*`/g, (quote) =>
      " ".repeat(quote.length),
    );
}

function discussed(text: string): boolean {
  return /原文|引用|示例|错误句|讨论|解释|是否存在|是否合理|这一说法|这种说法/.test(text);
}

function professionalCheck(text: string): boolean {
  return professional.test(text) && check.test(text) && !optional.test(text);
}

function passedCheck(text: string): boolean {
  return (
    professionalCheck(text) &&
    /通过|合格|达标|获准|(?:取得|拿到|获得|已有|已获)[^。；;]{0,60}结论|(?:检查|检测|检验|复检|验收|评估)(?:已)?完成/.test(
      text,
    ) &&
    !/是否|能否|询问|未通过|没通过|不通过|不合格|未合格|未达标|不达标|尚未|待取得|未取得/.test(text)
  );
}

/** Bounded contradictions in the route's own declared check dependency and ordered
 * steps only. A non-substitution statement alone does not establish a universal
 * safety prerequisite. This does not verify real safety or infer omitted checks. */
export function assertDeclaredCheckOrder(strategy: Strategy): void {
  const fields = [
    strategy.thesis,
    strategy.resources,
    strategy.firstAction,
    strategy.failureCondition,
    ...strategy.claims.map((claim) => claim.text),
    ...strategy.steps,
  ].map(ownText);
  const declarations = fields
    .flatMap((field) => field.split(/[。；;\n]/))
    .filter((sentence) => {
      if (discussed(sentence) || optional.test(sentence)) return false;
      const separator = sentence.search(
        /不能(?:够)?(?:替代|代替)|无法(?:替代|代替)|不可(?:替代|代替)/,
      );
      if (separator < 0) return false;
      const before = sentence.slice(0, separator);
      return (
        /自检|自行|本人|静态检查|静态查验|静态观察|试用|试骑|试驾|试运行/.test(before) &&
        !/并非|不是|不应声称|不能声称/.test(before) &&
        professionalCheck(sentence.slice(separator))
      );
    });
  if (!declarations.length) return;

  const steps = strategy.steps.map(ownText);
  const safetyContext = fields.some((field) => /安全/.test(field));
  let passed = false;
  let arrangedProfessionalCheck = false;
  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const step = steps[stepIndex];
    for (const match of step.matchAll(trial)) {
      const prefix = step.slice(0, match.index);
      const clausePrefix = prefix.split(/[，,。；;\n]/).at(-1) ?? "";
      const suffix = step.slice(match.index! + match[0].length).split(/[，,。；;\n]/)[0];
      if (
        discussed(step) ||
        /[?？]|是否|能否/.test(clausePrefix + suffix) ||
        /不|未|没|禁止|暂停|停止|避免|取消|预约|联系|询问|计划外|若要|如果要/.test(clausePrefix) ||
        /^(?:不得|禁止|暂停|取消|尚未|未曾|没有|不|未|并未)(?:进行|开始|执行|发生|完成)?/.test(
          suffix,
        )
      )
        continue;

      const explicitGate = fields.some((field) =>
        field
          .split(/[。；;\n]/)
          .some(
            (sentence) =>
              professionalCheck(sentence) &&
              new RegExp(
                `(?:通过|合格|达标)[^。；;]{0,16}(?:后|才|方可)[^。；;]{0,8}${match[0]}`,
              ).test(sentence),
          ),
      );
      const isolated = /隔离|沙箱|仿真|模拟|测试环境/.test(step);
      const physical =
        /试骑|试驾/.test(match[0]) || /设备|机器|装置|机械|电器|车辆|工具/.test(step);
      const safetyTrial = /安全|刹车|制动|急停|绝缘|防护/.test(clausePrefix + match[0] + suffix);
      // Physical safety screening and an explicit declared trial gate are the only
      // supported contexts. Software/test-environment trials do not imply such a gate.
      if (!explicitGate && (!safetyContext || isolated || !physical || !safetyTrial)) continue;
      const localCheckGate =
        /(?:检查|检测|检验|复检|验收|结论)[^，,。；;]{0,16}(?:通过|合格|达标)[^，,。；;]{0,8}(?:后|才|方可)/.test(
          clausePrefix,
        );
      if (passed || passedCheck(prefix) || (arrangedProfessionalCheck && localCheckGate)) continue;

      const remaining = [step.slice(match.index! + match[0].length), ...steps.slice(stepIndex + 1)];
      const laterCheck = remaining.some((text) =>
        text
          .split(/[。；;\n]/)
          .some(
            (sentence) =>
              professionalCheck(sentence) &&
              !discussed(sentence) &&
              !/(?:无需|不需要|不必|取消|不做|不进行)[^，,。；;]{0,12}(?:专业|独立|第三方|检查|检测)/.test(
                sentence,
              ),
          ),
      );
      if (laterCheck) {
        throw new Error(
          `声明的检查顺序矛盾：步骤${stepIndex + 1}先${match[0]}，后续步骤仍在核实或取得专业/独立检查结论，但本方案明确声明自检或试用不能替代该结论。请先取得所声明的必要通过结论，再安排相关试用；不要用静态观察或试用补证该前提。`,
        );
      }
    }
    if (passedCheck(step)) passed = true;
    if (
      professionalCheck(step) &&
      /先由|安排|进行|取得|完成|出具/.test(step) &&
      !/询问|报价|费用|是否|能否|标准/.test(step)
    )
      arrangedProfessionalCheck = true;
  }
}
