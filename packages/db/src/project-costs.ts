import type { Prisma } from "./client.js";

/** Financial snapshots remain independent of current project ownership and lifecycle. */
export async function getProjectCostSummaries(tx: Prisma.TransactionClient, spaceId: string) {
  const rows = await tx.usageRecord.groupBy({
    by: ["projectId", "billingKind"],
    where: { spaceId },
    _sum: { costMicroUsd: true },
    _count: { _all: true, costMicroUsd: true },
  });
  const holdings = await tx.budgetReservation.findMany({
    where: { spaceId, status: "unreconciled" },
    select: { projectId: true, amountMicroUsd: true, unreconciledAt: true, createdAt: true },
  });
  const buckets = new Map<
    string | null,
    {
      projectId: string | null;
      knownMarginalMicroUsd: bigint;
      unknownCostCalls: number;
      subscriptionIncludedCalls: number;
      unreconciledMicroUsd: bigint;
      oldestHoldingAt: Date | null;
    }
  >();
  const bucket = (projectId: string | null) => {
    let value = buckets.get(projectId);
    if (!value) {
      value = {
        projectId,
        knownMarginalMicroUsd: 0n,
        unknownCostCalls: 0,
        subscriptionIncludedCalls: 0,
        unreconciledMicroUsd: 0n,
        oldestHoldingAt: null,
      };
      buckets.set(projectId, value);
    }
    return value;
  };
  bucket(null);
  for (const row of rows) {
    const value = bucket(row.projectId);
    if (row.billingKind === "subscription_included")
      value.subscriptionIncludedCalls += row._count._all;
    else if (row.billingKind === "api") {
      value.knownMarginalMicroUsd += row._sum.costMicroUsd ?? 0n;
      value.unknownCostCalls += row._count._all - row._count.costMicroUsd;
    } else value.unknownCostCalls += row._count._all;
  }
  for (const holding of holdings) {
    const value = bucket(holding.projectId);
    value.unreconciledMicroUsd += holding.amountMicroUsd;
    const since = holding.unreconciledAt ?? holding.createdAt;
    if (!value.oldestHoldingAt || since < value.oldestHoldingAt) value.oldestHoldingAt = since;
  }
  return [...buckets.values()].map((value) => ({
    ...value,
    knownMarginalMicroUsd: value.knownMarginalMicroUsd.toString(),
    unreconciledMicroUsd: value.unreconciledMicroUsd.toString(),
    complete: value.unknownCostCalls === 0 && value.unreconciledMicroUsd === 0n,
  }));
}
