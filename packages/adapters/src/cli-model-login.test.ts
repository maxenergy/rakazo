import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliModelSignInError, loginCliModel } from "./cli-model-login.js";
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
    const prompt = vi.fn().mockReturnValue(new Promise(() => undefined));
    await loginCliModel("claude-code", { notify, prompt });
    expect(prompt.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(vi.mocked(runCliProcess).mock.calls[0]?.[0].args).toEqual([
      "auth",
      "login",
      "--claudeai",
    ]);
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "auth_url", url: expect.stringContaining("state=partial&") }),
    );
  });

  it("supports the hosted Claude code fallback without exposing or collecting OAuth tokens", async () => {
    const write = vi.fn();
    let acceptCode: () => void;
    const receivedCode = new Promise<void>((resolve) => {
      acceptCode = resolve;
    });
    vi.mocked(runCliProcess).mockImplementation(async (options) => {
      options.onOutput?.(
        "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?state=fake&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback\nPaste code here if prompted > ",
        (code) => {
          write(code);
          acceptCode();
        },
        vi.fn(),
        true,
      );
      await receivedCode;
      return "Login successful\n";
    });
    const logins = new PiOAuthLogins();
    const scope = { userId: "test-user", spaceId: "test-space" };
    const started = await logins.begin({ ...scope, provider: "claude-code" });
    expect(started).toMatchObject({ mode: "auth-url", callbackOwner: "provider" });
    expect(new URL(started.verificationUri).hostname).toBe("claude.com");
    expect(() =>
      logins.submit(started.loginId, { ...scope, userId: "other-user" }, "code#state"),
    ).toThrow("not found");
    expect(write).not.toHaveBeenCalled();
    logins.submit(started.loginId, scope, "fake-code#fake-state");
    await receivedCode;
    await vi.waitFor(() =>
      expect(logins.complete(started.loginId, scope).status).toBe("connected"),
    );
    const finished = await logins.finish(started.loginId, scope, async (login) => login.credential);
    expect(finished).toEqual({
      status: "connected",
      value: { type: "cli", profileId: expect.any(String) },
    });
    expect(write).toHaveBeenCalledExactlyOnceWith("fake-code#fake-state\n");
  });

  it.each([
    "https://claude.com.attacker.invalid/authorize",
    "https://claude.com@attacker.invalid/authorize",
    "https://user:password@claude.com/authorize",
    "https://claude.com:8443/authorize",
  ])("rejects untrusted Claude sign-in URLs: %s", async (url) => {
    const notify = vi.fn();
    vi.mocked(runCliProcess).mockImplementation(async (options) => {
      options.onOutput?.(`${url}\n`, vi.fn(), vi.fn(), true);
      return "";
    });
    await expect(loginCliModel("claude-code", { notify, prompt: vi.fn() })).rejects.toBeInstanceOf(
      CliModelSignInError,
    );
    expect(notify).not.toHaveBeenCalled();
    expect(await readdir(join(directory, "model-cli"))).toEqual([]);
  });

  it("does not forward multiple lines to the Claude CLI code prompt", async () => {
    const write = vi.fn();
    const stop = vi.fn();
    vi.mocked(runCliProcess).mockImplementation(async (options) => {
      options.onOutput?.("https://claude.com/cai/oauth/authorize?state=fake\n", write, stop, true);
      await Promise.resolve();
      await Promise.resolve();
      return "";
    });
    await expect(
      loginCliModel("claude-code", {
        notify: vi.fn(),
        prompt: vi.fn().mockResolvedValue("fake-code\nextra-input"),
      }),
    ).rejects.toBeInstanceOf(CliModelSignInError);
    expect(write).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("completes Antigravity's hosted code flow and checks access without model inference", async () => {
    const notify = vi.fn();
    const write = vi.fn();
    const stop = vi.fn();
    vi.mocked(runCliProcess).mockImplementation(async (options) => {
      if (!options.interactiveAuth) {
        expect(options.args).toEqual(["--print", "/usage", "--output-format", "json"]);
        return "Subscription quotas\n";
      }
      expect(options.args).toEqual([]);
      expect(options.interactiveAuth).toBe(true);
      expect(options).not.toHaveProperty("initialInput");
      options.onOutput?.(
        "Select login method:\n> 1. Google OAuth\n2. Use a Google Cloud project\n",
        write,
        stop,
        true,
      );
      expect(write).toHaveBeenCalledExactlyOnceWith("\r");
      write.mockClear();
      options.onOutput?.(
        "https://accounts.google.com/o/oauth2/auth?state=fake&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback\n",
        write,
        stop,
        false,
      );
      await Promise.resolve();
      expect(write).toHaveBeenCalledExactlyOnceWith("fake-code\r");
      options.onOutput?.("Authentication suc", write, stop, false);
      options.onOutput?.("cessful!\n", write, stop, false);
      return "";
    });
    await loginCliModel("antigravity-cli", {
      notify,
      prompt: vi.fn().mockResolvedValue("fake-code"),
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    expect(runCliProcess).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(runCliProcess).mock.calls;
    expect(calls[1]?.[0].profileId).toBe(calls[0]?.[0].profileId);
  });

  it("extracts a code only from the hosted callback for the current Antigravity attempt", async () => {
    const write = vi.fn();
    vi.mocked(runCliProcess).mockImplementation(async (options) => {
      if (!options.interactiveAuth) return "Subscription quotas\n";
      options.onOutput?.(
        "https://accounts.google.com/o/oauth2/auth?state=current\n",
        write,
        vi.fn(),
        true,
      );
      await Promise.resolve();
      options.onOutput?.("Authentication successful!\n", write, vi.fn(), true);
      return "";
    });
    await loginCliModel("antigravity-cli", {
      notify: vi.fn(),
      prompt: vi
        .fn()
        .mockResolvedValue(
          "https://antigravity.google/oauth-callback?code=4%2Ffake-code&state=current",
        ),
    });
    expect(write).toHaveBeenCalledExactlyOnceWith("4/fake-code\r");
  });

  it.each([
    "https://antigravity.google/oauth-callback?code=fake&state=old",
    "https://antigravity.google.attacker.invalid/oauth-callback?code=fake&state=current",
    "https://attacker@antigravity.google/oauth-callback?code=fake&state=current",
    "https://antigravity.google/oauth-callback?state=current",
    "fake\u001b[Acode",
    "fake\tcode",
    "/logout",
    "fake\nextra-command",
  ])("rejects callback confusion and terminal input injection: %s", async (code) => {
    const write = vi.fn();
    const stop = vi.fn();
    vi.mocked(runCliProcess).mockImplementation(async (options) => {
      options.onOutput?.(
        "https://accounts.google.com/o/oauth2/auth?state=current\n",
        write,
        stop,
        true,
      );
      await Promise.resolve();
      await Promise.resolve();
      return "";
    });
    await expect(
      loginCliModel("antigravity-cli", {
        notify: vi.fn(),
        prompt: vi.fn().mockResolvedValue(code),
      }),
    ).rejects.toThrow("Authorization code is invalid.");
    expect(write).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
    expect(await readdir(join(directory, "model-cli"))).toEqual([]);
  });

  it("reports a native token rejection without leaking vendor diagnostics", async () => {
    vi.mocked(runCliProcess).mockImplementation(async (options) => {
      options.onOutput?.(
        "https://accounts.google.com/o/oauth2/auth?state=current\n",
        vi.fn(),
        vi.fn(),
        true,
      );
      options.onOutput?.(
        'Got an error: token exchange failed: oauth2: "invalid_grant" "Private vendor details"\n',
        vi.fn(),
        vi.fn(),
        true,
      );
      return "";
    });
    await expect(
      loginCliModel("antigravity-cli", {
        notify: vi.fn(),
        prompt: vi.fn().mockReturnValue(new Promise(() => undefined)),
      }),
    ).rejects.toThrow("Authorization code is invalid. Start sign-in again.");
    expect(await readdir(join(directory, "model-cli"))).toEqual([]);
  });

  it("removes the profile when the saved Antigravity credential cannot authenticate a new process", async () => {
    vi.mocked(runCliProcess)
      .mockImplementationOnce(async (options) => {
        options.onOutput?.(
          "https://accounts.google.com/o/oauth2/auth?state=current\n",
          vi.fn(),
          vi.fn(),
          true,
        );
        options.onOutput?.("Authentication successful!\n", vi.fn(), vi.fn(), true);
        return "";
      })
      .mockRejectedValueOnce(new Error("Native cached credential failed: private detail"));
    await expect(
      loginCliModel("antigravity-cli", {
        notify: vi.fn(),
        prompt: vi.fn().mockReturnValue(new Promise(() => undefined)),
      }),
    ).rejects.toThrow("CLI sign-in failed. Start sign-in again.");
    expect(await readdir(join(directory, "model-cli"))).toEqual([]);
  });

  it("does not treat an Antigravity authorization URL alone as a completed login", async () => {
    vi.mocked(runCliProcess).mockImplementation(async (options) => {
      options.onOutput?.(
        "https://accounts.google.com/o/oauth2/auth?state=fake\n",
        vi.fn(),
        vi.fn(),
        false,
      );
      return "";
    });
    const prompt = vi.fn().mockReturnValue(new Promise(() => undefined));
    await expect(
      loginCliModel("antigravity-cli", { notify: vi.fn(), prompt }),
    ).rejects.toBeInstanceOf(CliModelSignInError);
    expect(prompt.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(await readdir(join(directory, "model-cli"))).toEqual([]);
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
      provider: "antigravity-cli",
    });
    expect(started).toMatchObject({ mode: "auth-url", callbackOwner: "provider" });
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
