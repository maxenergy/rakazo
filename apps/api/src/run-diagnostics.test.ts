import type { Actor } from "@rakazo/contracts";
import { RunDiagnosticsOutputSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { getRunDiagnostics } from "./run-diagnostics.js";

const actor: Actor = { userId: "user-1", spaceId: "space-1", email: "user@rakazo.test", isDeploymentOwner: false };
const now = new Date("2026-01-20T12:00:00Z");
function fixture() {
  const run = vi.fn().mockResolvedValue({ id: "run-1", threadId: "thread-1", status: "completed" });
  const rows = vi.fn().mockResolvedValue([]);
  const prisma = { run: { findFirst: run }, attempt: { findMany: rows }, event: { findMany: rows }, externalEffect: { findMany: rows }, usageRecord: { findMany: rows } } as unknown as PrismaClient;
  return { prisma, run, rows };
}

describe("run diagnostics", () => {
  it("authorizes the run before reading evidence", async () => {
    const { prisma, run, rows } = fixture();
    run.mockResolvedValue(null);
    await expect(getRunDiagnostics(prisma, actor, { runId: "foreign-run", section: "usage", limit: 25 }, now)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(run.mock.calls[0][0].where).toEqual({ id: "foreign-run", spaceId: actor.spaceId, userId: actor.userId });
    expect(rows).not.toHaveBeenCalled();
  });

  it("returns lossless money and call correlation without arbitrary payloads", async () => {
    const { prisma, rows } = fixture();
    rows.mockResolvedValue([{ id: "usage-1", createdAt: now, provider: "fake-provider", model: "fake-model", callId: "call-1", inputTokens: 5, outputTokens: 7, costMicroUsd: 9007199254740993n, request: "PRIVATE_SENTINEL", result: "PRIVATE_SENTINEL" }]);
    const result = await getRunDiagnostics(prisma, actor, { runId: "run-1", section: "usage", limit: 25 }, now);
    expect(RunDiagnosticsOutputSchema.parse(result).entries[0]).toMatchObject({ provider: "fake-provider", model: "fake-model", callId: "call-1", costMicroUsd: "9007199254740993" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
    expect(rows.mock.calls[0][0].where).toMatchObject({ runId: "run-1", spaceId: actor.spaceId, userId: actor.userId });
  });

  it("bounds reads and uses timestamp plus id for tied pagination", async () => {
    const { prisma, rows } = fixture();
    rows.mockResolvedValue(["c", "b", "a"].map(id => ({ id, startedAt: now, finishedAt: null, status: "running", fence: 4 })));
    const result = await getRunDiagnostics(prisma, actor, { runId: "run-1", section: "attempts", limit: 2, before: { at: now.toISOString(), id: "d" } }, now);
    expect(result.entries.map(row => row.id)).toEqual(["c", "b"]);
    expect(result.nextCursor).toEqual({ at: now.toISOString(), id: "b" });
    expect(rows.mock.calls[0][0]).toMatchObject({ take: 3, orderBy: [{ startedAt: "desc" }, { id: "desc" }], where: { OR: [{ startedAt: { lt: now } }, { startedAt: now, id: { lt: "d" } }] } });
  });

  it("preserves unknown outcomes and omits raw errors", async () => {
    const { prisma, rows } = fixture();
    rows.mockResolvedValue([{ id: "effect-1", createdAt: now, status: "PRIVATE_SENTINEL", request: "PRIVATE_SENTINEL", result: "PRIVATE_SENTINEL" }]);
    const result = await getRunDiagnostics(prisma, actor, { runId: "run-1", section: "effects", limit: 25 }, now);
    expect(result.entries[0].status).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
    expect(result.historyMayBeIncomplete).toBe(true);
  });

  it("propagates database failures instead of reporting empty evidence", async () => {
    const { prisma, rows } = fixture();
    rows.mockRejectedValue(new Error("database unavailable"));
    await expect(getRunDiagnostics(prisma, actor, { runId: "run-1", section: "events", limit: 25 }, now)).rejects.toThrow("database unavailable");
  });
});
