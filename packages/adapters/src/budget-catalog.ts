import type { BudgetModelRates } from "./budget-price.js";
import { listPiCatalog } from "./pi-models.js";

/** Rate in USD per million tokens used for models whose catalog price is missing or zero. */
export const DEFAULT_BUDGET_FALLBACK_PER_MTOK = 100;

/** Looks up per-model rates from the Pi catalog; undefined when the model has no entry or price. */
export function catalogBudgetRates(
  provider: string,
  modelId: string,
): BudgetModelRates | undefined {
  const pricing = listPiCatalog().find(
    (entry) => entry.provider === provider && entry.id === modelId,
  )?.pricing;
  if (!pricing) return undefined;
  return {
    input: pricing.inputPerMTok ?? undefined,
    output: pricing.outputPerMTok ?? undefined,
    cacheRead: pricing.cacheReadPerMTok ?? undefined,
    cacheWrite: pricing.cacheWritePerMTok ?? undefined,
  };
}
