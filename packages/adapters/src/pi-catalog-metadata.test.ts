import { describe, expect, it } from "vitest";
import { catalogMetadata } from "./pi-catalog-metadata.js";

describe("catalog metadata normalization", () => {
  it("leaves missing metadata unknown", () => {
    expect(catalogMetadata({})).toEqual({ pricing: null, contextWindow: null, maxTokens: null });
  });

  it.each([NaN, Infinity, -1, "10", undefined])("rejects malformed price %s", (value) => {
    expect(catalogMetadata({ cost: { input: value, output: 2 } }).pricing).toEqual({
      inputPerMTok: null,
      outputPerMTok: 2,
      cacheReadPerMTok: null,
      cacheWritePerMTok: null,
    });
  });

  it.each([NaN, Infinity, -1, 0, 1.5, "10", Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed limits %s",
    (value) => {
      expect(catalogMetadata({ contextWindow: value, maxTokens: value })).toMatchObject({
        contextWindow: null,
        maxTokens: null,
      });
    },
  );

  it("preserves valid limits and explicit false", () => {
    expect(catalogMetadata({ contextWindow: 100, maxTokens: 20, reasoning: false })).toEqual({
      pricing: null,
      contextWindow: 100,
      maxTokens: 20,
      reasoning: false,
    });
    expect(catalogMetadata({ reasoning: "false" })).not.toHaveProperty("reasoning");
  });

  it("distinguishes an unverified all-zero table from verified zero prices", () => {
    const fields = { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    expect(catalogMetadata(fields).pricing).toBeNull();
    expect(catalogMetadata(fields, true).pricing).toEqual({
      inputPerMTok: 0,
      outputPerMTok: 0,
      cacheReadPerMTok: 0,
      cacheWritePerMTok: 0,
    });
    expect(catalogMetadata({ cost: { input: 0, output: 2 } }).pricing?.inputPerMTok).toBe(0);
  });

  it("does not mutate runtime metadata", () => {
    const fields = {
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100,
      maxTokens: 20,
      reasoning: false,
    };
    const before = structuredClone(fields);
    catalogMetadata(fields);
    expect(fields).toEqual(before);
  });
});
