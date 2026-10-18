BEGIN;

-- CreateTable
CREATE TABLE "goals" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "state" TEXT NOT NULL DEFAULT 'planned',
    "dueAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "key_results" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "milestoneId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "state" TEXT NOT NULL DEFAULT 'planned',
    "measure" TEXT NOT NULL,
    "targetValue" DOUBLE PRECISION NOT NULL,
    "currentValue" DOUBLE PRECISION NOT NULL,
    "calculationRule" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "key_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "goals_spaceId_projectId_archivedAt_updatedAt_id_idx" ON "goals"("spaceId", "projectId", "archivedAt", "updatedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "goals_spaceId_projectId_id_key" ON "goals"("spaceId", "projectId", "id");

-- CreateIndex
CREATE INDEX "key_results_spaceId_goalId_archivedAt_updatedAt_id_idx" ON "key_results"("spaceId", "goalId", "archivedAt", "updatedAt", "id");

-- CreateIndex
CREATE INDEX "key_results_spaceId_projectId_milestoneId_idx" ON "key_results"("spaceId", "projectId", "milestoneId");

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_spaceId_projectId_fkey" FOREIGN KEY ("spaceId", "projectId") REFERENCES "projects"("spaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "key_results" ADD CONSTRAINT "key_results_spaceId_projectId_goalId_fkey" FOREIGN KEY ("spaceId", "projectId", "goalId") REFERENCES "goals"("spaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "key_results" ADD CONSTRAINT "key_results_spaceId_projectId_fkey" FOREIGN KEY ("spaceId", "projectId") REFERENCES "projects"("spaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "key_results" ADD CONSTRAINT "key_results_spaceId_projectId_milestoneId_fkey" FOREIGN KEY ("spaceId", "projectId", "milestoneId") REFERENCES "milestones"("spaceId", "projectId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- Preserve milestone deletion compatibility with older application code.
CREATE FUNCTION clear_key_result_milestone_link() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE key_results
    SET "milestoneId" = NULL
    WHERE "spaceId" = OLD."spaceId"
      AND "projectId" = OLD."projectId"
      AND "milestoneId" = OLD.id;
    RETURN OLD;
END;
$$;

CREATE TRIGGER clear_key_result_milestone_link_before_delete
BEFORE DELETE ON milestones
FOR EACH ROW EXECUTE FUNCTION clear_key_result_milestone_link();

COMMIT;
