ALTER TABLE "artifacts"
  ADD COLUMN "project_id" TEXT,
  ADD COLUMN "milestone_id" TEXT,
  ADD COLUMN "ticket_id" TEXT,
  ADD COLUMN "link_source" TEXT;
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_milestone_id_fkey" FOREIGN KEY ("milestone_id") REFERENCES "milestones"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "artifacts_spaceId_project_id_createdAt_idx" ON "artifacts"("spaceId", "project_id", "createdAt");
CREATE INDEX "artifacts_spaceId_milestone_id_createdAt_idx" ON "artifacts"("spaceId", "milestone_id", "createdAt");
CREATE INDEX "artifacts_spaceId_ticket_id_createdAt_idx" ON "artifacts"("spaceId", "ticket_id", "createdAt");

ALTER TABLE "runs" ADD COLUMN "ticketId" TEXT REFERENCES "tickets"("id") ON DELETE SET NULL;
