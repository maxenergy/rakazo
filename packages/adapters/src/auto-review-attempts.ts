import type { AutoReviewResult, ProcessEvent } from "@rakazo/adapter-kit";

export type ReviewFailureClass = "quota" | "rate_limit" | "no_credentials";
export type ReviewCandidate = { provider: string; model: string };
export type ReviewHead = {
  cwd: string;
  head: string | null;
  dirty: boolean | null;
  reason?: "no_git_workspace" | "head_read_failed";
};

/** No tool command is evaluated here; cwd is resolved by the caller. */
export async function readReviewHead(
  cwd: string | undefined,
  execute: (command: string) => AsyncIterable<ProcessEvent>,
): Promise<ReviewHead> {
  const fallback: ReviewHead = {
    cwd: cwd ?? ".",
    head: null,
    dirty: null,
    reason: "head_read_failed",
  };
  try {
    let output = "";
    let stderr = "";
    let code: number | undefined;
    for await (const event of execute(
      "pwd; git rev-parse --verify HEAD && git status --porcelain",
    )) {
      if (event.type === "stdout") output = (output + event.data).slice(0, 16384);
      if (event.type === "stderr") stderr = (stderr + event.data).slice(0, 4096);
      if (event.type === "exit") code = event.code;
    }
    const [actualCwd, head, ...status] = output.trimEnd().split("\n");
    fallback.cwd = actualCwd || fallback.cwd;
    if (code === 128 && /fatal: not a git repository/.test(stderr)) {
      return { ...fallback, reason: "no_git_workspace" };
    }
    if (code !== 0 || !head || !/^[a-f0-9]{40,64}$/.test(head)) return fallback;
    return { cwd: fallback.cwd, head, dirty: status.some(Boolean) };
  } catch {
    return fallback;
  }
}

export type ReviewAttempt = ReviewHead & {
  toolCallId: string;
  requestHash: string;
  primaryProvider: string;
  provider: string;
  model: string;
  attempt: number;
  usageKey: string;
  failureClass: ReviewFailureClass | null;
  disposition: "switch" | "ask" | "pass" | "error";
};

/** Only typed availability failures can advance the ordered, independent chain. */
export async function runReviewAttempts(input: {
  runId: string;
  toolCallId: string;
  requestHash: string;
  primaryProvider: string;
  candidates: ReviewCandidate[];
  readHead: () => Promise<ReviewHead>;
  review: (
    candidate: ReviewCandidate,
    usageKey: string,
  ) => Promise<AutoReviewResult & { failureClass?: ReviewFailureClass }>;
  onAttempt: (attempt: ReviewAttempt) => Promise<unknown>;
}): Promise<AutoReviewResult> {
  const seen = new Set<string>();
  const candidates = input.candidates.filter(({ provider }) => {
    const key = provider.trim().toLowerCase();
    if (key === input.primaryProvider.trim().toLowerCase() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const [index, candidate] of candidates.entries()) {
    const attempt = index + 1;
    const usageKey = `auto-review:${input.runId}:${input.toolCallId}:${attempt}`;
    const head = await input.readHead();
    const result = await input.review(candidate, usageKey);
    const failureClass = result.decision === "error" ? result.failureClass : undefined;
    await input.onAttempt({
      ...head,
      toolCallId: input.toolCallId,
      requestHash: input.requestHash,
      primaryProvider: input.primaryProvider,
      ...candidate,
      attempt,
      usageKey,
      failureClass: failureClass ?? null,
      disposition: failureClass
        ? index + 1 < candidates.length
          ? "switch"
          : "ask"
        : result.decision,
    });
    if (!failureClass) return result;
  }
  return {
    decision: "ask",
    model: "auto-review",
    reason: "No eligible independent reviewer is available.",
  };
}
