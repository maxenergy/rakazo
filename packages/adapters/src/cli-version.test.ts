import { execFile } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  execFile: vi.fn(),
}));

vi.mock("./cli-model-process.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  cliExecutable: () => ({ file: "mock-cli", prefix: [] }),
}));

beforeEach(() => {
  vi.resetModules();
  vi.mocked(execFile).mockReset();
});

function result(error: Error | null, stdout = "") {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    callback(error, stdout, "");
    return {} as ReturnType<typeof execFile>;
  });
}

describe("CLI version probe", () => {
  it.each(["2.1.3 (Claude Code)", "codex-cli 0.166.0", "v1.2.3-beta.1"])(
    "parses %s and caches the probe",
    async (output) => {
      result(null, output);
      const { probeCliVersion } = await import("./cli-model-provider.js");
      const version = await probeCliVersion("claude-code");
      expect(version).toBe(output.match(/\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?/i)?.[0]);
      expect(await probeCliVersion("claude-code")).toBe(version);
      expect(execFile).toHaveBeenCalledOnce();
      expect(vi.mocked(execFile).mock.calls[0]?.[2]).toMatchObject({
        timeout: 5000,
        maxBuffer: 16384,
      });
    },
  );

  it.each([
    new Error("not installed"),
    Object.assign(new Error("timeout"), { killed: true, code: "ETIMEDOUT" }),
  ])("does not block inference on probe failure", async (error) => {
    result(error);
    const { probeCliVersion } = await import("./cli-model-provider.js");
    await expect(probeCliVersion("claude-code")).resolves.toBeUndefined();
    expect(execFile).toHaveBeenCalledOnce();
  });

  it("ignores unrecognized output", async () => {
    result(null, "unexpected output");
    const { probeCliVersion } = await import("./cli-model-provider.js");
    await expect(probeCliVersion("claude-code")).resolves.toBeUndefined();
    expect(execFile).toHaveBeenCalledOnce();
  });
});
