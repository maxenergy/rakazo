import { recommendModels } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateBotModelSelection } from "./bot-model-tools.js";
import { admittedCliModel } from "./cli-model-admission.js";
import { cliCatalogForSpace } from "./cli-model-catalog.js";
import { discoverCodexModels } from "./cli-model-discovery.js";
import { createRunExecutor } from "./executor.js";
import {
  pinnedModelCredentialError,
  prepareStoredModelAuth,
  validateConnectedModelChoice,
} from "./model-selection.js";
import {
  codexDiscoveredTransportLimits,
  modelsForRequest,
  resolveRuntimeModel,
} from "./pi-runtime.js";

vi.mock("./cli-model-discovery.js", () => ({ discoverCodexModels: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

const id = "fixture-discovered-codex";
const profileId = "11111111-1111-4111-8111-111111111111";
let sequence = 0;
function fixture() {
  const scope = { userId: "admission-user", spaceId: String(++sequence) };
  const credential = {
    id: "credential",
    userId: scope.userId,
    provider: "codex-cli",
    label: "Fixture",
    secretId: "secret",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    defaultModel: id,
    thinkingLevel: null,
  };
  const preference = {
    id: "preference",
    credential,
    isDefault: true,
    modelId: id,
    thinkingLevel: null,
    updatedAt: new Date(0),
  };
  const preferences = [preference];
  const raw = {
    spaceModelPreference: {
      findMany: vi.fn(async () => preferences),
      findFirst: vi.fn(async () => preference),
    },
    userModelCredential: { findMany: vi.fn(async () => [credential]) },
    secret: { findFirst: vi.fn(async () => ({ id: "secret", ciphertext: "cipher" })) },
    deploymentSettings: { findUnique: vi.fn(async () => null) },
    bot: {
      findFirst: vi.fn(async () => ({
        modelProvider: "codex-cli",
        modelId: id,
        thinkingLevel: null,
      })),
    },
  };
  const load = vi.fn(async () =>
    JSON.stringify({ kind: "cli", credential: { type: "cli", profileId } }),
  );
  const prisma = raw as unknown as PrismaClient;
  return { scope, credential, preferences, raw, load, prisma };
}
function discovered() {
  vi.mocked(discoverCodexModels).mockResolvedValue({
    status: "discovered",
    models: [
      { id, model: id, displayName: "New Codex" },
      { id: "hidden", model: "fixture-hidden", displayName: "Hidden", hidden: true },
    ],
  });
}

describe("discovered Codex admission paths", () => {
  it("lists, selects and admits a new ID, keeping capability/price/context unknown", async () => {
    discovered();
    const f = fixture();
    const store = { load: f.load };
    const catalog = await cliCatalogForSpace(
      f.prisma,
      store,
      f.scope,
      {
        byProvider: { "codex-cli": "cli" },
        byModel: {},
        secretIdByProvider: { "codex-cli": "secret" },
        secretIdByModel: {},
      },
      [
        {
          provider: "codex-cli",
          providerName: "Codex CLI",
          id: "gpt-6.1-sol",
          label: "Codex",
          auth: "oauth",
          billing: "Subscription",
          subscription: true,
        },
      ],
    );
    expect(catalog).toEqual([
      expect.objectContaining({
        id,
        contextWindow: null,
        capabilities: {
          imageInput: { value: null, source: null },
          reasoning: { value: null, source: null },
        },
      }),
    ]);
    expect(catalog[0]?.pricing).toBeUndefined();
    expect(
      recommendModels(catalog, { capabilities: ["imageInput"] }, () => "cli").recommendations,
    ).toEqual([]);
    expect(recommendModels(catalog, { contextWindow: 1 }, () => "cli").recommendations).toEqual([]);
    expect(
      await validateConnectedModelChoice(f.prisma, f.scope, "codex-cli", id, store),
    ).toBeUndefined();
    expect(
      await validateBotModelSelection(
        { prisma: f.prisma, secretStore: store },
        f.scope,
        "codex-cli",
        id,
      ),
    ).toBeUndefined();
    expect(
      (
        await prepareStoredModelAuth(
          f.prisma,
          store,
          f.scope.userId,
          "secret",
          "codex-cli",
          id,
          undefined,
          undefined,
          { spaceId: f.scope.spaceId, credentialId: f.credential.id },
        )
      ).auth,
    ).toEqual({ status: "ready" });
    expect(
      pinnedModelCredentialError(
        { modelProvider: "codex-cli", modelId: id, thinkingLevel: null },
        f.credential,
      ),
    ).toBeUndefined();
    expect(await admittedCliModel(f.prisma, store, f.scope, "fixture-hidden")).toBeUndefined();
    expect(await admittedCliModel(f.prisma, store, f.scope, "fixture-absent")).toBeUndefined();
  });

  it("constructs an admitted runtime ID with derived transport limits", async () => {
    discovered();
    const f = fixture();
    const evidence = await admittedCliModel(f.prisma, { load: f.load }, f.scope, id);
    const resolved = resolveRuntimeModel({
      provider: "codex-cli",
      id,
      apiKey: profileId,
      cliDiscovery: evidence,
    });
    expect(resolved.model).toMatchObject({
      id,
      provider: "codex-cli",
      api: "rakazo-cli",
      ...codexDiscoveredTransportLimits(),
      input: ["text"],
      reasoning: false,
    });
    const statics = modelsForRequest(
      { model: { provider: "codex-cli", id: "gpt-6.1-sol" } },
      "codex-cli",
    )
      .getProvider("codex-cli")!
      .getModels();
    expect(resolved.model?.contextWindow).toBe(
      Math.min(...statics.map((model) => model.contextWindow)),
    );
    expect(resolved.model?.maxTokens).toBe(Math.min(...statics.map((model) => model.maxTokens)));
  });

  it("keeps unadmitted, mismatched credentials and other providers unknown", async () => {
    discovered();
    const f = fixture();
    const evidence = await admittedCliModel(f.prisma, { load: f.load }, f.scope, id);
    expect(
      resolveRuntimeModel({ provider: "codex-cli", id, apiKey: profileId }).model,
    ).toBeUndefined();
    expect(
      resolveRuntimeModel({
        provider: "codex-cli",
        id,
        apiKey: "different-profile",
        cliDiscovery: evidence,
      }).model,
    ).toBeUndefined();
    expect(
      resolveRuntimeModel({
        provider: "claude-code",
        id,
        apiKey: profileId,
        cliDiscovery: evidence,
      }).model,
    ).toBeUndefined();
    expect(
      resolveRuntimeModel({
        provider: "codex-cli",
        id,
        apiKey: profileId,
        cliDiscovery: { ...evidence! },
      }).model,
    ).toBeUndefined();
  });

  it("uses the same admission for primary and cache-only fallback, failing closed after expiry", async () => {
    discovered();
    vi.useFakeTimers();
    const f = fixture();
    const executor = createRunExecutor({
      prisma: f.prisma,
      secretStore: { load: f.load },
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    const primary = await executor.resolveModel(f.scope);
    expect(primary.cliDiscovery?.modelId).toBe(id);
    const fallback = await executor.resolveConnectedModel(
      f.scope,
      "codex-cli",
      id,
      undefined,
      true,
      true,
    );
    expect(fallback.cliDiscovery?.modelId).toBe(id);
    await expect(
      executor.resolveConnectedModel(
        { ...f.scope, spaceId: "other" },
        "codex-cli",
        id,
        undefined,
        true,
        true,
      ),
    ).rejects.toThrow(/model_not_discovered/);
    await expect(
      executor.resolveConnectedModel(
        { ...f.scope, userId: "other" },
        "codex-cli",
        id,
        undefined,
        true,
        true,
      ),
    ).rejects.toThrow(/model_not_discovered/);
    f.raw.secret.findFirst.mockResolvedValue({ id: "secret", ciphertext: "changed" });
    await expect(
      executor.resolveConnectedModel(f.scope, "codex-cli", id, undefined, true, true),
    ).rejects.toThrow(/model_not_discovered/);
    f.raw.secret.findFirst.mockResolvedValue({ id: "secret", ciphertext: "cipher" });
    vi.advanceTimersByTime(60_000);
    vi.mocked(discoverCodexModels).mockResolvedValue({ status: "static", models: null });
    await expect(executor.resolveModel(f.scope)).rejects.toThrow(/model_not_discovered/);
    expect(f.preferences[0]?.modelId).toBe(id);
  });
});
