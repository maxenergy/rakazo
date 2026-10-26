import { ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough } from "node:stream";
import { spawn as spawnTerminal } from "node-pty";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loginCliModel } from "./cli-model-login.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  spawn: vi.fn(),
}));
vi.mock("node-pty", () => ({ spawn: vi.fn() }));

const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("native login terminal redraws", () => {
  it.each([true, false])(
    "handles partial checkbox and cursor-positioned workspace output (rejected: %s)",
    async (rejected) => {
      const root = await mkdtemp(join(tmpdir(), "rakazo-native-login-test-"));
      roots.push(root);
      vi.stubEnv("DATA_DIR", root);
      vi.stubEnv("PATH", `${root}${delimiter}${process.env.PATH || process.env.Path || ""}`);
      await writeFile(join(root, process.platform === "win32" ? "agy.exe" : "agy"), "fixture");
      let emit: (text: string) => void;
      let exit: (event: { exitCode: number }) => void;
      let stage = "code";
      const redraw = (text: string) => emit(`\x1b[2J\x1b[1;1H${text}`);
      const kill = vi.fn(() => queueMicrotask(() => exit({ exitCode: 1 })));
      const write = vi.fn((text: string) => {
        if (stage === "code" && text === "fake-code\r") {
          stage = "theme";
          redraw("solarized dark\x1b[3;1H[Next]\x1b[4;1Henter Confirm");
        } else if (stage === "theme" && text === "\r") {
          stage = "checked";
          redraw("  > [x] Yes, I agree to help improve Antigravity CLI\x1b[5;1H[Previous] [Done]");
        } else if (stage === "checked" && text === "\r") {
          stage = "unchecked";
          // ConPTY only changes the checkbox cell; it does not repeat the text.
          emit("\x1b[1;6H \x1b[1;7H");
        } else if (stage === "unchecked" && text === "\x1b[B\x1b[C\r") {
          stage = "trust";
          const directory = vi.mocked(spawnTerminal).mock.calls[0]![2]!.cwd;
          // Cursor positioning separates lines without any LF or CR characters.
          redraw(
            `Accessing workspace: ${directory}\x1b[2;1HDo you trust the contents of this project?`,
          );
        } else if (stage === "trust" && text === "\r") {
          stage = "prompt";
          redraw(
            rejected
              ? "Antigravity CLI 1.2.16\x1b[3;1HEligibility check failed: Your current account is not eligible for Antigravity, because it is not currently available in your location."
              : "Antigravity CLI 1.2.16",
          );
        } else if (stage === "prompt" && text === "/usage\r") {
          stage = "quota";
          redraw("Weekly Limit Remaining");
        }
      });
      vi.mocked(spawnTerminal).mockReturnValue({
        write,
        kill,
        onData: vi.fn((listener) => {
          emit = listener;
          return { dispose: vi.fn() };
        }),
        onExit: vi.fn((listener) => {
          exit = listener;
          queueMicrotask(() => emit("https://accounts.google.com/o/oauth2/auth?state=fake\r\n"));
          return { dispose: vi.fn() };
        }),
      } as unknown as ReturnType<typeof spawnTerminal>);
      vi.mocked(spawn).mockImplementation(() => {
        const child = Object.assign(new ChildProcess(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        });
        queueMicrotask(() => {
          child.stdout.write(
            JSON.stringify({ status: "SUCCESS", command: { name: "usage" }, num_turns: 0 }),
          );
          child.emit("close", 0);
        });
        return child;
      });
      const controller = new AbortController();
      const login = loginCliModel("antigravity-cli", {
        notify: vi.fn(),
        prompt: vi.fn().mockResolvedValue("fake-code"),
        signal: controller.signal,
      });
      // Keep a stalled old implementation from leaving an unhandled rejection.
      void login.catch(() => undefined);
      try {
        await vi.waitFor(() => expect(kill).toHaveBeenCalled(), { timeout: 1500 });
        if (rejected) {
          await expect(login).rejects.toThrow(
            "Antigravity is not available in this account's region.",
          );
          expect(spawn).not.toHaveBeenCalled();
          expect(await readdir(join(root, "model-cli"))).toEqual([]);
        } else {
          await expect(login).resolves.toMatchObject({ type: "cli" });
          expect(write).toHaveBeenCalledWith("/usage\r");
          expect(spawn).toHaveBeenCalledOnce();
        }
      } finally {
        controller.abort();
        await login.catch(() => undefined);
      }
    },
  );
});
