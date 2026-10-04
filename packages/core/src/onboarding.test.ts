import type { MessageBlock } from "@rakazo/contracts";
import {
  MessageBlock as MessageBlockSchema,
  ONBOARDING_COPY,
  OnboardingApp,
  OnboardingFocus,
  onboardingText,
  UI_LOCALES,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { localizeOnboardingMessage } from "./onboarding.js";

describe("shared onboarding localization", () => {
  it.each(UI_LOCALES)("covers every focus and app, plus one/two/three cards in %s", (locale) => {
    const copy = ONBOARDING_COPY[locale];
    for (const focus of OnboardingFocus.options) {
      expect(copy.labels[focus].trim()).not.toBe("");
      expect(onboardingText({ id: "focus.ack", focus }, locale)).not.toContain("undefined");
    }
    for (const app of OnboardingApp.options) expect(copy.apps[app].trim()).not.toBe("");
    for (const count of [1, 2, 3]) {
      const text = onboardingText({ id: "apps.ready", count }, locale);
      expect(text).not.toContain("undefined");
      if (locale !== "en") expect(text).not.toBe(onboardingText({ id: "apps.ready", count }, "en"));
    }
  });

  it("relocalizes persisted references after switching languages without changing the saved message", () => {
    const block: MessageBlock = {
      kind: "text",
      text: ONBOARDING_COPY.fr.next,
      onboarding: { id: "focus.next" },
    };
    const original = { role: "bot", blocks: [block] };
    expect(localizeOnboardingMessage(original, "zh-CN").blocks[0]).toMatchObject({
      text: "你想先从哪项任务开始？",
    });
    expect(original.blocks[0]).toEqual(block);
    expect(localizeOnboardingMessage(original, "en").blocks[0]).toMatchObject({
      text: ONBOARDING_COPY.en.next,
    });
    expect(MessageBlockSchema.parse(block)).toEqual(block);
  });

  it("translates legacy deterministic copy but preserves user input and freeform model replies", () => {
    const legacy: MessageBlock[] = [
      { kind: "text", text: ONBOARDING_COPY.en.ack(ONBOARDING_COPY.en.summaries.everything) },
      { kind: "text", text: ONBOARDING_COPY.en.next },
      { kind: "text", text: "I’m Chief. My responsibilities are still undefined." },
    ];
    const translated = localizeOnboardingMessage({ role: "bot", blocks: legacy }, "zh-CN");
    expect(translated.blocks[0]).toMatchObject({
      text: ONBOARDING_COPY["zh-CN"].ack("Slack、日历和邮件"),
    });
    expect(translated.blocks[1]).toMatchObject({ text: ONBOARDING_COPY["zh-CN"].next });
    expect(translated.blocks[2]).toBe(legacy[2]);
    const user = { role: "user", blocks: legacy };
    expect(localizeOnboardingMessage(user, "zh-CN")).toBe(user);
  });

  it("formats application lists with the locale's conjunction", () => {
    expect(
      onboardingText({ id: "apps.suggest", names: ["Slack", "Gmail", "Calendar"] }, "zh-CN"),
    ).toContain("Slack、Gmail和Calendar");
    expect(onboardingText({ id: "apps.suggest", names: ["Slack"] }, "en")).toContain(
      "Slack is a good place",
    );
  });
});
