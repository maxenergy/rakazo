import type { Prisma, PrismaClient } from "./client.js";

export interface WriteOffBudgetHoldingInput {
  spaceId: string;
  callId: string;
  actorId: string;
  reason: string;
  now?: Date;
}

/** Releases an unknown-cost holding once; actual spend remains eligible for settlement. */
export function writeOffBudgetHolding(db: PrismaClient, input: WriteOffBudgetHoldingInput) {
  return db.$transaction((tx) => writeOffBudgetHoldingInTransaction(tx, input));
}

export async function writeOffBudgetHoldingInTransaction(
  tx: Prisma.TransactionClient,
  input: WriteOffBudgetHoldingInput,
) {
  if (!input.actorId.trim() || !input.reason.trim()) {
    throw new Error("Write-off requires an actor and reason");
  }
  const identity = `rak:budget-call:${input.spaceId}:${input.callId}`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))`;
  await tx.$queryRaw`SELECT 1 FROM "usage_records" WHERE "spaceId" = ${input.spaceId} AND "callId" = ${input.callId} FOR UPDATE`;
  const rows = await tx.$queryRaw<
    Array<{ id: string; budgetId: string; status: string; amountMicroUsd: bigint }>
  >`
    SELECT * FROM "budget_reservations" WHERE "spaceId" = ${input.spaceId} AND "callId" = ${input.callId} FOR UPDATE`;
  const reservation = rows[0];
  if (reservation?.status !== "unreconciled") return false;
  await tx.$queryRaw`SELECT 1 FROM "project_budgets" WHERE "id" = ${reservation.budgetId} FOR UPDATE`;
  await tx.projectBudget.update({
    where: { id: reservation.budgetId },
    data: { reservedMicroUsd: { decrement: reservation.amountMicroUsd } },
  });
  const now = input.now ?? new Date();
  await tx.$executeRaw`UPDATE "budget_reservations"
    SET "status" = 'written_off', "writtenOffAt" = ${now},
        "writtenOffBy" = ${input.actorId}, "writeOffReason" = ${input.reason}, "closedAt" = ${now}
    WHERE "id" = ${reservation.id}`;
  return true;
}
