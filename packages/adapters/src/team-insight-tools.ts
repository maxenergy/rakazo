import type { PrismaClient } from "@rakazo/db";

/**
 * Read-only views that let org bots diagnose their own failures and judge models by
 * results, instead of asking a human to read logs or guessing from model names.
 */
export const TEAM_INSIGHT_TOOL_NAMES = ["run_failures", "model_scorecard"] as const;
export type TeamInsightToolName = (typeof TEAM_INSIGHT_TOOL_NAMES)[number];
export function isTeamInsightToolName(name: string): name is TeamInsightToolName {
  return TEAM_INSIGHT_TOOL_NAMES.some((candidate) => candidate === name);
}

const FAILURE_WINDOW_MS = 72 * 60 * 60_000;
const FAILURE_EVENT_TYPES = [
  "run.failed",
  "run.cancelled",
  "run.storage_refused",
  "run.waiting_input",
  "run.waiting_budget",
];

type Scope = { spaceId: string; userId: string; botId: string };

function clip(value: unknown, max = 240): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Recent failed or cancelled runs of this bot, or of a named colleague in the same org. */
export async function runFailures(
  prisma: PrismaClient,
  scope: Scope,
  args: { bot?: unknown; limit?: unknown },
) {
  const name = typeof args.bot === "string" ? args.bot.trim() : "";
  const target = name
    ? await prisma.bot.findFirst({
        where: {
          spaceId: scope.spaceId,
          userId: scope.userId,
          archivedAt: null,
          orgRole: { not: null },
          name: { equals: name, mode: "insensitive" },
        },
        select: { id: true, name: true },
      })
    : await prisma.bot.findFirst({
        where: { id: scope.botId },
        select: { id: true, name: true },
      });
  if (!target) return { error: `No colleague named ${name} in this org.` };
  const limit = Math.min(10, Math.max(1, Number(args.limit) || 5));
  const runs = await prisma.run.findMany({
    where: {
      spaceId: scope.spaceId,
      botId: target.id,
      status: { in: ["failed", "cancelled"] },
      updatedAt: { gt: new Date(Date.now() - FAILURE_WINDOW_MS) },
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: {
      id: true,
      status: true,
      trigger: true,
      error: true,
      modelId: true,
      deadlineMs: true,
      startedAt: true,
      completedAt: true,
      updatedAt: true,
    },
  });
  const events = runs.length
    ? await prisma.event.findMany({
        where: { runId: { in: runs.map((run) => run.id) }, type: { in: FAILURE_EVENT_TYPES } },
        orderBy: { createdAt: "asc" },
        select: { runId: true, type: true, payload: true },
      })
    : [];
  return {
    bot: target.name,
    windowHours: FAILURE_WINDOW_MS / 3_600_000,
    failures: runs.map((run) => ({
      runId: run.id,
      status: run.status,
      trigger: run.trigger,
      model: run.modelId,
      error: run.error ? clip(run.error) : null,
      startedAt: run.startedAt?.toISOString() ?? null,
      endedAt: (run.completedAt ?? run.updatedAt).toISOString(),
      durationMinutes:
        run.startedAt && run.completedAt
          ? Math.round((run.completedAt.getTime() - run.startedAt.getTime()) / 60_000)
          : null,
      deadlineMinutes: run.deadlineMs ? Math.round(run.deadlineMs / 60_000) : null,
      events: events
        .filter((event) => event.runId === run.id)
        .map((event) => `${event.type}: ${clip(event.payload, 160)}`),
    })),
  };
}

/** Per org member over the last days: model, finished and failed runs, tickets done, tokens. */
export async function modelScorecard(prisma: PrismaClient, scope: Scope, args: { days?: unknown }) {
  const days = Math.min(30, Math.max(1, Number(args.days) || 7));
  const since = new Date(Date.now() - days * 24 * 60 * 60_000);
  const members = await prisma.bot.findMany({
    where: {
      spaceId: scope.spaceId,
      userId: scope.userId,
      archivedAt: null,
      orgRole: { not: null },
    },
    select: { id: true, name: true, modelProvider: true, modelId: true },
    orderBy: { createdAt: "asc" },
  });
  const ids = members.map((member) => member.id);
  const [runs, tickets, usage] = await Promise.all([
    prisma.run.groupBy({
      by: ["botId", "status"],
      where: { spaceId: scope.spaceId, botId: { in: ids }, updatedAt: { gt: since } },
      _count: { _all: true },
    }),
    prisma.ticket.groupBy({
      by: ["assigneeBotId"],
      where: {
        spaceId: scope.spaceId,
        assigneeBotId: { in: ids },
        status: { in: ["done", "closed"] },
        completedAt: { gt: since },
      },
      _count: { _all: true },
    }),
    prisma.usageRecord.groupBy({
      by: ["botId"],
      where: { spaceId: scope.spaceId, botId: { in: ids }, createdAt: { gt: since } },
      _sum: { inputTokens: true, cacheReadTokens: true, outputTokens: true },
      _count: { _all: true },
    }),
  ]);
  const count = (botId: string, status: string) =>
    runs.find((row) => row.botId === botId && row.status === status)?._count._all ?? 0;
  return {
    days,
    note: "Token counts cover only model calls that report usage; subscription CLIs may report none.",
    members: members.map((member) => {
      const spent = usage.find((row) => row.botId === member.id);
      const completed = count(member.id, "completed");
      const failed = count(member.id, "failed");
      return {
        bot: member.name,
        model: [member.modelProvider, member.modelId].filter(Boolean).join("/"),
        runsCompleted: completed,
        runsFailed: failed,
        failureRate: completed + failed ? Math.round((failed / (completed + failed)) * 100) : null,
        ticketsDone: tickets.find((row) => row.assigneeBotId === member.id)?._count._all ?? 0,
        modelCalls: spent?._count._all ?? 0,
        inputTokens: spent?._sum.inputTokens ?? null,
        cachedInputTokens: spent?._sum.cacheReadTokens ?? null,
        outputTokens: spent?._sum.outputTokens ?? null,
      };
    }),
  };
}

export async function executeTeamInsightTool(
  prisma: PrismaClient,
  scope: Scope,
  name: TeamInsightToolName,
  args: Record<string, unknown>,
) {
  return name === "run_failures"
    ? runFailures(prisma, scope, args)
    : modelScorecard(prisma, scope, args);
}
