import type {
  Actor,
  DecideProposalInput,
  Proposal,
  ProposalKind,
  ProposalStatus,
} from "@rakazo/contracts";
import { ProposalKindSchema, ProposalStatusSchema } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";

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
  const where = { spaceId_submitKey: { spaceId: scope.spaceId, submitKey: input.submitKey } };
  const existing = await prisma.proposal.findUnique({ where, include: withBotName });
  if (existing) return { proposal: mapProposal(existing), replayed: true };
  try {
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
  } catch (error) {
    const raced = await prisma.proposal.findUnique({ where, include: withBotName });
    if (!raced) throw error;
    return { proposal: mapProposal(raced), replayed: true };
  }
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
  const found = await prisma.proposal.findFirst({
    where: { id: input.proposalId, spaceId: scope.spaceId, userId: scope.userId },
    select: { options: true },
  });
  if (!found) throw new ProposalDecisionError("Proposal not found");
  if (input.option && !found.options.includes(input.option)) {
    throw new ProposalDecisionError("Choose one of the proposal's options");
  }
  const updated = await prisma.proposal.updateMany({
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
  const row = await prisma.proposal.findFirstOrThrow({
    where: { id: input.proposalId },
    include: withBotName,
  });
  return mapProposal(row);
}
