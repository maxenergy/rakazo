import type { MessageBlock, OnboardingText, UiLocale } from "@rakazo/contracts";
import { ONBOARDING_COPY, OnboardingApp, OnboardingFocus, onboardingText } from "@rakazo/contracts";

function legacyTextReference(text: string): OnboardingText | undefined {
  const english = ONBOARDING_COPY.en;
  if (text === english.next) return { id: "focus.next" };
  for (const focus of OnboardingFocus.options) {
    if (text === english.ack(english.summaries[focus])) return { id: "focus.ack", focus };
  }
  const ready = /^Hit those (one|two|three) and I’ll start pulling the picture\.$/.exec(text);
  if (ready) return { id: "apps.ready", count: ["one", "two", "three"].indexOf(ready[1]!) + 1 };
  const suffix =
    " are a good place to start. Connect them here and I’ll use what you already have.";
  if (text.endsWith(suffix)) {
    const names = text.slice(0, -suffix.length).split(/, and |, /);
    if (names.length >= 1 && names.length <= 3 && names.every(Boolean))
      return { id: "apps.suggest", names };
  }
  return undefined;
}

/** Translate product-authored onboarding only, including messages saved before references existed. */
export function localizeOnboardingBlock(block: MessageBlock, locale: UiLocale): MessageBlock {
  if (block.kind === "text") {
    const reference = block.onboarding ?? legacyTextReference(block.text);
    return reference ? { ...block, text: onboardingText(reference, locale) } : block;
  }
  const copy = ONBOARDING_COPY[locale];
  if (
    block.kind === "choice" &&
    (block.onboarding === "focus" || block.question === ONBOARDING_COPY.en.question)
  ) {
    return {
      ...block,
      question: copy.question,
      options: block.options.map((option) => {
        const focus = OnboardingFocus.safeParse(option.id);
        return focus.success ? { ...option, label: copy.labels[focus.data] } : option;
      }),
    };
  }
  if (block.kind === "app_connect") {
    const app =
      block.onboardingApp ??
      OnboardingApp.options.find((app) => ONBOARDING_COPY.en.apps[app] === block.description);
    return app ? { ...block, description: copy.apps[app] } : block;
  }
  return block;
}

export function localizeOnboardingMessage<T extends { role: string; blocks: MessageBlock[] }>(
  message: T,
  locale: UiLocale,
): T {
  return message.role === "bot"
    ? { ...message, blocks: message.blocks.map((block) => localizeOnboardingBlock(block, locale)) }
    : message;
}
