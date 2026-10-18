import type { ModelCallObserver } from "@rakazo/adapter-kit";

/** Catalog rates in USD per million tokens, which equals micro-USD per token. */
export interface BudgetModelRates {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface BudgetPriceOptions {
  lookup: (provider: string, modelId: string) => BudgetModelRates | undefined;
  /** Rate in USD per million tokens applied to input and output when the model has no known price. */
  fallbackPerMTok: number;
  /** Multiplier on the input token estimate, since the estimate is not exact. Default 1.25. */
  inputSafetyFactor?: number;
}

const valid = (rate: number | undefined): number =>
  typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : 0;

/**
 * Controllable upper bound for one call in micro-USD. Input is priced at the highest input-side
 * rate and output at the full maxOutputTokens, so the bound only overestimates. A missing price
 * uses the configured fallback rate, never zero.
 */
export function createUpperBound(
  options: BudgetPriceOptions,
): (call: Parameters<ModelCallObserver["beforeCall"]>[0]) => bigint {
  const factor = options.inputSafetyFactor ?? 1.25;
  return (call) => {
    const rates = options.lookup(call.provider, call.modelId);
    const known = valid(rates?.input) > 0 || valid(rates?.output) > 0;
    const inputRate = known
      ? Math.max(valid(rates?.input), valid(rates?.cacheWrite), valid(rates?.cacheRead))
      : options.fallbackPerMTok;
    const outputRate = known ? valid(rates?.output) : options.fallbackPerMTok;
    const micro = call.inputTokensEstimate * factor * inputRate + call.maxOutputTokens * outputRate;
    const bound = BigInt(Math.ceil(micro));
    return bound > 0n ? bound : 1n;
  };
}
