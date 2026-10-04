import type { MessageBlock } from "@rakazo/contracts";
import { localizeOnboardingBlock } from "@rakazo/core";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

export function ChoiceCard({
  botId,
  block,
}: {
  botId: string;
  block: Extract<MessageBlock, { kind: "choice" }>;
}) {
  const { locale, t } = useI18n();
  const tokens = useMobileTokens();
  const [pending, setPending] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const localized = localizeOnboardingBlock(block, locale);
  if (localized.kind !== "choice" || dismissed || block.answerId === "_dismissed") return null;

  async function choose(optionId: string) {
    setPending(true);
    setError(null);
    try {
      await rpc("onboarding/choose", { botId, optionId });
    } catch {
      setError(t("Could not save this choice"));
    } finally {
      setPending(false);
    }
  }

  async function dismiss() {
    setPending(true);
    setError(null);
    try {
      await rpc("onboarding/dismissFocus", { botId });
      setDismissed(true);
    } catch {
      setError(t("Could not dismiss"));
    } finally {
      setPending(false);
    }
  }

  return (
    <View
      style={{
        backgroundColor: tokens.card,
        borderColor: tokens.border,
        borderWidth: 1,
        borderRadius: 20,
        padding: 16,
        gap: 12,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ flex: 1, color: tokens.foreground, fontSize: 16 }}>
          {localized.question}
        </Text>
        {!block.answerId ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Dismiss")}
            disabled={pending}
            onPress={() => void dismiss()}
            hitSlop={12}
          >
            <Text style={{ color: tokens.mutedForeground, fontSize: 20 }}>×</Text>
          </Pressable>
        ) : null}
      </View>
      {localized.options
        .filter((option) => !block.answerId || option.id === block.answerId)
        .map((option) => (
          <Pressable
            key={option.id}
            accessibilityRole="button"
            accessibilityState={{
              disabled: pending || Boolean(block.answerId),
              selected: option.id === block.answerId,
            }}
            disabled={pending || Boolean(block.answerId)}
            onPress={() => void choose(option.id)}
            style={{
              backgroundColor: tokens.muted,
              borderRadius: 12,
              padding: 14,
              flexDirection: "row",
              gap: 12,
            }}
          >
            <Text style={{ color: tokens.mutedForeground }}>{option.letter}</Text>
            <Text style={{ flex: 1, color: tokens.foreground, fontSize: 15 }}>{option.label}</Text>
            {block.answerId === option.id ? (
              <Text style={{ color: tokens.mutedForeground }}>✓</Text>
            ) : null}
          </Pressable>
        ))}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
