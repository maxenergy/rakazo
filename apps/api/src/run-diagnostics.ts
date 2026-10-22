import { ORPCError } from "@orpc/server";
import type { Actor, RunDiagnosticsInput, RunDiagnosticsOutput } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const SAFE_STATUSES = new Set(["leased", "pending", "running", "completed", "failed", "cancelled", "blocked", "uncertain", "waiting_budget", "waiting_input", "waiting_takeover", "queued", "succeeded", "approved", "rejected", "executing", "recorded"]);
const statusOf = (value: string) => SAFE_STATUSES.has(value) ? value : "unknown";

export async function getRunDiagnostics(
  prisma: PrismaClient, actor: Actor, input: RunDiagnosticsInput, now = new Date(),
): Promise<RunDiagnosticsOutput> {
  const run = await prisma.run.findFirst({
    where: { id: input.runId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true, threadId: true, status: true },
  });
  if (!run) throw new ORPCError("NOT_FOUND");
  const windowStartedAt = new Date(now.getTime() - WINDOW_MS);
  const timeField = input.section === "attempts" ? "startedAt" : "createdAt";
  const pagination = input.before ? { OR: [
    { [timeField]: { lt: new Date(input.before.at) } },
    { [timeField]: new Date(input.before.at), id: { lt: input.before.id } },
  ] } : {};
  const common = {
    where: { runId: run.id, [timeField]: { gte: windowStartedAt, lte: now }, ...pagination },
    orderBy: [{ [timeField]: "desc" as const }, { id: "desc" as const }],
    take: input.limit + 1,
  };
  const base = { status: null, fence: null, finishedAt: null, provider: null, model: null,
    callId: null, inputTokens: null, outputTokens: null, costMicroUsd: null,
    evidence: { runId: run.id, threadId: run.threadId, eventSeq: null } };
  let entries: RunDiagnosticsOutput["entries"];
  switch (input.section) {
    case "attempts": {
      const rows = await prisma.attempt.findMany({ ...common, select: { id: true, startedAt: true, finishedAt: true, status: true, fence: true } });
      entries = rows.map(row => ({ ...base, id: row.id, at: row.startedAt.toISOString(), kind: "attempt", status: statusOf(row.status), fence: row.fence, finishedAt: row.finishedAt?.toISOString() ?? null }));
      break;
    }
    case "events": {
      const rows = await prisma.event.findMany({ ...common, where: { ...common.where, spaceId: actor.spaceId, threadId: run.threadId, type: { in: ["run.started", "run.checkpointed", "run.waiting_budget", "run.waiting_input", "run.completed", "run.failed", "run.cancelled", "effect.recorded", "effect.reconciled"] } }, select: { id: true, createdAt: true, type: true, seq: true } });
      entries = rows.map(row => ({ ...base, id: row.id, at: row.createdAt.toISOString(), kind: row.type, evidence: { ...base.evidence, eventSeq: row.seq } }));
      break;
    }
    case "effects": {
      const rows = await prisma.externalEffect.findMany({ ...common, where: { ...common.where, spaceId: actor.spaceId }, select: { id: true, createdAt: true, status: true } });
      entries = rows.map(row => ({ ...base, id: row.id, at: row.createdAt.toISOString(), kind: "effect", status: statusOf(row.status) }));
      break;
    }
    case "usage": {
      const rows = await prisma.usageRecord.findMany({ ...common, where: { ...common.where, spaceId: actor.spaceId, userId: actor.userId }, select: { id: true, createdAt: true, provider: true, model: true, callId: true, inputTokens: true, outputTokens: true, costMicroUsd: true } });
      entries = rows.map(row => ({ ...base, id: row.id, at: row.createdAt.toISOString(), kind: "usage", provider: row.provider, model: row.model, callId: row.callId, inputTokens: row.inputTokens, outputTokens: row.outputTokens, costMicroUsd: row.costMicroUsd?.toString() ?? null }));
      break;
    }
  }
  const hasMore = entries.length > input.limit;
  entries = entries.slice(0, input.limit);
  const last = entries.at(-1);
  return { runId: run.id, status: statusOf(run.status), section: input.section, entries,
    nextCursor: hasMore && last ? { at: last.at, id: last.id } : null,
    windowStartedAt: windowStartedAt.toISOString(), historyMayBeIncomplete: true };
}
