import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import { cliEnvironment, cliExecutable, prepareCliProfile } from "./cli-model-process.js";

const ModelSchema = z.object({
  id: z.string().min(1),
  model: z.string().min(1),
  displayName: z.string(),
  hidden: z.boolean().optional(),
  inputModalities: z.array(z.string()).optional(),
  supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })).optional(),
});
const PageSchema = z.object({
  data: z.array(ModelSchema),
  nextCursor: z.string().nullable(),
});
export type DiscoveredCliModel = z.infer<typeof ModelSchema>;
export type CliDiscoveryResult =
  | { status: "discovered"; models: DiscoveredCliModel[] }
  | { status: "static"; models: null };

/** Catalog requests only: never starts a thread, sends a prompt, or logs CLI output. */
export async function discoverCodexModels(
  profileId: string,
  timeoutMs = 5_000,
): Promise<CliDiscoveryResult> {
  try {
    const directory = await prepareCliProfile(profileId);
    const executable = cliExecutable("codex-cli");
    return await readCodexModelCatalog(
      executable,
      cliEnvironment("codex-cli", directory),
      timeoutMs,
    );
  } catch {
    return { status: "static", models: null };
  }
}

/** Process boundary exposed for deterministic fake-server tests. */
export function readCodexModelCatalog(
  executable: { file: string; prefix: string[] },
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CliDiscoveryResult> {
  return new Promise((resolve) => {
    const child = spawn(executable.file, [...executable.prefix, "app-server"], {
      env,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const lines = createInterface({ input: child.stdout });
    let finished = false;
    let requestId = 0;
    let initialized = false;
    let outputBytes = 0;
    const cursors = new Set<string>();
    const models = new Map<string, DiscoveredCliModel>();
    const finish = (result: CliDiscoveryResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.destroy();
      child.stdout.destroy();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        const killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 250);
        killTimer.unref();
        child.once("exit", () => clearTimeout(killTimer));
      }
      resolve(result);
    };
    const fail = () => finish({ status: "static", models: null });
    const timer = setTimeout(fail, Math.max(1, Math.min(timeoutMs, 30_000)));
    const send = (value: unknown) =>
      child.stdin.write(JSON.stringify(value) + String.fromCharCode(10));
    child.once("error", fail);
    child.once("exit", fail);
    child.stdin.on("error", fail);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 4 * 1024 * 1024) fail();
    });
    lines.on("line", (line) => {
      if (finished) return;
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message.id !== requestId) return;
        if (message.error || !message.result || typeof message.result !== "object") return fail();
        if (!initialized) {
          initialized = true;
          send({ method: "initialized", params: {} });
          send({ id: ++requestId, method: "model/list", params: { limit: 100 } });
          return;
        }
        const page = PageSchema.parse(message.result);
        for (const model of page.data) if (!model.hidden) models.set(model.model, model);
        if (page.nextCursor === null) {
          finish({ status: "discovered", models: [...models.values()] });
          return;
        }
        if (cursors.has(page.nextCursor)) return fail();
        cursors.add(page.nextCursor);
        send({
          id: ++requestId,
          method: "model/list",
          params: { limit: 100, cursor: page.nextCursor },
        });
      } catch {
        fail();
      }
    });
    send({
      id: requestId,
      method: "initialize",
      params: {
        clientInfo: { name: "rakazo", title: "Rakazo", version: "0.1.0" },
      },
    });
  });
}
