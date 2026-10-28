import { createHash } from "node:crypto";
import type {
  Actor,
  DecideProposalInput,
  Proposal,
  ProposalKind,
  ProposalStatus,
  UpdateProposalInput,
} from "@rakazo/contracts";
import { ProposalKindSchema, ProposalStatusSchema } from "@rakazo/contracts";
import { decideOverrunApprovalInTransaction } from "./budget-overrun-approvals.js";
import type { Prisma, PrismaClient } from "./client.js";
import {
  assertExecutionFence,
  type ExecutionFence,
  StaleExecutionFenceError,
} from "./execution-fence.js";
import { lockTicketSpace } from "./ticket-space-lock.js";

type ProposalRow = {
  version: number;
  contentHash: string;
  approvedVersion: number | null;
  approvedContentHash: string | null;
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

type ProposalContent = Pick<
  ProposalRow,
  "kind" | "title" | "summary" | "options" | "recommendation"
>;

export function proposalContentHash(content: ProposalContent): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        content.kind,
        content.title,
        content.summary,
        content.options,
        content.recommendation,
      ]),
    )
    .digest("hex");
}

/** Reject a stale decision before performing its side effect. */
export function assertProposalApproval(
  proposal: ProposalContent & {
    status: string;
    version: number;
    contentHash: string;
    approvedVersion: number | null;
    approvedContentHash: string | null;
  },
): void {
  if (
    proposal.status !== "approved" ||
    proposal.approvedVersion !== proposal.version ||
    proposal.approvedContentHash !== proposal.contentHash ||
    proposal.contentHash !== proposalContentHash(proposal)
  ) {
    throw new ProposalDecisionError("Proposal approval no longer matches its content");
  }
}

const withBotName = { bot: { select: { name: true } } } as const;

export function mapProposal(row: ProposalRow): Proposal {
  return {
    version: row.version,
    contentHash: row.contentHash,
    approvedVersion: row.approvedVersion,
    approvedContentHash: row.approvedContentHash,
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
  executionFence?: ExecutionFence,
): Promise<{ proposal: Proposal; replayed: boolean }> {
  try {
    return await prisma.$transaction(async (tx) => {
      if (executionFence) {
        await tx.$queryRaw`SELECT id FROM spaces WHERE id = ${scope.spaceId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM bots WHERE id = ${input.botId} FOR UPDATE`;
        await assertExecutionFence(tx, executionFence);
      }
      return createProposalInTransaction(tx, scope, input);
    });
  } catch (error) {
    if (error instanceof StaleExecutionFenceError) throw error;
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
      contentHash: proposalContentHash(fields),
      ...(teamDecision
        ? {
            status: "approved",
            approvedVersion: 1,
            approvedContentHash: proposalContentHash(fields),
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

export async function updateProposal(
  prisma: PrismaClient,
  scope: Pick<Actor, "userId" | "spaceId">,
  input: UpdateProposalInput,
): Promise<Proposal> {
  return prisma.$transaction(async (tx) => {
    await lockTicketSpace(tx, scope.spaceId);
    const { proposalId, ...content } = input;
    const where = { id: proposalId, spaceId: scope.spaceId, userId: scope.userId };
    const found = await tx.proposal.findFirst({ where });
    if (!found) throw new ProposalDecisionError("Proposal not found");
    // The migration trigger versions content and invalidates the previous decision.
    await tx.proposal.updateMany({ where, data: content });
    return mapProposal(await tx.proposal.findFirstOrThrow({ where, include: withBotName }));
  });
}

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
    include: withBotName,
  });
  if (!found) throw new ProposalDecisionError("Proposal not found");
  if (
    input.expectedVersion !== found.version ||
    input.expectedHash !== found.contentHash ||
    found.contentHash !== proposalContentHash(found)
  ) {
    throw new ProposalDecisionError("Proposal content changed; reload before deciding");
  }
  if (input.option && !found.options.includes(input.option)) {
    throw new ProposalDecisionError("Choose one of the proposal's options");
  }
  const updated = await tx.proposal.updateMany({
    where: {
      id: input.proposalId,
      spaceId: scope.spaceId,
      userId: scope.userId,
      status: "pending",
      version: found.version,
      contentHash: found.contentHash,
    },
    data: {
      status: input.decision === "approve" ? "approved" : "rejected",
      chosenOption: input.option ?? null,
      comment: input.comment?.trim() || null,
      decidedAt: new Date(),
      approvedVersion: input.decision === "approve" ? found.version : null,
      approvedContentHash: input.decision === "approve" ? found.contentHash : null,
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
    if (input.decision === "approve") {
      const approved = await tx.proposal.findFirstOrThrow({
        where: { id: input.proposalId, spaceId: scope.spaceId, userId: scope.userId },
        include: withBotName,
      });
      assertProposalApproval(approved);
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
