-- Who decided a proposal: the owner ("user") or the launch team itself ("team").
ALTER TABLE "proposals" ADD COLUMN "decidedBy" TEXT NOT NULL DEFAULT 'user';
