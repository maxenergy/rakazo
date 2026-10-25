import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { loadProjectContext } from "./project-context.js";
import { loadAgentTicketContext } from "./ticket-context.js";

describe("restored employee project context", () => {
  it("injects only the new project's tickets, goals and members", async () => {
    const tickets = [
      {
        id: "old-ticket",
        number: 1,
        projectId: "old",
        title: "Old private task",
        status: "doing",
        assigneeBotId: null,
      },
      {
        id: "new-ticket",
        number: 2,
        projectId: "new",
        title: "Current task",
        status: "doing",
        assigneeBotId: null,
      },
    ];
    const prisma = {
      project: {
        findFirst: vi.fn(async ({ where }) => ({ id: where.id, name: "New", status: "active" })),
      },
      goal: {
        findMany: vi.fn(async ({ where }) =>
          where.projectId === "new" ? [{ name: "Current goal" }] : [{ name: "Old goal" }],
        ),
      },
      projectMember: {
        findMany: vi.fn(async ({ where }) =>
          where.projectId === "new" ? [{ botId: "current-peer" }] : [{ botId: "old-peer" }],
        ),
      },
      board: { findUnique: vi.fn(async () => ({ id: "board", ticketPrefix: "RAK" })) },
      ticket: {
        findMany: vi.fn(async ({ where }) =>
          tickets.filter((ticket) => ticket.projectId === where.projectId),
        ),
      },
      ticketComment: { findMany: vi.fn(async () => []) },
    };
    const db = prisma as unknown as PrismaClient;
    const rendered = [
      await loadProjectContext(db, { spaceId: "space", projectId: "new" }),
      await loadAgentTicketContext(
        { prisma: db, ticketBoardEnabled: true },
        {
          spaceId: "space",
          projectId: "new",
          text: "RAK-1 RAK-2",
        },
      ),
    ].join("\n");
    expect(rendered).toContain("Current task");
    expect(rendered).toContain("Current goal");
    expect(rendered).toContain("current-peer");
    expect(rendered).not.toContain("Old private task");
    expect(rendered).not.toContain("Old goal");
    expect(rendered).not.toContain("old-peer");
    expect(prisma.goal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: "space", projectId: "new", archivedAt: null },
      }),
    );
    expect(prisma.projectMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: "new", project: { spaceId: "space" } },
      }),
    );
  });
});
