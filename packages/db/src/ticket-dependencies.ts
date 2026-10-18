import type { Prisma } from "./client.js";
import { isProjectItemArchived, ProjectLinkError } from "./project-links.js";
import { lockTicketSpace } from "./ticket-space-lock.js";

export function isTicketComplete(status: string): boolean {
  return status === "done" || status === "closed";
}

/** The caller owns the transaction; acquire this lock before any row lock. */
export async function addTicketDependency(
  tx: Prisma.TransactionClient,
  spaceId: string,
  ticketId: string,
  prerequisiteId: string,
) {
  await lockTicketSpace(tx, spaceId);
  if (ticketId === prerequisiteId)
    throw new ProjectLinkError("BAD_REQUEST", "A ticket cannot depend on itself.");
  const tickets = await tx.ticket.findMany({
    where: { spaceId, id: { in: [ticketId, prerequisiteId] } },
    include: { project: true, milestone: true },
  });
  if (tickets.length !== 2) throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  for (const ticket of tickets) {
    if (
      (ticket.project && isProjectItemArchived(ticket.project)) ||
      (ticket.milestone && isProjectItemArchived(ticket.milestone, ticket.project ?? undefined))
    )
      throw new ProjectLinkError("BAD_REQUEST", "Cannot link an archived resource.");
  }
  const cycle = await tx.$queryRaw<{ found: boolean }[]>`
    WITH RECURSIVE upstream(id) AS (
      SELECT ${prerequisiteId}::text
      UNION
      SELECT dependency."prerequisiteId"
      FROM ticket_dependencies dependency
      JOIN upstream ON dependency."ticketId" = upstream.id
      WHERE dependency."spaceId" = ${spaceId}
    )
    SELECT EXISTS(SELECT 1 FROM upstream WHERE id = ${ticketId}) AS found
  `;
  if (cycle[0]?.found)
    throw new ProjectLinkError("BAD_REQUEST", "Dependency would create a cycle.");
  await tx.$executeRaw`
    INSERT INTO ticket_dependencies ("spaceId", "ticketId", "prerequisiteId")
    VALUES (${spaceId}, ${ticketId}, ${prerequisiteId})
    ON CONFLICT ("spaceId", "ticketId", "prerequisiteId") DO NOTHING
  `;
}

export async function removeTicketDependency(
  tx: Prisma.TransactionClient,
  spaceId: string,
  ticketId: string,
  prerequisiteId: string,
) {
  await lockTicketSpace(tx, spaceId);
  const tickets = await tx.ticket.count({
    where: { spaceId, id: { in: [ticketId, prerequisiteId] } },
  });
  if (tickets !== (ticketId === prerequisiteId ? 1 : 2))
    throw new ProjectLinkError("NOT_FOUND", "Resource not found.");
  return tx.$executeRaw`
    DELETE FROM ticket_dependencies
    WHERE "spaceId" = ${spaceId}
      AND "ticketId" = ${ticketId}
      AND "prerequisiteId" = ${prerequisiteId}
  `;
}
