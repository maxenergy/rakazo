-- Index and foreign-key creation briefly blocks ticket writes.
BEGIN;

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "milestoneId" TEXT,
ADD COLUMN     "projectId" TEXT;

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "milestones" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "dueAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "milestones_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "projects_spaceId_archivedAt_updatedAt_id_idx" ON "projects"("spaceId", "archivedAt", "updatedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_spaceId_id_key" ON "projects"("spaceId", "id");

-- CreateIndex
CREATE INDEX "milestones_spaceId_projectId_archivedAt_updatedAt_id_idx" ON "milestones"("spaceId", "projectId", "archivedAt", "updatedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "milestones_spaceId_projectId_id_key" ON "milestones"("spaceId", "projectId", "id");

-- CreateIndex
CREATE INDEX "tickets_spaceId_projectId_status_idx" ON "tickets"("spaceId", "projectId", "status");

-- CreateIndex
CREATE INDEX "tickets_spaceId_milestoneId_status_idx" ON "tickets"("spaceId", "milestoneId", "status");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_spaceId_projectId_fkey" FOREIGN KEY ("spaceId", "projectId") REFERENCES "projects"("spaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "milestones"("id") ON DELETE SET NULL ON UPDATE CASCADE;


ALTER TABLE "tickets" ADD CONSTRAINT "tickets_milestone_requires_project_check" CHECK ("milestoneId" IS NULL OR "projectId" IS NOT NULL);

COMMIT;
