import type { Prisma } from "./client.js";

/** Acquire before row locks for dependency and ticket/project lifecycle writes. */
export async function lockTicketSpace(tx: Prisma.TransactionClient, spaceId: string) {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${spaceId}, 712012))`;
}
