import type { Prisma, PrismaClient } from "./client.js";

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
  const decidedAt = new Date();
  const decidedByUserId = input.decidedByUserId ?? null;
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
