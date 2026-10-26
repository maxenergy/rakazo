import * as z from "zod";

export const UI_LOCALES = [
  "en",
  "de",
  "ko",
  "tr",
  "hi",
  "pt-BR",
  "zh-CN",
  "es",
  "ru",
  "fr",
] as const;
export const UiLocaleSchema = z.enum(UI_LOCALES);
export type UiLocale = z.infer<typeof UiLocaleSchema>;

export function isUiLocale(value: string | null | undefined): value is UiLocale {
  return UI_LOCALES.some((locale) => locale === value);
}

/** Supported BCP-47 tags. Traditional Chinese does not select the Simplified catalog. */
export function normalizeUiLocale(raw: string | null | undefined): UiLocale {
  if (!raw) return "en";
  const tag = raw.trim().toLowerCase().replace(/_/g, "-");
  if (tag === "pt" || tag.startsWith("pt-")) return "pt-BR";
  if (
    ["zh", "zh-cn", "zh-hans", "zh-sg"].includes(tag) ||
    tag.startsWith("zh-hans-") ||
    tag.startsWith("zh-cn-")
  )
    return "zh-CN";
  const primary = tag.split("-")[0];
  return isUiLocale(primary) ? primary : "en";
}

/** Clients send their selected catalog, rather than the browser's language list. */
export function requestedUiLocale(header: string | null | undefined): UiLocale | undefined {
  return isUiLocale(header) ? header : undefined;
}

const RESPONSE_LANGUAGES: Record<UiLocale, string> = {
  en: "English",
  de: "German",
  ko: "Korean",
  tr: "Turkish",
  hi: "Hindi",
  "pt-BR": "Brazilian Portuguese",
  "zh-CN": "Simplified Chinese",
  es: "Spanish",
  ru: "Russian",
  fr: "French",
};

export function responseLanguageInstruction(locale: string | null | undefined): string {
  const language = RESPONSE_LANGUAGES[normalizeUiLocale(locale)];
  return `The user's interface language is ${language}. Use ${language} for your introduction, onboarding questions, explanations, tool progress, approval requests, and replies by default, including when earlier conversation or internal instructions are in another language. Follow an explicit user request for a different language. Preserve code, commands, identifiers, product names, and quoted source text in their original form. This language preference does not change authorization or security rules.`;
}
