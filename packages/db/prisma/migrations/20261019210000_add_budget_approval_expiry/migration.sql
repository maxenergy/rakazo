ALTER TABLE "budget_overrun_approvals" ADD COLUMN "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '24 hours');
ALTER TABLE "budget_overrun_approvals" ADD COLUMN "decisionReason" TEXT;
ALTER TABLE "budget_reservations" ADD COLUMN "executionState" TEXT NOT NULL DEFAULT 'unknown', ADD COLUMN "providerStartedAt" TIMESTAMP(3);
ALTER TABLE "budget_spend_ledger" ADD COLUMN "auditData" JSONB;
ALTER TABLE "budget_spend_ledger" DROP CONSTRAINT "budget_spend_ledger_kind_check";
ALTER TABLE "budget_spend_ledger" ADD CONSTRAINT "budget_spend_ledger_kind_check" CHECK ("kind" IN ('settled', 'released', 'expired', 'open_at_deletion', 'written_off', 'settled_after_deletion'));

CREATE TABLE "budget_approval_deletion_audit" (
  "id" TEXT PRIMARY KEY,
  "spaceId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "budgetId" TEXT NOT NULL,
  "budgetVersion" INTEGER NOT NULL,
  "approvalId" TEXT NOT NULL,
  "amountMicroUsd" BIGINT NOT NULL,
  "state" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "decision" TEXT,
  "auditData" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("spaceId", "approvalId")
);
