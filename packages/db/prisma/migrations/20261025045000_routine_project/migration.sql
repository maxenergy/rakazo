ALTER TABLE "routines" ADD COLUMN "projectId" TEXT;
CREATE INDEX "routines_projectId_idx" ON "routines"("projectId");
ALTER TABLE "routines" ADD CONSTRAINT "routines_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
