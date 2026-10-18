import type { ModelCatalogEntry } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { catalogCostState, sortModelCatalogByCost } from "./model-catalog-metadata.js";
import { catalogMetadataLines } from "./model-catalog-metadata-copy.js";

function entry(
  id: string,
  input: number | null = null,
  output: number | null = null,
): ModelCatalogEntry {
  return {
    provider: "example",
    id,
    label: id,
    billing: "API key",
    auth: "api-key",
    billingModes: ["api-key"],
    pricing: {
      inputPerMTok: input,
      outputPerMTok: output,
      cacheReadPerMTok: null,
      cacheWritePerMTok: null,
    },
  };
}
const ids = (entries: ModelCatalogEntry[]) => entries.map((item) => item.id);
const translate = (message: string, values?: Record<string, string | number>) =>
  message.replace(/\{(\w+)\}/g, (match, key: string) => String(values?.[key] ?? match));

describe("catalog cost metadata", () => {
  it("sorts distinct known keys consistently regardless of input order", () => {
    const a = entry("a", 1, 4);
    const b = entry("b", 1, 2);
    const c = entry("c", 0, 9);
    for (const input of [
      [a, b, c],
      [c, a, b],
      [b, c, a],
    ]) {
      expect(ids(sortModelCatalogByCost(input))).toEqual(["c", "b", "a"]);
      expect(input).toHaveLength(3);
    }
  });

  it("preserves each input's equal-price and unknown order", () => {
    const a = entry("a", 1, 2);
    const b = entry("b", 1, 2);
    const u = entry("u");
    const v = entry("v", 1);
    expect(ids(sortModelCatalogByCost([u, a, v, b]))).toEqual(["a", "b", "u", "v"]);
    expect(ids(sortModelCatalogByCost([v, b, u, a]))).toEqual(["b", "a", "v", "u"]);
  });

  it("requires all four prices to be known zero before calling a model free", () => {
    const model = entry("zero", 0, 0);
    expect(catalogCostState(model)).toBe("priced");
    model.pricing = {
      inputPerMTok: 0,
      outputPerMTok: 0,
      cacheReadPerMTok: 0,
      cacheWritePerMTok: 1,
    };
    expect(catalogCostState(model)).toBe("priced");
    expect(catalogMetadataLines(model, undefined, translate)).toContain("Input: No charge");
    model.pricing.cacheWritePerMTok = 0;
    expect(catalogCostState(model)).toBe("free");
  });

  it("keeps mixed billing unknown until the effective connection is known", () => {
    const model = {
      ...entry("mixed", 0, 0),
      billingModes: ["api-key", "subscription"] as ModelCatalogEntry["billingModes"],
    };
    expect(catalogCostState(model)).toBe("unknown");
    expect(catalogCostState(model, "oauth")).toBe("subscription");
    expect(catalogCostState(model, "api_key")).toBe("priced");
    expect(catalogMetadataLines(model, undefined, translate)[0]).toBe("Cost unknown");
  });

  it("renders null limits as unknown and distinguishes missing reasoning from false", () => {
    const model = { ...entry("unknown"), contextWindow: null, maxTokens: null };
    const lines = catalogMetadataLines(model, undefined, translate);
    expect(lines).toContain("Context window: Unknown");
    expect(lines).toContain("Maximum output tokens: Unknown");
    expect(lines.join("  ")).not.toContain("Does not support reasoning");
    expect(catalogMetadataLines({ ...model, reasoning: false }, undefined, translate)).toContain(
      "Does not support reasoning",
    );
  });

  it("handles empty, all unknown, subscription and mixed billing sorting", () => {
    const known = entry("known", 2, 3);
    const subscription = {
      ...entry("subscription", 0, 0),
      billingModes: ["subscription"] as ModelCatalogEntry["billingModes"],
    };
    const mixed = {
      ...entry("mixed", 1, 1),
      billingModes: ["api-key", "subscription"] as ModelCatalogEntry["billingModes"],
    };
    const unknown = entry("unknown");
    expect(sortModelCatalogByCost([])).toEqual([]);
    expect(ids(sortModelCatalogByCost([unknown, subscription, mixed]))).toEqual([
      "unknown",
      "subscription",
      "mixed",
    ]);
    expect(ids(sortModelCatalogByCost([subscription, mixed, known, unknown]))).toEqual([
      "known",
      "subscription",
      "mixed",
      "unknown",
    ]);
    expect(ids(sortModelCatalogByCost([known, mixed], () => "api_key"))).toEqual([
      "mixed",
      "known",
    ]);
    expect(catalogMetadataLines(subscription, undefined, translate)[0]).toBe(
      "Subscription, cost unknown",
    );
  });
});
