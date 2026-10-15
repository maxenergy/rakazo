import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";

const MAX_REPORTING_DEPTH = 64;

/**
 * Why `botId` cannot report to `managerBotId`, or undefined when it can.
 * The manager must be an active bot in the same space, and the chain above it
 * must not lead back to `botId`.
 */
export async function reportsToError(
  prisma: PrismaClient,
  actor: Pick<Actor, "userId" | "spaceId">,
  botId: string,
  managerBotId: string,
): Promise<string | undefined> {
  if (managerBotId === botId) return "A bot cannot report to itself";
  let cursor: string | null = managerBotId;
  for (let depth = 0; cursor && depth < MAX_REPORTING_DEPTH; depth += 1) {
    const current: { id: string; archivedAt: Date | null; reportsToBotId: string | null } | null =
      await prisma.bot.findFirst({
        where: { id: cursor, spaceId: actor.spaceId, userId: actor.userId },
        select: { id: true, archivedAt: true, reportsToBotId: true },
      });
    if (!current) return depth === 0 ? "Manager bot not found" : undefined;
    if (depth === 0 && current.archivedAt) return "Manager bot is archived";
    if (current.reportsToBotId === botId) return "That would create a reporting loop";
    cursor = current.reportsToBotId;
  }
  return cursor ? "Reporting chain is too deep" : undefined;
}
