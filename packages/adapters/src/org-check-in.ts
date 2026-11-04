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
/** How long a ticket whose prerequisites are done may sit unstarted before the CEO is asked. */
export const ORG_READY_TICKET_STALL_MS = 15 * 60_000;
/** Check-ins per org per day, so an org that keeps stalling cannot burn its subscriptions. */
export const ORG_CHECK_IN_DAILY_LIMIT = 24;
/** How many failed tickets one check-in names before it only counts the rest. */
const ORG_FAILED_TICKETS_NAMED = 10;
/** Rolling 24-hour cap and creation-time throttle, including failed attempts. */
export const ORG_RECORD_ONLY_DAILY_LIMIT = 6;
export const ORG_RECORD_ONLY_REPEAT_MS = 60 * 60_000;
const RECORD_ONLY_TRIGGER = "org_check_in_record_only";

export function orgRecordOnlyDue(count: number, lastAt: Date | null, now: Date) {
  return (
    count < ORG_RECORD_ONLY_DAILY_LIMIT &&
    (!lastAt || now.getTime() - lastAt.getTime() >= ORG_RECORD_ONLY_REPEAT_MS)
  );
}

export function orgCheckInPrompt(
  idleMinutes: number,
  idleMembers: readonly string[] = [],
  readyTickets: readonly string[] = [],
  failedTickets: readonly string[] = [],
) {
  return [
    failedTickets.length
      ? `Team check-in (automatic, not from the user): the owners of these tickets stopped because their latest run failed: ${failedTickets.join("; ")}. Use run_failures to see why, then assign the work again, change the plan, or tell the user what you need.`
      : undefined,
    readyTickets.length
      ? `Team check-in (automatic, not from the user): these tickets have every recorded prerequisite done but have not started: ${readyTickets.join("; ")}. Tell each owner to start now with message_bot, or record on the ticket why it still has to wait.`
      : undefined,
    idleMembers.length
      ? `Team check-in (automatic, not from the user): these colleagues have had no work for at least ${Math.round(ORG_MEMBER_IDLE_MS / 60_000)} minutes while others work: ${idleMembers.join(", ")}. Find what blocks each of them and give them work.`
      : `Team check-in (automatic, not from the user): no bot in your org has worked for ${idleMinutes} minutes and nothing is queued.`,
    "Review the open work: tickets, your latest decisions, and your team's last reports. If a next step is ready, assign it now with message_bot.",
    "A colleague whose turns failed on a CLI or subscription limit is usually available again after the limit resets, so try them again instead of waiting.",
    "A proposal waiting on the user holds back only the work that depends on it; keep the rest of the plan moving.",
    "If the team is waiting on the user, say what for in one sentence. Do not start work outside the agreed plan.",
    "If all the agreed work is done, do not stop there: agree the next phase with the CTO (goal, scope, milestones, staffing and models, cost within existing subscriptions, acceptance) and send it to the user with submit_proposal. Start it only after the user approves it on the Approvals page, and do not send another while one is waiting.",
  ]
    .filter(Boolean)
    .join("\n");
}

export type OrgCheckInState = {
  now: Date;
  activeRuns: number;
  checkInsToday: number;
  lastRun: { trigger: string; updatedAt: Date } | null;
  /** While some of the org works: whether the CEO has a run, and who has had none for a while. */
  ceoActive?: boolean;
  idleMembers?: readonly string[];
  /** Tickets whose recorded prerequisites are all done but which nobody has started. */
  readyTickets?: readonly string[];
  /** Tickets in progress whose owner's latest run failed since the last check-in. */
  failedTickets?: readonly string[];
  /** Proposals the org sent the user that are still undecided. */
  pendingProposals?: number;
  lastCheckInAt?: Date | null;
};

/**
 * Whether an idle org needs its CEO woken. Right after a check-in the org waits longer,
 * so a CEO that finds nothing to do is not woken again every few minutes.
 */
export function orgNeedsCheckIn(state: OrgCheckInState) {
  if (state.checkInsToday >= ORG_CHECK_IN_DAILY_LIMIT) return false;
  const sinceCheckIn = state.lastCheckInAt
    ? state.now.getTime() - state.lastCheckInAt.getTime()
    : Number.POSITIVE_INFINITY;
  // Ready work left unstarted is a stall even while other bots are busy.
  if (state.readyTickets?.length && !state.ceoActive && sinceCheckIn >= ORG_CHECK_IN_REPEAT_MS)
    return true;
  // Each failure is reported once, so this needs only the shorter wait.
  if (state.failedTickets?.length && !state.ceoActive && sinceCheckIn >= ORG_CHECK_IN_IDLE_MS)
    return true;
  if (state.activeRuns > 0) {
    // Part of a larger org can sit idle behind a blocker while the rest works.
    if (state.ceoActive || !state.idleMembers?.length) return false;
    return (
      !state.lastCheckInAt ||
      state.now.getTime() - state.lastCheckInAt.getTime() >= ORG_CHECK_IN_REPEAT_MS
    );
  }
  if (!state.lastRun) return false;
  // A whole org idle on an undecided proposal is waiting on the user, not stalled.
  if (state.pendingProposals) return false;
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

/**
 * Tickets owned by an org bot that wait in todo or blocked although every prerequisite
 * recorded for them is done, and whose owner has no active run: work that is ready but
 * that nobody picked up after the dependency wake.
 */
async function readyStalledTickets(
  prisma: PrismaClient,
  ceo: { spaceId: string; userId: string },
  now: Date,
) {
  const tickets = await prisma.ticket.findMany({
    where: {
      spaceId: ceo.spaceId,
      status: { in: ["todo", "blocked"] },
      updatedAt: { lt: new Date(now.getTime() - ORG_READY_TICKET_STALL_MS) },
      dependencies: {
        some: {},
        every: { prerequisite: { status: { in: ["done", "closed"] } } },
      },
      assigneeBot: {
        userId: ceo.userId,
        archivedAt: null,
        orgRole: { not: null },
        runs: {
          none: { trigger: { not: RECORD_ONLY_TRIGGER }, status: { in: [...ACTIVE_RUN_STATUSES] } },
        },
      },
    },
    select: {
      number: true,
      status: true,
      board: { select: { ticketPrefix: true } },
      assigneeBot: { select: { name: true } },
    },
    take: 10,
  });
  return tickets.map(
    (ticket) =>
      `${ticket.board.ticketPrefix}-${ticket.number} (${ticket.status}, owner ${ticket.assigneeBot?.name ?? "none"})`,
  );
}

/** Tickets in progress whose owner stopped on a failed run since the last check-in. */
async function failedOwnerTickets(
  prisma: PrismaClient,
  ceo: { id: string; spaceId: string; userId: string },
  since: Date | null,
) {
  const tickets = await prisma.ticket.findMany({
    where: {
      spaceId: ceo.spaceId,
      status: "doing",
      assigneeBot: {
        id: { not: ceo.id },
        userId: ceo.userId,
        archivedAt: null,
        orgRole: { not: null },
        runs: {
          some: { status: "failed", ...(since ? { updatedAt: { gt: since } } : {}) },
          none: { status: { in: [...ACTIVE_RUN_STATUSES] } },
        },
      },
    },
    select: {
      number: true,
      board: { select: { ticketPrefix: true } },
      assigneeBot: {
        select: {
          name: true,
          runs: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true } },
        },
      },
    },
  });
  const failed = tickets
    .filter((ticket) => ticket.assigneeBot?.runs[0]?.status === "failed")
    .map(
      (ticket) =>
        `${ticket.board.ticketPrefix}-${ticket.number} (owner ${ticket.assigneeBot?.name})`,
    );
  // The next check-in looks only at newer failures, so say when some went unnamed.
  return failed.length > ORG_FAILED_TICKETS_NAMED
    ? [
        ...failed.slice(0, ORG_FAILED_TICKETS_NAMED),
        `and ${failed.length - ORG_FAILED_TICKETS_NAMED} more on the board`,
      ]
    : failed;
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
    const orgRuns = { spaceId: ceo.spaceId, bot: org, trigger: { not: RECORD_ONLY_TRIGGER } };
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
      deps.prisma.run.count({
        where: {
          botId: ceo.id,
          trigger: { not: RECORD_ONLY_TRIGGER },
          status: { in: [...ACTIVE_RUN_STATUSES] },
        },
      }),
      deps.prisma.run.findFirst({
        where: { botId: ceo.id, trigger: "org_check_in" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
    ]);
    const idleMembers =
      activeRuns > 0 && ceoActiveRuns === 0 ? await idleOrgMembers(deps.prisma, ceo, now) : [];
    const readyTickets =
      ceoActiveRuns === 0 ? await readyStalledTickets(deps.prisma, ceo, now) : [];
    const failedTickets =
      ceoActiveRuns === 0
        ? await failedOwnerTickets(deps.prisma, ceo, lastCheckIn?.createdAt ?? null)
        : [];
    const pendingProposals =
      activeRuns === 0
        ? await deps.prisma.proposal.count({
            where: { spaceId: ceo.spaceId, userId: ceo.userId, status: "pending" },
          })
        : 0;
    const state = {
      now,
      activeRuns,
      checkInsToday,
      lastRun,
      ceoActive: ceoActiveRuns > 0,
      idleMembers,
      readyTickets,
      failedTickets,
      pendingProposals,
      lastCheckInAt: lastCheckIn?.createdAt ?? null,
    };
    // Real check-ins always win this reconciliation round.
    let trigger = "org_check_in";
    if (!orgNeedsCheckIn(state)) {
      const selected = (process.env.RECORD_ONLY_ORG_CHECK_IN_BOT_IDS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .includes(ceo.id);
      if (!selected || state.ceoActive || !state.lastRun) continue;
      const [count, last] = await Promise.all([
        deps.prisma.run.count({
          where: {
            botId: ceo.id,
            trigger: RECORD_ONLY_TRIGGER,
            createdAt: { gt: new Date(now.getTime() - 24 * 60 * 60_000) },
          },
        }),
        deps.prisma.run.findFirst({
          where: { botId: ceo.id, trigger: RECORD_ONLY_TRIGGER },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        }),
      ]);
      if (!orgRecordOnlyDue(count, last?.createdAt ?? null, now)) continue;
      trigger = RECORD_ONLY_TRIGGER;
    }
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
          prompt:
            (trigger === RECORD_ONLY_TRIGGER
              ? "Record-only organization check-in: evaluate only. Do not perform actions. Tools that change state are blocked.\n"
              : "") +
            orgCheckInPrompt(
              idleMinutes,
              activeRuns > 0 ? idleMembers : [],
              readyTickets,
              failedTickets,
            ),
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
          trigger,
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
