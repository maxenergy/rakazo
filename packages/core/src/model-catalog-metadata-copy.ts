import type { ModelCatalogEntry, ModelCredential } from "@rakazo/contracts";
import { catalogCostState } from "./model-catalog-metadata.js";

export type CatalogMetadataTranslate = (
  message: string,
  values?: Record<string, string | number>,
) => string;

/** Shared copy keeps unknown metadata distinct from zero and false on every surface. */
export function catalogMetadataLines(
  entry: ModelCatalogEntry,
  authKind: ModelCredential["authKind"],
  t: CatalogMetadataTranslate,
): string[] {
  const state = catalogCostState(entry, authKind);
  const lines: string[] = [];
  if (state === "subscription") lines.push(t("Subscription, cost unknown"));
  else if (state === "unknown") lines.push(t("Cost unknown"));
  else if (state === "free") lines.push(t("Free"));
  else {
    const price = (value: number | null | undefined): string => {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return t("Unknown");
      return value === 0
        ? t("No charge")
        : t("{price} USD / million tokens", { price: String(value) });
    };
    const pricing = entry.pricing;
    lines.push(
      t("Input: {price}", { price: price(pricing?.inputPerMTok) }),
      t("Output: {price}", { price: price(pricing?.outputPerMTok) }),
      t("Cache read: {price}", { price: price(pricing?.cacheReadPerMTok) }),
      t("Cache write: {price}", { price: price(pricing?.cacheWritePerMTok) }),
    );
  }
  if (entry.discovery) {
    lines.push(
      entry.discovery.status === "discovered"
        ? t("Discovered catalog: {source}", { source: entry.discovery.source })
        : t("Static catalog, availability not discovered: {source}", { source: entry.discovery.source }),
    );
  }
  const limit = (value: number | null | undefined): string =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? String(value)
      : t("Unknown");
  lines.push(
    t("Context window: {tokens}", { tokens: limit(entry.contextWindow) }),
    t("Maximum output tokens: {tokens}", { tokens: limit(entry.maxTokens) }),
  );
  if (entry.reasoning === true) lines.push(t("Supports reasoning"));
  else if (entry.reasoning === false) lines.push(t("Does not support reasoning"));
  return lines;
}
