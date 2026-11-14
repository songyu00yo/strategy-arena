export const OTHER_SEPARATOR = "：";
export const MAX_ANSWER_LENGTH = 3000;

const OTHER_LABELS = new Set([
  "其他",
  "其他(请补充)",
  "其他(请说明)",
  "其他(请描述)",
  "其他,下一步由我描述",
  "其他,下一步由我来描述",
  "other",
  "other (please specify)",
  "other (please describe)",
]);

export function normalizeChoiceLabel(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

export function isOtherOption(option: string): boolean {
  return OTHER_LABELS.has(normalizeChoiceLabel(option));
}

export type DecodedChoice = {
  option: string;
  detail: string | null;
};

export function decodeChoiceValue(value: string, options: readonly string[]): DecodedChoice | null {
  if (options.includes(value)) return { option: value, detail: null };
  for (const option of options) {
    if (!isOtherOption(option)) continue;
    for (const separator of [OTHER_SEPARATOR, ":"]) {
      const prefix = option + separator;
      if (value.startsWith(prefix)) return { option, detail: value.slice(prefix.length) };
    }
  }
  return null;
}

export function encodeOtherValue(option: string, detail: string): string {
  if (!isOtherOption(option)) throw new Error("Not an Other option.");
  return option + OTHER_SEPARATOR + detail;
}

export function validateChoiceAnswer(
  type: "single" | "multiple",
  options: readonly string[],
  value: string | string[],
  allowIncomplete: boolean,
): boolean {
  if ((type === "multiple") !== Array.isArray(value)) return false;
  const values = Array.isArray(value) ? value : [value];
  if (!values.length || values.length > 6) return false;
  if (values.reduce((sum, entry) => sum + entry.length, 0) > MAX_ANSWER_LENGTH) return false;

  const selected = new Set<string>();
  let otherCount = 0;
  for (const entry of values) {
    const decoded = decodeChoiceValue(entry, options);
    if (!decoded || selected.has(decoded.option)) return false;
    selected.add(decoded.option);
    if (isOtherOption(decoded.option)) {
      otherCount++;
      if (otherCount > 1 || (!allowIncomplete && !decoded.detail?.trim())) return false;
    }
  }
  return true;
}

export function hasCompleteChoiceAnswer(
  type: "single" | "multiple",
  options: readonly string[],
  value: string | string[],
): boolean {
  return validateChoiceAnswer(type, options, value, false);
}
