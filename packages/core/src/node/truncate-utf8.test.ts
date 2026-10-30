import { describe, expect, it } from "vitest";
import { truncateUtf8 } from "./truncate-utf8.js";

describe("truncateUtf8", () => {
  it.each([
    ["", 4, ""],
    ["abc", 0, ""],
    ["abc", -1, ""],
    ["abc", 2, "ab"],
    ["abc", 3, "abc"],
    ["a中🙂z", 3, "a"],
    ["a中🙂z", 4, "a中"],
    ["a中🙂z", 7, "a中"],
    ["a中🙂z", 8, "a中🙂"],
    ["a中🙂z", 99, "a中🙂z"],
    ["e\u0301", 2, "e"],
  ])("truncates %j to %i bytes", (value, budget, expected) => {
    expect(truncateUtf8(value, budget)).toBe(expected);
  });
});
