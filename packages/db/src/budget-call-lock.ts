import type { Prisma } from "./client.js";

/**
 * Acquire before usage, reservation, or budget row locks, even for absent calls.
 * Each transaction acquires one call key. Any future multi-call transaction must
 * deduplicate keys, acquire them in ascending signed int64 hashtextextended order,
 * and add an injected-collision test before introducing that path.
 */
export async function lockBudgetCall(
  tx: Prisma.TransactionClient,
  spaceId: string,
  callId: string,
): Promise<void> {
  const identity = `rak:budget-call:${spaceId}:${callId}`;
  // Prisma cannot deserialize PostgreSQL's void result; preserve lock acquisition
  // while returning a supported scalar type.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))::text`;
}
