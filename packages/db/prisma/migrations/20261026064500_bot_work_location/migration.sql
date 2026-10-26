CREATE TYPE "WorkLocation" AS ENUM ('container', 'host');
CREATE TYPE "HostAuditKind" AS ENUM ('exec', 'file.write', 'file.delete', 'grant', 'revoke');
ALTER TABLE "bots" ADD COLUMN "workLocation" "WorkLocation" NOT NULL DEFAULT 'container',
ADD COLUMN "hostRoots" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "hostGrantedAt" TIMESTAMP(3),
ADD COLUMN "hostGrantedByUserId" TEXT;
CREATE TABLE "host_audit_logs" (
  "id" TEXT NOT NULL,
  "botId" TEXT NOT NULL,
  "runId" TEXT,
  "userId" TEXT,
  "kind" "HostAuditKind" NOT NULL,
  "target" TEXT NOT NULL,
  "command" TEXT,
  "exitCode" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "host_audit_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "host_audit_logs_botId_createdAt_idx" ON "host_audit_logs"("botId", "createdAt");
