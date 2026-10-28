import type { ProposalKind } from "@rakazo/contracts";
import {
  PROPOSAL_OPTION_MAX_LENGTH,
  PROPOSAL_OPTIONS_MAX,
  PROPOSAL_SUMMARY_MAX_LENGTH,
  PROPOSAL_TITLE_MAX_LENGTH,
  ProposalKindSchema,
} from "@rakazo/contracts";

export type ProposalDraft = {
  kind: ProposalKind;
  title: string;
  summary: string;
  options: string[];
  recommendation: string;
};

/** Validate submit_proposal arguments from the model. */
export function parseProposalArgs(
  args: Record<string, unknown>,
): { ok: true; draft: ProposalDraft } | { ok: false; error: string } {
  const kind = ProposalKindSchema.safeParse(args.kind);
  if (!kind.success) return { ok: false, error: 'kind must be "plan" or "decision".' };
  const title = String(args.title ?? "").trim();
  if (!title) return { ok: false, error: "title is required." };
  if (title.length > PROPOSAL_TITLE_MAX_LENGTH) {
    return { ok: false, error: `title exceeds ${PROPOSAL_TITLE_MAX_LENGTH} characters.` };
  }
  const summary = String(args.summary ?? "").trim();
  if (!summary) return { ok: false, error: "summary is required." };
  if (summary.length > PROPOSAL_SUMMARY_MAX_LENGTH) {
    return { ok: false, error: `summary exceeds ${PROPOSAL_SUMMARY_MAX_LENGTH} characters.` };
  }
  const rawOptions = Array.isArray(args.options) ? args.options : [];
  const options = [
    ...new Set(rawOptions.map((option) => String(option ?? "").trim()).filter(Boolean)),
  ];
  if (options.length > PROPOSAL_OPTIONS_MAX) {
    return { ok: false, error: `Give at most ${PROPOSAL_OPTIONS_MAX} options.` };
  }
  if (options.some((option) => option.length > PROPOSAL_OPTION_MAX_LENGTH)) {
    return {
      ok: false,
      error: `Each option must be at most ${PROPOSAL_OPTION_MAX_LENGTH} characters.`,
    };
  }
  return {
    ok: true,
    draft: {
      kind: kind.data,
      title,
      summary,
      options,
      recommendation: String(args.recommendation ?? "")
        .trim()
        .slice(0, PROPOSAL_SUMMARY_MAX_LENGTH),
    },
  };
}

/** The message a bot wakes to once the user decides its proposal. */
export function proposalDecisionText(proposal: {
  approvedVersion?: number | null;
  approvedContentHash?: string | null;
  title: string;
  status: "approved" | "rejected" | "expired" | "stale";
  chosenOption: string | null;
  comment: string | null;
}) {
  return [
    `${{ approved: "Approved", rejected: "Rejected", expired: "Expired", stale: "Stale" }[proposal.status]}: ${proposal.title}`,
    proposal.status === "approved"
      ? `approvedVersion: ${proposal.approvedVersion}; approvedContentHash: ${proposal.approvedContentHash}`
      : undefined,
    proposal.chosenOption ? `Chosen option: ${proposal.chosenOption}` : undefined,
    proposal.comment ? `Comment: ${proposal.comment}` : undefined,
    proposal.status === "approved"
      ? "Go ahead with it."
      : "Do not act on it. Revise it with the comment in mind, or ask me what to change.",
  ]
    .filter(Boolean)
    .join("\n");
}
