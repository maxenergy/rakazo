import { describe, expect, it } from "vitest";
import { ModelCatalogEntrySchema } from "./domain.js";

const entry = { provider: "example", id: "example", label: "Example", billing: "Example billing" };

describe("model catalog compatibility", () => {
  it("accepts legacy entries without metadata", () => {
    expect(ModelCatalogEntrySchema.parse(entry)).toEqual(entry);
  });
  it("accepts nullable metadata and provider billing capabilities", () => {
    const value = {
      ...entry,
      pricing: {
        inputPerMTok: 0,
        outputPerMTok: 2,
        cacheReadPerMTok: null,
        cacheWritePerMTok: null,
      },
      contextWindow: null,
      maxTokens: 100,
      reasoning: false,
      billingModes: ["api-key", "subscription"],
    };
    expect(ModelCatalogEntrySchema.parse(value)).toEqual(value);
    expect(ModelCatalogEntrySchema.parse({ ...entry, pricing: null }).pricing).toBeNull();
  });
  it.each([NaN, Infinity, -1])("rejects invalid DTO prices %s", (value) => {
    expect(
      ModelCatalogEntrySchema.safeParse({
        ...entry,
        pricing: {
          inputPerMTok: value,
          outputPerMTok: null,
          cacheReadPerMTok: null,
          cacheWritePerMTok: null,
        },
      }).success,
    ).toBe(false);
  });
});
