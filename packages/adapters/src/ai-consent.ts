import { createHash } from "node:crypto";
import type { AiDataUse, AiRecipient } from "@rakazo/contracts";
import { AI_DISCLOSURE_VERSION } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { localBaseUrl } from "./pi-local-provider.js";
import { listPiCatalog } from "./pi-models.js";
import { voiceCatalogEntry } from "./voice-factory.js";

const PRIVACY_URLS: Record<string, string> = {
  cursor: "https://cursor.com/privacy",
  openrouter: "https://openrouter.ai/privacy",
  openai: "https://openai.com/policies/privacy-policy/",
  "openai-codex": "https://openai.com/policies/privacy-policy/",
  anthropic: "https://www.anthropic.com/legal/privacy",
  google: "https://policies.google.com/privacy",
  "vercel-ai-gateway": "https://vercel.com/legal/privacy-policy",
  elevenlabs: "https://elevenlabs.io/privacy-policy",
  cartesia: "https://cartesia.ai/legal/privacy",
  "fish-audio": "https://fish.audio/privacy/",
  supermemory: "https://supermemory.ai/privacy",
};

/** Never expose endpoint paths, query parameters, user info, or credentials in a disclosure. */
export function aiRecipient(input: {
  provider: string;
  use: AiDataUse;
  modelId?: string;
  baseUrl?: string;
}): Omit<AiRecipient, "allowed"> | null {
  if (input.provider === "scripted") return null;
  const endpoint = input.baseUrl ?? (input.provider === "local" ? localBaseUrl() : undefined);
  const origin = endpoint ? new URL(endpoint).origin : undefined;
  const name = recipientName(input.provider, input.use);
  // Bind custom connections to the full endpoint without exposing private URL components.
  const key = createHash("sha256")
    .update(JSON.stringify([input.use, input.provider, endpoint ?? "", input.modelId ?? ""]))
    .digest("hex");
  return {
    key,
    name: origin ? `${name} (${origin})` : name,
    use: input.use,
    detail: ["openrouter", "vercel-ai-gateway"].includes(input.provider)
      ? input.modelId
        ? `${input.modelId}, forwarded to its provider`
        : "Forwards to model providers"
      : (input.modelId ?? ""),
    privacyUrl: PRIVACY_URLS[input.provider],
  };
}

function recipientName(provider: string, use: AiDataUse) {
  if (use === "voice") return voiceCatalogEntry(provider)?.name ?? provider;
  if (use === "memory") return provider === "supermemory" ? "Supermemory" : provider;
  if (provider === "cursor") return "Cursor";
  return listPiCatalog().find((entry) => entry.provider === provider)?.providerName ?? provider;
}

export async function requireBackupModelConsent(
  prisma: Pick<PrismaClient, "aiDataConsent">,
  scope: { userId: string; spaceId: string },
  model: { provider: string; id: string; baseUrl?: string },
): Promise<void> {
  const recipient = aiRecipient({
    provider: model.provider,
    modelId: model.id,
    baseUrl: model.baseUrl,
    use: "model",
  });
  if (!recipient) return;
  const consent = await prisma.aiDataConsent.findUnique({
    where: { userId_spaceId_recipientKey: { ...scope, recipientKey: recipient.key } },
  });
  if (consent?.version !== AI_DISCLOSURE_VERSION)
    throw new Error("Backup model requires current AI data-sharing consent");
}
