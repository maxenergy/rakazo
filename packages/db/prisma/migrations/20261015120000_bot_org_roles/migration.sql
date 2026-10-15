-- Org layer: a bot's role, its team, and the bot it reports to. Null role keeps the bot outside the org.
ALTER TABLE "bots" ADD COLUMN "orgRole" TEXT;
ALTER TABLE "bots" ADD COLUMN "team" TEXT NOT NULL DEFAULT '';
ALTER TABLE "bots" ADD COLUMN "reportsToBotId" TEXT;

-- CreateIndex
CREATE INDEX "bots_reportsToBotId_idx" ON "bots"("reportsToBotId");

-- AddForeignKey
ALTER TABLE "bots" ADD CONSTRAINT "bots_reportsToBotId_fkey" FOREIGN KEY ("reportsToBotId") REFERENCES "bots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
