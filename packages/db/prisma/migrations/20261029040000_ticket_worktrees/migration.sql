CREATE TABLE "ticket_worktrees" (
  "id" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "location" TEXT NOT NULL,
  "computer" TEXT NOT NULL,
  "repo" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "branch" TEXT NOT NULL,
  CONSTRAINT "ticket_worktrees_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ticket_worktrees_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ticket_worktrees_ticketId_computer_repo_key" ON "ticket_worktrees"("ticketId", "computer", "repo");
