import type { ModelCapability, ModelCatalogEntry, ModelCredential } from "@rakazo/contracts";
import { catalogBillingMode } from "./model-catalog-metadata.js";

export type ModelRequirements = {
  capabilities?: ModelCapability[];
  contextWindow?: number;
  maxTokens?: number;
  workload?: { inputTokens: number; outputTokens: number };
};

/** Candidates must already be scoped to connected, authorized, available models. */
export function recommendModels<T extends ModelCatalogEntry>(
  candidates: readonly T[],
  requirements: ModelRequirements,
  authKindFor: (entry: T) => ModelCredential["authKind"],
) {
  const excluded: { provider: string; id: string; reasons: string[] }[] = [];
  const recommendations = candidates.flatMap((entry) => {
    const reasons: string[] = [];
    for (const capability of requirements.capabilities ?? []) {
      if (entry.capabilities?.[capability]?.value !== true) {
        reasons.push(`${capability}: unsupported or unknown`);
      }
    }
    for (const key of ["contextWindow", "maxTokens"] as const) {
      const minimum = requirements[key];
      const value = entry[key];
      if (minimum !== undefined && (value == null || value < minimum)) {
        reasons.push(`${key}: insufficient or unknown`);
      }
    }
    if (entry.placeholder) reasons.push("Placeholder is not an available model");
    if (reasons.length) {
      excluded.push({ provider: entry.provider, id: entry.id, reasons });
      return [];
    }
    const billingMode = catalogBillingMode(entry, authKindFor(entry));
    const workload = requirements.workload;
    const input = entry.pricing?.inputPerMTok;
    const output = entry.pricing?.outputPerMTok;
    const validPrice = (value: unknown): value is number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0;
    const estimate =
      billingMode === "api-key" && workload && validPrice(input) && validPrice(output)
        ? (input * workload.inputTokens + output * workload.outputTokens) / 1_000_000
        : null;
    const estimatedCostUsd = estimate !== null && Number.isFinite(estimate) ? estimate : null;
    return [
      {
        provider: entry.provider,
        id: entry.id,
        label: entry.label,
        discovery: entry.discovery ?? null,
        capabilities: entry.capabilities ?? null,
        billingMode,
        estimatedCostUsd,
        comparisonGroup: estimatedCostUsd === null ? null : "api-key-usd-token-workload",
        explanation:
          estimatedCostUsd !== null
            ? "USD estimate for the supplied uncached input/output workload; excludes other charges."
            : billingMode === "subscription"
              ? "Subscription billing is not comparable to API token prices."
              : "Comparable cost is unknown; supply a workload and complete API token prices.",
      },
    ];
  });
  const comparable = recommendations
    .filter((entry) => entry.estimatedCostUsd !== null)
    .sort((a, b) => a.estimatedCostUsd! - b.estimatedCostUsd!);
  return {
    recommendations: [
      ...comparable,
      ...recommendations.filter((entry) => entry.estimatedCostUsd === null),
    ],
    excluded,
    workload: requirements.workload ?? null,
    modelChanged: false as const,
  };
}
