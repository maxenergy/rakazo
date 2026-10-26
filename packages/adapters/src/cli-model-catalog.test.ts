import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { cliCatalogForSpace } from "./cli-model-catalog.js";
import type { SpaceCatalogAuth } from "./model-selection.js";
import type { PiCatalogEntry } from "./pi-models.js";

const entry = (id: string, provider = "codex-cli"): PiCatalogEntry => ({
  provider,
  providerName: provider,
  id,
  label: id,
  billing: "Subscription",
  auth: "oauth",
  subscription: true,
});
const auth: SpaceCatalogAuth = {
  byProvider: { "codex-cli": "cli" },
  byModel: { "codex-cli": { b: "cli", blocked: "disconnected" } },
  secretIdByProvider: { "codex-cli": "first" },
  secretIdByModel: { "codex-cli": { b: "second" } },
};
function fixture() {
  const findMany = vi.fn().mockResolvedValue([
    { id: "first", ciphertext: "first" },
    { id: "second", ciphertext: "second" },
  ]);
  const findFirst = vi.fn(async ({ where }: { where: { id: string } }) => ({
    id: where.id,
    ciphertext: where.id,
  }));
  const credentials = ["first", "second"].map((id) => ({
    id: `${id}-credential`,
    provider: "codex-cli",
    secretId: id,
    userId: "user",
    label: id,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }));
  const prisma = {
    secret: { findMany, findFirst },
    userModelCredential: { findMany: vi.fn(async () => credentials) },
    spaceModelPreference: {
      findMany: vi.fn(async () => [
        {
          id: "default",
          modelId: null,
          isDefault: true,
          thinkingLevel: null,
          updatedAt: new Date(0),
          credential: credentials[0],
        },
        {
          id: "specific",
          modelId: "b",
          isDefault: false,
          thinkingLevel: null,
          updatedAt: new Date(0),
          credential: credentials[1],
        },
      ]),
    },
  } as unknown as PrismaClient;
  const load = vi.fn(async (_cipher: string, id: string) =>
    JSON.stringify({
      kind: "cli",
      credential: {
        type: "cli",
        profileId:
          id === "first"
            ? "11111111-1111-4111-8111-111111111111"
            : "22222222-2222-4222-8222-222222222222",
      },
    }),
  );
  return { prisma, load, findMany, findFirst };
}
describe("credential-scoped CLI catalog", () => {
  it("includes discovered new IDs with unknown price and context", async () => {
    const f = fixture();
    const discover = vi.fn(async () => ({
      status: "discovered" as const,
      models: [
        { id: "known", model: "a", displayName: "Known model" },
        { id: "new", model: "fixture-new-codex-model", displayName: "New model" },
      ],
    }));
    const result = await cliCatalogForSpace(
      f.prisma,
      { load: f.load },
      { userId: "user", spaceId: "space" },
      auth,
      [entry("a")],
      discover,
    );
    expect(result.map((model) => model.id)).toEqual(["a", "fixture-new-codex-model"]);
    expect(result[1]?.contextWindow).toBeNull();
    expect(result[1]?.pricing).toBeUndefined();
    expect(result[0]?.discovery?.status).toBe("discovered");
  });

  it("uses each selected account and preserves unknown capabilities", async () => {
    const f = fixture();
    const discover = vi.fn(async (profile: string) => ({
      status: "discovered" as const,
      models: [
        {
          id: profile,
          model: profile === "11111111-1111-4111-8111-111111111111" ? "a" : "b",
          displayName: profile,
        },
      ],
    }));
    const result = await cliCatalogForSpace(
      f.prisma,
      { load: f.load },
      { userId: "user", spaceId: "space" },
      auth,
      [entry("a"), entry("b"), entry("absent"), entry("blocked")],
      discover,
    );
    expect(discover.mock.calls.map((call) => call[0]).sort()).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(f.findFirst).toHaveBeenCalledWith({
      where: { id: "first", userId: "user", spaceId: null },
      select: { id: true, ciphertext: true },
    });
    expect(result.map((model) => model.id)).toEqual(["a", "b", "blocked"]);
    expect(result[0]?.capabilities?.imageInput.value).toBeNull();
    expect(result[0]?.discovery?.status).toBe("discovered");
    expect(result[2]?.discovery?.status).toBe("static");
  });
  it("labels unsupported providers and discovery failures as static", async () => {
    const f = fixture();
    const discover = vi.fn(async () => ({ status: "static" as const, models: null }));
    const result = await cliCatalogForSpace(
      f.prisma,
      { load: f.load },
      { userId: "user", spaceId: "space" },
      auth,
      [entry("a"), entry("claude", "claude-code"), entry("grok", "grok-cli")],
      discover,
    );
    expect(result).toHaveLength(3);
    expect(result.every((model) => model.discovery?.status === "static")).toBe(true);
    expect(result.every((model) => model.discovery?.source.includes("not discovered"))).toBe(true);
  });
});
