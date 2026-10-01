import { RPCHandler } from "@orpc/server/fetch";
import { removeCliProfile } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

vi.mock("@rakazo/adapters", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  removeCliProfile: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

const actor = {
  userId: "user-test",
  spaceId: "space-test",
  email: "test@rakazo.test",
  isDeploymentOwner: true,
} satisfies Actor;
const oldProfile = "11111111-1111-4111-8111-111111111111";
const newProfile = "22222222-2222-4222-8222-222222222222";
const plaintext = (profileId: string) =>
  JSON.stringify({ kind: "cli", credential: { type: "cli", profileId } });

function fixture(existing = false) {
  const row = {
    id: "cred-test",
    userId: actor.userId,
    provider: "codex-cli",
    label: "Codex CLI",
    secretId: "secret-old",
  };
  const tx = {
    userModelCredential: {
      findFirst: vi.fn().mockResolvedValue(existing ? row : null),
      findMany: vi.fn().mockResolvedValue(existing ? [row] : []),
      create: vi.fn().mockResolvedValue(row),
      update: vi.fn().mockResolvedValue(row),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      count: vi.fn().mockResolvedValue(0),
    },
    userVoiceCredential: { count: vi.fn().mockResolvedValue(0) },
    secret: {
      findFirst: vi.fn().mockResolvedValue({ id: "secret-old", ciphertext: "fake-ciphertext" }),
      create: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    spaceModelPreference: {
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const committed = vi.fn();
  const deps = {
    prisma: {
      ...tx,
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => {
        const result = await fn(tx);
        committed();
        return result;
      }),
    },
    secrets: {
      put: vi.fn().mockResolvedValue({ id: "secret-new", ciphertext: "fake-ciphertext" }),
      load: vi.fn().mockReturnValue(plaintext(oldProfile)),
    },
    oauthLogins: {
      cancelProvider: vi.fn().mockResolvedValue(undefined),
      finish: vi.fn(async (_id, _actor, persist) => ({
        status: "connected",
        value: await persist({
          provider: "codex-cli",
          credential: { type: "cli", profileId: newProfile },
          signal: new AbortController().signal,
        }),
      })),
    },
    env: {
      defaultProvider: "openrouter",
      defaultModel: "fake-model",
      agentRuntime: "pi",
      sandboxProvider: "fake",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
    },
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  async function call(path: string, body: unknown) {
    return (
      await handler.handle(
        new Request(`http://127.0.0.1/rpc/models/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: body }),
        }),
        { prefix: "/rpc", context: { actor } },
      )
    ).response;
  }
  return { call, deps, tx, committed };
}

describe("CLI credential lifecycle", () => {
  it("persists a private profile reference without exposing it in the response", async () => {
    const { call, deps } = fixture();
    const response = await call("finishOAuth", { loginId: "login-test" });
    expect(response.status).toBe(200);
    expect(deps.secrets.put).toHaveBeenCalledWith(
      plaintext(newProfile),
      expect.objectContaining({ userId: actor.userId }),
    );
    expect(await response.text()).not.toContain(newProfile);
    expect(removeCliProfile).not.toHaveBeenCalled();
  });

  it("retires only the replaced profile after commit and keeps a committed login if cleanup fails", async () => {
    vi.mocked(removeCliProfile).mockRejectedValue(new Error("storage unavailable"));
    const { call, committed } = fixture(true);
    const response = await call("finishOAuth", { loginId: "login-test" });
    expect(response.status).toBe(200);
    expect(removeCliProfile).toHaveBeenCalledExactlyOnceWith(oldProfile);
    expect(committed.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(removeCliProfile).mock.invocationCallOrder[0]!,
    );
  });

  it("cancels account sign-ins and removes only this actor's committed profile on disconnect", async () => {
    const { call, deps, tx, committed } = fixture(true);
    const response = await call("disconnect", { provider: "codex-cli" });
    expect(response.status).toBe(200);
    expect(deps.oauthLogins.cancelProvider).toHaveBeenCalledWith({
      userId: actor.userId,
      provider: "codex-cli",
    });
    expect(tx.secret.findFirst).toHaveBeenCalledWith({
      where: { id: "secret-old", userId: actor.userId },
    });
    expect(removeCliProfile).toHaveBeenCalledExactlyOnceWith(oldProfile);
    expect(committed.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(removeCliProfile).mock.invocationCallOrder[0]!,
    );
  });
});
