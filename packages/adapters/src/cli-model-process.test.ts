import { ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cliEnvironment,
  cliExecutable,
  cliProfileDirectory,
  isCliProfileId,
  prepareCliProfile,
  runCliProcess,
} from "./cli-model-process.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  spawn: vi.fn(),
}));

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("CLI credential and command boundary", () => {
  it("rejects filesystem paths as profile identifiers", () => {
    expect(isCliProfileId("11111111-1111-4111-8111-111111111111")).toBe(true);
    for (const value of ["../auth", "C:\\private", "host-login", {}, ""]) {
      expect(isCliProfileId(value)).toBe(false);
      expect(() => cliProfileDirectory(String(value))).toThrow();
    }
  });

  it("never passes server keys, host CLI homes, hooks, or Node injection into a child", () => {
    for (const name of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "XAI_API_KEY",
      "GEMINI_API_KEY",
      "NODE_OPTIONS",
      "DATABASE_URL",
      "CODEX_HOME",
      "CLAUDE_CONFIG_DIR",
      "GROK_HOME",
      "BROWSER",
      "AGY_CLI_INTERACTIVE_HEADLESS",
      "AGY_CLI_NONINTERACTIVE_HEADLESS",
      "ANTIGRAVITY_APP_DATA_DIR",
      "XDG_CONFIG_HOME",
      "SSH_CONNECTION",
    ])
      vi.stubEnv(name, "private-host-setting");
    for (const provider of ["codex-cli", "claude-code", "antigravity-cli", "grok-cli"] as const) {
      const env = cliEnvironment(provider, "managed-profile");
      expect(Object.values(env)).not.toContain("private-host-setting");
      expect(env.HOME).toBe("managed-profile");
      expect(env.USERPROFILE).toBe("managed-profile");
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.BROWSER).toBe(provider === "claude-code" ? "none" : undefined);
      expect(env.AGY_CLI_NONINTERACTIVE_HEADLESS).toBe(
        provider === "antigravity-cli" ? "true" : undefined,
      );
    }
  });

  it.each([false, true])(
    "isolates Antigravity settings and native tools (interactive auth: %s)",
    async (interactiveAuth) => {
      const root = await mkdtemp(join(tmpdir(), "rakazo-agy-process-test-"));
      roots.push(root);
      vi.stubEnv("DATA_DIR", root);
      vi.stubEnv("PATH", `${root}${delimiter}${process.env.PATH || process.env.Path || ""}`);
      await writeFile(join(root, process.platform === "win32" ? "agy.exe" : "agy"), "fixture");
      const child = Object.assign(new ChildProcess(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      vi.mocked(spawn).mockImplementation(() => {
        queueMicrotask(() => child.emit("close", 0));
        return child;
      });
      const profileId = "11111111-1111-4111-8111-111111111111";
      await runCliProcess({ provider: "antigravity-cli", profileId, args: [], interactiveAuth });
      const env = vi.mocked(spawn).mock.calls[0]?.[2]?.env;
      expect(env?.USERPROFILE).toBe(cliProfileDirectory(profileId));
      expect(env?.AGY_CLI_NONINTERACTIVE_HEADLESS).toBe(interactiveAuth ? undefined : "true");
      expect(env?.AGY_CLI_INTERACTIVE_HEADLESS).toBe(interactiveAuth ? "true" : undefined);
      expect(env?.SSH_CONNECTION).toBe(interactiveAuth ? "127.0.0.1 0 127.0.0.1 0" : undefined);
      const settings = JSON.parse(
        await readFile(
          join(cliProfileDirectory(profileId), ".gemini", "antigravity-cli", "settings.json"),
          "utf8",
        ),
      );
      expect(settings.useG1Credits).toBe(false);
      for (const action of [
        "read_file",
        "write_file",
        "read_url",
        "execute_url",
        "command",
        "unsandboxed",
        "mcp",
      ])
        expect(settings.permissions.deny).toContain(`${action}(*)`);
      expect(settings).not.toHaveProperty("modelProvider");
    },
  );

  it.skipIf(process.platform !== "win32")(
    "finds the official Windows installation after a PATH change",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "rakazo-agy-executable-test-"));
      roots.push(root);
      const bin = join(root, "agy", "bin");
      await mkdir(bin, { recursive: true });
      const executable = join(bin, "agy.exe");
      await writeFile(executable, "fixture");
      vi.stubEnv("LOCALAPPDATA", root);
      vi.stubEnv("PATH", "");
      expect(cliExecutable("antigravity-cli")).toEqual({ file: executable, prefix: [] });
    },
  );

  it("rejects a managed root replaced by a directory symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "rakazo-cli-root-test-"));
    const outside = await mkdtemp(join(tmpdir(), "rakazo-cli-outside-test-"));
    roots.push(root, outside);
    vi.stubEnv("DATA_DIR", root);
    await symlink(
      outside,
      join(root, "model-cli"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(prepareCliProfile("11111111-1111-4111-8111-111111111111")).rejects.toThrow(
      "profile root",
    );
  });
});
