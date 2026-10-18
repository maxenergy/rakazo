import { describe, expect, it } from "vitest";
import { decimalUsdToMicroUsd } from "./money.js";

describe("decimalUsdToMicroUsd", () => {
  it.each([
    ["0", 0n],
    ["0.00000001", 1n],
    ["0.000001", 1n],
    ["1.0000001", 1000001n],
    ["1e-7", 1n],
    ["12345678901234567890.123456", 12345678901234567890123456n],
  ])("converts %s without floating-point arithmetic", (input, expected) => {
    expect(decimalUsdToMicroUsd(input)).toBe(expected);
  });

  it.each(["-1", "NaN", "Infinity", "", "1.2.3", "1e1001"])(
    "rejects invalid amount %s",
    (input) => expect(() => decimalUsdToMicroUsd(input)).toThrow(),
  );
});
