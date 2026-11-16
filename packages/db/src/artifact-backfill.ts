export type HistoricalArtifact = {
  id: string;
  spaceId: string;
  name: string;
  description: string | null;
  projectId: string | null;
  milestoneId: string | null;
  ticketId: string | null;
  linkSource: string | null;
};
export type HistoricalTicket = {
  id: string;
  spaceId: string;
  number: number;
  projectId: string | null;
  milestoneId: string | null;
  valid: boolean;
};

type Links = Pick<HistoricalArtifact, "projectId" | "milestoneId" | "ticketId" | "linkSource">;
export type BackfillPlan =
  | { kind: "matched"; links: Links }
  | { kind: "ambiguous" | "unmatched" | "skipped"; reason: string };

/** Only the name and description establish historical ownership. */
export function planArtifactBackfill(
  artifact: HistoricalArtifact,
  tickets: HistoricalTicket[],
): BackfillPlan {
  const refs = new Set<string>();
  for (const text of [artifact.name, artifact.description ?? ""]) {
    for (const match of text.matchAll(/(?<![A-Za-z0-9])RAK-([1-9]\d*)(?![A-Za-z0-9])/g)) {
      if (match[1]) refs.add(match[1]);
    }
  }
  if (refs.size === 0) return { kind: "unmatched", reason: "no_reference" };
  if (refs.size > 1) return { kind: "ambiguous", reason: "multiple_references" };
  const number = Number([...refs][0]);
  if (!Number.isSafeInteger(number)) return { kind: "unmatched", reason: "invalid_number" };
  const candidates = tickets.filter(
    (ticket) => ticket.spaceId === artifact.spaceId && ticket.number === number,
  );
  if (candidates.length > 1) return { kind: "ambiguous", reason: "multiple_tickets" };
  const ticket = candidates[0];
  if (!ticket) return { kind: "unmatched", reason: "ticket_not_found" };
  if (!ticket.valid) return { kind: "skipped", reason: "invalid_ticket_links" };
  const links: Links = {
    projectId: ticket.projectId,
    milestoneId: ticket.milestoneId,
    ticketId: ticket.id,
    linkSource: "backfill",
  };
  for (const key of ["projectId", "milestoneId", "ticketId"] as const) {
    if (artifact[key] !== null && artifact[key] !== links[key]) {
      return { kind: "skipped", reason: "existing_link_conflict" };
    }
  }
  const missing = Object.keys(links).some((key) => {
    const field = key as keyof Links;
    return artifact[field] === null && links[field] !== null;
  });
  if (!missing) return { kind: "skipped", reason: "already_linked" };
  return {
    kind: "matched",
    links: {
      projectId: artifact.projectId ?? links.projectId,
      milestoneId: artifact.milestoneId ?? links.milestoneId,
      ticketId: artifact.ticketId ?? links.ticketId,
      linkSource: artifact.linkSource ?? links.linkSource,
    },
  };
}

export type HistoricalRunProject = {
  runSpaceId: string | null;
  runProjectId: string | null;
  projectSpaceId: string | null;
};

/** Ticket references retain precedence; run ownership only fills unlinked artifacts. */
export function planArtifactRunProjectBackfill(
  artifact: HistoricalArtifact,
  tickets: HistoricalTicket[],
  run: HistoricalRunProject,
): BackfillPlan {
  const existing = planArtifactBackfill(artifact, tickets);
  if (existing.kind !== "unmatched" || existing.reason !== "no_reference") return existing;
  if (
    [artifact.projectId, artifact.milestoneId, artifact.ticketId, artifact.linkSource].some(
      (value) => value !== null,
    )
  )
    return { kind: "skipped", reason: "existing_links" };
  if (run.runSpaceId === null) return { kind: "skipped", reason: "run_not_found" };
  if (run.runSpaceId !== artifact.spaceId) return { kind: "skipped", reason: "run_space_mismatch" };
  if (run.runProjectId === null) return { kind: "skipped", reason: "run_without_project" };
  if (run.projectSpaceId === null) return { kind: "skipped", reason: "project_not_found" };
  if (run.projectSpaceId !== artifact.spaceId)
    return { kind: "skipped", reason: "project_space_mismatch" };
  return {
    kind: "matched",
    links: {
      projectId: run.runProjectId,
      milestoneId: null,
      ticketId: null,
      linkSource: "backfill_run_project",
    },
  };
}
