import type { Prisma } from "./client.js";
import { isProjectItemArchived, ProjectLinkError } from "./project-links.js";
import { lockTicketSpace } from "./ticket-space-lock.js";

async function lockProject(
  tx: Prisma.TransactionClient,
  spaceId: string,
  id: string,
  shared = false,
) {
  await lockTicketSpace(tx, spaceId);
  const rows = shared
    ? await tx.$queryRaw<
        { id: string; archivedAt: Date | null }[]
      >`SELECT id, "archivedAt" FROM projects WHERE id = ${id} AND "spaceId" = ${spaceId} FOR SHARE`
    : await tx.$queryRaw<
        { id: string; archivedAt: Date | null }[]
      >`SELECT id, "archivedAt" FROM projects WHERE id = ${id} AND "spaceId" = ${spaceId} FOR UPDATE`;
  if (!rows[0]) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  return rows[0];
}

export async function createProject(
  tx: Prisma.TransactionClient,
  spaceId: string,
  input: { name: string; description?: string },
) {
  await lockTicketSpace(tx, spaceId);
  return tx.project.create({ data: { spaceId, ...input } });
}

export async function updateProject(
  tx: Prisma.TransactionClient,
  spaceId: string,
  input: { id: string; name?: string; description?: string | null },
) {
  await lockProject(tx, spaceId, input.id);
  const { id, ...data } = input;
  return tx.project.update({ where: { id }, data });
}

export async function createMilestone(
  tx: Prisma.TransactionClient,
  spaceId: string,
  input: { projectId: string; name: string; description?: string; dueAt?: string | null },
) {
  const project = await lockProject(tx, spaceId, input.projectId, true);
  if (isProjectItemArchived(project))
    throw new ProjectLinkError("BAD_REQUEST", "Project is archived.");
  return tx.milestone.create({
    data: { ...input, spaceId, dueAt: input.dueAt ? new Date(input.dueAt) : null },
  });
}

export async function updateMilestone(
  tx: Prisma.TransactionClient,
  spaceId: string,
  input: { id: string; name?: string; description?: string | null; dueAt?: string | null },
) {
  await lockTicketSpace(tx, spaceId);
  const candidate = await tx.milestone.findFirst({ where: { id: input.id, spaceId } });
  if (!candidate) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  await lockProject(tx, spaceId, candidate.projectId);
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM milestones WHERE id = ${input.id} AND "spaceId" = ${spaceId} AND "projectId" = ${candidate.projectId} FOR UPDATE`;
  if (!rows.length) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  const { id, dueAt, ...data } = input;
  return tx.milestone.update({
    where: { id },
    data: {
      ...data,
      ...(dueAt !== undefined ? { dueAt: dueAt === null ? null : new Date(dueAt) } : {}),
    },
  });
}

/** Validate references before querying tickets without revealing other spaces. */
export async function validateProjectFilter(
  tx: Prisma.TransactionClient,
  spaceId: string,
  input: { projectId?: string | null; milestoneId?: string | null },
) {
  if (typeof input.projectId === "string") {
    const project = await tx.project.findFirst({ where: { id: input.projectId, spaceId } });
    if (!project) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  }
  if (typeof input.milestoneId === "string") {
    const milestone = await tx.milestone.findFirst({ where: { id: input.milestoneId, spaceId } });
    if (!milestone) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
    if (input.projectId !== undefined && milestone.projectId !== input.projectId)
      throw new ProjectLinkError("BAD_REQUEST", "Milestone does not belong to project.");
  }
}
