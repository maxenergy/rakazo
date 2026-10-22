import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { discoverCodexModels } from "./cli-model-discovery.js";
import type { CliDiscoveryResult } from "./cli-model-discovery.js";
import { isCliModelProvider } from "./cli-model-process.js";
import type { SpaceCatalogAuth } from "./model-selection.js";
import type { PiCatalogEntry } from "./pi-models.js";
import { parseModelSecret } from "./pi-oauth.js";

/** Read only the selected credentials; never borrow another account's catalog. */
export async function cliCatalogForSpace(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: { userId: string; spaceId: string },
  auth: SpaceCatalogAuth,
  catalog: PiCatalogEntry[],
  discover: typeof discoverCodexModels = discoverCodexModels,
): Promise<PiCatalogEntry[]> {
  const selected = (entry: PiCatalogEntry): string | undefined => {
    const specific = auth.byModel[entry.provider]?.[entry.id];
    const kind = specific ?? auth.byProvider[entry.provider];
    if (kind !== "cli") return undefined;
    return specific === undefined
      ? auth.secretIdByProvider[entry.provider]
      : auth.secretIdByModel[entry.provider]?.[entry.id];
  };
  const ids = [...new Set(catalog.flatMap(entry => {
    const id = entry.provider === "codex-cli" ? selected(entry) : undefined;
    return id ? [id] : [];
  }))];
  const results = new Map<string, CliDiscoveryResult>();
  if (ids.length > 0) {
    const secrets = await prisma.secret.findMany({
      where: { id: { in: ids }, userId: scope.userId, spaceId: null },
      select: { id: true, ciphertext: true },
    });
    await Promise.all(secrets.map(async secret => {
      try {
        const parsed = parseModelSecret(await secretStore.load(secret.ciphertext, secret.id));
        if (parsed.kind === "cli") results.set(secret.id, await discover(parsed.credential.profileId));
      } catch {
        // Missing/unreadable profiles retain the labelled static catalog.
      }
    }));
  }
  return catalog.flatMap(entry => {
    if (!isCliModelProvider(entry.provider)) return [entry];
    const fallback: PiCatalogEntry = {
      ...entry, discovery: { status: "static", source: "Rakazo static CLI catalog (not discovered)" },
    };
    const id = selected(entry);
    const result = id ? results.get(id) : undefined;
    if (result?.status !== "discovered") return [fallback];
    const model = result.models.find(model => model.model === entry.id);
    if (!model) return [];
    const source = "Codex app-server model/list";
    return [{
      ...entry,
      label: model.displayName || entry.label,
      discovery: { status: "discovered" as const, source },
      capabilities: {
        imageInput: { value: model.inputModalities === undefined ? null : model.inputModalities.includes("image"), source: model.inputModalities === undefined ? null : source },
        reasoning: { value: model.supportedReasoningEfforts === undefined ? null : model.supportedReasoningEfforts.length > 0, source: model.supportedReasoningEfforts === undefined ? null : source },
      },
    }];
  });
}
