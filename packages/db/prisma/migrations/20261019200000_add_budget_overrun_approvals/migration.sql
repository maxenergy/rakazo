CREATE TABLE "budget_overrun_approvals" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "budgetVersion" INTEGER NOT NULL,
    "amountMicroUsd" BIGINT NOT NULL,
    "scope" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "proposalId" TEXT,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "appliedVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "budget_overrun_approvals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "budget_overrun_approvals_amount_positive" CHECK ("amountMicroUsd" > 0)
);
CREATE UNIQUE INDEX "budget_overrun_approvals_spaceId_requestKey_key" ON "budget_overrun_approvals"("spaceId", "requestKey");
CREATE INDEX "budget_overrun_approvals_spaceId_projectId_status_idx" ON "budget_overrun_approvals"("spaceId", "projectId", "status");
ALTER TABLE "budget_overrun_approvals" ADD CONSTRAINT "budget_overrun_approvals_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "project_budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
