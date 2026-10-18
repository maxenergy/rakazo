import type { Prisma } from "./client.js";
import { ProjectLinkError } from "./project-links.js";
import { lockTicketSpace } from "./ticket-space-lock.js";

type GoalFields = {
  name: string;
  description?: string | null;
  state?: "planned" | "active" | "achieved" | "cancelled";
  dueAt?: string | null;
};

function dates(input: { dueAt?: string | null }) {
  return input.dueAt === undefined
    ? {}
    : { dueAt: input.dueAt === null ? null : new Date(input.dueAt) };
}

async function activeProject(tx: Prisma.TransactionClient, spaceId: string, projectId: string) {
  const project = await tx.project.findFirst({ where: { id: projectId, spaceId } });
  if (!project) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  if (project.archivedAt) throw new ProjectLinkError("BAD_REQUEST", "Project is archived.");
  return project;
}

export async function createGoal(
  tx: Prisma.TransactionClient,
  spaceId: string,
  input: GoalFields & { projectId: string },
) {
  await lockTicketSpace(tx, spaceId);
  await activeProject(tx, spaceId, input.projectId);
  const { dueAt, ...data } = input;
  return tx.goal.create({ data: { ...data, spaceId, ...dates({ dueAt }) } });
}

export async function updateGoal(
  tx: Prisma.TransactionClient,
  spaceId: string,
  input: Partial<GoalFields> & { id: string },
) {
  await lockTicketSpace(tx, spaceId);
  const goal = await tx.goal.findFirst({ where: { id: input.id, spaceId } });
  if (!goal) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  await activeProject(tx, spaceId, goal.projectId);
  if (goal.archivedAt) throw new ProjectLinkError("BAD_REQUEST", "Goal is archived.");
  const { id, dueAt, ...data } = input;
  return tx.goal.update({ where: { id }, data: { ...data, ...dates({ dueAt }) } });
}

type KeyResultFields = GoalFields & {
  milestoneId?: string | null;
  measure: string;
  targetValue: number;
  currentValue: number;
  calculationRule: string;
};

async function activeGoal(tx: Prisma.TransactionClient, spaceId: string, goalId: string) {
  const goal = await tx.goal.findFirst({ where: { id: goalId, spaceId } });
  if (!goal) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  await activeProject(tx, spaceId, goal.projectId);
  if (goal.archivedAt) throw new ProjectLinkError("BAD_REQUEST", "Goal is archived.");
  return goal;
}

async function validateMilestone(
  tx: Prisma.TransactionClient,
  spaceId: string,
  projectId: string,
  milestoneId: string | null | undefined,
) {
  if (milestoneId == null) return;
  const milestone = await tx.milestone.findFirst({ where: { id: milestoneId, spaceId } });
  if (!milestone) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  if (milestone.projectId !== projectId)
    throw new ProjectLinkError("BAD_REQUEST", "Milestone does not belong to project.");
  if (milestone.archivedAt) throw new ProjectLinkError("BAD_REQUEST", "Milestone is archived.");
}

export async function createKeyResult(
  tx: Prisma.TransactionClient,
  spaceId: string,
  input: KeyResultFields & { goalId: string },
) {
  await lockTicketSpace(tx, spaceId);
  const goal = await activeGoal(tx, spaceId, input.goalId);
  await validateMilestone(tx, spaceId, goal.projectId, input.milestoneId);
  const { dueAt, ...data } = input;
  return tx.keyResult.create({
    data: { ...data, spaceId, projectId: goal.projectId, ...dates({ dueAt }) },
  });
}

export async function updateKeyResult(
  tx: Prisma.TransactionClient,
  spaceId: string,
  input: Partial<KeyResultFields> & { id: string },
) {
  await lockTicketSpace(tx, spaceId);
  const current = await tx.keyResult.findFirst({ where: { id: input.id, spaceId } });
  if (!current) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  await activeGoal(tx, spaceId, current.goalId);
  if (current.archivedAt) throw new ProjectLinkError("BAD_REQUEST", "Key result is archived.");
  await validateMilestone(
    tx,
    spaceId,
    current.projectId,
    input.milestoneId === undefined ? current.milestoneId : input.milestoneId,
  );
  const { id, dueAt, ...data } = input;
  return tx.keyResult.update({ where: { id }, data: { ...data, ...dates({ dueAt }) } });
}

export async function deleteGoal(tx: Prisma.TransactionClient, spaceId: string, id: string) {
  await lockTicketSpace(tx, spaceId);
  const goal = await tx.goal.findFirst({ where: { id, spaceId } });
  if (!goal) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  await activeProject(tx, spaceId, goal.projectId);
  await tx.goal.delete({ where: { id } });
}

export async function archiveKeyResult(tx: Prisma.TransactionClient, spaceId: string, id: string) {
  await lockTicketSpace(tx, spaceId);
  const row = await tx.keyResult.findFirst({ where: { id, spaceId } });
  if (!row) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  await activeGoal(tx, spaceId, row.goalId);
  if (!row.archivedAt)
    await tx.keyResult.update({ where: { id }, data: { archivedAt: new Date() } });
}

export async function deleteKeyResult(tx: Prisma.TransactionClient, spaceId: string, id: string) {
  await lockTicketSpace(tx, spaceId);
  const row = await tx.keyResult.findFirst({ where: { id, spaceId } });
  if (!row) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  await activeGoal(tx, spaceId, row.goalId);
  await tx.keyResult.delete({ where: { id } });
}
