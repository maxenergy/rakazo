import type { ModelCatalogEntry } from "@rakazo/contracts";

export type CatalogMetadataFields = {
  cost?: Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite", unknown>>;
  contextWindow?: unknown;
  maxTokens?: unknown;
  reasoning?: unknown;
};

export type CatalogMetadata = Pick<ModelCatalogEntry, "reasoning"> & {
  pricing: {
    inputPerMTok: number | null;
    outputPerMTok: number | null;
    cacheReadPerMTok: number | null;
    cacheWritePerMTok: number | null;
  } | null;
  contextWindow: number | null;
  maxTokens: number | null;
};

function price(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function limit(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Normalize only source-verified fields; runtime model values remain untouched. */
export function catalogMetadata(
  fields: CatalogMetadataFields,
  verifiedZero = false,
): CatalogMetadata {
  const cost = fields.cost;
  const pricing = {
    inputPerMTok: price(cost?.input),
    outputPerMTok: price(cost?.output),
    cacheReadPerMTok: price(cost?.cacheRead),
    cacheWritePerMTok: price(cost?.cacheWrite),
  };
  const values = Object.values(pricing);
  return {
    pricing:
      values.every((value) => value === null) ||
      (!verifiedZero && values.every((value) => value === 0))
        ? null
        : pricing,
    contextWindow: limit(fields.contextWindow),
    maxTokens: limit(fields.maxTokens),
    ...(typeof fields.reasoning === "boolean" ? { reasoning: fields.reasoning } : {}),
  };
}
