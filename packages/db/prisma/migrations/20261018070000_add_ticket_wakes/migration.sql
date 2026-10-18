BEGIN;

CREATE TABLE "ticket_wakes" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "prerequisiteId" TEXT NOT NULL,
  "prerequisiteCompletedAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "claimedBy" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "wokenAt" TIMESTAMP(3),

  CONSTRAINT "ticket_wakes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ticket_wakes_dedupe_key" ON "ticket_wakes"("spaceId", "ticketId", "prerequisiteId", "prerequisiteCompletedAt");

CREATE INDEX "ticket_wakes_status_leaseExpiresAt_idx" ON "ticket_wakes"("status", "leaseExpiresAt");

ALTER TABLE "ticket_wakes" ADD CONSTRAINT "ticket_wakes_spaceId_ticketId_fkey" FOREIGN KEY ("spaceId", "ticketId") REFERENCES "tickets"("spaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ticket_wakes" ADD CONSTRAINT "ticket_wakes_spaceId_prerequisiteId_fkey" FOREIGN KEY ("spaceId", "prerequisiteId") REFERENCES "tickets"("spaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
