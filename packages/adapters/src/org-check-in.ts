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
/** How long a member may sit without work, while others work, before the CEO is asked. */
export const ORG_MEMBER_IDLE_MS = 30 * 60_000;
/** Check-ins per org per day, so an org that keeps stalling cannot burn its subscriptions. */
export const ORG_CHECK_IN_DAILY_LIMIT = 24;

export function orgCheckInPrompt(idleMinutes: number, idleMembers: readonly string[] = []) {
  return [
    idleMembers.length
      ? `Team check-in (automatic, not from the user): these colleagues have had no work for at least ${Math.round(ORG_MEMBER_IDLE_MS / 60_000)} minutes while others work: ${idleMembers.join(", ")}. Find what blocks each of them and give them work.`
      : `Team check-in (automatic, not from the user): no bot in your org has worked for ${idleMinutes} minutes and nothing is queued.`,
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
  /** While some of the org works: whether the CEO has a run, and who has had none for a while. */
  ceoActive?: boolean;
  idleMembers?: readonly string[];
  lastCheckInAt?: Date | null;
};

/**
 * Whether an idle org needs its CEO woken. Right after a check-in the org waits longer,
 * so a CEO that finds nothing to do is not woken again every few minutes.
 */
export function orgNeedsCheckIn(state: OrgCheckInState) {
  if (state.checkInsToday >= ORG_CHECK_IN_DAILY_LIMIT) return false;
  if (state.activeRuns > 0) {
    // Part of a larger org can sit idle behind a blocker while the rest works.
    if (state.ceoActive || !state.idleMembers?.length) return false;
    return (
      !state.lastCheckInAt ||
      state.now.getTime() - state.lastCheckInAt.getTime() >= ORG_CHECK_IN_REPEAT_MS
    );
  }
  if (!state.lastRun) return false;
  const wait =
    state.lastRun.trigger === "org_check_in" ? ORG_CHECK_IN_REPEAT_MS : ORG_CHECK_IN_IDLE_MS;
  return state.now.getTime() - state.lastRun.updatedAt.getTime() >= wait;
}

/** Org members other than the CEO with no active run and no run for a while. */
async function idleOrgMembers(
  prisma: PrismaClient,
  ceo: { id: string; spaceId: string; userId: string },
  now: Date,
) {
  const members = await prisma.bot.findMany({
    where: {
      spaceId: ceo.spaceId,
      userId: ceo.userId,
      archivedAt: null,
      orgRole: { not: null },
      id: { not: ceo.id },
    },
    select: {
      name: true,
      runs: {
        orderBy: { updatedAt: "desc" },
        take: 10,
        select: { status: true, updatedAt: true },
      },
    },
  });
  const active = new Set<string>(ACTIVE_RUN_STATUSES);
  return members
    .filter(({ runs }) => {
      if (runs.some((run) => active.has(run.status))) return false;
      const last = runs[0]?.updatedAt;
      return !last || now.getTime() - last.getTime() >= ORG_MEMBER_IDLE_MS;
    })
    .map((member) => member.name);
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
    const [activeRuns, checkInsToday, lastRun, ceoActiveRuns, lastCheckIn] = await Promise.all([
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
      deps.prisma.run.count({ where: { botId: ceo.id, status: { in: [...ACTIVE_RUN_STATUSES] } } }),
      deps.prisma.run.findFirst({
        where: { botId: ceo.id, trigger: "org_check_in" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
    ]);
    const idleMembers =
      activeRuns > 0 && ceoActiveRuns === 0 ? await idleOrgMembers(deps.prisma, ceo, now) : [];
    const state = {
      now,
      activeRuns,
      checkInsToday,
      lastRun,
      ceoActive: ceoActiveRuns > 0,
      idleMembers,
      lastCheckInAt: lastCheckIn?.createdAt ?? null,
    };
    if (!orgNeedsCheckIn(state)) continue;
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
          prompt: orgCheckInPrompt(idleMinutes, activeRuns > 0 ? idleMembers : []),
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
