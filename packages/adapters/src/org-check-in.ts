import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/** How long a whole org must sit with no run before the CEO is asked to pick up open work. */
export const ORG_CHECK_IN_IDLE_MS = 10 * 60_000;
/**
 * After a check-in found nothing to start, wait this long before the next one: a
 * colleague's subscription limit or another outside wait can clear in the meantime.
 */
export const ORG_CHECK_IN_REPEAT_MS = 60 * 60_000;
/** Check-ins per org per day, so an org that keeps stalling cannot burn its subscriptions. */
export const ORG_CHECK_IN_DAILY_LIMIT = 12;

export function orgCheckInPrompt(idleMinutes: number) {
  return [
    `Team check-in (automatic, not from the user): no bot in your org has worked for ${idleMinutes} minutes and nothing is queued.`,
    "Review the open work: tickets, your latest decisions, and your team's last reports. If a next step is ready, assign it now with message_bot.",
    "A colleague whose turns failed on a CLI or subscription limit is usually available again after the limit resets, so try them again instead of waiting.",
    "A proposal waiting on the user holds back only the work that depends on it; keep the rest of the plan moving.",
    "If the team is waiting on the user, say what for in one sentence. If the agreed work is done, report that to the user. Do not start work outside the agreed plan.",
  ].join("\n");
}

export type OrgCheckInState = {
  now: Date;
  activeRuns: number;
  checkInsToday: number;
  lastRun: { trigger: string; updatedAt: Date } | null;
};

/**
 * Whether an idle org needs its CEO woken. Right after a check-in the org waits longer,
 * so a CEO that finds nothing to do is not woken again every few minutes.
 */
export function orgNeedsCheckIn(state: OrgCheckInState) {
  if (state.activeRuns > 0) return false;
  if (state.checkInsToday >= ORG_CHECK_IN_DAILY_LIMIT) return false;
  if (!state.lastRun) return false;
  const wait =
    state.lastRun.trigger === "org_check_in" ? ORG_CHECK_IN_REPEAT_MS : ORG_CHECK_IN_IDLE_MS;
  return state.now.getTime() - state.lastRun.updatedAt.getTime() >= wait;
}

/** Wake the CEO of each org whose bots have all gone quiet with work possibly left open. */
export async function reconcileOrgCheckIns(
  deps: { prisma: PrismaClient; jobs: JobPublisher },
  now = new Date(),
) {
  const ceos = await deps.prisma.bot.findMany({
    where: { orgRole: "ceo", archivedAt: null, thread: { isNot: null } },
    select: { id: true, spaceId: true, userId: true, thread: { select: { id: true } } },
  });
  for (const ceo of ceos) {
    if (!ceo.thread) continue;
    const org = { spaceId: ceo.spaceId, userId: ceo.userId, orgRole: { not: null } };
    const orgRuns = { spaceId: ceo.spaceId, bot: org };
    const [activeRuns, checkInsToday, lastRun] = await Promise.all([
      deps.prisma.run.count({ where: { ...orgRuns, status: { in: [...ACTIVE_RUN_STATUSES] } } }),
      deps.prisma.run.count({
        where: {
          botId: ceo.id,
          trigger: "org_check_in",
          createdAt: { gt: new Date(now.getTime() - 24 * 60 * 60_000) },
        },
      }),
      deps.prisma.run.findFirst({
        where: orgRuns,
        orderBy: { updatedAt: "desc" },
        select: { trigger: true, updatedAt: true },
      }),
    ]);
    if (!orgNeedsCheckIn({ now, activeRuns, checkInsToday, lastRun })) continue;
    const idleMinutes = Math.round(
      (now.getTime() - (lastRun?.updatedAt ?? now).getTime()) / 60_000,
    );
    const threadId = ceo.thread.id;
    const run = await deps.prisma.$transaction(async (tx) => {
      const task = await tx.task.create({
        data: {
          spaceId: ceo.spaceId,
          botId: ceo.id,
          threadId,
          userId: ceo.userId,
          prompt: orgCheckInPrompt(idleMinutes),
          status: "queued",
        },
      });
      return tx.run.create({
        data: {
          spaceId: ceo.spaceId,
          botId: ceo.id,
          threadId,
          userId: ceo.userId,
          taskId: task.id,
          trigger: "org_check_in",
          status: "queued",
        },
        select: { id: true },
      });
    });
    getLogger().info("org.check_in", { "bot.id": ceo.id, "org.idle_minutes": idleMinutes });
    await deps.jobs.enqueue(runContinueJob(run.id)).catch((error) => {
      getLogger().warn("org check-in deferred to reconciliation", error);
    });
  }
}
