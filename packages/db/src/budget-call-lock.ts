import type { Prisma } from "./client.js";

/** Acquire before usage, reservation, or budget row locks, even for absent calls. */
export async function lockBudgetCall(
  tx: Prisma.TransactionClient,
  spaceId: string,
  callId: string,
): Promise<void> {
  const identity = `rak:budget-call:${spaceId}:${callId}`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))`;
}
