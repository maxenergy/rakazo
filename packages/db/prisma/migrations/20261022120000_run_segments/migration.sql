ALTER TABLE "runs" ADD COLUMN "deadlineAt" TIMESTAMP(3),
ADD COLUMN "progressAt" TIMESTAMP(3),
ADD COLUMN "segmentCheckpoint" TEXT;
