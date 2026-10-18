import type { Prisma } from "./client.js";

/** Acquire before row locks for dependency and ticket/project lifecycle writes. */
export async function lockTicketSpace(tx: Prisma.TransactionClient, spaceId: string) {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${spaceId}, 712012))`;
  // Write a shared row so an older RepeatableRead snapshot fails with a
  // serialization conflict instead of validating dependencies against stale data.
  await tx.$executeRaw`UPDATE spaces SET id = id WHERE id = ${spaceId}`;
}
