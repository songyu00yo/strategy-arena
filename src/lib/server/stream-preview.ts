export interface ModelPreview {
  stage: string;
  field: string;
  text: string;
}
export type ModelPreviewCallback = (preview: ModelPreview) => void | Promise<void>;
export const MAX_PREVIEW_FIELD_CHARS = 2000;
export const MAX_PREVIEW_TOTAL_CHARS = 16_000;
export const MAX_PREVIEW_FIELDS = 48;

type Context = {
  kind: "object" | "array";
  path: string[];
  state: "key" | "colon" | "value" | "comma";
  key: string;
  index: number;
  keys: Set<string>;
};
const scalarFields = new Set([
  "title",
  "thesis",
  "resources",
  "firstAction",
  "failureCondition",
  "reason",
  "impact",
  "verification",
  "summary",
  "headline",
  "rationale",
  "exitCondition",
]);
const listFields = new Set(["steps", "conditions", "uncertainties", "nextActions"]);
function readablePath(path: string[]) {
  const parts = path[0] === "strategy" ? path.slice(1) : path;
  return (
    (parts.length === 1 && scalarFields.has(parts[0])) ||
    (parts.length === 2 && listFields.has(parts[0]) && /^\d+$/.test(parts[1])) ||
    (parts.length === 3 &&
      ["responses", "comparisons", "attackFindings"].includes(parts[0]) &&
      /^\d+$/.test(parts[1]) &&
      ["reason", "change"].includes(parts[2]))
  );
}

/** A bounded JSON tokenizer. Only decoded string values on explicit display paths escape it. */
export class StreamPreview {
  private stack: Context[] = [];
  private rootConsumed = false;
  private inString = false;
  private keyString = false;
  private value = "";
  private path: string[] = [];
  private escaped = false;
  private unicode: string | null = null;
  private primitive = "";
  private disabled = false;
  private length = 0;
  private changed = new Map<string, string>();
  private displayed = new Map<string, string>();
  private displayedSize = 0;
  duplicateKeyDetected = false;
  validationError: string | null = null;

  constructor(
    private stage: string,
    private callback?: ModelPreviewCallback,
  ) {}

  private valuePath() {
    const parent = this.stack.at(-1);
    return parent
      ? [...parent.path, parent.kind === "object" ? parent.key : String(parent.index)]
      : [];
  }
  private consumeValue() {
    const parent = this.stack.at(-1);
    if (parent) {
      if (parent.state !== "value") throw new Error("Unexpected JSON value");
      parent.state = "comma";
    } else {
      if (this.rootConsumed) throw new Error("Multiple JSON values");
      this.rootConsumed = true;
    }
  }
  private remember() {
    if (this.keyString || !readablePath(this.path)) return;
    // Keep a high surrogate private until its low surrogate arrives in a later chunk.
    const text = this.value.replace(/[\uD800-\uDBFF]$/, "");
    const field = this.path.join(".");
    const previous = this.displayed.get(field);
    const total = this.displayedSize - (previous?.length ?? 0) + text.length;
    if (
      text.length > MAX_PREVIEW_FIELD_CHARS ||
      total > MAX_PREVIEW_TOTAL_CHARS ||
      (!this.displayed.has(field) && this.displayed.size >= MAX_PREVIEW_FIELDS)
    )
      return;
    this.displayedSize = total;
    this.displayed.set(field, text);
    this.changed.set(field, text);
  }
  private character(char: string) {
    if (this.inString) {
      if (this.unicode !== null) {
        if (!/^[0-9a-f]$/i.test(char)) throw new Error("Invalid JSON unicode escape");
        this.unicode += char;
        if (this.unicode.length === 4) {
          this.value += String.fromCharCode(parseInt(this.unicode, 16));
          this.unicode = null;
        }
      } else if (this.escaped) {
        this.escaped = false;
        if (char === "u") this.unicode = "";
        else {
          const escapes: Record<string, string> = {
            '"': '"',
            "\\": "\\",
            "/": "/",
            b: "\b",
            f: "\f",
            n: "\n",
            r: "\r",
            t: "\t",
          };
          if (!Object.hasOwn(escapes, char)) throw new Error("Invalid JSON escape");
          this.value += escapes[char];
        }
      } else if (char === "\\") this.escaped = true;
      else if (char === '"') {
        this.inString = false;
        if (this.keyString) {
          const parent = this.stack.at(-1)!;
          if (parent.keys.has(this.value)) throw new Error("Duplicate JSON key");
          parent.keys.add(this.value);
          parent.key = this.value;
          parent.state = "colon";
        } else this.remember();
      } else {
        if (char.charCodeAt(0) < 32) throw new Error("Unescaped JSON control character");
        this.value += char;
      }
      return;
    }
    if (this.primitive) {
      if (!/[\s,}\]]/.test(char)) {
        this.primitive += char;
        return;
      }
      if (!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?)$/i.test(this.primitive))
        throw new Error("Invalid JSON primitive");
      this.primitive = "";
    }
    if (/\s/.test(char)) return;
    const parent = this.stack.at(-1);
    if (char === '"') {
      this.keyString = parent?.kind === "object" && parent.state === "key";
      this.path = this.keyString ? [] : this.valuePath();
      if (!this.keyString) this.consumeValue();
      this.value = "";
      this.inString = true;
    } else if (char === "{" || char === "[") {
      const path = this.valuePath();
      this.consumeValue();
      if (this.stack.length >= 32) throw new Error("JSON depth limit");
      this.stack.push({
        kind: char === "{" ? "object" : "array",
        path,
        state: char === "{" ? "key" : "value",
        key: "",
        index: 0,
        keys: new Set(),
      });
    } else if (char === "}" || char === "]") {
      if (
        !parent ||
        (char === "}") !== (parent.kind === "object") ||
        !["comma", parent.kind === "object" ? "key" : "value"].includes(parent.state)
      )
        throw new Error("Unexpected JSON closing delimiter");
      this.stack.pop();
    } else if (char === ":") {
      if (parent?.kind !== "object" || parent.state !== "colon")
        throw new Error("Unexpected colon");
      parent.state = "value";
    } else if (char === ",") {
      if (!parent || parent.state !== "comma") throw new Error("Unexpected comma");
      parent.state = parent.kind === "object" ? "key" : "value";
      parent.index++;
    } else {
      if (!/[tfn\d-]/.test(char)) throw new Error("Unexpected JSON token");
      this.consumeValue();
      this.primitive = char;
    }
  }
  feed(delta: string) {
    if (this.disabled) return;
    this.changed.clear();
    this.length += delta.length;
    try {
      if (this.length > 256_000) throw new Error("JSON preview size limit");
      for (const char of delta) this.character(char);
      if (this.inString) this.remember();
    } catch (error) {
      this.disabled = true;
      this.validationError = error instanceof Error ? error.message : "Invalid JSON structure";
      this.duplicateKeyDetected = error instanceof Error && error.message === "Duplicate JSON key";
      this.changed.clear();
      return;
    }
    for (const [field, text] of this.changed) {
      // A disconnected viewer or failed preview write must not interrupt usage collection.
      try {
        const pending = this.callback?.({ stage: this.stage, field, text });
        if (pending) void pending.catch(() => {});
      } catch {}
    }
  }
}

/** Run after complete JSON decoding, before accepting schema output, including JSON fixtures. */
export function assertUniqueJsonKeys(json: string) {
  const parser = new StreamPreview("validation");
  parser.feed(json);
  if (parser.validationError) throw new Error(parser.validationError);
}
