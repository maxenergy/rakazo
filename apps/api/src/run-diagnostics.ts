import { ORPCError } from "@orpc/server";
import type { Actor, RunDiagnosticsInput, RunDiagnosticsOutput } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const SAFE_STATUSES = new Set([
  "leased",
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "blocked",
  "uncertain",
  "waiting_budget",
  "waiting_approval",
  "waiting_input",
  "waiting_takeover",
  "queued",
  "succeeded",
  "approved",
  "rejected",
  "executing",
  "recorded",
]);
const statusOf = (value: string) => (SAFE_STATUSES.has(value) ? value : "unknown");

export async function getRunDiagnostics(
  prisma: PrismaClient,
  actor: Actor,
  input: RunDiagnosticsInput,
  now = new Date(),
): Promise<RunDiagnosticsOutput> {
  const run = await prisma.run.findFirst({
    where: { id: input.runId, spaceId: actor.spaceId, userId: actor.userId },
    select: {
      id: true,
      threadId: true,
      status: true,
      modelProvider: true,
      modelId: true,
      modelPinned: true,
      leaseFence: true,
      sourceMessageId: true,
      thread: { select: { botId: true, groupId: true } },
    },
  });
  if (!run) throw new ORPCError("NOT_FOUND");
  // Read persisted approvals on every request, including after a restart.
  const pendingApprovals = await prisma.proposal.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      status: "pending",
      submitKey: { startsWith: `${run.id}:submit_proposal:` },
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const persistedStatus = statusOf(run.status);
  const status =
    pendingApprovals.length > 0 && ["completed", "waiting_approval"].includes(run.status)
      ? "waiting_approval"
      : persistedStatus;
  const threadPath = run.thread?.groupId
    ? `/app/g/${encodeURIComponent(run.thread.groupId)}`
    : run.thread?.botId
      ? `/app/${encodeURIComponent(run.thread.botId)}`
      : null;
  const sourceHref =
    threadPath && run.sourceMessageId
      ? `${threadPath}?m=${encodeURIComponent(run.sourceMessageId)}`
      : null;
  const windowStartedAt = new Date(now.getTime() - WINDOW_MS);
  const timeField = input.section === "attempts" ? "startedAt" : "createdAt";
  const pagination = input.before
    ? {
        OR: [
          { [timeField]: { lt: new Date(input.before.at) } },
          { [timeField]: new Date(input.before.at), id: { lt: input.before.id } },
        ],
      }
    : {};
  const common = {
    where: { runId: run.id, [timeField]: { gte: windowStartedAt, lte: now }, ...pagination },
    orderBy: [{ [timeField]: "desc" as const }, { id: "desc" as const }],
    take: input.limit + 1,
  };
  const base = {
    status: null,
    fence: null,
    finishedAt: null,
    provider: null,
    model: null,
    callId: null,
    inputTokens: null,
    outputTokens: null,
    costMicroUsd: null,
    evidence: { runId: run.id, threadId: run.threadId, eventSeq: null, sourceHref },
  };
  let entries: RunDiagnosticsOutput["entries"];
  switch (input.section) {
    case "attempts": {
      const rows = await prisma.attempt.findMany({
        ...common,
        select: { id: true, startedAt: true, finishedAt: true, status: true, fence: true },
      });
      entries = rows.map((row, index) => {
        const previous = rows[index + 1];
        const takeover =
          previous &&
          row.fence > previous.fence &&
          previous.startedAt < row.startedAt &&
          (!previous.finishedAt || previous.finishedAt > row.startedAt);
        return {
          ...base,
          id: row.id,
          at: row.startedAt.toISOString(),
          kind: "attempt",
          status: statusOf(row.status),
          fence: row.fence,
          finishedAt: row.finishedAt?.toISOString() ?? null,
          derived: takeover ? ("lease_takeover" as const) : null,
        };
      });
      break;
    }
    case "events": {
      const rows = await prisma.event.findMany({
        ...common,
        where: {
          ...common.where,
          spaceId: actor.spaceId,
          threadId: run.threadId,
          type: {
            in: [
              "steering.delivered",
              "run.started",
              "run.checkpointed",
              "run.waiting_budget",
              "run.waiting_input",
              "run.completed",
              "run.failed",
              "run.cancelled",
              "effect.recorded",
              "effect.reconciled",
            ],
          },
        },
        select: { id: true, createdAt: true, type: true, seq: true },
      });
      entries = await Promise.all(
        rows.map(async (row) => {
          const entry = {
            ...base,
            id: row.id,
            at: row.createdAt.toISOString(),
            kind: row.type,
            evidence: { ...base.evidence, eventSeq: row.seq },
          };
          if (row.type === "steering.delivered") {
            const record = await prisma.event.findFirst({
              where: {
                id: row.id,
                runId: run.id,
                spaceId: actor.spaceId,
                threadId: run.threadId,
                type: "steering.delivered",
              },
              select: { payload: true },
            });
            const payload = record?.payload;
            const data =
              payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
            if (
              !("messageId" in data) ||
              typeof data.messageId !== "string" ||
              !("receivedAt" in data) ||
              typeof data.receivedAt !== "string" ||
              !Number.isFinite(Date.parse(data.receivedAt))
            )
              return entry;
            return {
              ...entry,
              provider: run.modelProvider ?? null,
              model: run.modelId ?? null,
              steering: {
                messageId: data.messageId,
                receivedAt: new Date(data.receivedAt).toISOString(),
                deliveredAt: entry.at,
                usage: { runId: run.id, section: "usage" as const, attribution: "run" as const },
              },
            };
          }
          if (row.type !== "effect.reconciled") return entry;
          // Only reconciliation events may have their payload read. Never return the correlation key.
          const record = await prisma.event.findFirst({
            where: { id: row.id, runId: run.id, spaceId: actor.spaceId, type: "effect.reconciled" },
            select: { payload: true },
          });
          const payload = record?.payload;
          const data =
            payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
          const valid =
            "executionId" in data &&
            typeof data.executionId === "string" &&
            "kind" in data &&
            typeof data.kind === "string";
          const effect = valid
            ? await prisma.externalEffect.findFirst({
                where: {
                  runId: run.id,
                  spaceId: actor.spaceId,
                  idempotencyKey: data.executionId as string,
                  kind: data.kind as string,
                },
                select: {
                  id: true,
                  kind: true,
                  status: true,
                  reviewDecision: true,
                  createdAt: true,
                },
              })
            : null;
          return {
            ...entry,
            recovery: {
              match: effect ? ("matched" as const) : ("unmatched" as const),
              legacy: "legacy" in data && data.legacy === true,
              effect: effect
                ? {
                    ...effect,
                    status: statusOf(effect.status),
                    reviewDecision:
                      effect.reviewDecision === "approved" || effect.reviewDecision === "rejected"
                        ? effect.reviewDecision
                        : null,
                    createdAt: effect.createdAt.toISOString(),
                  }
                : null,
            },
          };
        }),
      );
      break;
    }
    case "effects": {
      const rows = await prisma.externalEffect.findMany({
        ...common,
        where: { ...common.where, spaceId: actor.spaceId },
        select: { id: true, createdAt: true, status: true },
      });
      entries = rows.map((row) => ({
        ...base,
        id: row.id,
        at: row.createdAt.toISOString(),
        kind: "effect",
        status: statusOf(row.status),
      }));
      break;
    }
    case "usage": {
      const rows = await prisma.usageRecord.findMany({
        ...common,
        where: { ...common.where, spaceId: actor.spaceId, userId: actor.userId },
        select: {
          id: true,
          createdAt: true,
          provider: true,
          model: true,
          callId: true,
          inputTokens: true,
          outputTokens: true,
          costMicroUsd: true,
        },
      });
      entries = rows.map((row, index) => {
        const previous = rows[index + 1];
        const changed =
          previous &&
          previous.createdAt < row.createdAt &&
          (previous.provider !== row.provider || previous.model !== row.model);
        return {
          ...base,
          id: row.id,
          at: row.createdAt.toISOString(),
          kind: "usage",
          provider: row.provider,
          model: row.model,
          callId: row.callId,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          costMicroUsd: row.costMicroUsd?.toString() ?? null,
          derived: changed ? ("model_changed" as const) : null,
        };
      });
      break;
    }
  }
  const hasMore = entries.length > input.limit;
  entries = entries.slice(0, input.limit);
  const last = entries.at(-1);
  return {
    runId: run.id,
    status,
    persistedStatus,
    pendingApprovalIds: pendingApprovals.map((approval) => approval.id),
    runContext: {
      modelProvider: run.modelProvider ?? null,
      modelId: run.modelId ?? null,
      modelPinned: run.modelPinned ?? false,
      leaseFence: run.leaseFence ?? 0,
    },
    section: input.section,
    entries,
    nextCursor: hasMore && last ? { at: last.at, id: last.id } : null,
    windowStartedAt: windowStartedAt.toISOString(),
    historyMayBeIncomplete: true,
  };
}
