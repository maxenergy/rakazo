import { describe, expect, it } from "vitest";
import { CreateKeyResultInput, UpdateKeyResultInput } from "./goals.js";

describe("explicit key result measurements", () => {
  const input = {
    goalId: "goal",
    name: "Revenue",
    measure: "USD",
    targetValue: 100,
    currentValue: 0,
    calculationRule: "Sum of confirmed invoices",
  };
  it("requires an explicit current value and visible calculation rule", () => {
    expect(CreateKeyResultInput.safeParse(input).success).toBe(true);
    expect(CreateKeyResultInput.safeParse({ ...input, currentValue: undefined }).success).toBe(
      false,
    );
    expect(CreateKeyResultInput.safeParse({ ...input, calculationRule: " " }).success).toBe(false);
  });
  it("rejects non-finite measurements and unknown states", () => {
    for (const currentValue of [NaN, Infinity, -Infinity]) {
      expect(UpdateKeyResultInput.safeParse({ id: "kr", currentValue }).success).toBe(false);
    }
    expect(UpdateKeyResultInput.safeParse({ id: "kr", state: "automatic" }).success).toBe(false);
  });
  it("keeps state independent of numeric achievement", () => {
    expect(CreateKeyResultInput.parse({ ...input, currentValue: 200, state: "active" }).state).toBe(
      "active",
    );
  });
});
