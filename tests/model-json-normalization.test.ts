/** Exact syntax recovery only; no provider, key or billing access. */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeModelJson } from "../src/lib/server/model";

describe("single redundant trailing object brace", () => {
  it("leaves valid JSON unchanged and records no normalization", () => {
    expect(
      decodeModelJson('{"a":{"text":"literal } and escaped \\\" quote"},"list":[1,2]}'),
    ).toEqual({ value: { a: { text: 'literal } and escaped " quote' }, list: [1, 2] } });
    expect(decodeModelJson("[1,2]")).toEqual({ value: [1, 2] });
  });
  it("removes exactly one final brace while retaining the original string and hash", () => {
    const original =
      ' \n{"value":{"text":"literal } { and escaped \\\" quote","list":[{"x":true}]}} }\t\r\n';
    const result = decodeModelJson(original);
    expect(result.value).toEqual({
      value: { text: 'literal } { and escaped " quote', list: [{ x: true }] },
    });
    expect(result.formatNormalization).toMatchObject({
      kind: "single-redundant-trailing-object-brace",
      originalOutput: original,
      originalOutputSha256: createHash("sha256").update(original).digest("hex"),
      removedSuffix: "}",
    });
    const offset = result.formatNormalization!.removedOffset;
    expect(original[offset]).toBe("}");
    expect(JSON.parse(original.slice(0, offset) + original.slice(offset + 1))).toEqual(
      result.value,
    );
  });
  it.each([
    '{"x":1}}}',
    '{"x":1} trailing text}',
    'prefix {"x":1}}',
    '{"x":1}{"y":2}}',
    '{"x":1,}}',
    '{"x":}',
    '{"x":1',
    '{"x":"unterminated}}',
    '[{"x":1}]}',
    "null}",
    "true}",
    "1}",
    '"text"}',
    '{"x":1}}\u00a0',
  ])("rejects every other malformed shape without discarding content: %s", (output) => {
    expect(() => decodeModelJson(output)).toThrow();
  });
});
