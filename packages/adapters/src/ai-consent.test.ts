import { AI_DISCLOSURE_VERSION } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aiRecipient, requireBackupModelConsent } from "./ai-consent.js";

afterEach(() => vi.unstubAllGlobals());

describe("mobile AI recipient disclosure", () => {
  it("identifies both gateways without querying or changing their routing", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const provider of ["openrouter", "vercel-ai-gateway"]) {
      const recipient = aiRecipient({ provider, use: "model", modelId: "any/model" });
      expect(recipient?.detail).toBe("any/model, forwarded to its provider");
      expect(aiRecipient({ provider, use: "model" })?.detail).toBe("Forwards to model providers");
      expect(recipient?.privacyUrl).toBeTruthy();
      expect(recipient).not.toHaveProperty("payloadFields");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses only the model ID for direct providers", () => {
    expect(
      aiRecipient({ provider: "openai", use: "model", modelId: "example-model" })?.detail,
    ).toBe("example-model");
    expect(aiRecipient({ provider: "openai", use: "model" })?.detail).toBe("");
  });
  it("supports custom endpoints without exposing secrets or inventing a provider policy", () => {
    const recipient = aiRecipient({
      provider: "openai-compatible",
      use: "model",
      baseUrl: "https://user:password@example.com/private?token=secret",
    })!;
    expect(recipient.name).toContain("https://example.com");
    expect(JSON.stringify(recipient)).not.toMatch(/password|private|token|secret/);
    expect(recipient.privacyUrl).toBeUndefined();
    expect(
      aiRecipient({
        provider: "openai-compatible",
        use: "model",
        baseUrl: "https://example.com/other",
      })?.key,
    ).not.toBe(recipient.key);
  });
  it("supports local models without a hosted dependency", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(
      aiRecipient({ provider: "local", use: "model", baseUrl: "http://127.0.0.1:11434/v1" })?.name,
    ).toContain("http://127.0.0.1:11434");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("backup execution consent", () => {
  it.each([null, { version: "outdated" }, { version: AI_DISCLOSURE_VERSION }])(
    "permits execution only with current scoped consent: %j",
    async (consent) => {
      const findUnique = vi.fn().mockResolvedValue(consent);
      const prisma = { aiDataConsent: { findUnique } } as unknown as PrismaClient;
      const scope = { userId: "run-user", spaceId: "run-space" };
      const model = { provider: "openai", id: "test-model" };
      const result = requireBackupModelConsent(prisma, scope, model);
      if (consent?.version === AI_DISCLOSURE_VERSION) await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toThrow("requires current AI data-sharing consent");
      expect(findUnique).toHaveBeenCalledWith({
        where: {
          userId_spaceId_recipientKey: {
            ...scope,
            recipientKey: aiRecipient({
              provider: model.provider,
              modelId: model.id,
              use: "model",
            })!.key,
          },
        },
      });
    },
  );
});
