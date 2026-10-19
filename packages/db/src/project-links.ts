import type { Prisma } from "./client.js";
import { lockTicketSpace } from "./ticket-space-lock.js";

export class ProjectLinkError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "BAD_REQUEST",
    message: string,
  ) {
    super(message);
  }
}

export type TicketLinks = { projectId: string | null; milestoneId: string | null };
export type TicketLinkPatch = { projectId?: string | null; milestoneId?: string | null };

export function isProjectItemArchived(
  item: { archivedAt: Date | null },
  project?: { archivedAt: Date | null },
): boolean {
  return item.archivedAt !== null || (project !== undefined && project.archivedAt !== null);
}

/** Call before locking a ticket; keep these parent locks until its write commits. */
export async function resolveTicketLinks(
  tx: Prisma.TransactionClient,
  spaceId: string,
  current: TicketLinks,
  patch: TicketLinkPatch,
): Promise<TicketLinks> {
  await lockTicketSpace(tx, spaceId);
  let projectId = patch.projectId === undefined ? current.projectId : patch.projectId;
  let milestoneId = patch.milestoneId === undefined ? current.milestoneId : patch.milestoneId;
  if (patch.projectId === null) {
    if (patch.milestoneId)
      throw new ProjectLinkError("BAD_REQUEST", "Milestone requires a project.");
    milestoneId = null;
  } else if (
    patch.projectId !== undefined &&
    patch.projectId !== current.projectId &&
    patch.milestoneId === undefined
  ) {
    milestoneId = null;
  }
  if (milestoneId) {
    const candidate = await tx.milestone.findFirst({ where: { id: milestoneId, spaceId } });
    if (!candidate) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
    if (patch.projectId === undefined && patch.milestoneId !== undefined)
      projectId = candidate.projectId;
  }
  if (!projectId) return { projectId: null, milestoneId: null };
  const projects = await tx.$queryRaw<
    { id: string; archivedAt: Date | null }[]
  >`SELECT id, "archivedAt" FROM projects WHERE id = ${projectId} AND "spaceId" = ${spaceId} FOR SHARE`;
  const project = projects[0];
  if (!project) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  if (isProjectItemArchived(project))
    throw new ProjectLinkError("BAD_REQUEST", "Project is archived.");
  if (milestoneId) {
    const milestones = await tx.$queryRaw<
      { id: string; projectId: string; archivedAt: Date | null }[]
    >`SELECT id, "projectId", "archivedAt" FROM milestones WHERE id = ${milestoneId} AND "spaceId" = ${spaceId} FOR SHARE`;
    const milestone = milestones[0];
    if (!milestone) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
    if (milestone.projectId !== projectId)
      throw new ProjectLinkError("BAD_REQUEST", "Milestone does not belong to project.");
    if (isProjectItemArchived(milestone, project))
      throw new ProjectLinkError("BAD_REQUEST", "Milestone is archived.");
  }
  return { projectId, milestoneId };
}

/** Archive only the project; existing links and child timestamps remain intact. */
export async function archiveProject(
  tx: Prisma.TransactionClient,
  spaceId: string,
  projectId: string,
) {
  await lockTicketSpace(tx, spaceId);
  const rows = await tx.$queryRaw<
    { id: string; archivedAt: Date | null }[]
  >`SELECT id, "archivedAt" FROM projects WHERE id = ${projectId} AND "spaceId" = ${spaceId} FOR UPDATE`;
  const project = rows[0];
  if (!project) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  const now = new Date();
  const pending = await tx.budgetOverrunApproval.findMany({
    where: { spaceId, projectId, status: "pending" },
    select: { proposalId: true },
  });
  await tx.budgetOverrunApproval.updateMany({
    where: { spaceId, projectId, status: "pending" },
    data: { status: "stale", decisionReason: "project_archived", decidedAt: now },
  });
  const proposalIds = pending.flatMap((row) => (row.proposalId ? [row.proposalId] : []));
  await tx.proposal.updateMany({
    where: { id: { in: proposalIds }, spaceId, status: "pending" },
    data: { status: "expired", chosenOption: null, decidedAt: now },
  });
  if (isProjectItemArchived(project)) return;
  await tx.project.update({ where: { id: projectId }, data: { archivedAt: now } });
}

export async function archiveMilestone(
  tx: Prisma.TransactionClient,
  spaceId: string,
  milestoneId: string,
) {
  await lockTicketSpace(tx, spaceId);
  const candidate = await tx.milestone.findFirst({ where: { id: milestoneId, spaceId } });
  if (!candidate) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  const projects = await tx.$queryRaw<
    { id: string; archivedAt: Date | null }[]
  >`SELECT id, "archivedAt" FROM projects WHERE id = ${candidate.projectId} AND "spaceId" = ${spaceId} FOR UPDATE`;
  const project = projects[0];
  if (!project) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  const rows = await tx.$queryRaw<
    { id: string; archivedAt: Date | null }[]
  >`SELECT id, "archivedAt" FROM milestones WHERE id = ${milestoneId} AND "spaceId" = ${spaceId} AND "projectId" = ${project.id} FOR UPDATE`;
  const milestone = rows[0];
  if (!milestone) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  if (isProjectItemArchived(milestone, project)) return;
  await tx.milestone.update({ where: { id: milestoneId }, data: { archivedAt: new Date() } });
}

/** The caller owns the transaction; tickets and comments remain intact. */
export async function deleteProject(
  tx: Prisma.TransactionClient,
  spaceId: string,
  projectId: string,
) {
  await lockTicketSpace(tx, spaceId);
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM projects WHERE id = ${projectId} AND "spaceId" = ${spaceId} FOR UPDATE`;
  if (!rows.length) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  await tx.$queryRaw`SELECT id FROM project_budgets WHERE "spaceId" = ${spaceId} AND "projectId" = ${projectId} ORDER BY id FOR UPDATE`;
  const reservations = await tx.budgetReservation.findMany({
    where: { spaceId, projectId, status: { in: ["reserved", "unreconciled"] } },
    orderBy: { callId: "asc" },
  });
  for (const reservation of reservations) {
    const unstarted =
      reservation.status === "reserved" && reservation.executionState === "not_started";
    await tx.budgetSpendLedger.create({
      data: {
        spaceId,
        projectId,
        budgetId: reservation.budgetId,
        budgetVersion: reservation.budgetVersion,
        callId: reservation.callId,
        kind: unstarted ? "released" : "open_at_deletion",
        amountMicroUsd: reservation.amountMicroUsd,
        auditData: { reservationId: reservation.id, executionState: reservation.executionState },
      },
    });
    if (unstarted) {
      await tx.budgetReservation.update({
        where: { id: reservation.id },
        data: { status: "released", closedAt: new Date() },
      });
      await tx.projectBudget.update({
        where: { id: reservation.budgetId },
        data: { reservedMicroUsd: { decrement: reservation.amountMicroUsd } },
      });
    }
  }
  const approvals = await tx.budgetOverrunApproval.findMany({ where: { spaceId, projectId } });
  for (const approval of approvals) {
    await tx.budgetApprovalDeletionAudit.create({
      data: {
        spaceId,
        projectId,
        budgetId: approval.budgetId,
        budgetVersion: approval.budgetVersion,
        approvalId: approval.id,
        amountMicroUsd: approval.amountMicroUsd,
        state: approval.status,
        scope: approval.scope,
        decision: approval.status === "pending" ? "project_deleted" : approval.decisionReason,
        auditData: {
          approvalId: approval.id,
          state: approval.status,
          scope: approval.scope,
          decision: approval.status === "pending" ? "project_deleted" : approval.decisionReason,
          decidedByUserId: approval.decidedByUserId,
          decidedAt: approval.decidedAt?.toISOString() ?? null,
          appliedVersion: approval.appliedVersion,
        },
      },
    });
  }
  await tx.$queryRaw`SELECT id FROM milestones WHERE "projectId" = ${projectId} AND "spaceId" = ${spaceId} ORDER BY id FOR UPDATE`;
  await tx.ticket.updateMany({
    where: { spaceId, projectId },
    data: { projectId: null, milestoneId: null },
  });
  await tx.project.delete({ where: { id: projectId } });
}

export async function deleteMilestone(
  tx: Prisma.TransactionClient,
  spaceId: string,
  milestoneId: string,
) {
  await lockTicketSpace(tx, spaceId);
  const candidate = await tx.milestone.findFirst({ where: { id: milestoneId, spaceId } });
  if (!candidate) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  await tx.$queryRaw`SELECT id FROM projects WHERE id = ${candidate.projectId} AND "spaceId" = ${spaceId} FOR UPDATE`;
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM milestones WHERE id = ${milestoneId} AND "spaceId" = ${spaceId} AND "projectId" = ${candidate.projectId} FOR UPDATE`;
  if (!rows.length) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  await tx.ticket.updateMany({ where: { spaceId, milestoneId }, data: { milestoneId: null } });
  await tx.keyResult.updateMany({ where: { spaceId, milestoneId }, data: { milestoneId: null } });
  await tx.milestone.delete({ where: { id: milestoneId } });
}

/** Retry the whole transaction when links change before the ticket lock. */
export async function lockTicketForLinkUpdate(
  tx: Prisma.TransactionClient,
  spaceId: string,
  boardId: string,
  ticketId: string,
  patch: TicketLinkPatch,
) {
  await lockTicketSpace(tx, spaceId);
  const where = { id: ticketId, spaceId, boardId };
  const changesLinks = patch.projectId !== undefined || patch.milestoneId !== undefined;
  const candidate = changesLinks ? await tx.ticket.findFirst({ where }) : null;
  if (changesLinks && !candidate) return null;
  const links = candidate ? await resolveTicketLinks(tx, spaceId, candidate, patch) : undefined;
  await tx.$queryRaw`SELECT id FROM tickets WHERE id = ${ticketId} AND "spaceId" = ${spaceId} AND "boardId" = ${boardId} FOR UPDATE`;
  const current = await tx.ticket.findFirst({ where });
  if (!current) return null;
  if (
    candidate &&
    (candidate.projectId !== current.projectId || candidate.milestoneId !== current.milestoneId)
  ) {
    throw Object.assign(new Error("Ticket links changed concurrently."), { code: "P2034" });
  }
  return { current, links };
}
