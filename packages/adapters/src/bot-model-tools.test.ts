import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  listConnectedBotModels,
  parseBotModelSelection,
  setBotModelFromTool,
  validateBotModelSelection,
} from "./bot-model-tools.js";

const scope = { userId: "user-1", spaceId: "space-1", botId: "chief-1" };
const selection = { model_provider: "claude-code", model_id: "claude-opus-5-5" };

function fixture(provider = "claude-code") {
  const credential = {
    id: "credential-1",
    userId: scope.userId,
    provider,
    label: "Test connection",
    secretId: "secret-1",
    updatedAt: new Date("2026-01-01"),
    createdAt: new Date("2026-01-01"),
  };
  const preferences = [] as Array<{
    id: string;
    modelId: string;
    isDefault: boolean;
    updatedAt: Date;
    thinkingLevel: null;
    credential: typeof credential;
  }>;
  const credentials = [credential];
  const savedSecret = JSON.stringify({
    kind: "cli",
    credential: { type: "cli", profileId: "11111111-1111-4111-8111-111111111111" },
  });
  const load = vi.fn(() => savedSecret);
  const findFirst = vi.fn().mockResolvedValue({ id: "cto-1", name: "CTO" });
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const raw = {
    bot: { findFirst, updateMany },
    userModelCredential: {
      findMany: vi.fn(async ({ where }: { where: { provider?: string } }) =>
        credentials.filter((entry) => !where.provider || entry.provider === where.provider),
      ),
    },
    spaceModelPreference: {
      findMany: vi.fn(async ({ where }: { where: { credential?: { provider: string } } }) =>
        preferences.filter(
          (entry) => !where.credential || entry.credential.provider === where.credential.provider,
        ),
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { modelId: string } }) =>
          preferences.find((entry) => entry.modelId === where.modelId) ?? null,
      ),
    },
    secret: {
      findMany: vi.fn(async () => [{ id: "secret-1", ciphertext: "encrypted-fixture" }]),
      findFirst: vi.fn(async () => ({ id: "secret-1", ciphertext: "encrypted-fixture" })),
    },
  };
  return {
    deps: { prisma: raw as unknown as PrismaClient, secretStore: { load } },
    raw,
    credential,
    credentials,
    preferences,
    findFirst,
    updateMany,
    load,
    savedSecret,
  };
}

describe("bot model tools", () => {
  it("accepts a complete pair and ignores unused optional fields", () => {
    expect(
      parseBotModelSelection({ model_provider: " claude-code ", model_id: " claude-opus-5-5 " }),
    ).toEqual({ modelProvider: "claude-code", modelId: "claude-opus-5-5" });
    expect(parseBotModelSelection({ model_provider: null, model_id: "" })).toEqual({
      modelProvider: undefined,
      modelId: undefined,
    });
  });

  it.each([
    { model_provider: "claude-code" },
    { model_id: "claude-opus-5-5" },
    { model_provider: 123, model_id: "claude-opus-5-5" },
  ])("rejects an incomplete or malformed selection: %j", (args) => {
    expect(parseBotModelSelection(args)).toHaveProperty("error");
  });

  it("saves a child's provider and model together with scoped authorization", async () => {
    const { deps, findFirst, updateMany } = fixture();
    await expect(
      setBotModelFromTool(deps, scope, { bot_id: "cto-1", ...selection }),
    ).resolves.toEqual({
      ok: true,
      botId: "cto-1",
      name: "CTO",
      modelProvider: "claude-code",
      modelId: "claude-opus-5-5",
    });
    const where = {
      id: "cto-1",
      userId: "user-1",
      spaceId: "space-1",
      archivedAt: null,
      OR: [{ id: "chief-1" }, { parentBotId: "chief-1" }],
    };
    expect(findFirst).toHaveBeenCalledWith({
      where,
      select: { id: true, name: true, modelProvider: true, modelId: true },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where,
      data: { modelProvider: "claude-code", modelId: "claude-opus-5-5", thinkingLevel: null },
    });
  });

  it.each([undefined, null, ""])(
    "can configure the caller with an unused bot ID (%s)",
    async (botId) => {
      const { deps, findFirst, updateMany } = fixture();
      await setBotModelFromTool(deps, scope, { ...selection, bot_id: botId });
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: "chief-1" }) }),
      );
      updateMany.mockClear();
      findFirst.mockResolvedValueOnce(null);
      expect(
        await setBotModelFromTool(deps, scope, { bot_id: "another-bot", ...selection }),
      ).toHaveProperty("error");
      expect(updateMany).not.toHaveBeenCalled();
    },
  );

  it("refuses a disconnected provider before changing the bot", async () => {
    const { deps, updateMany, credentials } = fixture();
    credentials.length = 0;
    await expect(
      setBotModelFromTool(deps, scope, { bot_id: "cto-1", ...selection }),
    ).resolves.toEqual({ error: "Connect that model provider first" });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("preserves the existing thinking preference when the model is unchanged", async () => {
    const { deps, findFirst, updateMany } = fixture();
    findFirst.mockResolvedValueOnce({
      id: "cto-1",
      name: "CTO",
      modelProvider: "claude-code",
      modelId: "claude-opus-5-5",
    });
    await setBotModelFromTool(deps, scope, { bot_id: "cto-1", ...selection });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { modelProvider: "claude-code", modelId: "claude-opus-5-5" },
      }),
    );
  });

  it("does not silently fall back when the model ID belongs to another provider", async () => {
    const { deps, updateMany } = fixture();
    await expect(
      setBotModelFromTool(deps, scope, { ...selection, model_id: "gpt-6-astra" }),
    ).resolves.toEqual({ error: "Unknown model for that provider" });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("rejects unreadable authentication and subscription-incompatible models", async () => {
    const { deps, load } = fixture();
    load.mockImplementation(() => {
      throw new Error("unreadable");
    });
    await expect(
      validateBotModelSelection(deps, scope, "claude-code", "claude-opus-5-5"),
    ).resolves.toBe("Reconnect that model provider first");
    const oauth = fixture("openai-codex");
    oauth.load.mockReturnValue(
      JSON.stringify({ type: "oauth", access: "test-access", refresh: "test-refresh", expires: 1 }),
    );
    await expect(
      validateBotModelSelection(oauth.deps, scope, "openai-codex", "gpt-5.3-codex-spark"),
    ).resolves.toContain("not available");
  });

  it("reports failure if the child was archived between validation and save", async () => {
    const { deps, updateMany } = fixture();
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(setBotModelFromTool(deps, scope, selection)).resolves.toEqual({
      error: "That bot is no longer available.",
    });
  });

  it("lists exact connected model IDs without disclosing credentials or unrelated providers", async () => {
    const { deps, raw, savedSecret } = fixture();
    const result = await listConnectedBotModels(deps, scope);
    expect(result.models).toContainEqual({
      provider: "claude-code",
      providerName: "Claude Code",
      id: "claude-opus-5-5",
      label: "Claude Opus 5.5",
    });
    expect(result.models.every((model) => model.provider === "claude-code")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(savedSecret);
    expect(JSON.stringify(result)).not.toContain("secret-1");
    expect(raw.spaceModelPreference.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "user-1",
          spaceId: "space-1",
          modelId: { not: null },
          credential: { userId: "user-1", provider: "openai-compatible" },
        },
      }),
    );
  });

  it("includes a saved custom endpoint model through its own connection", async () => {
    const { deps, credential, preferences, load } = fixture("openai-compatible");
    preferences.push({
      id: "preference-1",
      modelId: "custom-model",
      isDefault: true,
      updatedAt: new Date("2026-01-01"),
      thinkingLevel: null,
      credential,
    });
    load.mockReturnValue(
      JSON.stringify({
        kind: "openai_compatible",
        baseUrl: "https://models.example/v1",
        apiKey: "test-key",
      }),
    );
    const result = await listConnectedBotModels(deps, scope);
    expect(result.models).toEqual([
      {
        provider: "openai-compatible",
        providerName: "OpenAI-compatible",
        id: "custom-model",
        label: "custom-model",
      },
    ]);
  });
});
