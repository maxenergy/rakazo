import { randomUUID } from "node:crypto";
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
  let authenticated = provider !== "antigravity-cli";
  let selectedGoogleOAuth = false;
  let selectedTheme = false;
  let declinedTelemetry = false;
  let completedOnboarding = false;
  let trustedProfile = false;
  let requestedQuota = false;
  let authorizationUrl: URL | undefined;
  const codeAbort = new AbortController();
  let codeFailure: string | undefined;
  try {
    const directory = await prepareCliProfile(profileId);
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
            : [],
      interactiveAuth: provider === "antigravity-cli",
      onOutput(text, write, stop, _stdout, screen) {
        buffer = screen ?? stripVTControlCharacters(buffer + text).slice(-64 * 1024);
        if (provider === "antigravity-cli") {
          // Wait for a complete error: an output chunk may end before its region reason.
          const eligibilityError = buffer
            .match(/(?:Eligibility check failed:|Account ineligible:)[^\r\n]*(?:[.\r\n])/)?.[0]
            ?.replace(/\s+/g, " ");
          // Eligibility errors can arrive after Google has already saved a token.
          // Quota information alone does not establish account eligibility.
          if (eligibilityError) {
            codeFailure = /not currently available in your location/i.test(eligibilityError)
              ? "Antigravity is not available in this account's region."
              : /not eligible for Antigravity|Account ineligible/i.test(eligibilityError)
                ? "This account is not eligible for Antigravity."
                : "CLI sign-in failed. Start sign-in again.";
            stop();
            return;
          }
          if (buffer.includes("Got an error:")) {
            codeFailure = buffer.includes("invalid_grant")
              ? "Authorization code is invalid. Start sign-in again."
              : "CLI sign-in failed. Start sign-in again.";
            stop();
            return;
          }
          if (announced) {
            // Finish the native first-run preferences without enabling data collection.
            if (
              !selectedTheme &&
              buffer.includes("solarized dark") &&
              buffer.includes("[Next]") &&
              buffer.includes("enter Confirm")
            ) {
              selectedTheme = true;
              write("\r");
            }
            if (
              !declinedTelemetry &&
              buffer.includes("[x] Yes, I agree to help improve Antigravity CLI")
            ) {
              declinedTelemetry = true;
              write("\r");
            }
            if (
              !completedOnboarding &&
              buffer.includes("[ ] Yes, I agree to help improve Antigravity CLI") &&
              buffer.includes("[Done]")
            ) {
              completedOnboarding = true;
              write("\x1b[B\x1b[C\r");
            }
            if (!trustedProfile && buffer.includes("Do you trust the contents of this project?")) {
              // The CLI may only trust its managed, private login directory.
              const workspace = buffer.match(/Accessing workspace:\s*([^\r\n]+)/)?.[1]?.trim();
              if (workspace !== directory) throw new Error("Unexpected CLI workspace.");
              trustedProfile = true;
              write("\r");
            }
            if (trustedProfile && !requestedQuota && /Antigravity CLI \d+\.\d+/.test(buffer)) {
              // Use the native slash command after its prompt opens, never a model prompt.
              requestedQuota = true;
              write("/usage\r");
            }
            if (
              buffer.includes("Authentication successful!") ||
              (requestedQuota && buffer.includes("Weekly Limit Remaining"))
            ) {
              authenticated = true;
              stop();
              return;
            }
          }
        }
        if (
          provider === "antigravity-cli" &&
          !selectedGoogleOAuth &&
          /Select login method:[\s\S]*>\s*1\. Google OAuth/.test(buffer)
        ) {
          selectedGoogleOAuth = true;
          write("\r");
        }
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
            authorizationUrl = url;
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
              if (provider === "claude-code" || provider === "antigravity-cli") {
                // Hosted callbacks display a code for the native stdin prompt.
                // The vendor CLI remains responsible for token exchange/validation.
                void interaction
                  .prompt({
                    type: "manual_code",
                    message: "Paste authorization code.",
                    signal: codeAbort.signal,
                  })
                  .then((code) => {
                    if (codeAbort.signal.aborted) return;
                    if (!code.trim() || /[\r\n]/.test(code)) throw new Error("Invalid code.");
                    if (provider === "antigravity-cli") {
                      let value = code.trim();
                      if (/^https?:\/\//i.test(value)) {
                        const callback = new URL(value);
                        if (
                          callback.origin !== "https://antigravity.google" ||
                          callback.pathname !== "/oauth-callback" ||
                          callback.username ||
                          callback.password ||
                          callback.searchParams.get("state") !==
                            authorizationUrl?.searchParams.get("state")
                        )
                          throw new Error("Invalid code.");
                        value = callback.searchParams.get("code") ?? "";
                      }
                      // A pasted code must not inject terminal keys or CLI commands.
                      if (!/^[A-Za-z0-9][A-Za-z0-9_./~-]{0,8191}$/.test(value))
                        throw new Error("Invalid code.");
                      write(`${value}\r`);
                    } else write(`${code.trim()}\n`);
                  })
                  .catch(() => {
                    if (codeAbort.signal.aborted) return;
                    codeFailure = "Authorization code is invalid. Start sign-in again.";
                    stop();
                  });
              }
            }
          }
        }
      },
    });
    if (codeFailure) throw new CliModelSignInError(codeFailure);
    if (!announced || !authenticated)
      throw new Error("CLI sign-in did not complete. Start sign-in again.");
    if (provider === "antigravity-cli") {
      // Confirm that a new process can use the saved subscription credential.
      // /usage is handled by the CLI itself and does not run model inference.
      const output = await runCliProcess({
        provider,
        profileId,
        signal: interaction.signal,
        timeoutMs: 60_000,
        args: ["--print", "/usage", "--output-format", "json"],
      });
      const usage = JSON.parse(output);
      if (usage.status !== "SUCCESS" || usage.command?.name !== "usage" || usage.num_turns !== 0)
        throw new Error("CLI sign-in did not complete.");
    }
    return { type: "cli", profileId };
  } catch (error) {
    await removeCliProfile(profileId).catch(() => undefined);
    if (error instanceof CliModelSignInError) throw error;
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
