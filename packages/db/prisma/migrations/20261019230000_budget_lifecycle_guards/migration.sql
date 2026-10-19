ALTER TABLE "project_budgets" DROP CONSTRAINT "project_budgets_spaceId_projectId_fkey";
ALTER TABLE "project_budgets" ADD CONSTRAINT "project_budgets_spaceId_projectId_fkey" FOREIGN KEY ("spaceId", "projectId") REFERENCES "projects"("spaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "budget_overrun_approvals" ADD COLUMN "decisionReason" TEXT;
ALTER TABLE "budget_reservations" ADD COLUMN "executionState" TEXT NOT NULL DEFAULT 'unknown', ADD COLUMN "providerStartedAt" TIMESTAMP(3);
