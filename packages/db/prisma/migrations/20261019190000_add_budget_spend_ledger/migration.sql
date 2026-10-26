-- Additive space-scoped spend/audit ledger. projectId/budgetId are denormalized with no foreign key
-- so spend history survives project deletion (project_budgets keeps ON DELETE CASCADE).
BEGIN;

CREATE TABLE "budget_spend_ledger" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "budgetId" TEXT NOT NULL,
  "budgetVersion" INTEGER NOT NULL,
  "callId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "amountMicroUsd" BIGINT NOT NULL,
  "overrunMicroUsd" BIGINT NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "budget_spend_ledger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "budget_spend_ledger_amounts_check" CHECK ("amountMicroUsd" >= 0 AND "overrunMicroUsd" >= 0),
  CONSTRAINT "budget_spend_ledger_kind_check" CHECK ("kind" IN ('settled', 'released', 'expired'))
);

CREATE UNIQUE INDEX "budget_spend_ledger_spaceId_callId_kind_key" ON "budget_spend_ledger"("spaceId", "callId", "kind");
CREATE INDEX "budget_spend_ledger_spaceId_projectId_createdAt_idx" ON "budget_spend_ledger"("spaceId", "projectId", "createdAt");

COMMIT;
