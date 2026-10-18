import { GoalSchema, KeyResultSchema } from "@rakazo/contracts";
import type { Prisma } from "./client.js";
import { ProjectLinkError } from "./project-links.js";

export async function readGoals(
  tx: Prisma.TransactionClient,
  spaceId: string,
  input: { projectId?: string; id?: string; archived?: boolean },
) {
  if (
    input.projectId &&
    !(await tx.project.findFirst({ where: { id: input.projectId, spaceId } }))
  ) {
    throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  }
  const rows = await tx.goal.findMany({
    where: {
      spaceId,
      ...(input.id ? { id: input.id } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
    },
    include: { project: { select: { archivedAt: true } } },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  if (input.id && !rows.length) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  return rows.flatMap(({ project, ...row }) => {
    const archived = Boolean(row.archivedAt || project.archivedAt);
    if (!input.id && archived !== (input.archived ?? false)) return [];
    return [
      GoalSchema.parse({
        ...row,
        archived,
        dueAt: row.dueAt?.toISOString() ?? null,
        archivedAt: row.archivedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }),
    ];
  });
}

export async function readKeyResults(
  tx: Prisma.TransactionClient,
  spaceId: string,
  input: { goalId?: string; id?: string; archived?: boolean },
) {
  if (input.goalId && !(await tx.goal.findFirst({ where: { id: input.goalId, spaceId } }))) {
    throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  }
  const rows = await tx.keyResult.findMany({
    where: {
      spaceId,
      ...(input.id ? { id: input.id } : {}),
      ...(input.goalId ? { goalId: input.goalId } : {}),
    },
    include: {
      project: { select: { archivedAt: true } },
      goal: { select: { archivedAt: true } },
      milestone: { select: { archivedAt: true } },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  if (input.id && !rows.length) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  return rows.flatMap(({ project, goal, milestone, ...row }) => {
    const archived = Boolean(
      row.archivedAt || project.archivedAt || goal.archivedAt || milestone?.archivedAt,
    );
    if (!input.id && archived !== (input.archived ?? false)) return [];
    return [
      KeyResultSchema.parse({
        ...row,
        archived,
        dueAt: row.dueAt?.toISOString() ?? null,
        archivedAt: row.archivedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }),
    ];
  });
}
