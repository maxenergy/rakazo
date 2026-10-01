import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginCliModel } from "./cli-model-login.js";
import { runCliProcess } from "./cli-model-process.js";
import {
  PiOAuthLogins,
  parseModelSecret,
  resolveModelAuth,
  serializeModelSecret,
} from "./pi-oauth.js";

vi.mock("./cli-model-process.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runCliProcess: vi.fn(),
}));
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "rakazo-cli-login-test-"));
  vi.stubEnv("DATA_DIR", directory);
});
afterEach(async () => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("official CLI login", () => {
  it.each(["codex-cli", "grok-cli"] as const)(
    "uses %s device code without collecting OAuth tokens",
    async (provider) => {
      const notify = vi.fn();
      vi.mocked(runCliProcess).mockImplementation(async (options) => {
        const write = vi.fn();
        options.onOutput?.(
          `Open https://${provider === "codex-cli" ? "auth.openai.com" : "auth.x.ai"}/device\n`,
          write,
          vi.fn(),
          false,
        );
        expect(notify).not.toHaveBeenCalled();
        options.onOutput?.("Code: ABCD-EFGH\n", write, vi.fn(), false);
        return "Successfully logged in\n";
      });
      const credential = await loginCliModel(provider, { notify, prompt: vi.fn() });
      expect(notify).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ type: "device_code", userCode: "ABCD-EFGH" }),
      );
      expect(credential).toEqual({ type: "cli", profileId: expect.any(String) });
      expect(credential).not.toHaveProperty("access");
      expect(vi.mocked(runCliProcess).mock.calls[0]?.[0].args).toEqual(["login", "--device-auth"]);
    },
  );

  it("waits for the native Claude browser flow and keeps a fragmented URL intact", async () => {
    const notify = vi.fn();
    vi.mocked(runCliProcess).mockImplementation(async (options) => {
      const write = vi.fn();
      options.onOutput?.("https://claude.ai/oauth/authorize?state=par", write, vi.fn(), false);
      expect(notify).not.toHaveBeenCalled();
      options.onOutput?.(
        "tial&redirect_uri=http%3A%2F%2Flocalhost%3A54321%2Fcallback\n",
        write,
        vi.fn(),
        false,
      );
      return "Login complete\n";
    });
    await loginCliModel("claude-code", { notify, prompt: vi.fn() });
    expect(vi.mocked(runCliProcess).mock.calls[0]?.[0].args).toEqual([
      "auth",
      "login",
      "--claudeai",
    ]);
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "auth_url", url: expect.stringContaining("state=partial&") }),
    );
  });

  it("drives Gemini's ACP initialize/authenticate handshake and stops after success", async () => {
    const notify = vi.fn();
    const write = vi.fn();
    const stop = vi.fn();
    vi.mocked(runCliProcess).mockImplementation(async (options) => {
      expect(JSON.parse(options.initialInput || "{}")).toMatchObject({
        method: "initialize",
        params: { protocolVersion: 1 },
      });
      options.onOutput?.(
        '{"jsonrpc":"2.0","id":1,"result":{"authMethods":[]}}\n',
        write,
        stop,
        true,
      );
      expect(JSON.parse(write.mock.calls[0]![0])).toMatchObject({
        method: "authenticate",
        params: { methodId: "oauth-personal" },
      });
      options.onOutput?.(
        "https://accounts.google.com/o/oauth2/v2/auth?state=fake\n",
        write,
        stop,
        false,
      );
      options.onOutput?.('{"jsonrpc":"2.0","id":2,"result":{}}\n', write, stop, true);
      return "";
    });
    await loginCliModel("gemini-cli", { notify, prompt: vi.fn() });
    expect(stop).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
  });

  it("removes a failed login's private directory", async () => {
    vi.mocked(runCliProcess).mockRejectedValue(new Error("CLI request cancelled."));
    await expect(loginCliModel("codex-cli", { notify: vi.fn(), prompt: vi.fn() })).rejects.toThrow(
      "cancelled",
    );
    expect(await readdir(join(directory, "model-cli"))).toEqual([]);
  });

  it("stores only a scoped profile reference and rejects API-key/provider confusion", async () => {
    const plaintext = serializeModelSecret({
      kind: "cli",
      credential: { type: "cli", profileId: "11111111-1111-4111-8111-111111111111" },
    });
    expect(parseModelSecret(plaintext).kind).toBe("cli");
    await expect(resolveModelAuth(plaintext, "codex-cli")).resolves.toMatchObject({
      apiKey: "11111111-1111-4111-8111-111111111111",
    });
    await expect(resolveModelAuth(plaintext, "openai")).rejects.toThrow("API provider");
    await expect(resolveModelAuth("fake-api-key", "codex-cli")).rejects.toThrow("official CLI");
    expect(() =>
      parseModelSecret('{"kind":"cli","credential":{"type":"cli","profileId":"../host"}}'),
    ).toThrow("corrupt");
  });

  it("reuses the existing user/space fence and browser polling lifecycle", async () => {
    const logins = new PiOAuthLogins(async (_provider, _type, interaction) => {
      interaction.notify({
        type: "auth_url",
        url: "https://accounts.google.com/authorize?state=fake",
      });
      return { type: "cli", profileId: "11111111-1111-4111-8111-111111111111" };
    });
    const started = await logins.begin({
      userId: "test-user",
      spaceId: "test-space",
      provider: "gemini-cli",
    });
    expect(started.mode).toBe("browser");
    expect(
      logins.complete(started.loginId, { userId: "another-user", spaceId: "test-space" }).status,
    ).toBe("error");
    expect(
      logins.complete(started.loginId, { userId: "test-user", spaceId: "another-space" }).status,
    ).toBe("error");
    const finish = await logins.finish(
      started.loginId,
      { userId: "test-user", spaceId: "test-space" },
      async (login) => login.credential.type,
    );
    expect(finish).toEqual({ status: "connected", value: "cli" });
    expect(
      logins.complete(started.loginId, { userId: "test-user", spaceId: "test-space" }).status,
    ).toBe("error");
  });
});
