import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, realpath, rm } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let windowsSid: Promise<string> | undefined;

export const CLI_MODEL_PROVIDERS = {
  "codex-cli": { command: "codex", name: "Codex CLI", source: "openai-codex", plan: "ChatGPT" },
  "claude-code": { command: "claude", name: "Claude Code", source: "anthropic", plan: "Claude" },
  "gemini-cli": {
    command: "gemini",
    name: "Gemini CLI",
    source: "google",
    plan: "Google AI Pro / Ultra",
  },
  "grok-cli": { command: "grok", name: "Grok CLI", source: "xai", plan: "SuperGrok" },
} as const;
export type CliModelProvider = keyof typeof CLI_MODEL_PROVIDERS;
export type CliModelCredential = { type: "cli"; profileId: string };

export function isCliModelProvider(provider: string): provider is CliModelProvider {
  return Object.hasOwn(CLI_MODEL_PROVIDERS, provider);
}

export function isCliProfileId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

export function cliProfileDirectory(profileId: string): string {
  if (!isCliProfileId(profileId)) throw new Error("Invalid CLI sign-in profile.");
  return join(resolve(process.env.DATA_DIR || "data"), "model-cli", profileId);
}

export async function prepareCliProfile(profileId: string): Promise<string> {
  const directory = cliProfileDirectory(profileId);
  const dataRoot = resolve(process.env.DATA_DIR || "data");
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const dataPath = await realpath(dataRoot);
  const root = join(dataRoot, "model-cli");
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (resolve(await realpath(root)) !== resolve(dataPath, "model-cli"))
    throw new Error("Invalid CLI profile root.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Never follow a replaced profile directory outside the managed root.
  const [actual, parent] = await Promise.all([
    realpath(directory),
    realpath(resolve(directory, "..")),
  ]);
  if (
    resolve(parent) !== resolve(dataPath, "model-cli") ||
    resolve(actual) !== resolve(parent, profileId)
  )
    throw new Error("Invalid CLI profile directory.");
  if (process.platform === "win32") {
    windowsSid ??= execFileAsync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      windowsHide: true,
    }).then(({ stdout }) => {
      const sid = stdout.match(/S-\d+-\d+(?:-\d+)+/)?.[0];
      if (!sid) throw new Error("Could not protect CLI credential storage.");
      return sid;
    });
    await execFileAsync(
      "icacls.exe",
      [
        directory,
        "/inheritance:r",
        "/grant:r",
        `*${await windowsSid}:(OI)(CI)F`,
        "*S-1-5-18:(OI)(CI)F",
      ],
      { windowsHide: true },
    );
  }
  return directory;
}

export async function removeCliProfile(profileId: string): Promise<void> {
  const directory = await prepareCliProfile(profileId);
  await rm(directory, { recursive: true, force: true });
}

/** Resolve only fixed official CLI entry points; no shell or user-supplied command. */
export function cliExecutable(provider: CliModelProvider): { file: string; prefix: string[] } {
  const command = CLI_MODEL_PROVIDERS[provider].command;
  const directories = (process.env.PATH || process.env.Path || "").split(delimiter).filter(Boolean);
  for (const directory of directories) {
    const native = join(directory, process.platform === "win32" ? `${command}.exe` : command);
    if (existsSync(native)) return { file: native, prefix: [] };
    if (process.platform !== "win32") continue;
    // npm's .cmd wrappers require a shell. Invoke their official JS bin directly instead.
    const packageName =
      provider === "gemini-cli"
        ? "@google/gemini-cli"
        : provider === "codex-cli"
          ? "@openai/codex"
          : provider === "grok-cli"
            ? "@xai-official/grok"
            : "@anthropic-ai/claude-code";
    const bins =
      provider === "gemini-cli"
        ? ["bundle/gemini.js", "dist/index.js"]
        : provider === "codex-cli"
          ? ["bin/codex.js"]
          : provider === "grok-cli"
            ? ["bin/grok"]
            : ["cli.js"];
    for (const bin of bins) {
      const entry = join(directory, "node_modules", packageName, bin);
      if (existsSync(entry)) return { file: process.execPath, prefix: [entry] };
    }
  }
  throw new Error(
    `Install ${CLI_MODEL_PROVIDERS[provider].name} on the API and worker host first.`,
  );
}

/** Credentials/settings are private to one connection, never inherited from the server account. */
export function cliEnvironment(provider: CliModelProvider, directory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const permitted =
    /^(path|pathext|systemroot|windir|comspec|temp|tmp|tmpdir|lang|lc_.*|https?_proxy|all_proxy|no_proxy|node_extra_ca_certs|ssl_cert_file)$/i;
  for (const [key, value] of Object.entries(process.env)) if (permitted.test(key)) env[key] = value;
  env.HOME = directory;
  env.USERPROFILE = directory;
  env.APPDATA = join(directory, "AppData", "Roaming");
  env.LOCALAPPDATA = join(directory, "AppData", "Local");
  if (provider === "codex-cli") env.CODEX_HOME = join(directory, ".codex");
  if (provider === "claude-code") {
    env.CLAUDE_CONFIG_DIR = join(directory, ".claude");
    // Rakazo opens the announced URL on the user's device. Do not let the CLI
    // start a second browser on the API host inside this credential profile.
    env.BROWSER = "none";
  }
  if (provider === "grok-cli") env.GROK_HOME = join(directory, ".grok");
  if (provider === "gemini-cli") {
    env.GEMINI_CLI_HOME = directory;
    env.GEMINI_CLI_NO_RELAUNCH = "true";
  }
  return env;
}

export type CliProcessOptions = {
  provider: CliModelProvider;
  profileId: string;
  args: string[];
  cwd?: string;
  input?: string;
  initialInput?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onOutput?: (
    text: string,
    write: (text: string) => void,
    stop: () => void,
    stdout: boolean,
  ) => void;
};

export async function runCliProcess(options: CliProcessOptions): Promise<string> {
  options.signal?.throwIfAborted();
  const directory = await prepareCliProfile(options.profileId);
  await mkdir(join(directory, `.${CLI_MODEL_PROVIDERS[options.provider].command}`), {
    recursive: true,
    mode: 0o700,
  });
  const executable = cliExecutable(options.provider);
  return new Promise<string>((resolveResult, reject) => {
    const child = spawn(executable.file, [...executable.prefix, ...options.args], {
      cwd: options.cwd || directory,
      env: cliEnvironment(options.provider, directory),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: "pipe",
    });
    let output = "";
    let failure: Error | undefined;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          shell: false,
          stdio: "ignore",
        });
        killer.on("error", () => child.kill());
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const abort = () => {
      failure = new Error("CLI request cancelled.");
      stop();
    };
    const timer = setTimeout(
      () => {
        failure = new Error("CLI request timed out. Try again.");
        stop();
      },
      options.timeoutMs ?? 10 * 60_000,
    );
    timer.unref();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const write = (text: string) => {
      if (!child.stdin.destroyed) child.stdin.write(text);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const receive = (text: string, stdout: boolean) => {
      if (stdout) output += text;
      if (output.length > 4 * 1024 * 1024) {
        failure = new Error("CLI response exceeded the size limit.");
        stop();
        return;
      }
      try {
        options.onOutput?.(text, write, stop, stdout);
      } catch {
        failure = new Error("CLI sign-in failed. Start sign-in again.");
        stop();
      }
    };
    child.stdout.on("data", (data: string) => receive(data, true));
    child.stderr.on("data", (data: string) => receive(data, false));
    child.stdin.on("error", () => undefined);
    child.on("error", () => {
      failure = new Error(`Could not start ${CLI_MODEL_PROVIDERS[options.provider].name}.`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0 && !stopped)
        reject(
          new Error(
            `${CLI_MODEL_PROVIDERS[options.provider].name} failed. Check sign-in, model access, and subscription limits.`,
          ),
        );
      else resolveResult(output);
    });
    if (options.initialInput !== undefined) write(options.initialInput);
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}
