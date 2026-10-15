import * as z from "zod";
import { Id } from "./ids.js";

/** plan: a plan of work to approve; decision: a choice that changes scope, budget, or direction. */
export const PROPOSAL_KINDS = ["plan", "decision"] as const;
export const ProposalKindSchema = z.enum(PROPOSAL_KINDS);
export type ProposalKind = z.infer<typeof ProposalKindSchema>;

export const PROPOSAL_STATUSES = ["pending", "approved", "rejected"] as const;
export const ProposalStatusSchema = z.enum(PROPOSAL_STATUSES);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export const PROPOSAL_TITLE_MAX_LENGTH = 200;
export const PROPOSAL_SUMMARY_MAX_LENGTH = 20_000;
export const PROPOSAL_OPTION_MAX_LENGTH = 200;
export const PROPOSAL_OPTIONS_MAX = 6;
export const PROPOSAL_COMMENT_MAX_LENGTH = 2_000;

export const ProposalSchema = z.object({
  id: Id,
  botId: Id,
  botName: z.string(),
  kind: ProposalKindSchema,
  title: z.string(),
  summary: z.string(),
  options: z.array(z.string()),
  recommendation: z.string(),
  status: ProposalStatusSchema,
  chosenOption: z.string().nullable(),
  comment: z.string().nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const ListProposalsInput = z.object({ status: ProposalStatusSchema.optional() });
export type ListProposalsInput = z.infer<typeof ListProposalsInput>;

export const DecideProposalInput = z.object({
  proposalId: Id,
  decision: z.enum(["approve", "reject"]),
  /** One of the proposal's options, when it offered any. */
  option: z.string().trim().min(1).max(PROPOSAL_OPTION_MAX_LENGTH).optional(),
  comment: z.string().trim().max(PROPOSAL_COMMENT_MAX_LENGTH).optional(),
});
export type DecideProposalInput = z.infer<typeof DecideProposalInput>;
