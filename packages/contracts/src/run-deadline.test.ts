import { describe, expect, it } from "vitest";
import { RunDeadlineMsSchema } from "./rpc.js";

describe("run deadline override", () => {
  it.each([0, -1, 1.5, 86400001, Infinity, NaN])("rejects invalid duration %s", (value) => {
    expect(RunDeadlineMsSchema.safeParse(value).success).toBe(false);
  });
  it.each([1, 86400000])("accepts bounded integer %s", (value) => {
    expect(RunDeadlineMsSchema.parse(value)).toBe(value);
  });
  it("keeps omission optional", () => {
    expect(RunDeadlineMsSchema.optional().parse(undefined)).toBeUndefined();
  });
});
