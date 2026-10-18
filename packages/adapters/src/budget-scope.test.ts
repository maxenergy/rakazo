import { describe, expect, it } from "vitest";
import { currentBudgetScope, runWithBudgetScope } from "./budget-scope.js";

describe("budget scope", () => {
  it("is null outside a run", () => {
    expect(currentBudgetScope()).toBeNull();
  });

  it("isolates concurrent runs across awaits", async () => {
    const seen: Array<string | undefined> = [];
    const run = (projectId: string, delay: number) =>
      runWithBudgetScope({ spaceId: "s", projectId }, async () => {
        await new Promise((r) => setTimeout(r, delay));
        seen.push(currentBudgetScope()?.projectId);
      });
    await Promise.all([run("p1", 10), run("p2", 1)]);
    expect(seen.sort()).toEqual(["p1", "p2"]);
  });
});
