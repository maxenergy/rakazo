import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";

import type { CatalogMetadataFields } from "./pi-catalog-metadata.js";

const supplementMetadata = new WeakMap<MutableModels, Map<string, CatalogMetadataFields>>();

export function supplementedCatalogMetadata(
  models: MutableModels,
  provider: string,
  id: string,
): CatalogMetadataFields | undefined {
  return supplementMetadata.get(models)?.get(`${provider}/${id}`);
}

/** Fill catalog gaps until the bundled provider library includes these releases. */
export function supplementPiModels(models: MutableModels): MutableModels {
  function add(
    providerId: string,
    baseId: string,
    overrides: Partial<Model<Api>> & { id: string },
  ) {
    if (models.getModel(providerId, overrides.id)) return;
    const provider = models.getProvider(providerId);
    const base = models.getModel(providerId, baseId);
    if (!provider || !base) throw new Error(`Missing model baseline: ${providerId}/${baseId}`);
    const model = { ...base, ...overrides };
    let metadata = supplementMetadata.get(models);
    if (!metadata) {
      metadata = new Map();
      supplementMetadata.set(models, metadata);
    }
    // Limits copied from a baseline or a fallback do not establish provenance.
    // The supplement's explicit cost table is the source for these base-tier prices.
    metadata.set(`${providerId}/${overrides.id}`, {
      ...(overrides.cost ? { cost: overrides.cost } : {}),
      ...(typeof overrides.reasoning === "boolean" ? { reasoning: overrides.reasoning } : {}),
    });
    models.setProvider({ ...provider, getModels: () => [model, ...provider.getModels()] });
  }
  add("anthropic", "claude-sonnet-5", {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    compat: {
      forceAdaptiveThinking: true,
      supportsTemperature: false,
      supportsStrictTools: true,
      supportsMidConvoEffort: true,
      supportsMidConvoSystemMessages: true,
      supportsMidConvoToolChanges: true,
    },
  });
  const sol = models.getModel("openai-codex", "gpt-6-sol");
  add("openai-codex", "gpt-6-sol", {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    cost: {
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
      tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
    },
    // Subscription transport keeps its own window; the account catalog may narrow it.
    contextWindow: sol?.contextWindow ?? 272000,
  });
  return models;
}
