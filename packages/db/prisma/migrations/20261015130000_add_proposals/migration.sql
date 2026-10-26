-- CreateTable
CREATE TABLE "proposals" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recommendation" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "chosenOption" TEXT,
    "comment" TEXT,
    "decidedAt" TIMESTAMP(3),
    "submitKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "proposals_spaceId_submitKey_key" ON "proposals"("spaceId", "submitKey");

-- CreateIndex
CREATE INDEX "proposals_spaceId_userId_status_createdAt_idx" ON "proposals"("spaceId", "userId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "proposals_botId_idx" ON "proposals"("botId");

-- AddForeignKey
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
