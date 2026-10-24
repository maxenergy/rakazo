import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { modelScorecard, runFailures } from "./team-insight-tools.js";

const scope = { spaceId: "space", userId: "user", botId: "bot-1" };
const started = new Date("2026-10-25T01:00:00Z");
const ended = new Date("2026-10-25T01:30:00Z");

function prisma(overrides: Record<string, unknown>) {
  return overrides as unknown as PrismaClient;
}

describe("runFailures", () => {
  it("lists recent failures of the calling bot with their failure events", async () => {
    const run = {
      id: "run-1",
      status: "failed",
      trigger: "tickets",
      error: "Storage admission refused: storage_low or capacity_unknown",
      modelId: "gpt-6.1-sol",
      deadlineMs: 1_800_000,
      startedAt: started,
      completedAt: ended,
      updatedAt: ended,
    };
    const db = prisma({
      bot: { findFirst: vi.fn(async () => ({ id: "bot-1", name: "Core" })) },
      run: { findMany: vi.fn(async () => [run]) },
      event: {
        findMany: vi.fn(async () => [
          { runId: "run-1", type: "run.storage_refused", payload: { reason: "capacity_unknown" } },
        ]),
      },
    });
    const result = await runFailures(db, scope, {});
    expect(result).toMatchObject({
      bot: "Core",
      failures: [
        {
          runId: "run-1",
          durationMinutes: 30,
          deadlineMinutes: 30,
          events: ['run.storage_refused: {"reason":"capacity_unknown"}'],
        },
      ],
    });
  });

  it("refuses colleagues outside the org", async () => {
    const db = prisma({ bot: { findFirst: vi.fn(async () => null) } });
    expect(await runFailures(db, scope, { bot: "Stranger" })).toEqual({
      error: "No colleague named Stranger in this org.",
    });
  });
});

describe("modelScorecard", () => {
  it("summarizes runs, done tickets and tokens per org member", async () => {
    const db = prisma({
      bot: {
        findMany: vi.fn(async () => [
          { id: "bot-1", name: "Core", modelProvider: "codex-cli", modelId: "gpt-6.1-sol" },
        ]),
      },
      run: {
        groupBy: vi.fn(async () => [
          { botId: "bot-1", status: "completed", _count: { _all: 9 } },
          { botId: "bot-1", status: "failed", _count: { _all: 1 } },
        ]),
      },
      ticket: {
        groupBy: vi.fn(async () => [{ assigneeBotId: "bot-1", _count: { _all: 2 } }]),
      },
      usageRecord: {
        groupBy: vi.fn(async () => [
          {
            botId: "bot-1",
            _count: { _all: 4 },
            _sum: { inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 200 },
          },
        ]),
      },
    });
    const result = await modelScorecard(db, scope, { days: 3 });
    expect(result.days).toBe(3);
    expect(result.members).toEqual([
      {
        bot: "Core",
        model: "codex-cli/gpt-6.1-sol",
        runsCompleted: 9,
        runsFailed: 1,
        failureRate: 10,
        ticketsDone: 2,
        modelCalls: 4,
        inputTokens: 1000,
        cachedInputTokens: 9000,
        outputTokens: 200,
      },
    ]);
  });
});
