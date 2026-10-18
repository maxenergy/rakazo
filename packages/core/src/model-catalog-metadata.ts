import type { ModelCatalogEntry, ModelCredential } from "@rakazo/contracts";

export type CatalogBillingMode = "api-key" | "subscription" | "unknown";

/** Only use credentials for the effective connection, never a host's hidden secret. */
export function catalogBillingMode(
  entry: ModelCatalogEntry,
  authKind?: ModelCredential["authKind"],
): CatalogBillingMode {
  const modes = entry.billingModes;
  if (modes?.length === 1) return modes[0]!;
  if (authKind === "api_key" || authKind === "openai_compatible") return "api-key";
  if (authKind === "oauth" || authKind === "cli") return "subscription";
  if (!modes && entry.auth === "api-key" && !entry.subscription) return "api-key";
  return "unknown";
}

function knownPrice(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function catalogCostState(entry: ModelCatalogEntry, authKind?: ModelCredential["authKind"]) {
  const mode = catalogBillingMode(entry, authKind);
  if (mode === "subscription") return "subscription";
  if (mode === "unknown" || !entry.pricing) return "unknown";
  const values = [
    entry.pricing.inputPerMTok,
    entry.pricing.outputPerMTok,
    entry.pricing.cacheReadPerMTok,
    entry.pricing.cacheWritePerMTok,
  ];
  if (values.every((value) => value === 0)) return "free";
  return values.some(knownPrice) ? "priced" : "unknown";
}

/** Explicit index tie breaking preserves each input's equal-price and unknown groups. */
export function sortModelCatalogByCost<T extends ModelCatalogEntry>(
  entries: readonly T[],
  authKindFor: (entry: T) => ModelCredential["authKind"] = () => undefined,
): T[] {
  const decorated = entries.map((entry, index) => {
    const pricing = entry.pricing;
    const key =
      catalogBillingMode(entry, authKindFor(entry)) === "api-key" &&
      pricing &&
      knownPrice(pricing.inputPerMTok) &&
      knownPrice(pricing.outputPerMTok)
        ? ([pricing.inputPerMTok, pricing.outputPerMTok] as const)
        : null;
    return { entry, index, key };
  });
  decorated.sort((a, b) => {
    if (!a.key || !b.key) return a.key ? -1 : b.key ? 1 : a.index - b.index;
    return a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.index - b.index;
  });
  return decorated.map(({ entry }) => entry);
}
