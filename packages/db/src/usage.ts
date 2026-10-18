import type { AgentRuntimeEvent, UsageOperationKind } from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "./client.js";
import { lockBudgetCall } from "./budget-call-lock.js";
import { decimalUsdToMicroUsd } from "./money.js";
import { reconcileUsageInTransaction } from "./usage-reconciliation.js";

type UsageEvent = Extract<AgentRuntimeEvent, { type: "usage" }>;
export interface UsageAttribution {
  spaceId: string;
  userId: string;
  botId?: string;
  runId?: string;
  parentRunId?: string;
  rootRunId?: string;
  projectId?: string | null;
  operationId?: string;
  operationKind?: UsageOperationKind;
}

export class UsageReplayConflictError extends Error {
  constructor(readonly callId: string, readonly field: string) {
    super(`Conflicting usage replay for ${callId}: ${field}`);
    this.name = "UsageReplayConflictError";
  }
}

/** Usage validation, persistence and reconciliation share one transaction. */
export function recordUsage(
  db: PrismaClient,
  event: UsageEvent,
  attribution: UsageAttribution,
  options: { tx?: Prisma.TransactionClient } = {},
) {
  const execute = (tx: Prisma.TransactionClient) => recordUsageInTransaction(tx, event, attribution);
  return options.tx ? execute(options.tx) : db.$transaction(execute);
}

async function recordUsageInTransaction(
  tx: Prisma.TransactionClient,
  event: UsageEvent,
  attribution: UsageAttribution,
) {
  const callId = event.callId ?? null;
  if (callId) await lockBudgetCall(tx, attribution.spaceId, callId);
  const billingKind = event.billingKind ?? "unknown";
  const costMicroUsd = billingKind === "subscription_included"
    ? null
    : event.costUsdDecimal == null ? null : decimalUsdToMicroUsd(event.costUsdDecimal);
  const identity = {
    spaceId: attribution.spaceId,
    attributedRunId: attribution.runId ?? null,
    parentRunId: attribution.parentRunId ?? attribution.runId ?? null,
    rootRunId: attribution.rootRunId ?? attribution.runId ?? null,
    projectId: attribution.projectId ?? null,
    callId,
    provider: event.provider,
    model: event.model,
    billingKind,
  };
  if (callId) {
    await tx.$queryRaw`SELECT 1 FROM "usage_records" WHERE "spaceId" = ${attribution.spaceId} AND "callId" = ${callId} FOR UPDATE`;
  }
  const prior = callId ? await tx.usageRecord.findUnique({
    where: { spaceId_callId: { spaceId: attribution.spaceId, callId } },
  }) : null;
  if (prior) {
    for (const field of Object.keys(identity) as (keyof typeof identity)[]) {
      if (prior[field] !== identity[field]) throw new UsageReplayConflictError(callId!, field);
    }
    let row = prior;
    if (costMicroUsd !== null && prior.costMicroUsd === null) {
      row = await tx.usageRecord.update({
        where: { id: prior.id },
        data: { costMicroUsd, costSource: event.costSource ?? null, pricingVersion: event.pricingVersion ?? null },
      });
    } else if (costMicroUsd !== null && prior.costMicroUsd !== costMicroUsd) {
      if (prior.costSource === (event.costSource ?? null)) throw new UsageReplayConflictError(callId!, "costMicroUsd");
      const anomalies = Array.isArray(prior.costAnomalies) ? prior.costAnomalies : [];
      const anomaly = { kind: "amount_source_conflict", costMicroUsd: costMicroUsd.toString(), costSource: event.costSource ?? null };
      if (!anomalies.some((item) => JSON.stringify(item) === JSON.stringify(anomaly))) {
        row = await tx.usageRecord.update({ where: { id: prior.id }, data: { costAnomalies: [...anomalies, anomaly] } });
      }
    }
    await reconcileUsageInTransaction(tx, row);
    return row;
  }
  // Lock the optional lifecycle parent before insertion, avoiding a failed FK
  // statement that would otherwise abort the surrounding PostgreSQL transaction.
  const runs = attribution.runId ? await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "runs" WHERE "id" = ${attribution.runId} AND "spaceId" = ${attribution.spaceId} FOR KEY SHARE` : [];
  const row = await tx.usageRecord.create({
    data: {
      ...identity,
      userId: attribution.userId,
      botId: attribution.botId ?? null,
      runId: runs[0]?.id ?? null,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens ?? null,
      cacheWriteTokens: event.cacheWriteTokens ?? null,
      cacheWrite1hTokens: event.cacheWrite1hTokens ?? null,
      reasoningTokens: event.reasoningTokens ?? null,
      totalTokens: event.totalTokens ?? null,
      costMicroUsd,
      costSource: event.costSource ?? null,
      pricingVersion: event.pricingVersion ?? null,
      usageSource: event.usageSource ?? null,
      operationId: attribution.operationId ?? null,
      operationKind: attribution.operationKind ?? event.operationKind ?? "answer",
      agentId: event.agentId ?? null,
    },
  });
  await reconcileUsageInTransaction(tx, row);
  return row;
}
