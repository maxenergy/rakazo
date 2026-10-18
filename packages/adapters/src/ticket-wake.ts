import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import { isTicketCompletedStatus, TicketStatusSchema } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { claimTicketWakes, completeTicketWake } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

type WakeInput = { spaceId: string; ticketId: string; botId: string };

/** Creates the queued task and run for a ticket's current owner; null if nothing to wake. */
async function createTicketWakeRun(
  tx: Prisma.TransactionClient,
  input: WakeInput,
  noRun?: (reason: string) => void,
) {
  const ticket = await tx.ticket.findFirst({
    where: { id: input.ticketId, spaceId: input.spaceId, assigneeBotId: input.botId },
    include: { board: { select: { ticketPrefix: true } } },
  });
  if (!ticket) {
    noRun?.("ticket_missing_or_reassigned");
    return null;
  }
  const status = TicketStatusSchema.safeParse(ticket.status);
  if (!status.success || isTicketCompletedStatus(status.data)) {
    noRun?.("ticket_not_actionable");
    return null;
  }
  const bot = await tx.bot.findFirst({
    where: { id: input.botId, spaceId: input.spaceId, archivedAt: null },
    select: { id: true, userId: true, thread: { select: { id: true } } },
  });
  if (!bot?.thread) {
    noRun?.(bot ? "assignee_thread_missing" : "assignee_unavailable");
    return null;
  }
  const task = await tx.task.create({
    data: {
      spaceId: input.spaceId,
      botId: bot.id,
      threadId: bot.thread.id,
      userId: bot.userId,
      prompt: `Work on ticket ${ticket.board.ticketPrefix}-${ticket.number}. Read it with ticket_get. Keep progress in ticket comments and update its status with ticket_update. Use ask or approval cards when user input is needed.`,
      status: "queued",
    },
  });
  return tx.run.create({
    data: {
      spaceId: input.spaceId,
      botId: bot.id,
      threadId: bot.thread.id,
      userId: bot.userId,
      taskId: task.id,
      trigger: "tickets",
      status: "queued",
    },
  });
}

async function enqueueTicketWakeRun(jobs: JobPublisher, runId: string) {
  await jobs.enqueue(runContinueJob(runId)).catch((error) => {
    getLogger().warn("ticket wake deferred to reconciliation", error);
  });
}

/** Assignment wakes only its current owner, without posting a chat message. */
export async function wakeTicketAssignee(
  deps: { prisma: PrismaClient; jobs: JobPublisher; ticketBoardEnabled?: boolean },
  input: WakeInput,
): Promise<void> {
  if (!deps.ticketBoardEnabled) return;
  const run = await deps.prisma.$transaction((tx) => createTicketWakeRun(tx, input));
  if (!run) return;
  await enqueueTicketWakeRun(deps.jobs, run.id);
}

/**
 * Delivers durable dependency wakes. Each claimed wake is fenced inside the delivery
 * transaction: the run is created only if this claimer still owns the lease, so a stale
 * owner (lease expired and reclaimed) creates nothing and a wake yields at most one run.
 * Expired leases left by a crashed runtime are reclaimed by the next claim.
 */
export async function reconcileTicketWakes(
  deps: { prisma: PrismaClient; jobs: JobPublisher; ticketBoardEnabled?: boolean },
  options: { claimer: string; limit?: number; leaseMs?: number; now?: Date; maxAttempts?: number },
): Promise<number> {
  if (!deps.ticketBoardEnabled) return 0;
  const wakes = await claimTicketWakes(deps.prisma, options.claimer, options);
  let delivered = 0;
  for (const wake of wakes) {
    try {
      const run = await deps.prisma.$transaction(async (tx) => {
        const owned = await completeTicketWake(tx, wake.id, wake.spaceId, options.claimer);
        if (!owned) return undefined;
        const ticket = await tx.ticket.findFirst({
          where: { id: wake.ticketId, spaceId: wake.spaceId },
          select: { assigneeBotId: true },
        });
        let reason = ticket ? "unassigned" : "ticket_missing";
        const created = ticket?.assigneeBotId
          ? await createTicketWakeRun(
              tx,
              {
                spaceId: wake.spaceId,
                ticketId: wake.ticketId,
                botId: ticket.assigneeBotId,
              },
              (value) => {
                reason = value;
              },
            )
          : null;
        if (!created) {
          await tx.ticketWake.update({
            where: { id: wake.id },
            data: { status: "skipped", wokenAt: null, outcomeReason: reason },
          });
        }
        return created;
      });
      if (!run) continue;
      delivered += 1;
      await enqueueTicketWakeRun(deps.jobs, run.id);
    } catch (error) {
      getLogger().error("ticket wake delivery", error);
    }
  }
  return delivered;
}
