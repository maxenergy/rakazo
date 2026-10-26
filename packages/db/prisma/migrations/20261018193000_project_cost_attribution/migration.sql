BEGIN;

ALTER TABLE "runs"
  ADD COLUMN "projectId" TEXT,
  ADD COLUMN "parentRunId" TEXT,
  ADD COLUMN "rootRunId" TEXT;

ALTER TABLE "usage_records"
  ADD COLUMN "costMicroUsd" BIGINT,
  ADD COLUMN "billingKind" TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN "projectId" TEXT,
  ADD COLUMN "attributedRunId" TEXT,
  ADD COLUMN "rootRunId" TEXT,
  ADD COLUMN "costAnomalies" JSONB;

DROP INDEX "usage_records_callId_key";
CREATE UNIQUE INDEX "usage_records_spaceId_callId_key" ON "usage_records"("spaceId", "callId");
CREATE INDEX "usage_records_spaceId_projectId_createdAt_idx" ON "usage_records"("spaceId", "projectId", "createdAt");

ALTER TABLE "budget_reservations"
  ADD COLUMN "recoveredAt" TIMESTAMP(3),
  ADD COLUMN "unreconciledAt" TIMESTAMP(3),
  ADD COLUMN "chargedAfterRelease" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "chargedAfterWriteOff" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "writtenOffAt" TIMESTAMP(3),
  ADD COLUMN "writtenOffBy" TEXT,
  ADD COLUMN "writeOffReason" TEXT;

ALTER TABLE "budget_reservations"
  DROP CONSTRAINT "budget_reservations_status_check",
  ADD CONSTRAINT "budget_reservations_status_check"
    CHECK ("status" IN ('reserved', 'settled', 'released', 'expired', 'unreconciled', 'written_off'));

ALTER TABLE "usage_records"
  ADD CONSTRAINT "usage_records_cost_micro_usd_check"
    CHECK ("costMicroUsd" IS NULL OR "costMicroUsd" >= 0);

COMMIT;
