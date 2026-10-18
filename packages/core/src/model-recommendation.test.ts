import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "@rakazo/contracts";
import { recommendModels } from "./model-recommendation.js";

const entry = (id: string, patch: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry => ({
  provider: "example", id, label: id, billing: "API key", billingModes: ["api-key"],
  ...patch,
});
const workload = { inputTokens: 1_000_000, outputTokens: 1_000_000 };

describe("model recommendations", () => {
  it("rejects unknown and false hard capabilities", () => {
    const result = recommendModels([entry("unknown"), entry("false", { capabilities: {
      imageInput: { value: false, source: "registry" },
      reasoning: { value: null, source: null },
    } })], { capabilities: ["imageInput"] }, () => "api_key");
    expect(result.recommendations).toEqual([]);
    expect(result.excluded).toHaveLength(2);
  });

  it("compares complete API prices while retaining unknown and subscription costs", () => {
    const pricing = { inputPerMTok: 2, outputPerMTok: 3, cacheReadPerMTok: null, cacheWritePerMTok: null };
    const candidates = [entry("unknown"), entry("paid", { pricing }),
      entry("subscription", { pricing, billingModes: ["subscription"] }),
      entry("zero", { pricing: { ...pricing, inputPerMTok: 0, outputPerMTok: 0 } })];
    const before = structuredClone(candidates);
    const result = recommendModels(candidates, { workload }, () => "api_key");
    expect(result.recommendations.map((model) => model.id)).toEqual(["zero", "paid", "unknown", "subscription"]);
    expect(result.recommendations.map((model) => model.estimatedCostUsd)).toEqual([0, 5, null, null]);
    expect(result.modelChanged).toBe(false);
    expect(candidates).toEqual(before);
  });

  it("excludes placeholders and insufficient or unknown limits", () => {
    const result = recommendModels([entry("placeholder", { placeholder: true }),
      entry("unknown"), entry("small", { contextWindow: 100 }),
      entry("fits", { contextWindow: 200 })], { contextWindow: 150 }, () => "api_key");
    expect(result.recommendations.map((model) => model.id)).toEqual(["fits"]);
  });
});
