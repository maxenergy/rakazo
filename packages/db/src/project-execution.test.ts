import { describe, expect, it, vi } from "vitest";
import { assertProjectExecutionAllowed } from "./project-execution.js";

describe("assertProjectExecutionAllowed", () => {
  it("rejects paused project execution and scopes the lookup to its space", async () => {
    const findFirst = vi.fn().mockResolvedValue({ status: "paused" });
    await expect(
      assertProjectExecutionAllowed({ project: { findFirst } }, "space", "paused"),
    ).rejects.toThrow("Project is paused.");
    expect(findFirst).toHaveBeenCalledWith({ where: { id: "paused", spaceId: "space" } });
  });

  it("allows resumed and legacy projects, independently of employee memberships", async () => {
    const findFirst = vi.fn().mockResolvedValueOnce({ status: "active" }).mockResolvedValueOnce({});
    const db = { project: { findFirst } };
    await expect(assertProjectExecutionAllowed(db, "space", "resumed")).resolves.toBeUndefined();
    await expect(assertProjectExecutionAllowed(db, "space", "legacy")).resolves.toBeUndefined();
  });

  it("does not infer a project for unassigned work", async () => {
    const findFirst = vi.fn();
    await assertProjectExecutionAllowed({ project: { findFirst } }, "space", null);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("rejects missing or inaccessible projects", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    await expect(
      assertProjectExecutionAllowed({ project: { findFirst } }, "space", "missing"),
    ).rejects.toThrow("Resource not found.");
  });
});
