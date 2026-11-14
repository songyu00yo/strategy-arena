import { describe, expect, it } from "vitest";
import {
  decodeChoiceValue,
  encodeOtherValue,
  hasCompleteChoiceAnswer,
  isOtherOption,
  MAX_ANSWER_LENGTH,
  validateChoiceAnswer,
} from "@/lib/answer-options";
import { AnswerSchema } from "@/lib/intake-contracts";

const other = "其他（请补充）";
const options = ["方案 A", "方案 B", other];

describe("choice answer contract", () => {
  it.each([
    "其他",
    "其他（请补充）",
    "其他(请说明)",
    "其他（请描述）",
    "其他，下一步由我描述",
    "其他,下一步由我来描述",
    "Other",
    "OTHER (please specify)",
    "Ｏｔｈｅｒ （please describe）",
  ])("recognizes the complete legacy Other label %j", (label) => {
    expect(isOtherOption(label)).toBe(true);
    expect(hasCompleteChoiceAnswer("single", [label], label)).toBe(false);
    expect(validateChoiceAnswer("single", [label], label, true)).toBe(true);
    expect(hasCompleteChoiceAnswer("single", [label], `${label}:完整说明`)).toBe(true);
    expect(hasCompleteChoiceAnswer("single", [label], `${label}：完整说明`)).toBe(true);
  });

  it("matches regular options exactly and binds detail only to the actual Other label", () => {
    expect(decodeChoiceValue("方案 A", options)).toEqual({ option: "方案 A", detail: null });
    expect(decodeChoiceValue("方案 A：伪造文本", options)).toBeNull();
    expect(decodeChoiceValue("其他：未提供的标签", options)).toBeNull();
    expect(decodeChoiceValue(`${other}：局域网同步`, options)).toEqual({
      option: other,
      detail: "局域网同步",
    });
    expect(isOtherOption("其他费用")).toBe(false);
    expect(isOtherOption("其他同学")).toBe(false);
    expect(isOtherOption("Others")).toBe(false);
    for (const ordinary of ["其他材料", "其他支付渠道", "其他场地", "其他人员", "其他方案 A"]) {
      expect(isOtherOption(ordinary)).toBe(false);
      expect(hasCompleteChoiceAnswer("single", [ordinary], ordinary)).toBe(true);
      expect(hasCompleteChoiceAnswer("single", [ordinary], `${ordinary}：伪造补充`)).toBe(false);
    }
  });

  it.each([other, `${other}：`, `${other}： \n\t`])(
    "retains incomplete Other %j in drafts and requires detail for confirmation",
    (value) => {
      expect(validateChoiceAnswer("single", options, value, true)).toBe(true);
      expect(hasCompleteChoiceAnswer("single", options, value)).toBe(false);
      expect(validateChoiceAnswer("multiple", options, ["方案 A", value], true)).toBe(true);
      expect(hasCompleteChoiceAnswer("multiple", options, ["方案 A", value])).toBe(false);
    },
  );

  it("preserves spaces and newlines in a complete Other answer", () => {
    const detail = "local network \n offline mode ";
    const encoded = encodeOtherValue(other, detail);
    expect(decodeChoiceValue(encoded, options)?.detail).toBe(detail);
    expect(hasCompleteChoiceAnswer("multiple", options, ["方案 A", "方案 B", encoded])).toBe(true);
    expect(() => encodeOtherValue("方案 A", detail)).toThrow();
  });

  it("requires the answer representation to match the question type", () => {
    expect(validateChoiceAnswer("single", options, ["方案 A"], true)).toBe(false);
    expect(validateChoiceAnswer("multiple", options, "方案 A", true)).toBe(false);
    expect(validateChoiceAnswer("multiple", options, [], true)).toBe(false);
    expect(validateChoiceAnswer("single", options, "不存在", true)).toBe(false);
  });

  it("rejects duplicate options and multiple encodings of the same Other selection", () => {
    expect(validateChoiceAnswer("multiple", options, ["方案 A", "方案 A"], true)).toBe(false);
    expect(validateChoiceAnswer("multiple", options, [other, `${other}：详情`], true)).toBe(false);
    expect(validateChoiceAnswer("multiple", options, [`${other}：一`, `${other}：二`], false)).toBe(
      false,
    );
    expect(
      validateChoiceAnswer("multiple", [other, "Other"], [`${other}：一`, "Other：two"], false),
    ).toBe(false);
  });

  it("bounds the total encoded answer at 3000 characters in both the parser and schema", () => {
    const available = MAX_ANSWER_LENGTH - "方案 A".length - other.length - 1;
    const values = ["方案 A", encodeOtherValue(other, "字".repeat(available))];
    expect(hasCompleteChoiceAnswer("multiple", options, values)).toBe(true);
    expect(
      AnswerSchema.safeParse({ questionId: "scope", state: "answered", value: values }).success,
    ).toBe(true);
    const oversized = [values[0], values[1] + "字"];
    expect(validateChoiceAnswer("multiple", options, oversized, true)).toBe(false);
    expect(
      AnswerSchema.safeParse({ questionId: "scope", state: "answered", value: oversized }).success,
    ).toBe(false);
    const single = encodeOtherValue(other, "字".repeat(MAX_ANSWER_LENGTH - other.length - 1));
    expect(hasCompleteChoiceAnswer("single", options, single)).toBe(true);
    expect(hasCompleteChoiceAnswer("single", options, single + "字")).toBe(false);
  });

  it("continues reading legacy values and the original six-choice bound", () => {
    for (const value of ["方案 A", ["方案 A", "方案 B"], other, ["方案 A", other]]) {
      expect(AnswerSchema.safeParse({ questionId: "old", state: "answered", value }).success).toBe(
        true,
      );
    }
    const values = Array.from({ length: 6 }, (_, index) => `选项${index}`);
    expect(hasCompleteChoiceAnswer("multiple", values, values)).toBe(true);
    const seven = [...values, "第七项"];
    expect(validateChoiceAnswer("multiple", seven, seven, true)).toBe(false);
    expect(
      AnswerSchema.safeParse({ questionId: "old", state: "answered", value: seven }).success,
    ).toBe(false);
  });

  it("allocates detail space after the full original 100-character Other label", () => {
    const label = other.padEnd(100, " ");
    const detail = "字".repeat(MAX_ANSWER_LENGTH - label.length - 1);
    const encoded = encodeOtherValue(label, detail);
    expect(encoded.length).toBe(MAX_ANSWER_LENGTH);
    expect(decodeChoiceValue(encoded, [label])?.detail).toBe(detail);
    expect(hasCompleteChoiceAnswer("single", [label], encoded)).toBe(true);
    expect(hasCompleteChoiceAnswer("single", [label], encoded + "字")).toBe(false);
  });
});
