import type { Milestone, Project, ProjectProgress } from "@rakazo/contracts";
import type { Prisma } from "./client.js";
import { isProjectItemArchived, ProjectLinkError } from "./project-links.js";

function progress(total: number, completed: number): ProjectProgress {
  return { total, completed, ratio: total === 0 ? null : completed / total };
}

/** The caller supplies a RepeatableRead transaction so rows and counts share a snapshot. */
export async function readProjects(
  tx: Prisma.TransactionClient,
  spaceId: string,
  input: { id?: string; archived?: boolean; q?: string },
): Promise<Project[]> {
  const rows = await tx.project.findMany({
    where: {
      spaceId,
      ...(input.id !== undefined ? { id: input.id } : {}),
      ...(input.q
        ? {
            OR: [
              { name: { contains: input.q, mode: "insensitive" } },
              { description: { contains: input.q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    include: { members: { where: { role: "owner" } } },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  if (input.id !== undefined && rows.length === 0)
    throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  const visible =
    input.id !== undefined
      ? rows
      : rows.filter((row) => isProjectItemArchived(row) === (input.archived ?? false));
  const counts = await tx.ticket.groupBy({
    by: ["projectId", "status"],
    where: { spaceId, projectId: { in: visible.map((row) => row.id) } },
    _count: { _all: true },
  });
  const inFlightRuns =
    input.id !== undefined
      ? await tx.run.findMany({
          where: {
            spaceId,
            projectId: input.id,
            status: {
              in: [
                "queued",
                "leased",
                "running",
                "waiting_input",
                "waiting_takeover",
                "waiting_budget",
              ],
            },
          },
          select: { id: true, botId: true, threadId: true, status: true },
          orderBy: { createdAt: "asc" },
        })
      : undefined;
  return visible.map((row) => {
    const groups = counts.filter((group) => group.projectId === row.id);
    return {
      ...row,
      ...(inFlightRuns
        ? {
            inFlightRuns: inFlightRuns.map((run) => ({
              ...run,
              externalProcessState: "needs_confirmation" as const,
            })),
          }
        : {}),
      pausedAt: row.pausedAt?.toISOString() ?? null,
      owner: row.members[0]
        ? { ...row.members[0], createdAt: row.members[0].createdAt.toISOString() }
        : null,
      archived: isProjectItemArchived(row),
      archivedAt: row.archivedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      progress: progress(
        groups.reduce((sum, group) => sum + group._count._all, 0),
        groups.reduce(
          (sum, group) =>
            sum + (group.status === "done" || group.status === "closed" ? group._count._all : 0),
          0,
        ),
      ),
    };
  });
}

/** Parent visibility, effective archive state and counts are read in the caller's snapshot. */
export async function readMilestones(
  tx: Prisma.TransactionClient,
  spaceId: string,
  input: { id?: string; projectId?: string; archived?: boolean; q?: string },
): Promise<Milestone[]> {
  if (input.projectId !== undefined) {
    const parent = await tx.project.findFirst({ where: { id: input.projectId, spaceId } });
    if (!parent) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  }
  const rows = await tx.milestone.findMany({
    where: {
      spaceId,
      ...(input.id !== undefined ? { id: input.id } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.q
        ? {
            OR: [
              { name: { contains: input.q, mode: "insensitive" } },
              { description: { contains: input.q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    include: { project: true },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  if (input.id !== undefined && rows.length === 0)
    throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  const visible =
    input.id !== undefined
      ? rows
      : rows.filter((row) => isProjectItemArchived(row, row.project) === (input.archived ?? false));
  const counts = await tx.ticket.groupBy({
    by: ["projectId", "milestoneId", "status"],
    where: { spaceId, milestoneId: { in: visible.map((row) => row.id) } },
    _count: { _all: true },
  });
  return visible.map(({ project, ...row }) => {
    const groups = counts.filter(
      (group) => group.milestoneId === row.id && group.projectId === row.projectId,
    );
    return {
      ...row,
      archived: isProjectItemArchived(row, project),
      archivedAt: row.archivedAt?.toISOString() ?? null,
      dueAt: row.dueAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      progress: progress(
        groups.reduce((sum, group) => sum + group._count._all, 0),
        groups.reduce(
          (sum, group) =>
            sum + (group.status === "done" || group.status === "closed" ? group._count._all : 0),
          0,
        ),
      ),
    };
  });
}
