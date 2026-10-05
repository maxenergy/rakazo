import type { Actor } from "@rakazo/contracts";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { findModelCredential } from "@rakazo/db";
import {
  isCatalogModelChoice,
  modelCredentialAuthKindsForSpace,
  readStoredModelAuth,
  validateConnectedModelChoice,
} from "./model-selection.js";
import { listAvailablePiCatalog } from "./pi-catalog-availability.js";
import type { CodexLiveCatalog } from "./pi-codex-catalog.js";
import { applyCodexLiveCatalog, codexLiveCatalogsForSpace } from "./pi-codex-catalog.js";
import type { EncryptedSecretStore } from "./secrets.js";

type BotModelScope = Pick<Actor, "userId" | "spaceId">;
type BotModelDeps = {
  prisma: PrismaClient;
  secretStore: Pick<EncryptedSecretStore, "load">;
  codexCatalog?: CodexLiveCatalog;
};

export function parseBotModelSelection(
  args: Record<string, unknown>,
): { modelProvider?: string; modelId?: string } | { error: string } {
  const provider = args.model_provider;
  const modelId = args.model_id;
  if (
    (provider != null && typeof provider !== "string") ||
    (modelId != null && typeof modelId !== "string")
  ) {
    return { error: "model_provider and model_id must be strings." };
  }
  const modelProvider = String(provider ?? "").trim();
  const model = String(modelId ?? "").trim();
  if (Boolean(modelProvider) !== Boolean(model)) {
    return { error: "model_provider and model_id must both be set." };
  }
  if (modelProvider.length > 80 || model.length > 200) {
    return { error: "Model provider or model ID is too long." };
  }
  return { modelProvider: modelProvider || undefined, modelId: model || undefined };
}

export async function validateBotModelSelection(
  deps: BotModelDeps,
  scope: BotModelScope,
  provider: string,
  modelId: string,
) {
  const error = await validateConnectedModelChoice(deps.prisma, scope, provider, modelId);
  if (error) return error;
  const credential = await findModelCredential(deps.prisma, scope, provider, modelId);
  if (!credential) return "Connect that model provider first";
  if (!isCatalogModelChoice(provider, modelId) && credential.defaultModel !== modelId) {
    return "Unknown model for that provider";
  }
  const auth = await readStoredModelAuth(
    deps.prisma,
    deps.secretStore,
    scope.userId,
    credential.secretId,
    provider,
    modelId,
    deps.codexCatalog,
  );
  if (auth.status === "rejected") return auth.message;
  if (auth.status !== "ready") return "Reconnect that model provider first";
  return undefined;
}

export async function listConnectedBotModels(deps: BotModelDeps, scope: BotModelScope) {
  const auth = await modelCredentialAuthKindsForSpace(deps.prisma, deps.secretStore, scope);
  let catalog = listAvailablePiCatalog(auth.byProvider, auth.byModel);
  if (deps.codexCatalog) {
    const live = await codexLiveCatalogsForSpace(
      deps.prisma,
      deps.secretStore,
      scope,
      auth,
      deps.codexCatalog,
    );
    if (live.size > 0) catalog = applyCodexLiveCatalog(catalog, auth, live);
  }
  const models = catalog
    .filter((entry) => {
      const kind = auth.byModel[entry.provider]?.[entry.id] ?? auth.byProvider[entry.provider];
      return !entry.placeholder && kind !== undefined && kind !== "disconnected";
    })
    .map(({ provider, providerName, id, label }) => ({ provider, providerName, id, label }));
  const custom = await deps.prisma.spaceModelPreference.findMany({
    where: {
      userId: scope.userId,
      spaceId: scope.spaceId,
      modelId: { not: null },
      credential: { userId: scope.userId, provider: OPENAI_COMPATIBLE_PROVIDER_ID },
    },
    select: { modelId: true },
  });
  for (const preference of custom) {
    const id = preference.modelId?.trim();
    if (
      !id ||
      models.some((model) => model.provider === OPENAI_COMPATIBLE_PROVIDER_ID && model.id === id)
    )
      continue;
    if (await validateBotModelSelection(deps, scope, OPENAI_COMPATIBLE_PROVIDER_ID, id)) continue;
    models.push({
      provider: OPENAI_COMPATIBLE_PROVIDER_ID,
      providerName: "OpenAI-compatible",
      id,
      label: id,
    });
  }
  return { models };
}

export async function setBotModelFromTool(
  deps: BotModelDeps,
  scope: BotModelScope & { botId: string },
  args: Record<string, unknown>,
) {
  const selection = parseBotModelSelection(args);
  if ("error" in selection) return selection;
  if (!selection.modelProvider || !selection.modelId) {
    return { error: "model_provider and model_id are required. Use list_models for exact IDs." };
  }
  const botId = String(args.bot_id ?? "").trim() || scope.botId;
  const where = {
    id: botId,
    userId: scope.userId,
    spaceId: scope.spaceId,
    archivedAt: null,
    OR: [{ id: scope.botId }, { parentBotId: scope.botId }],
  };
  const bot = await deps.prisma.bot.findFirst({
    where,
    select: { id: true, name: true, modelProvider: true, modelId: true },
  });
  if (!bot) return { error: "Only this bot or an active bot it created can be configured." };
  const error = await validateBotModelSelection(
    deps,
    scope,
    selection.modelProvider,
    selection.modelId,
  );
  if (error) return { error };
  const updated = await deps.prisma.bot.updateMany({
    where,
    data: {
      ...selection,
      ...(selection.modelProvider !== bot.modelProvider || selection.modelId !== bot.modelId
        ? { thinkingLevel: null }
        : {}),
    },
  });
  if (updated.count !== 1) return { error: "That bot is no longer available." };
  return { ok: true as const, botId: bot.id, name: bot.name, ...selection };
}
