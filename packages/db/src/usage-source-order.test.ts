import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { recordUsage, UsageReplayConflictError } from "./usage.js";

describe("usage cost source arrival order", () => {
  it.each([
    ["pricing_estimate", "provider_reported"],
    ["provider_reported", "pricing_estimate"],
  ])("preserves %s when a differing %s arrives", async (firstSource, laterSource) => {
    let row: any = null;
    const tx = {
      $queryRaw: vi.fn(async () => []),
      usageRecord: {
        findUnique: vi.fn(async () => row),
        create: vi.fn(async ({ data }: any) => (row = { id: "usage", ...data })),
        update: vi.fn(async ({ data }: any) => (row = { ...row, ...data })),
      },
    };
    const db = { $transaction: async (execute: any) => execute(tx) } as unknown as PrismaClient;
    const attribution = { spaceId: "space", userId: "user" };
    const event = { type: "usage" as const, provider: "fixture", model: "model", callId: "call", inputTokens: 10, outputTokens: 2, billingKind: "api" as const };
    await recordUsage(db, { ...event, costUsdDecimal: "0.000100", costSource: firstSource, pricingVersion: "first-version" }, attribution);
    const discrepancy = { ...event, costUsdDecimal: "0.000125", costSource: laterSource, pricingVersion: "later-version" };
    await recordUsage(db, discrepancy, attribution);
    await recordUsage(db, discrepancy, attribution);
    expect(row).toMatchObject({ costMicroUsd: 100n, costSource: firstSource, pricingVersion: "first-version" });
    expect(row.costAnomalies).toEqual([{ kind: "amount_source_conflict", costMicroUsd: "125", costSource: laterSource }]);
    expect(tx.usageRecord.create).toHaveBeenCalledTimes(1);
    expect(tx.usageRecord.update).toHaveBeenCalledTimes(1);
    await expect(recordUsage(db, { ...event, costUsdDecimal: "0.000126", costSource: firstSource }, attribution)).rejects.toBeInstanceOf(UsageReplayConflictError);
    expect(row.costMicroUsd).toBe(100n);
    expect(tx.usageRecord.update).toHaveBeenCalledTimes(1);
  });
});
