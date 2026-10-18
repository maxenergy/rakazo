import type { Prisma } from "./client.js";
import { lockBudgetCall } from "./budget-call-lock.js";
import { settleBudgetInTransaction } from "./project-budgets.js";

interface UsageSettlement {
  spaceId: string;
  callId: string | null;
  projectId: string | null;
  billingKind: string;
  costMicroUsd: bigint | null;
}

/** Caller shares the transaction that persists usage. Never creates a reservation. */
export async function reconcileUsageInTransaction(
  tx: Prisma.TransactionClient,
  usage: UsageSettlement,
): Promise<void> {
  if (!usage.callId || usage.billingKind === "subscription_included") return;
  await lockBudgetCall(tx, usage.spaceId, usage.callId);
  await tx.$queryRaw`SELECT 1 FROM "usage_records" WHERE "spaceId" = ${usage.spaceId} AND "callId" = ${usage.callId} FOR UPDATE`;
  const rows = await tx.$queryRaw<{ id: string; budgetId: string; amountMicroUsd: bigint; unreconciledAt: Date | null; status: string }[]>`SELECT * FROM "budget_reservations" WHERE "spaceId" = ${usage.spaceId} AND "callId" = ${usage.callId} FOR UPDATE`;
  const reservation = rows[0];
  if (!reservation) return;
  const budgets = await tx.$queryRaw<{ projectId: string }[]>`SELECT * FROM "project_budgets" WHERE "id" = ${reservation.budgetId} FOR UPDATE`;
  if (!budgets[0] || budgets[0].projectId !== usage.projectId) {
    throw new Error("Usage project conflicts with reservation attribution");
  }
  if (usage.costMicroUsd !== null) {
    await settleBudgetInTransaction(tx, {
      spaceId: usage.spaceId,
      callId: usage.callId,
      actualMicroUsd: usage.costMicroUsd,
    });
    return;
  }
  if (["settled", "unreconciled", "written_off"].includes(reservation.status)) return;
  const recovering = reservation.status === "released" || reservation.status === "expired";
  if (recovering) {
    await tx.projectBudget.update({
      where: { id: reservation.budgetId },
      data: { reservedMicroUsd: { increment: reservation.amountMicroUsd } },
    });
  }
  await tx.budgetReservation.update({
    where: { id: reservation.id },
    data: {
      status: "unreconciled",
      unreconciledAt: reservation.unreconciledAt ?? new Date(),
      recoveredAt: recovering ? new Date() : undefined,
      chargedAfterRelease: reservation.status === "released" ? true : undefined,
    },
  });
}
