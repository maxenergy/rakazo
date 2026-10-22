import type { Actor } from "@rakazo/contracts";
import { RunDiagnosticsOutputSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { requireBotThread } from "./bot-thread.js";
import { getRunDiagnostics } from "./run-diagnostics.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
};
const now = new Date("2026-01-20T12:00:00Z");
function fixture() {
  const run = vi.fn().mockResolvedValue({ id: "run-1", threadId: "thread-1", status: "completed" });
  const rows = vi.fn().mockResolvedValue([]);
  const prisma = {
    run: { findFirst: run },
    attempt: { findMany: rows },
    event: { findMany: rows },
    externalEffect: { findMany: rows },
    usageRecord: { findMany: rows },
  } as unknown as PrismaClient;
  return { prisma, run, rows };
}

describe("run diagnostics", () => {
  it("returns only allowlisted run model and lease context", async () => {
    const { prisma, run } = fixture();
    run.mockResolvedValue({
      id: "run-1",
      threadId: "thread-1",
      status: "uncertain",
      modelProvider: "fixture-provider",
      modelId: "fixture-model",
      modelPinned: true,
      leaseFence: 7,
    });
    const result = await getRunDiagnostics(
      prisma,
      actor,
      { runId: "run-1", section: "attempts", limit: 25 },
      now,
    );
    expect(result.runContext).toEqual({
      modelProvider: "fixture-provider",
      modelId: "fixture-model",
      modelPinned: true,
      leaseFence: 7,
    });
    expect(run.mock.calls[0][0].select).toMatchObject({
      modelProvider: true,
      modelId: true,
      modelPinned: true,
      leaseFence: true,
    });
    expect(RunDiagnosticsOutputSchema.safeParse(result).success).toBe(true);
  });

  it.each([
    { spaceId: "foreign-space", userId: actor.userId },
    { spaceId: actor.spaceId, userId: "foreign-user" },
  ])("rejects unauthorized source bot navigation for $spaceId/$userId", async (identity) => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { bot: { findFirst } } as unknown as PrismaClient;
    await expect(
      requireBotThread(
        { prisma, events: {} as Parameters<typeof requireBotThread>[0]["events"] },
        { ...actor, ...identity },
        "source-bot",
      ),
    ).rejects.toThrow();
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "source-bot", spaceId: identity.spaceId, userId: identity.userId },
      include: { thread: true },
    });
  });

  it.each([
    { matched: true, legacy: false },
    { matched: false, legacy: false },
    { matched: false, legacy: true },
  ])("safely correlates reconciliation $matched/$legacy", async ({ matched, legacy }) => {
    const { prisma, rows } = fixture();
    rows.mockResolvedValue([{ id: "event-1", createdAt: now, type: "effect.reconciled", seq: 7 }]);
    const payload = vi
      .fn()
      .mockResolvedValue({
        payload: { executionId: "PRIVATE_KEY", kind: "tool", legacy, extra: "PRIVATE_EXTRA" },
      });
    const effect = vi
      .fn()
      .mockResolvedValue(
        matched
          ? {
              id: "effect-1",
              kind: "tool",
              status: "completed",
              reviewDecision: "approved",
              createdAt: now,
            }
          : null,
      );
    Object.assign(prisma.event, { findFirst: payload });
    Object.assign(prisma.externalEffect, { findFirst: effect });
    const result = await getRunDiagnostics(
      prisma,
      actor,
      { runId: "run-1", section: "events", limit: 25 },
      now,
    );
    expect(result.entries[0].recovery).toMatchObject({
      match: matched ? "matched" : "unmatched",
      legacy,
    });
    expect(result.entries[0].recovery?.effect?.id ?? null).toBe(matched ? "effect-1" : null);
    expect(effect).toHaveBeenCalledWith({
      where: {
        runId: "run-1",
        spaceId: actor.spaceId,
        idempotencyKey: "PRIVATE_KEY",
        kind: "tool",
      },
      select: { id: true, kind: true, status: true, reviewDecision: true, createdAt: true },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    expect(RunDiagnosticsOutputSchema.safeParse(result).success).toBe(true);
  });

  it("derives a model change using the extra row across the page boundary", async () => {
    const { prisma, rows } = fixture();
    rows.mockResolvedValue([
      {
        id: "new",
        createdAt: now,
        provider: "provider",
        model: "backup",
        callId: "call-new",
        inputTokens: 1,
        outputTokens: 2,
        costMicroUsd: 3n,
      },
      {
        id: "old",
        createdAt: new Date(now.getTime() - 1000),
        provider: "provider",
        model: "primary",
        callId: "call-old",
        inputTokens: 1,
        outputTokens: 2,
        costMicroUsd: 3n,
      },
    ]);
    const result = await getRunDiagnostics(
      prisma,
      actor,
      { runId: "run-1", section: "usage", limit: 1 },
      now,
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].derived).toBe("model_changed");
    expect(result.nextCursor).toEqual({ at: now.toISOString(), id: "new" });
  });

  it("derives takeover only when a higher fence overlaps an earlier attempt", async () => {
    const { prisma, rows } = fixture();
    const earlier = new Date(now.getTime() - 1000);
    const newer = { id: "new", startedAt: now, finishedAt: null, status: "running", fence: 2 };
    const older = { id: "old", startedAt: earlier, finishedAt: null, status: "running", fence: 1 };
    rows.mockResolvedValue([newer, older]);
    const input = { runId: "run-1", section: "attempts" as const, limit: 1 };
    expect((await getRunDiagnostics(prisma, actor, input, now)).entries[0].derived).toBe(
      "lease_takeover",
    );
    rows.mockResolvedValue([newer, { ...older, finishedAt: now }]);
    expect((await getRunDiagnostics(prisma, actor, input, now)).entries[0].derived).toBeNull();
    rows.mockResolvedValue([newer]);
    expect((await getRunDiagnostics(prisma, actor, input, now)).entries[0].derived).toBeNull();
  });

  it("authorizes the run before reading evidence", async () => {
    const { prisma, run, rows } = fixture();
    run.mockResolvedValue(null);
    await expect(
      getRunDiagnostics(prisma, actor, { runId: "foreign-run", section: "usage", limit: 25 }, now),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(run.mock.calls[0][0].where).toEqual({
      id: "foreign-run",
      spaceId: actor.spaceId,
      userId: actor.userId,
    });
    expect(rows).not.toHaveBeenCalled();
  });

  it("returns lossless money and call correlation without arbitrary payloads", async () => {
    const { prisma, rows } = fixture();
    rows.mockResolvedValue([
      {
        id: "usage-1",
        createdAt: now,
        provider: "fake-provider",
        model: "fake-model",
        callId: "call-1",
        inputTokens: 5,
        outputTokens: 7,
        costMicroUsd: 9007199254740993n,
        request: "PRIVATE_SENTINEL",
        result: "PRIVATE_SENTINEL",
      },
    ]);
    const result = await getRunDiagnostics(
      prisma,
      actor,
      { runId: "run-1", section: "usage", limit: 25 },
      now,
    );
    expect(RunDiagnosticsOutputSchema.parse(result).entries[0]).toMatchObject({
      provider: "fake-provider",
      model: "fake-model",
      callId: "call-1",
      costMicroUsd: "9007199254740993",
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
    expect(rows.mock.calls[0][0].where).toMatchObject({
      runId: "run-1",
      spaceId: actor.spaceId,
      userId: actor.userId,
    });
  });

  it("bounds reads and uses timestamp plus id for tied pagination", async () => {
    const { prisma, rows } = fixture();
    rows.mockResolvedValue(
      ["c", "b", "a"].map((id) => ({
        id,
        startedAt: now,
        finishedAt: null,
        status: "running",
        fence: 4,
      })),
    );
    const result = await getRunDiagnostics(
      prisma,
      actor,
      { runId: "run-1", section: "attempts", limit: 2, before: { at: now.toISOString(), id: "d" } },
      now,
    );
    expect(result.entries.map((row) => row.id)).toEqual(["c", "b"]);
    expect(result.nextCursor).toEqual({ at: now.toISOString(), id: "b" });
    expect(rows.mock.calls[0][0]).toMatchObject({
      take: 3,
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      where: { OR: [{ startedAt: { lt: now } }, { startedAt: now, id: { lt: "d" } }] },
    });
  });

  it("preserves unknown outcomes and omits raw errors", async () => {
    const { prisma, rows } = fixture();
    rows.mockResolvedValue([
      {
        id: "effect-1",
        createdAt: now,
        status: "PRIVATE_SENTINEL",
        request: "PRIVATE_SENTINEL",
        result: "PRIVATE_SENTINEL",
      },
    ]);
    const result = await getRunDiagnostics(
      prisma,
      actor,
      { runId: "run-1", section: "effects", limit: 25 },
      now,
    );
    expect(result.entries[0].status).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
    expect(result.historyMayBeIncomplete).toBe(true);
  });

  it("propagates database failures instead of reporting empty evidence", async () => {
    const { prisma, rows } = fixture();
    rows.mockRejectedValue(new Error("database unavailable"));
    await expect(
      getRunDiagnostics(prisma, actor, { runId: "run-1", section: "events", limit: 25 }, now),
    ).rejects.toThrow("database unavailable");
  });
});
