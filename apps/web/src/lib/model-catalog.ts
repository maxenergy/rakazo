import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import type { ThinkingLevel } from "@rakazo/contracts";
import { modelBillingCopy } from "@rakazo/core";

export function modelBillingLabel(billing: string): string {
  const copy = modelBillingCopy(billing);
  const provider = "name" in copy ? (copy.name ?? "") : "";
  switch (copy.kind) {
    case "api":
      return t`Uses your ${provider} API key. Rakazo does not pay for model usage.`;
    case "local":
      return t`Runs on infrastructure configured by the deployment owner. No model charges from Rakazo.`;
    case "custom":
      return t`Runs on a URL you control. Rakazo does not pay for model usage.`;
    case "fixture":
      return t`No model charges. Deterministic fixture for tests.`;
    case "configured":
      return t`Configured model: ${provider}`;
    case "unavailable":
      return t`${provider} subscription login is not in the Rakazo UI yet. Skip if this deployment already has credentials.`;
    case "subscription":
      return t`Sign in with ${provider}. Uses your subscription. Rakazo does not pay.`;
    case "grok":
      return t`Sign in with SuperGrok or X Premium, or paste an xAI API key. Rakazo does not pay.`;
    case "literal":
      return copy.text;
  }
}

export function thinkingLevelLabel(level: ThinkingLevel) {
  if (level === "xhigh") return i18n._({ id: "Extra high", message: "Extra high" });
  if (level === "low") return i18n._({ id: "Low", message: "Low" });
  if (level === "medium") return i18n._({ id: "Medium", message: "Medium" });
  if (level === "high") return i18n._({ id: "High", message: "High" });
  if (level === "minimal") return i18n._({ id: "Minimal", message: "Minimal" });
  if (level === "max") return i18n._({ id: "Max", message: "Max" });
  return `${level.slice(0, 1).toUpperCase()}${level.slice(1)}`;
}
