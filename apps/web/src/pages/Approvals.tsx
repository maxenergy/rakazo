import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { Proposal } from "@rakazo/contracts";
import { PROPOSAL_COMMENT_MAX_LENGTH } from "@rakazo/contracts";
import { Button, NativeSelect, NativeSelectOption, Textarea } from "@rakazo/ui-web";
import { ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { formatRelativeTime } from "../lib/relative-time";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { WindowChrome } from "./WindowChrome";

const REFRESH_MS = 15_000;

export function ApprovalsPage() {
  const { t } = useLingui();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    try {
      setProposals(await rpc.proposals.list({}));
      setError("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  const pending = proposals.filter((proposal) => proposal.status === "pending");
  const decided = proposals.filter((proposal) => proposal.status !== "pending");

  return (
    <div className="flex h-screen min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WindowChrome />
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <Button variant="ghost" size="icon" render={<Link to="/app" />} aria-label={t`Back`}>
          <ChevronLeft />
        </Button>
        <h1 className="flex-1 font-medium">
          <Trans>Approvals</Trans>
        </h1>
      </header>
      {error ? (
        <p role="alert" className="px-4 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <main className="min-h-0 flex-1 overflow-auto p-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {pending.map((proposal) => (
            <PendingProposal key={proposal.id} proposal={proposal} onDecided={reload} />
          ))}
          {loaded && pending.length === 0 && !error ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              <Trans>Nothing to approve</Trans>
            </p>
          ) : null}
          {decided.length ? (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm text-muted-foreground">
                <Trans>Decided</Trans>
              </summary>
              <ul className="mt-2 flex flex-col gap-2">
                {decided.map((proposal) => (
                  <li
                    key={proposal.id}
                    data-testid={`proposal-decided-${proposal.id}`}
                    className="rounded-lg border p-3 text-sm"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-medium">{proposal.title}</span>
                      <span className="text-muted-foreground">
                        {proposal.decidedBy === "team" ? (
                          <Trans>Team decision</Trans>
                        ) : proposal.status === "approved" ? (
                          <Trans>Approved</Trans>
                        ) : (
                          <Trans>Rejected</Trans>
                        )}
                      </span>
                    </div>
                    <div className="text-muted-foreground">
                      {proposal.botName}
                      {proposal.chosenOption ? ` · ${proposal.chosenOption}` : ""}
                      {proposal.comment ? ` · ${proposal.comment}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function PendingProposal({
  proposal,
  onDecided,
}: {
  proposal: Proposal;
  onDecided: () => Promise<void>;
}) {
  const { t } = useLingui();
  const optionId = useId();
  const commentId = useId();
  const [option, setOption] = useState(proposal.options[0] ?? "");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    setError("");
    try {
      await rpc.proposals.decide({
        proposalId: proposal.id,
        decision,
        ...(decision === "approve" && option ? { option } : {}),
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
      await onDecided();
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  }

  return (
    <article
      data-testid={`proposal-${proposal.id}`}
      className="flex flex-col gap-3 rounded-lg border p-4"
    >
      <header>
        <h2 className="font-medium">{proposal.title}</h2>
        <p className="text-xs text-muted-foreground">
          {proposal.botName} ·{" "}
          {proposal.kind === "plan" ? <Trans>Plan</Trans> : <Trans>Decision</Trans>} ·{" "}
          {formatRelativeTime(proposal.createdAt)}
        </p>
      </header>
      <div className="text-sm">
        <ChatMarkdown>{proposal.summary}</ChatMarkdown>
      </div>
      {proposal.recommendation ? (
        <div className="rounded-md bg-muted p-3 text-sm">
          <ChatMarkdown>{proposal.recommendation}</ChatMarkdown>
        </div>
      ) : null}
      {proposal.options.length ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={optionId} className="text-sm">
            <Trans>Option</Trans>
          </label>
          <NativeSelect
            id={optionId}
            value={option}
            onChange={(event) => setOption(event.target.value)}
          >
            {proposal.options.map((choice) => (
              <NativeSelectOption key={choice} value={choice}>
                {choice}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      ) : null}
      <Textarea
        id={commentId}
        aria-label={t`Comment`}
        placeholder={t`Comment (optional)`}
        maxLength={PROPOSAL_COMMENT_MAX_LENGTH}
        value={comment}
        onChange={(event) => setComment(event.target.value)}
      />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={busy} onClick={() => void decide("reject")}>
          <Trans>Reject</Trans>
        </Button>
        <Button disabled={busy} onClick={() => void decide("approve")}>
          <Trans>Approve</Trans>
        </Button>
      </div>
    </article>
  );
}
