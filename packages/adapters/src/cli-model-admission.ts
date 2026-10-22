import { createHash } from "node:crypto";
import type { AgentRunModel, SecretStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { findModelCredential } from "@rakazo/db";
import type { CliDiscoveryResult } from "./cli-model-discovery.js";
import { discoverCodexModels } from "./cli-model-discovery.js";
import { listPiCatalog } from "./pi-models.js";
import { parseModelSecret } from "./pi-oauth.js";

type Admission = NonNullable<AgentRunModel["cliDiscovery"]>;
const cachedEvidence = new WeakMap<CliDiscoveryResult, () => boolean>();
const issuedEvidence = new WeakMap<Admission, () => boolean>();

export function validCliDiscoveryEvidence(config: AgentRunModel): boolean {
  const evidence = config.cliDiscovery;
  return (
    config.provider === "codex-cli" &&
    Boolean(
      evidence &&
        evidence.modelId === config.id &&
        evidence.profileId === config.apiKey &&
        issuedEvidence.get(evidence)?.(),
    )
  );
}

type Scope = Pick<Actor, "userId" | "spaceId">;
const unavailable: CliDiscoveryResult = { status: "static", models: null };
export const MODEL_NOT_DISCOVERED = "model_not_discovered: reconnect or refresh the model catalog";

export function isNewCodexCliModel(provider: string, modelId: string): boolean {
  return (
    provider === "codex-cli" &&
    !listPiCatalog().some((entry) => entry.provider === provider && entry.id === modelId)
  );
}

type CacheEntry = {
  expires: number;
  result?: CliDiscoveryResult;
  pending?: Promise<CliDiscoveryResult>;
};

/** Process-local evidence only. Expired results never authorise new model IDs. */
export function createCliDiscoveryCache(
  discover: typeof discoverCodexModels = discoverCodexModels,
  now: () => number = () => Date.now(),
) {
  const entries = new Map<string, CacheEntry>();
  return async (key: string, profileId: string, cacheOnly = false): Promise<CliDiscoveryResult> => {
    const entry = entries.get(key);
    if (entry?.result && entry.expires > now()) return entry.result;
    if (cacheOnly) return unavailable;
    if (entry?.pending) return entry.pending;
    // Bound both settled and in-flight entries without evicting active requests.
    if (entries.size >= 128) {
      const victim = [...entries].find(([, value]) => !value.pending);
      if (!victim) return unavailable;
      entries.delete(victim[0]);
    }
    const next: CacheEntry = { expires: 0 };
    entries.set(key, next);
    next.pending = Promise.resolve()
      .then(() => discover(profileId, 5_000))
      .catch(() => unavailable)
      .then((result) => {
        next.result =
          result.status === "discovered"
            ? { status: "discovered", models: result.models.map((model) => ({ ...model })) }
            : { status: "static", models: null };
        next.expires = now() + (result.status === "discovered" ? 60_000 : 5_000);
        cachedEvidence.set(next.result, () => entries.get(key) === next && next.expires > now());
        next.pending = undefined;
        return next.result;
      });
    return next.pending;
  };
}
const processDiscovery = createCliDiscoveryCache();

/** Always reload the exact selected secret before consulting cached evidence. */
export async function discoverSelectedCliCredential(
  prisma: Pick<PrismaClient, "secret">,
  secretStore: Pick<SecretStore, "load">,
  scope: Scope,
  credential: { id: string; secretId: string },
  cacheOnly = false,
  discover = processDiscovery,
): Promise<CliDiscoveryResult> {
  const secret = await prisma.secret.findFirst({
    where: { id: credential.secretId, userId: scope.userId, spaceId: null },
    select: { id: true, ciphertext: true },
  });
  if (!secret) return unavailable;
  try {
    const parsed = parseModelSecret(await secretStore.load(secret.ciphertext, secret.id));
    if (parsed.kind !== "cli") return unavailable;
    // Keep ciphertext out of cache keys, logs and error messages.
    const ref = createHash("sha256").update(secret.ciphertext).digest("hex");
    const key = JSON.stringify([
      scope.userId,
      scope.spaceId,
      credential.id,
      secret.id,
      ref,
      parsed.credential.profileId,
    ]);
    return await discover(key, parsed.credential.profileId, cacheOnly);
  } catch {
    return unavailable;
  }
}

export async function admittedCliModel(
  prisma: PrismaClient,
  secretStore: Pick<SecretStore, "load">,
  scope: Scope,
  modelId: string,
  cacheOnly = false,
): Promise<Admission | undefined> {
  const credential = await findModelCredential(prisma, scope, "codex-cli", modelId);
  if (!credential) return undefined;
  const result = await discoverSelectedCliCredential(
    prisma,
    secretStore,
    scope,
    credential,
    cacheOnly,
  );
  const model =
    result.status === "discovered"
      ? result.models.find((model) => model.model === modelId && !model.hidden)
      : undefined;
  const valid = cachedEvidence.get(result);
  if (!model || !valid?.()) return undefined;
  // Read the selected profile again; no secret or identity crosses the request boundary.
  const secret = await prisma.secret.findFirst({
    where: { id: credential.secretId, userId: scope.userId, spaceId: null },
    select: { id: true, ciphertext: true },
  });
  if (!secret) return undefined;
  try {
    const parsed = parseModelSecret(await secretStore.load(secret.ciphertext, secret.id));
    if (parsed.kind !== "cli") return undefined;
    // A reconnect between reads cannot inherit evidence for the old secret.
    const current = await discoverSelectedCliCredential(
      prisma,
      secretStore,
      scope,
      credential,
      true,
    );
    if (current !== result) return undefined;
    const evidence: Admission = Object.freeze({
      modelId,
      profileId: parsed.credential.profileId,
      imageInput:
        model.inputModalities === undefined ? null : model.inputModalities.includes("image"),
      reasoning:
        model.supportedReasoningEfforts === undefined
          ? null
          : model.supportedReasoningEfforts.length > 0,
    });
    issuedEvidence.set(evidence, valid);
    return evidence;
  } catch {
    return undefined;
  }
}
