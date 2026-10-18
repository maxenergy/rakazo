import { describe, expect, it } from "vitest";
import { createUpperBound } from "./budget-price.js";

const call = (inputTokensEstimate: number, maxOutputTokens: number) => ({
  provider: "p",
  modelId: "m",
  inputTokensEstimate,
  maxOutputTokens,
});

describe("budget upper bound", () => {
  it("prices input with a safety factor and output at the full cap", () => {
    const bound = createUpperBound({
      lookup: () => ({ input: 3, output: 15 }),
      fallbackPerMTok: 100,
    });
    // 1000 * 1.25 * 3 + 2000 * 15 = 3750 + 30000
    expect(bound(call(1000, 2000))).toBe(33_750n);
  });

  it("uses the highest input-side rate", () => {
    const bound = createUpperBound({
      lookup: () => ({ input: 3, output: 15, cacheWrite: 6 }),
      fallbackPerMTok: 100,
      inputSafetyFactor: 1,
    });
    expect(bound(call(1000, 0))).toBe(6_000n);
  });

  it("uses the fallback rate for unknown or zero prices, never zero", () => {
    const unknown = createUpperBound({ lookup: () => undefined, fallbackPerMTok: 10 });
    expect(unknown(call(100, 100))).toBe(1_250n + 1_000n);
    const zero = createUpperBound({
      lookup: () => ({ input: 0, output: 0 }),
      fallbackPerMTok: 10,
    });
    expect(zero(call(100, 100))).toBe(2_250n);
  });

  it("returns at least 1 micro-USD", () => {
    const bound = createUpperBound({ lookup: () => undefined, fallbackPerMTok: 10 });
    expect(bound(call(0, 0))).toBe(1n);
  });
});

describe("incomplete budget prices and invalid bounds", () => {
  it.each([
    [{ input: 2 }, 1250],
    [{ output: 3 }, 1550],
    [{ input: 0, output: 3 }, 1550],
    [{ input: Number.NaN, output: 3 }, 1550],
    [{ cacheWrite: 20 }, 3500],
  ])("reserves missing components using fallback: %j", (rates, expected) => {
    const bound = createUpperBound({ lookup: () => rates, fallbackPerMTok: 10 });
    expect(bound(call(100, 100))).toBe(BigInt(expected));
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid fallback %s",
    (fallbackPerMTok) => {
      expect(() => createUpperBound({ lookup: () => undefined, fallbackPerMTok })).toThrow(
        RangeError,
      );
    },
  );

  it.each([0, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects unsafe factor %s",
    (inputSafetyFactor) => {
      expect(() =>
        createUpperBound({ lookup: () => undefined, fallbackPerMTok: 10, inputSafetyFactor }),
      ).toThrow(RangeError);
    },
  );

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid token bounds %s",
    (tokens) => {
      const bound = createUpperBound({ lookup: () => undefined, fallbackPerMTok: 10 });
      expect(() => bound(call(tokens, 100))).toThrow(RangeError);
      expect(() => bound(call(100, tokens))).toThrow(RangeError);
    },
  );

  it("rejects reservations exceeding safe numeric precision", () => {
    const bound = createUpperBound({ lookup: () => undefined, fallbackPerMTok: Number.MAX_VALUE });
    expect(() => bound(call(100, 100))).toThrow(RangeError);
  });
});
