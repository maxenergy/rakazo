import { describe, expect, it } from "vitest";
import { SetProjectBudgetInput } from "./projects.js";

describe("project budget money validation", () => {
  it("rejects malformed and out-of-range amounts without throwing", () => {
    for (const limitMicroUsd of [
      "abc",
      "1.5",
      "-1",
      "01",
      "1e3",
      "9223372036854775808",
      "9".repeat(100),
    ]) {
      expect(
        SetProjectBudgetInput.safeParse({ projectId: "project-a", limitMicroUsd }).success,
      ).toBe(false);
    }
  });
  it("preserves exact integer strings through the supported boundary", () => {
    for (const limitMicroUsd of ["0", "9007199254740993", "9223372036854775807"]) {
      expect(
        SetProjectBudgetInput.parse({ projectId: "project-a", limitMicroUsd }).limitMicroUsd,
      ).toBe(limitMicroUsd);
    }
  });
});
