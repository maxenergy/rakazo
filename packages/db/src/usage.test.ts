import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { recordUsage, UsageReplayConflictError } from "./usage.js";

const attribution = { spaceId: "space-fixture", userId: "user-fixture" };
const event = {
  type: "usage" as const,
  provider: "fixture",
  model: "test",
  callId: "call-fixture",
  inputTokens: 10,
  outputTokens: 2,
};
function fixture() {
  let row: any = null;
  const tx = {
    $queryRaw: vi.fn(async () => []),
    usageRecord: {
      findUnique: vi.fn(async () => row),
      create: vi.fn(async ({ data }: any) => (row = { id: "usage-fixture", ...data })),
      update: vi.fn(async ({ data }: any) => (row = { ...row, ...data })),
    },
  };
  const transaction = vi.fn(async (execute: any) => execute(tx));
  const db = { $transaction: transaction } as unknown as PrismaClient;
  return { db, tx, transaction };
}

describe("usage ledger transactions", () => {
  it("retains durable attribution when the lifecycle run was deleted", async () => {
    const { db } = fixture();
    const row = await recordUsage(db, event, { ...attribution, runId: "deleted-run" });
    expect(row).toMatchObject({
      runId: null,
      attributedRunId: "deleted-run",
      parentRunId: "deleted-run",
      inputTokens: 10,
    });
  });
  it("replays a call without inserting duplicate usage", async () => {
    const { db, tx } = fixture();
    await recordUsage(db, event, attribution);
    await recordUsage(db, event, attribution);
    expect(tx.usageRecord.create).toHaveBeenCalledTimes(1);
  });
  it("rejects conflicting immutable project attribution including null", async () => {
    const { db, tx } = fixture();
    await recordUsage(db, event, attribution);
    await expect(
      recordUsage(db, event, { ...attribution, projectId: "project-fixture" }),
    ).rejects.toBeInstanceOf(UsageReplayConflictError);
    expect(tx.usageRecord.update).not.toHaveBeenCalled();
  });
  it("enriches an unknown amount and never downgrades it on unknown replay", async () => {
    const { db, tx } = fixture();
    await recordUsage(db, event, attribution);
    const enriched = await recordUsage(db, { ...event, costUsdDecimal: "0.0000011" }, attribution);
    expect(enriched.costMicroUsd).toBe(2n);
    const replay = await recordUsage(db, event, attribution);
    expect(replay.costMicroUsd).toBe(2n);
    expect(tx.usageRecord.update).toHaveBeenCalledTimes(1);
  });
  it("reuses the supplied transaction without opening a nested transaction", async () => {
    const { db, tx, transaction } = fixture();
    await recordUsage(db, event, attribution, { tx: tx as any });
    expect(transaction).not.toHaveBeenCalled();
    expect(tx.usageRecord.create).toHaveBeenCalledTimes(1);
  });
  it("keeps unknown background usage null and writes no floating-point money", async () => {
    const { db } = fixture();
    const row = await recordUsage(
      db,
      { ...event, callId: undefined, costUsd: 0.1 },
      { ...attribution, operationKind: "compaction" },
    );
    expect(row).toMatchObject({
      runId: null,
      costMicroUsd: null,
      inputTokens: 10,
      operationKind: "compaction",
    });
    expect(row).not.toHaveProperty("costUsd");
  });
});
