import { describe, expect, it } from "vitest";
import { parseIntakePages } from "../src/components/guided-intake";

describe("intake PDF page selection", () => {
  it("accepts mixed page ranges and deduplicates repeated pages", () => {
    expect(parseIntakePages("1-3, 3，8 10–11", 40)).toEqual([1, 2, 3, 8, 10, 11]);
  });
  it.each(["", "0", "-1", "4-2", "2-42", "1.5", "two", "1-9999999999", "1-20,21"])(
    "rejects invalid or oversized page selection %j",
    (input) => {
      expect(() => parseIntakePages(input, 40)).toThrow();
    },
  );
  it("allows twenty distinct pages and rejects a page outside the document", () => {
    expect(parseIntakePages("1-20", 20)).toHaveLength(20);
    expect(() => parseIntakePages("21", 20)).toThrow("1 到 20");
  });
});
