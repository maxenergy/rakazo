import type { Prisma } from "./client.js";
import { ProjectLinkError } from "./project-links.js";

export type ArtifactLinkInput = {
  projectId?: string;
  milestoneId?: string;
  ticketId?: string;
  ticketRef?: string;
};
export type ArtifactRunContext = {
  projectId: string | null;
  ticketId?: string | null;
};

type LinkReader = Pick<Prisma.TransactionClient, "ticket" | "project" | "milestone">;

function conflict(): never {
  throw new ProjectLinkError(
    "BAD_REQUEST",
    "Artifact association conflicts with its ticket or run.",
  );
}

/** Resolve only trusted ids or an explicit reference, never an employee's current assignment. */
export async function resolveArtifactLinks(
  db: LinkReader,
  spaceId: string,
  input: ArtifactLinkInput,
  context?: ArtifactRunContext,
) {
  let ticketId = input.ticketId ?? context?.ticketId ?? null;
  if (input.ticketId && context?.ticketId && input.ticketId !== context.ticketId) conflict();
  if (input.ticketRef) {
    const match = /^(.+)-(\d+)$/.exec(input.ticketRef);
    if (!match || !Number.isSafeInteger(Number(match[2]))) conflict();
    const ticket = await db.ticket.findFirst({
      where: { spaceId, number: Number(match[2]), board: { ticketPrefix: match[1] } },
      select: { id: true },
    });
    if (!ticket) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
    if (ticketId && ticketId !== ticket.id) conflict();
    ticketId = ticket.id;
  }
  let projectId = input.projectId ?? context?.projectId ?? null;
  let milestoneId = input.milestoneId ?? null;
  if (ticketId) {
    const ticket = await db.ticket.findFirst({
      where: { id: ticketId, spaceId },
      select: { projectId: true, milestoneId: true },
    });
    if (!ticket) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
    if (input.projectId !== undefined && input.projectId !== ticket.projectId) conflict();
    if (input.milestoneId !== undefined && input.milestoneId !== ticket.milestoneId) conflict();
    if (context && context.projectId !== ticket.projectId) conflict();
    projectId = ticket.projectId;
    milestoneId = ticket.milestoneId;
  }
  if (context && input.projectId !== undefined && input.projectId !== context.projectId) conflict();
  if (milestoneId) {
    const milestone = await db.milestone.findFirst({
      where: { id: milestoneId, spaceId },
      select: { projectId: true },
    });
    if (!milestone) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
    if (milestone.projectId !== projectId) conflict();
  }
  if (projectId) {
    const project = await db.project.findFirst({
      where: { id: projectId, spaceId },
      select: { id: true },
    });
    if (!project) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  }
  const explicit = [input.projectId, input.milestoneId, input.ticketId, input.ticketRef].some(
    (value) => value !== undefined,
  );
  return {
    projectId,
    milestoneId,
    ticketId,
    linkSource: explicit ? "explicit" : projectId || ticketId ? "run" : null,
  };
}
