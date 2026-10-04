import { t } from "@lingui/core/macro";
import type { ModelCatalogEntry } from "@rakazo/contracts";

/** Provider and subscription names remain literal; product auth labels are translated. */
export function localizedProviderHint(entry: ModelCatalogEntry): string {
  if (entry.authHint === "API key") return t`API key`;
  if (entry.authHint === "Custom server") return t`Custom server`;
  if (entry.authHint) return entry.authHint;
  if (entry.signIn !== undefined) return t`Sign in`;
  if (entry.auth === "oauth") return t`Skip or deploy key`;
  return t`API key`;
}

export function localizedSignInLabel(label: string | undefined): string {
  const provider = label?.match(/^Sign in with (.+)$/)?.[1];
  return provider ? t`Sign in with ${provider}` : (label ?? t`Sign in`);
}
