import type { Prisma, PrismaClient } from "./client.js";

export type ClaimedTicketWake = {
  id: string;
  spaceId: string;
  ticketId: string;
  prerequisiteId: string;
  attempts: number;
};

/**
 * Records a durable wake for every dependent whose prerequisites are now all complete.
 * Call inside the transaction that completes the prerequisite, so the wake commits or
 * rolls back with it. The unique key makes a repeated call a no-op.
 */
export async function enqueueDependentWakes(
  tx: Prisma.TransactionClient,
  spaceId: string,
  prerequisiteId: string,
  completedAt: Date,
): Promise<number> {
  return tx.$executeRaw`
    INSERT INTO ticket_wakes (id, "spaceId", "ticketId", "prerequisiteId", "prerequisiteCompletedAt")
    SELECT gen_random_uuid()::text, d."spaceId", d."ticketId", d."prerequisiteId", ${completedAt}
    FROM ticket_dependencies d
    WHERE d."spaceId" = ${spaceId}
      AND d."prerequisiteId" = ${prerequisiteId}
      AND NOT EXISTS (
        SELECT 1
        FROM ticket_dependencies o
        JOIN tickets p ON p."spaceId" = o."spaceId" AND p.id = o."prerequisiteId"
        WHERE o."spaceId" = d."spaceId"
          AND o."ticketId" = d."ticketId"
          AND p.status NOT IN ('done', 'closed')
      )
    ON CONFLICT ("spaceId", "ticketId", "prerequisiteId", "prerequisiteCompletedAt") DO NOTHING
  `;
}

/**
 * Atomically claims pending wakes, and wakes whose earlier claim lease expired (for
 * example after a runtime restart). SKIP LOCKED keeps concurrent claimers disjoint.
 */
export async function claimTicketWakes(
  prisma: PrismaClient,
  claimer: string,
  options: { limit?: number; leaseMs?: number; now?: Date } = {},
): Promise<ClaimedTicketWake[]> {
  const limit = options.limit ?? 20;
  const now = options.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + (options.leaseMs ?? 60_000));
  return prisma.$queryRaw<ClaimedTicketWake[]>`
    UPDATE ticket_wakes w
    SET status = 'claimed', "claimedBy" = ${claimer}, "leaseExpiresAt" = ${leaseExpiresAt},
        attempts = w.attempts + 1
    WHERE w.id IN (
      SELECT id FROM ticket_wakes
      WHERE status = 'pending' OR (status = 'claimed' AND "leaseExpiresAt" <= ${now})
      ORDER BY "createdAt", id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING w.id, w."spaceId", w."ticketId", w."prerequisiteId", w.attempts
  `;
}

/** Marks a claimed wake delivered. Returns false if the claim was lost to another owner. */
export async function completeTicketWake(
  prisma: PrismaClient,
  id: string,
  claimer: string,
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await prisma.$executeRaw`
    UPDATE ticket_wakes
    SET status = 'woken', "wokenAt" = ${now}, "leaseExpiresAt" = NULL
    WHERE id = ${id} AND status = 'claimed' AND "claimedBy" = ${claimer}
  `;
  return updated === 1;
}
