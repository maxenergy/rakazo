import type { PrismaClient } from "./client.js";

export async function readBotContinuation(
  prisma: Pick<PrismaClient, "projectMember" | "ticket" | "routine" | "project">,
  scope: { spaceId: string; userId: string; botId: string },
) {
  const [memberships, tickets, routines] = await Promise.all([
    prisma.projectMember.findMany({
      where: { botId: scope.botId, project: { spaceId: scope.spaceId } },
    }),
    prisma.ticket.findMany({
      where: {
        spaceId: scope.spaceId,
        assigneeBotId: scope.botId,
        status: { notIn: ["done", "closed"] },
      },
      select: { id: true, projectId: true, title: true, status: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    prisma.routine.findMany({
      where: {
        spaceId: scope.spaceId,
        userId: scope.userId,
        botId: scope.botId,
        active: false,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  ]);
  const memberIds = new Set(memberships.map((row) => row.projectId));
  const projectIds = [
    ...new Set(
      [
        ...memberIds,
        ...tickets.map((row) => row.projectId),
        ...routines.map((row) => row.projectId),
      ].filter((id): id is string => id != null),
    ),
  ];
  const projects = await prisma.project.findMany({
    where: { spaceId: scope.spaceId, id: { in: projectIds } },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  return {
    botId: scope.botId,
    tickets,
    routines,
    projects: projects.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      member: memberIds.has(row.id),
    })),
  };
}
