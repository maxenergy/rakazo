import { normalizeUiLocale as normalizeSharedUiLocale } from "@rakazo/contracts";

export const UI_LOCALES = ["en", "zh-CN", "ru", "de"] as const;

export type UiLocale = (typeof UI_LOCALES)[number];

/** Locales offered on the mobile Account language picker. */
export const ACCOUNT_UI_LOCALES = ["en", "zh-CN"] as const satisfies readonly UiLocale[];

export type AccountUiLocale = (typeof ACCOUNT_UI_LOCALES)[number];

export const UI_LOCALE_STORAGE_KEY = "rakazo.uiLocale";

export const UI_LOCALE_LABELS: Record<UiLocale, string> = {
  en: "English",
  "zh-CN": "简体中文",
  ru: "Русский",
  de: "Deutsch",
};

/** Convert an internal locale identifier to the document language tag. */
export function htmlLangForLocale(locale: string): string {
  return locale === "zh-CN" ? "zh-CN" : locale;
}

/** Return whether a value is one of the supported mobile UI locales. */
export function isUiLocale(value: string | null | undefined): value is UiLocale {
  return value === "en" || value === "zh-CN" || value === "ru" || value === "de";
}

/** Normalize BCP-47 tags to a mobile UI locale, else `en`. */
export function normalizeUiLocale(raw: string | null | undefined): UiLocale {
  const locale = normalizeSharedUiLocale(raw);
  return isUiLocale(locale) ? locale : "en";
}

export type ResolveUiLocaleOptions = {
  stored?: string | null;
  envDefault?: string | null;
  deviceLanguage?: string | null;
};

/**
 * Order: saved choice → `EXPO_PUBLIC_DEFAULT_UI_LOCALE` → device language → English.
 */
export function resolveUiLocale(options: ResolveUiLocaleOptions = {}): UiLocale {
  if (options.stored) return normalizeUiLocale(options.stored);
  if (options.envDefault) return normalizeUiLocale(options.envDefault);
  if (options.deviceLanguage) return normalizeUiLocale(options.deviceLanguage);
  return "en";
}
