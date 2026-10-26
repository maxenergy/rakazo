import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { catalogMetadata } from "./pi-catalog-metadata.js";
import { supplementedCatalogMetadata, supplementPiModels } from "./pi-current-models.js";

describe("supplement metadata provenance", () => {
  it("keeps inherited fields unknown and runtime baselines unchanged", () => {
    const models = builtinModels();
    const base = models.getModel("anthropic", "claude-sonnet-5");
    const before = { ...base, cost: base ? { ...base.cost } : undefined };
    supplementPiModels(models);
    expect(models.getModel("anthropic", "claude-sonnet-5")).toEqual(before);
    const fields = supplementedCatalogMetadata(models, "anthropic", "claude-sonnet-5-5");
    expect(fields).toEqual({});
    expect(catalogMetadata(fields!)).toEqual({
      pricing: null,
      capabilities: {
        imageInput: { value: null, source: null },
        reasoning: { value: null, source: null },
      },
      contextWindow: null,
      maxTokens: null,
    });
  });

  it("projects explicit base-tier prices without inherited limits or reasoning", () => {
    const models = supplementPiModels(builtinModels());
    const runtime = models.getModel("openai-codex", "gpt-6.1-sol");
    const before = { ...runtime, cost: runtime ? { ...runtime.cost } : undefined };
    const fields = supplementedCatalogMetadata(models, "openai-codex", "gpt-6.1-sol");
    expect(catalogMetadata(fields!, true)).toEqual({
      pricing: {
        inputPerMTok: 2,
        outputPerMTok: 10,
        cacheReadPerMTok: 0.1,
        cacheWritePerMTok: 2.5,
      },
      capabilities: {
        imageInput: { value: null, source: null },
        reasoning: { value: null, source: null },
      },
      contextWindow: null,
      maxTokens: null,
    });
    expect(runtime).toEqual(before);
    supplementPiModels(models);
    expect(models.getModel("openai-codex", "gpt-6.1-sol")).toBe(runtime);
    expect(supplementedCatalogMetadata(models, "openai-codex", "gpt-6.1-sol")).toEqual(fields);
  });
});
