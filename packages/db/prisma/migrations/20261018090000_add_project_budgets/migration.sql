-- Additive project budget storage (integer micro-USD); no existing table is altered.
BEGIN;

CREATE TABLE "project_budgets" (
  "id" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "limitMicroUsd" BIGINT NOT NULL,
  "reservedMicroUsd" BIGINT NOT NULL DEFAULT 0,
  "settledMicroUsd" BIGINT NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "project_budgets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_budgets_amounts_check" CHECK ("limitMicroUsd" >= 0 AND "reservedMicroUsd" >= 0 AND "settledMicroUsd" >= 0),
  CONSTRAINT "project_budgets_version_check" CHECK ("version" >= 1)
);

CREATE UNIQUE INDEX "project_budgets_spaceId_projectId_key" ON "project_budgets"("spaceId", "projectId");

ALTER TABLE "project_budgets"
  ADD CONSTRAINT "project_budgets_spaceId_projectId_fkey"
  FOREIGN KEY ("spaceId", "projectId") REFERENCES "projects"("spaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "project_budget_versions" (
  "budgetId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "limitMicroUsd" BIGINT NOT NULL,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_budget_versions_pkey" PRIMARY KEY ("budgetId", "version"),
  CONSTRAINT "project_budget_versions_limit_check" CHECK ("limitMicroUsd" >= 0)
);

ALTER TABLE "project_budget_versions"
  ADD CONSTRAINT "project_budget_versions_budgetId_fkey"
  FOREIGN KEY ("budgetId") REFERENCES "project_budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "budget_reservations" (
  "id" TEXT NOT NULL,
  "budgetId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "budgetVersion" INTEGER NOT NULL,
  "callId" TEXT NOT NULL,
  "amountMicroUsd" BIGINT NOT NULL,
  "settledMicroUsd" BIGINT,
  "overrunMicroUsd" BIGINT NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'reserved',
  "settledLate" BOOLEAN NOT NULL DEFAULT false,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3),
  CONSTRAINT "budget_reservations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "budget_reservations_amounts_check" CHECK ("amountMicroUsd" >= 0 AND COALESCE("settledMicroUsd", 0) >= 0 AND "overrunMicroUsd" >= 0),
  CONSTRAINT "budget_reservations_status_check" CHECK ("status" IN ('reserved', 'settled', 'released', 'expired'))
);

CREATE UNIQUE INDEX "budget_reservations_callId_key" ON "budget_reservations"("callId");
CREATE INDEX "budget_reservations_budgetId_status_expiresAt_idx" ON "budget_reservations"("budgetId", "status", "expiresAt");

ALTER TABLE "budget_reservations"
  ADD CONSTRAINT "budget_reservations_budgetId_fkey"
  FOREIGN KEY ("budgetId") REFERENCES "project_budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
