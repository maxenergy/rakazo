import { expect, it, vi } from "vitest";
import { runAutoReviewJudge } from "./auto-review.js";
import type { ReviewAttempt } from "./auto-review-attempts.js";
import { readReviewHead, runReviewAttempts } from "./auto-review-attempts.js";
import { reviewFailureFacts } from "./review-failure.js";

const candidates = [
  { provider: "a", model: "m1" },
  { provider: "b", model: "m2" },
];
const head = { cwd: "/workspace", head: "a".repeat(40), dirty: false };
function setup() {
  const events: ReviewAttempt[] = [];
  return {
    events,
    input: {
      runId: "run",
      toolCallId: "tool",
      requestHash: "hash",
      primaryProvider: "primary",
      candidates,
      readHead: vi.fn(async () => head),
      onAttempt: async (event: ReviewAttempt) => {
        events.push(event);
      },
    },
  };
}

it("switches on quota to a different provider and records HEAD per attempt", async () => {
  const { input, events } = setup();
  const review = vi
    .fn()
    .mockResolvedValueOnce({
      decision: "error",
      model: "a/m1",
      failureClass: "quota",
    })
    .mockResolvedValueOnce({ decision: "pass", model: "b/m2" });
  expect((await runReviewAttempts({ ...input, review })).decision).toBe("pass");
  expect(events.map((e) => [e.provider, e.disposition, e.head])).toEqual([
    ["a", "switch", head.head],
    ["b", "pass", head.head],
  ]);
  expect(input.readHead).toHaveBeenCalledTimes(2);
});

it("asks when all candidates are unavailable; unclassified errors never fail over", async () => {
  const { input, events } = setup();
  expect(
    (
      await runReviewAttempts({
        ...input,
        review: async () => ({
          decision: "error",
          model: "m",
          failureClass: "rate_limit",
        }),
      })
    ).decision,
  ).toBe("ask");
  expect(events.at(-1)?.disposition).toBe("ask");
  const review = vi.fn(async () => ({ decision: "error" as const, model: "m" }));
  expect((await runReviewAttempts({ ...input, review })).decision).toBe("error");
  expect(review).toHaveBeenCalledTimes(1);
});

it("never calls the run primary provider, including when no independent candidate remains", async () => {
  const { input } = setup();
  const review = vi.fn(async () => ({ decision: "pass" as const, model: "m" }));
  expect(
    (
      await runReviewAttempts({
        ...input,
        primaryProvider: "A",
        candidates: [candidates[0]!],
        review,
      })
    ).decision,
  ).toBe("ask");
  expect(review).not.toHaveBeenCalled();
});

it("gives each actual fake provider call a distinct accounting key", async () => {
  const { input } = setup();
  const usage: string[] = [];
  await runReviewAttempts({
    ...input,
    review: async (candidate, key) => {
      usage.push(key);
      return candidate.provider === "a"
        ? { decision: "error", model: "m", failureClass: "quota" }
        : { decision: "pass", model: "m" };
    },
  });
  expect(usage).toEqual(["auto-review:run:tool:1", "auto-review:run:tool:2"]);
});

it("records no_git_workspace and continues the review", async () => {
  const { input, events } = setup();
  const noGit = await readReviewHead("/plain", async function* () {
    yield { type: "stdout", data: "/plain\n" };
    yield {
      type: "stderr",
      data: "fatal: not a git repository (or any of the parent directories): .git",
    };
    yield { type: "exit", code: 128 };
  });
  expect(noGit).toEqual({ cwd: "/plain", head: null, dirty: null, reason: "no_git_workspace" });
  expect(
    (
      await runReviewAttempts({
        ...input,
        readHead: async () => noGit,
        review: async () => ({ decision: "pass", model: "m" }),
      })
    ).decision,
  ).toBe("pass");
  expect(events[0]?.reason).toBe("no_git_workspace");
});

it("passes only whitelisted failure facts without leaking the provider payload", async () => {
  const raw = Object.assign(new Error("secret-provider-payload"), {
    code: "insufficient_quota",
    status: 429,
    apiKey: "secret-api-key",
    body: "secret-body",
  });
  const facts = reviewFailureFacts(raw);
  expect(facts).toEqual({ code: "insufficient_quota", status: 429 });
  const result = await runAutoReviewJudge({
    runtime: {
      describe: () => ({
        id: "fake",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { streaming: false, compaction: false, tools: false, scripted: false },
      }),
      abort: async () => {},
      async *run() {
        yield* [];
        throw Object.assign(new Error("safe"), facts);
      },
    },
    checker: { provider: "a", model: "m" },
    prompt: "check",
    runId: "run",
    spaceId: "space",
    userId: "user",
    botId: "bot",
    threadId: "thread",
  });
  expect(result.failureClass).toBe("quota");
  expect(JSON.stringify({ facts, result })).not.toContain("secret");
  expect(reviewFailureFacts({ code: "secret-code", status: 500 })).toEqual({});
});
