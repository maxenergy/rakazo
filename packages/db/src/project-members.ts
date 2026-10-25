import type { Prisma } from "./client.js";
import { ProjectLinkError } from "./project-links.js";
import { lockTicketSpace } from "./ticket-space-lock.js";

async function requireProject(tx: Prisma.TransactionClient, spaceId: string, projectId: string) {
  const project = await tx.project.findFirst({
    where: { id: projectId, spaceId },
    select: { id: true },
  });
  if (!project) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
}

export async function readProjectMembers(
  tx: Prisma.TransactionClient,
  spaceId: string,
  projectId: string,
) {
  await requireProject(tx, spaceId, projectId);
  const rows = await tx.projectMember.findMany({
    where: { projectId },
    orderBy: [{ createdAt: "asc" }, { botId: "asc" }],
  });
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

export async function editProjectMember(
  tx: Prisma.TransactionClient,
  spaceId: string,
  action: "add" | "remove" | "owner",
  input: { projectId: string; botId: string | null },
) {
  await lockTicketSpace(tx, spaceId);
  await requireProject(tx, spaceId, input.projectId);
  if (input.botId !== null) {
    const bot = await tx.bot.findFirst({
      where: { id: input.botId, spaceId },
      select: { id: true },
    });
    if (!bot) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  } else if (action !== "owner") {
    throw new ProjectLinkError("BAD_REQUEST", "Bot is required.");
  }
  if (action === "owner") {
    await tx.projectMember.updateMany({
      where: { projectId: input.projectId, role: "owner" },
      data: { role: "member" },
    });
  }
  if (input.botId !== null) {
    const where = { projectId_botId: { projectId: input.projectId, botId: input.botId } };
    if (action === "remove") {
      await tx.projectMember.deleteMany({
        where: { projectId: input.projectId, botId: input.botId },
      });
    } else {
      await tx.projectMember.upsert({
        where,
        create: {
          projectId: input.projectId,
          botId: input.botId,
          role: action === "owner" ? "owner" : "member",
        },
        update: action === "owner" ? { role: "owner" } : {},
      });
    }
  }
  return readProjectMembers(tx, spaceId, input.projectId);
}

export async function readBotProjects(
  tx: Prisma.TransactionClient,
  spaceId: string,
  botId: string,
) {
  const bot = await tx.bot.findFirst({ where: { id: botId, spaceId }, select: { id: true } });
  if (!bot) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  const rows = await tx.projectMember.findMany({
    where: { botId, project: { spaceId } },
    include: { project: { select: { name: true, status: true } } },
    orderBy: { projectId: "asc" },
  });
  return rows.map(({ projectId, role, project }) => ({ projectId, role, ...project }));
}
