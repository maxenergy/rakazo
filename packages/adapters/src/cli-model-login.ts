import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { CliModelCredential, CliModelProvider } from "./cli-model-process.js";
import { prepareCliProfile, removeCliProfile, runCliProcess } from "./cli-model-process.js";

/** Only adapter-owned messages may cross the public RPC boundary. */
export class CliModelSignInError extends Error {}

/** Login remains inside the unmodified vendor CLI, including credential storage/refresh. */
export async function loginCliModel(
  provider: CliModelProvider,
  interaction: AuthInteraction,
): Promise<CliModelCredential> {
  const profileId = randomUUID();
  let buffer = "";
  let announced = false;
  let authenticated = provider !== "gemini-cli";
  let acpBuffer = "";
  const codeAbort = new AbortController();
  let codeFailure = false;
  try {
    const directory = await prepareCliProfile(profileId);
    if (provider === "gemini-cli") {
      await mkdir(join(directory, ".gemini"), { mode: 0o700 });
      await writeFile(
        join(directory, ".gemini", "settings.json"),
        JSON.stringify({
          security: { auth: { enforcedType: "oauth-personal" } },
          hooks: { enabled: false },
          mcpServers: {},
        }),
        { mode: 0o600 },
      );
    }
    await runCliProcess({
      provider,
      profileId,
      signal: interaction.signal,
      timeoutMs: 15 * 60_000,
      args:
        provider === "codex-cli" || provider === "grok-cli"
          ? ["login", "--device-auth"]
          : provider === "claude-code"
            ? ["auth", "login", "--claudeai"]
            : ["--acp", "--extensions", "none"],
      ...(provider === "gemini-cli"
        ? {
            initialInput: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "rakazo", version: "0.1.0" } } })}\n`,
          }
        : {}),
      onOutput(text, write, stop, stdout) {
        buffer = stripVTControlCharacters(buffer + text).slice(-64 * 1024);
        if (!announced) {
          const uri = buffer.match(/https:\/\/[^\s<>"]+(?=[\s<>"])/)?.[0];
          if (uri) {
            const url = new URL(uri);
            const hosts =
              provider === "codex-cli"
                ? ["auth.openai.com", "chatgpt.com"]
                : provider === "grok-cli"
                  ? ["auth.x.ai", "grok.com", "accounts.x.ai"]
                  : provider === "claude-code"
                    ? ["claude.com", "claude.ai", "platform.claude.com", "console.anthropic.com"]
                    : ["accounts.google.com"];
            if (!hosts.includes(url.hostname) || url.username || url.password || url.port)
              throw new Error("Untrusted CLI sign-in URL.");
            if (provider === "codex-cli" || provider === "grok-cli") {
              const userCode = buffer.match(/\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\b/)?.[0];
              if (userCode) {
                interaction.notify({
                  type: "device_code",
                  verificationUri: url.href,
                  userCode,
                  expiresInSeconds: 900,
                });
                announced = true;
              }
            } else {
              interaction.notify({ type: "auth_url", url: url.href });
              announced = true;
              if (provider === "claude-code") {
                // The CLI's printed URL may finish at a hosted code page rather
                // than its loopback listener. Keep its native stdin prompt wired
                // to the existing paste-code flow; the CLI still validates PKCE.
                void interaction
                  .prompt({
                    type: "manual_code",
                    message: "Paste authorization code.",
                    signal: codeAbort.signal,
                  })
                  .then((code) => {
                    if (codeAbort.signal.aborted) return;
                    if (!code.trim() || /[\r\n]/.test(code)) throw new Error("Invalid code.");
                    write(`${code.trim()}\n`);
                  })
                  .catch(() => {
                    if (codeAbort.signal.aborted) return;
                    codeFailure = true;
                    stop();
                  });
              }
            }
          }
        }
        if (provider === "gemini-cli" && stdout) {
          acpBuffer += text;
          const lines = acpBuffer.split("\n");
          acpBuffer = lines.pop() || "";
          for (const line of lines) {
            let event: { id?: number; result?: unknown; error?: unknown };
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }
            if (event.id === 1 && event.result) {
              write(
                `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "authenticate", params: { methodId: "oauth-personal" } })}\n`,
              );
            }
            if (event.id === 2) {
              if (event.error) throw new Error("Gemini CLI authentication failed.");
              authenticated = true;
              stop();
            }
          }
        }
      },
    });
    if (!announced || !authenticated || codeFailure)
      throw new Error("CLI sign-in did not complete. Start sign-in again.");
    return { type: "cli", profileId };
  } catch (error) {
    await removeCliProfile(profileId).catch(() => undefined);
    if (
      error instanceof Error &&
      /^(Install .+ host first\.|CLI request cancelled\.|CLI request timed out\.)/.test(
        error.message,
      )
    )
      throw new CliModelSignInError(error.message);
    throw new CliModelSignInError("CLI sign-in failed. Start sign-in again.");
  } finally {
    codeAbort.abort();
  }
}
