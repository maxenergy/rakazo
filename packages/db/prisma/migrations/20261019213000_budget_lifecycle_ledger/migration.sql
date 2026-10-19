ALTER TABLE "budget_overrun_approvals" ADD COLUMN "decisionReason" TEXT;
ALTER TABLE "budget_reservations" ADD COLUMN "executionState" TEXT NOT NULL DEFAULT 'unknown', ADD COLUMN "providerStartedAt" TIMESTAMP(3);
ALTER TABLE "budget_spend_ledger" ADD COLUMN "auditData" JSONB;
ALTER TABLE "budget_spend_ledger" DROP CONSTRAINT "budget_spend_ledger_kind_check";
ALTER TABLE "budget_spend_ledger" ADD CONSTRAINT "budget_spend_ledger_kind_check" CHECK ("kind" IN ('settled', 'released', 'expired', 'open_at_deletion', 'written_off', 'approval_at_deletion'));
