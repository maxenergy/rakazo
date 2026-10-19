import type { Prisma, PrismaClient } from "./client.js";
import { lockTicketSpace } from "./ticket-space-lock.js";

/** Thrown when a requestKey is replayed with a different project, amount or scope. */
export class OverrunRequestConflictError extends Error {
  constructor(readonly requestKey: string) {
    super(`Overrun request ${requestKey} was already used with different parameters`);
    this.name = "OverrunRequestConflictError";
  }
}

export interface OverrunRequestInput {
  spaceId: string;
  projectId: string;
  amountMicroUsd: bigint;
  scope: string;
  requestKey: string;
  proposalId?: string | null;
  expiresAt?: Date;
}

export interface OverrunDecisionInput {
  spaceId: string;
  approvalId: string;
  decision: "approved" | "rejected";
  decidedByUserId?: string | null;
}

export interface OverrunDecisionResult {
  status: string;
  /** True only on the first approval that raised the limit; callbacks and rejections never resume. */
  resume: boolean;
  replayed: boolean;
  appliedVersion: number | null;
}

/** Bind a pending approval to the project's current budget version. Idempotent on (spaceId, requestKey). */
export async function requestOverrunApproval(db: PrismaClient, input: OverrunRequestInput) {
  return db.$transaction((tx) => requestOverrunApprovalInTransaction(tx, input));
}

/** Create the bound request within the caller transaction. */
export async function requestOverrunApprovalInTransaction(
  tx: Prisma.TransactionClient,
  input: OverrunRequestInput,
) {
  await lockTicketSpace(tx, input.spaceId);
  const project = await tx.project.findFirst({
    where: { id: input.projectId, spaceId: input.spaceId },
    select: { archivedAt: true },
  });
  if (project?.archivedAt) throw new Error("Project is archived");
  if (input.amountMicroUsd <= 0n) throw new RangeError("amountMicroUsd must be positive");
  const existing = await tx.budgetOverrunApproval.findUnique({
    where: { spaceId_requestKey: { spaceId: input.spaceId, requestKey: input.requestKey } },
  });
  if (existing) {
    if (
      existing.projectId !== input.projectId ||
      existing.amountMicroUsd !== input.amountMicroUsd ||
      existing.scope !== input.scope
    ) {
      throw new OverrunRequestConflictError(input.requestKey);
    }
    return existing;
  }
  const budget = await tx.projectBudget.findUnique({
    where: { spaceId_projectId: { spaceId: input.spaceId, projectId: input.projectId } },
  });
  if (!budget) throw new Error("Project has no budget");
  return tx.budgetOverrunApproval.create({
    data: {
      spaceId: input.spaceId,
      projectId: input.projectId,
      budgetId: budget.id,
      budgetVersion: budget.version,
      amountMicroUsd: input.amountMicroUsd,
      scope: input.scope,
      requestKey: input.requestKey,
      proposalId: input.proposalId ?? null,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    },
  });
}

/**
 * Decide a pending approval once. Approving raises the limit by exactly the bound amount, and only
 * if the budget is still at the version it was requested against; otherwise the approval goes
 * stale and nothing is applied. Replayed decisions return the stored outcome and never resume.
 */
export async function decideOverrunApproval(
  db: PrismaClient,
  input: OverrunDecisionInput,
): Promise<OverrunDecisionResult> {
  return db.$transaction((tx) => decideOverrunApprovalInTransaction(tx, input));
}

/** Apply a decision inside the caller transaction so proposal and recovery commit together. */
export async function decideOverrunApprovalInTransaction(
  tx: Prisma.TransactionClient,
  input: OverrunDecisionInput,
): Promise<OverrunDecisionResult> {
  await lockTicketSpace(tx, input.spaceId);
  const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "budget_overrun_approvals"
      WHERE "id" = ${input.approvalId} AND "spaceId" = ${input.spaceId}
      FOR UPDATE`;
  if (!rows[0]) throw new Error("Overrun approval not found");
  const approval = await tx.budgetOverrunApproval.findUniqueOrThrow({
    where: { id: input.approvalId },
  });
  if (approval.status !== "pending") {
    return {
      status: approval.status,
      resume: false,
      replayed: true,
      appliedVersion: approval.appliedVersion,
    };
  }
  const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  if (!clock) throw new Error("Database clock query returned no rows");
  let decidedAt = clock.now;
  const decidedByUserId = input.decidedByUserId ?? null;
  if (approval.expiresAt <= decidedAt) {
    await tx.budgetOverrunApproval.update({
      where: { id: approval.id },
      data: { status: "expired", decidedAt },
    });
    return { status: "expired", resume: false, replayed: false, appliedVersion: null };
  }
  if (input.decision === "rejected") {
    await tx.budgetOverrunApproval.update({
      where: { id: approval.id },
      data: { status: "rejected", decidedByUserId, decidedAt },
    });
    return { status: "rejected", resume: false, replayed: false, appliedVersion: null };
  }
  const locked = await tx.$queryRaw<{ id: string; version: number; limitMicroUsd: bigint }[]>`
      SELECT "id", "version", "limitMicroUsd" FROM "project_budgets"
      WHERE "id" = ${approval.budgetId} FOR UPDATE`;
  const [lockedClock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  if (!lockedClock) throw new Error("Database clock query returned no rows");
  decidedAt = lockedClock.now;
  if (approval.expiresAt <= decidedAt) {
    await tx.budgetOverrunApproval.update({
      where: { id: approval.id },
      data: { status: "expired", decidedAt },
    });
    return { status: "expired", resume: false, replayed: false, appliedVersion: null };
  }
  const current = locked[0];
  if (!current || current.version !== approval.budgetVersion) {
    await tx.budgetOverrunApproval.update({
      where: { id: approval.id },
      data: { status: "stale", decidedByUserId, decidedAt },
    });
    return { status: "stale", resume: false, replayed: false, appliedVersion: null };
  }
  const limit = current.limitMicroUsd + approval.amountMicroUsd;
  const version = current.version + 1;
  await tx.projectBudget.update({
    where: { id: current.id },
    data: { version, limitMicroUsd: limit },
  });
  await tx.projectBudgetVersion.create({
    data: { budgetId: current.id, version, limitMicroUsd: limit, createdByUserId: decidedByUserId },
  });
  await tx.budgetOverrunApproval.update({
    where: { id: approval.id },
    data: { status: "approved", appliedVersion: version, decidedByUserId, decidedAt },
  });
  return { status: "approved", resume: true, replayed: false, appliedVersion: version };
}

/** Expire persisted deadlines after restart; never queues or resumes a run. */
export async function expireOverrunApprovals(db: PrismaClient): Promise<number> {
  const [clock] = await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  if (!clock) throw new Error("Database clock query returned no rows");
  const now = clock.now;
  const candidates = await db.budgetOverrunApproval.findMany({
    where: { status: "pending", expiresAt: { lte: now } },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    take: 100,
    select: { id: true, spaceId: true, proposalId: true },
  });
  let expired = 0;
  for (const candidate of candidates) {
    expired += await db.$transaction(async (tx) => {
      await lockTicketSpace(tx, candidate.spaceId);
      // User decisions lock the space, then proposal, then approval. Keep that order.
      if (candidate.proposalId) {
        await tx.$queryRaw`SELECT id FROM proposals WHERE id = ${candidate.proposalId} AND "spaceId" = ${candidate.spaceId} FOR UPDATE`;
      }
      const changed = await tx.budgetOverrunApproval.updateMany({
        where: {
          id: candidate.id,
          spaceId: candidate.spaceId,
          status: "pending",
          expiresAt: { lte: now },
        },
        data: { status: "expired", decidedAt: now },
      });
      if (changed.count === 1 && candidate.proposalId) {
        await tx.proposal.updateMany({
          where: { id: candidate.proposalId, spaceId: candidate.spaceId, status: "pending" },
          data: { status: "expired", chosenOption: null, decidedAt: now },
        });
      }
      return changed.count;
    });
  }
  return expired;
}
