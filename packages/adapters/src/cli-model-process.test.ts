import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cliEnvironment,
  cliProfileDirectory,
  isCliProfileId,
  prepareCliProfile,
} from "./cli-model-process.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
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
    ])
      vi.stubEnv(name, "private-host-setting");
    for (const provider of ["codex-cli", "claude-code", "gemini-cli", "grok-cli"] as const) {
      const env = cliEnvironment(provider, "managed-profile");
      expect(Object.values(env)).not.toContain("private-host-setting");
      expect(env.HOME).toBe("managed-profile");
      expect(env.USERPROFILE).toBe("managed-profile");
      expect(env.OPENAI_API_KEY).toBeUndefined();
    }
  });

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
