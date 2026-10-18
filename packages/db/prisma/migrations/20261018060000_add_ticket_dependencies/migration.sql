-- Additive dependency storage; existing tickets and lifecycle fields are unchanged.
BEGIN;

CREATE UNIQUE INDEX "tickets_spaceId_id_key" ON "tickets"("spaceId", "id");

CREATE TABLE "ticket_dependencies" (
  "spaceId" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "prerequisiteId" TEXT NOT NULL,
  CONSTRAINT "ticket_dependencies_pkey" PRIMARY KEY ("spaceId", "ticketId", "prerequisiteId"),
  CONSTRAINT "ticket_dependencies_no_self_check" CHECK ("ticketId" <> "prerequisiteId"),
  CONSTRAINT "ticket_dependencies_spaceId_ticketId_fkey" FOREIGN KEY ("spaceId", "ticketId") REFERENCES "tickets"("spaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ticket_dependencies_spaceId_prerequisiteId_fkey" FOREIGN KEY ("spaceId", "prerequisiteId") REFERENCES "tickets"("spaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ticket_dependencies_spaceId_prerequisiteId_idx" ON "ticket_dependencies"("spaceId", "prerequisiteId");

COMMIT;
