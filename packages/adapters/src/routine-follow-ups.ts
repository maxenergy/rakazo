import { ONCE_ROUTINE_CRON } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

function runsOnce(crons: readonly string[] | undefined) {
  return crons?.length === 1 && crons[0] === ONCE_ROUTINE_CRON;
}

/**
 * A queued one-time routine run is superseded when the same bot queued a newer one.
 * Bots schedule one-time follow-ups ("check CI again") while a long turn is still
 * running; they pile up behind it, and each newer one was written from fresher state,
 * so only the latest needs to run.
 */
export async function onceFollowUpSuperseded(
  prisma: PrismaClient,
  run: { id: string; botId: string; routineId: string | null; createdAt: Date },
) {
  if (!run.routineId) return false;
  const routine = await prisma.routine.findUnique({
    where: { id: run.routineId },
    select: { crons: true },
  });
  if (!runsOnce(routine?.crons)) return false;
  const newer = await prisma.run.findMany({
    where: {
      botId: run.botId,
      trigger: "routine",
      status: "queued",
      id: { not: run.id },
      createdAt: { gt: run.createdAt },
    },
    select: { routine: { select: { crons: true } } },
  });
  return newer.some((candidate) => runsOnce(candidate.routine?.crons));
}
