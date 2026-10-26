ALTER TABLE "runs" ADD COLUMN "deadlineMs" INTEGER;
ALTER TABLE "runs" ADD CONSTRAINT "runs_deadlineMs_check" CHECK ("deadlineMs" > 0 AND "deadlineMs" <= 86400000);
