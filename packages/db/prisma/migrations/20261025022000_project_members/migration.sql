CREATE TYPE "ProjectStatus" AS ENUM ('active', 'paused');
CREATE TYPE "ProjectMemberRole" AS ENUM ('owner', 'member');
ALTER TABLE "projects" ADD COLUMN "status" "ProjectStatus" NOT NULL DEFAULT 'active', ADD COLUMN "pausedAt" TIMESTAMP(3);
CREATE TABLE "project_members" (
  "projectId" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "role" "ProjectMemberRole" NOT NULL DEFAULT 'member',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("projectId", "botId")
);
CREATE INDEX "project_members_botId_idx" ON "project_members"("botId");
CREATE UNIQUE INDEX "project_members_one_owner" ON "project_members"("projectId") WHERE "role" = 'owner';
