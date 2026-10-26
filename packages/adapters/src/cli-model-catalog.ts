import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { findModelCredential } from "@rakazo/db";
import { createCliDiscoveryCache, discoverSelectedCliCredential } from "./cli-model-admission.js";
import type { DiscoveredCliModel, discoverCodexModels } from "./cli-model-discovery.js";
import { isCliModelProvider } from "./cli-model-process.js";
import type { SpaceCatalogAuth } from "./model-selection.js";
import type { PiCatalogEntry } from "./pi-models.js";

const source = "Codex app-server model/list";
export function discoveredCliCapabilities(
  model: DiscoveredCliModel,
): PiCatalogEntry["capabilities"] {
  return {
    imageInput: {
      value: model.inputModalities === undefined ? null : model.inputModalities.includes("image"),
      source: model.inputModalities === undefined ? null : source,
    },
    reasoning: {
      value:
        model.supportedReasoningEfforts === undefined
          ? null
          : model.supportedReasoningEfforts.length > 0,
      source: model.supportedReasoningEfforts === undefined ? null : source,
    },
  };
}

/** Read only the selected credentials; never borrow another account's catalog. */
export async function cliCatalogForSpace(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: { userId: string; spaceId: string },
  auth: SpaceCatalogAuth,
  catalog: PiCatalogEntry[],
  discover?: typeof discoverCodexModels,
  cacheOnly = false,
): Promise<PiCatalogEntry[]> {
  const cache = discover ? createCliDiscoveryCache(discover) : undefined;
  const read = async (modelId: string) => {
    const credential = await findModelCredential(prisma, scope, "codex-cli", modelId);
    if (!credential) return { status: "static" as const, models: null };
    return discoverSelectedCliCredential(prisma, secretStore, scope, credential, cacheOnly, cache);
  };
  const selected = (entry: PiCatalogEntry) =>
    (auth.byModel[entry.provider]?.[entry.id] ?? auth.byProvider[entry.provider]) === "cli";
  const candidates = new Set<string>();
  const result: PiCatalogEntry[] = [];
  for (const entry of catalog) {
    if (!isCliModelProvider(entry.provider)) {
      result.push(entry);
      continue;
    }
    const fallback: PiCatalogEntry = {
      ...entry,
      discovery: { status: "static", source: "Rakazo static CLI catalog (not discovered)" },
    };
    if (entry.provider !== "codex-cli" || !selected(entry)) {
      result.push(fallback);
      continue;
    }
    const discovered = await read(entry.id);
    if (discovered.status !== "discovered") {
      result.push(fallback);
      continue;
    }
    for (const model of discovered.models) if (!model.hidden) candidates.add(model.model);
    const model = discovered.models.find((model) => model.model === entry.id && !model.hidden);
    if (model)
      result.push({
        ...entry,
        label: model.displayName || entry.label,
        discovery: { status: "discovered", source },
        capabilities: discoveredCliCapabilities(model),
      });
  }
  for (const id of candidates) {
    if (catalog.some((entry) => entry.provider === "codex-cli" && entry.id === id)) continue;
    // A model-specific preference can choose a different account from the one
    // that supplied this candidate. Confirm against that actual credential.
    const discovered = await read(id);
    const model =
      discovered.status === "discovered"
        ? discovered.models.find((model) => model.model === id && !model.hidden)
        : undefined;
    if (!model) continue;
    result.push({
      provider: "codex-cli",
      providerName: "Codex CLI",
      id,
      label: model.displayName || id,
      billing: "Subscription",
      auth: "oauth",
      subscription: true,
      discovery: { status: "discovered", source },
      capabilities: discoveredCliCapabilities(model),
      contextWindow: null,
      maxTokens: null,
    });
  }
  return result;
}
