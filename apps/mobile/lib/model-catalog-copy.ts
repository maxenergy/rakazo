import { modelBillingCopy } from "@rakazo/core";
import { t } from "./i18n";

export function modelSignInLabel(label: string | undefined): string {
  const provider = label?.match(/^Sign in with (.+)$/)?.[1];
  return provider ? t("Sign in with {provider}", { provider }) : (label ?? t("Sign in"));
}

export function modelBillingLabel(billing: string): string {
  const copy = modelBillingCopy(billing);
  const provider = "name" in copy ? (copy.name ?? "") : "";
  switch (copy.kind) {
    case "api":
      return t("Uses your {provider} API key. Rakazo does not pay for model usage.", { provider });
    case "local":
      return t(
        "Runs on infrastructure configured by the deployment owner. No model charges from Rakazo.",
      );
    case "custom":
      return t("Runs on a URL you control. Rakazo does not pay for model usage.");
    case "fixture":
      return t("No model charges. Deterministic fixture for tests.");
    case "configured":
      return t("Configured model: {provider}", { provider });
    case "unavailable":
      return t(
        "{provider} subscription login is not in the Rakazo UI yet. Skip if this deployment already has credentials.",
        { provider },
      );
    case "subscription":
      return t("Sign in with {provider}. Uses your subscription. Rakazo does not pay.", {
        provider,
      });
    case "grok":
      return t(
        "Sign in with SuperGrok or X Premium, or paste an xAI API key. Rakazo does not pay.",
      );
    case "literal":
      return copy.text;
  }
}
