ALTER TABLE "budget_overrun_approvals" ADD COLUMN "expiresAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '24 hours');
