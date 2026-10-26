import { abortableDelay } from "./async.js";

export type ModelOAuthCompletion =
  | { status: "pending" }
  | { status: "ready" }
  | { status: "error"; error: string };

type OAuthControllerRef = { current: AbortController | null };

/** Public sign-in errors are catalog keys, never raw vendor diagnostics. */
export function modelOAuthErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/^(CLI request timed out\.|Sign-in timed out\.|Sign-in session not found\.)/.test(message))
    return "Authorization timed out. Please try again.";
  if (message === "Authorization code is invalid. Start sign-in again.")
    return "Authorization code is invalid. Start sign-in again.";
  if (message === "Antigravity is not available in this account's region.")
    return "Antigravity is not available in this account's region.";
  if (message === "This account is not eligible for Antigravity.")
    return "This account is not eligible for Antigravity.";
  return "Could not connect this provider";
}

export function cancelModelOAuthAttempt(ref: OAuthControllerRef, reset: () => void) {
  const controller = ref.current;
  controller?.abort();
  if (ref.current !== controller) return;
  ref.current = null;
  reset();
}

export function finishModelOAuthAttempt(
  ref: OAuthControllerRef,
  controller: AbortController,
  resetBusy: () => void,
) {
  if (ref.current !== controller) return;
  ref.current = null;
  resetBusy();
}

export async function waitForModelOAuthCompletion(
  complete: () => Promise<ModelOAuthCompletion>,
  options: { signal?: AbortSignal; attempts?: number; pollIntervalMs?: number } = {},
): Promise<{ status: "ready" }> {
  const attempts = options.attempts ?? 180;
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(options.signal);
    const result = await complete();
    throwIfAborted(options.signal);
    if (result.status === "ready") return result;
    if (result.status === "error") throw new Error(result.error);
    if (attempt < attempts) await abortableDelay(pollIntervalMs, options.signal);
  }
  throw new Error("Sign-in timed out. Try again.");
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new Error("OAuth polling cancelled");
}
