import type {
  Actor,
  DecideProposalInput,
  Proposal,
  ProposalKind,
  ProposalStatus,
} from "@rakazo/contracts";
import { ProposalKindSchema, ProposalStatusSchema } from "@rakazo/contracts";
import { decideOverrunApprovalInTransaction } from "./budget-overrun-approvals.js";
import type { Prisma, PrismaClient } from "./client.js";
import { lockTicketSpace } from "./ticket-space-lock.js";

type ProposalRow = {
  id: string;
  botId: string;
  kind: string;
  title: string;
  summary: string;
  options: string[];
  recommendation: string;
  status: string;
  chosenOption: string | null;
  comment: string | null;
  decidedAt: Date | null;
  decidedBy?: string;
  createdAt: Date;
  bot: { name: string };
};

const withBotName = { bot: { select: { name: true } } } as const;

export function mapProposal(row: ProposalRow): Proposal {
  return {
    id: row.id,
    botId: row.botId,
    botName: row.bot.name,
    kind: ProposalKindSchema.catch("plan").parse(row.kind),
    title: row.title,
    summary: row.summary,
    options: row.options,
    recommendation: row.recommendation,
    status: ProposalStatusSchema.catch("pending").parse(row.status),
    chosenOption: row.chosenOption,
    comment: row.comment,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedBy: row.decidedBy === "team" ? "team" : "user",
    createdAt: row.createdAt.toISOString(),
  };
}

/** Create a proposal once per submit key; a replay returns the first row. */
export async function createProposal(
  prisma: PrismaClient,
  scope: Pick<Actor, "userId" | "spaceId">,
  input: {
    botId: string;
    submitKey: string;
    kind: ProposalKind;
    title: string;
    summary: string;
    options: string[];
    recommendation: string;
    /** A decision the launch team made itself: recorded as already decided. */
    teamDecision?: { chosenOption: string | null };
  },
): Promise<{ proposal: Proposal; replayed: boolean }> {
  try {
    return await prisma.$transaction((tx) => createProposalInTransaction(tx, scope, input));
  } catch (error) {
    const raced = await prisma.proposal.findUnique({
      where: { spaceId_submitKey: { spaceId: scope.spaceId, submitKey: input.submitKey } },
      include: withBotName,
    });
    if (!raced) throw error;
    return { proposal: mapProposal(raced), replayed: true };
  }
}

/** Create within the caller transaction; uniqueness failures roll back that transaction. */
export async function createProposalInTransaction(
  prisma: Prisma.TransactionClient,
  scope: Pick<Actor, "userId" | "spaceId">,
  input: {
    botId: string;
    submitKey: string;
    kind: ProposalKind;
    title: string;
    summary: string;
    options: string[];
    recommendation: string;
    /** A decision the launch team made itself: recorded as already decided. */
    teamDecision?: { chosenOption: string | null };
  },
): Promise<{ proposal: Proposal; replayed: boolean }> {
  const where = { spaceId_submitKey: { spaceId: scope.spaceId, submitKey: input.submitKey } };
  const existing = await prisma.proposal.findUnique({ where, include: withBotName });
  if (existing) return { proposal: mapProposal(existing), replayed: true };
  const { teamDecision, ...fields } = input;
  const row = await prisma.proposal.create({
    data: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      ...fields,
      ...(teamDecision
        ? {
            status: "approved",
            decidedBy: "team",
            decidedAt: new Date(),
            chosenOption: teamDecision.chosenOption,
          }
        : {}),
    },
    include: withBotName,
  });
  return { proposal: mapProposal(row), replayed: false };
}

export async function listProposals(
  prisma: PrismaClient,
  scope: Pick<Actor, "userId" | "spaceId">,
  status?: ProposalStatus,
): Promise<Proposal[]> {
  const rows = await prisma.proposal.findMany({
    where: { spaceId: scope.spaceId, userId: scope.userId, ...(status ? { status } : {}) },
    include: withBotName,
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows.map(mapProposal);
}

export class ProposalDecisionError extends Error {}

/**
 * Record the user's decision on a pending proposal. Only the first decision
 * lands, so a double click or a second device cannot flip it.
 */
export async function decideProposal(
  prisma: PrismaClient,
  scope: Pick<Actor, "userId" | "spaceId">,
  input: DecideProposalInput,
): Promise<Proposal> {
  return prisma.$transaction((tx) => decideProposalInTransaction(tx, scope, input));
}

/** Record a decision within the caller transaction. */
export async function decideProposalInTransaction(
  tx: Prisma.TransactionClient,
  scope: Pick<Actor, "userId" | "spaceId">,
  input: DecideProposalInput,
): Promise<Proposal> {
  await lockTicketSpace(tx, scope.spaceId);
  const found = await tx.proposal.findFirst({
    where: { id: input.proposalId, spaceId: scope.spaceId, userId: scope.userId },
    select: { options: true },
  });
  if (!found) throw new ProposalDecisionError("Proposal not found");
  if (input.option && !found.options.includes(input.option)) {
    throw new ProposalDecisionError("Choose one of the proposal's options");
  }
  const updated = await tx.proposal.updateMany({
    where: {
      id: input.proposalId,
      spaceId: scope.spaceId,
      userId: scope.userId,
      status: "pending",
    },
    data: {
      status: input.decision === "approve" ? "approved" : "rejected",
      chosenOption: input.option ?? null,
      comment: input.comment?.trim() || null,
      decidedAt: new Date(),
    },
  });
  if (updated.count === 0) throw new ProposalDecisionError("This proposal was already decided");
  const approval = await tx.budgetOverrunApproval.findFirst({
    where: { spaceId: scope.spaceId, proposalId: input.proposalId },
  });
  if (approval) {
    const binding = JSON.parse(approval.scope);
    if (typeof binding.threadId !== "string" || typeof binding.runId !== "string") {
      throw new ProposalDecisionError("Invalid budget approval scope");
    }
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${binding.threadId} AND "spaceId" = ${scope.spaceId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM runs WHERE id = ${binding.runId} AND "spaceId" = ${scope.spaceId} FOR UPDATE`;
    const run = await tx.run.findFirst({
      where: {
        id: binding.runId,
        spaceId: scope.spaceId,
        threadId: binding.threadId,
        botId: binding.botId,
      },
    });
    const attempt =
      typeof binding.attemptId === "string"
        ? await tx.attempt.findFirst({
            where: {
              id: binding.attemptId,
              runId: binding.runId,
              fence: binding.leaseFence,
              status: "waiting_budget",
            },
            select: { id: true },
          })
        : null;
    const checkpoint = run?.checkpoint ? JSON.parse(run.checkpoint) : null;
    const valid =
      attempt !== null &&
      run?.status === "waiting_budget" &&
      run.leaseFence === binding.leaseFence &&
      checkpoint?.kind === "budget_pause_v1" &&
      checkpoint.approvalId === approval.id &&
      checkpoint.proposalId === input.proposalId &&
      checkpoint.call?.callId === binding.callId &&
      checkpoint.call?.projectId === approval.projectId &&
      checkpoint.call?.spaceId === scope.spaceId &&
      BigInt(checkpoint.call.amountMicroUsd) === approval.amountMicroUsd;
    if (input.decision === "approve" && !valid) {
      throw new ProposalDecisionError("Budget approval no longer matches the paused run");
    }
    const result = await decideOverrunApprovalInTransaction(tx, {
      spaceId: scope.spaceId,
      approvalId: approval.id,
      decision: input.decision === "approve" ? "approved" : "rejected",
      decidedByUserId: scope.userId,
    });
    if (result.status === "expired" || result.status === "stale") {
      await tx.proposal.updateMany({
        where: { id: input.proposalId, spaceId: scope.spaceId, userId: scope.userId },
        data: { status: result.status, chosenOption: null },
      });
    }
    if (result.resume && valid) {
      const resumed = await tx.run.updateMany({
        where: {
          id: binding.runId,
          spaceId: scope.spaceId,
          status: "waiting_budget",
          leaseFence: binding.leaseFence,
          checkpoint: run!.checkpoint,
        },
        data: { status: "queued", checkpoint: null },
      });
      if (resumed.count !== 1)
        throw new ProposalDecisionError("Paused run changed during approval");
    }
  }
  const row = await tx.proposal.findFirstOrThrow({
    where: { id: input.proposalId },
    include: withBotName,
  });
  return mapProposal(row);
}
