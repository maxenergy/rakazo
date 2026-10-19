import { lockBudgetCall } from "./budget-call-lock.js";
import type { Prisma, PrismaClient } from "./client.js";
import { lockTicketSpace } from "./ticket-space-lock.js";
import { reconcileUsageInTransaction } from "./usage-reconciliation.js";

/** All amounts are integer micro-USD (1 USD = 1_000_000) held as bigint. */
export const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1000;

/** Thrown when a callId is replayed for another budget or with a different amount. */
export class BudgetCallIdConflictError extends Error {
  constructor(
    readonly callId: string,
    readonly kind: "other_budget" | "amount_mismatch",
  ) {
    super(
      kind === "other_budget"
        ? "callId already used for another budget"
        : "callId already used with a different amount",
    );
    this.name = "BudgetCallIdConflictError";
  }
}

export type BudgetReservationResult =
  | {
      ok: true;
      reservationId: string;
      budgetId: string;
      budgetVersion: number;
      amountMicroUsd: bigint;
      replayed: boolean;
    }
  | {
      ok: false;
      reason: "no_budget" | "insufficient" | "reservation_closed";
      availableMicroUsd: bigint;
      /** Stored status of the closed reservation, set with reason reservation_closed. */
      status?: "settled" | "released" | "expired";
    };

export interface BudgetSettlement {
  reservationId: string;
  status: "settled";
  settledMicroUsd: bigint;
  overrunMicroUsd: bigint;
  settledLate: boolean;
  replayed: boolean;
}

interface BudgetRow {
  id: string;
  version: number;
  limitMicroUsd: bigint;
  reservedMicroUsd: bigint;
  settledMicroUsd: bigint;
}

interface ReservationRow {
  spaceId: string;
  projectId: string;
  budgetVersion: number;
  callId: string;
  id: string;
  budgetId: string;
  amountMicroUsd: bigint;
  settledMicroUsd: bigint | null;
  overrunMicroUsd: bigint;
  status: string;
  settledLate: boolean;
  executionState: string;
  expiresAt: Date;
}

function assertPositiveMicroUsd(value: bigint, label: string) {
  assertMicroUsd(value, label);
  if (value <= 0n) throw new Error(`${label} must be greater than zero`);
}

function assertMicroUsd(value: bigint, label: string) {
  if (typeof value !== "bigint" || value < 0n) {
    throw new Error(`${label} must be a non-negative integer micro-USD bigint`);
  }
}

/** Create the budget or change its limit; every change bumps the version and is kept. */
async function setProjectBudgetOnce(
  db: PrismaClient,
  input: {
    spaceId: string;
    projectId: string;
    limitMicroUsd: bigint;
    createdByUserId?: string | null;
  },
) {
  assertMicroUsd(input.limitMicroUsd, "limitMicroUsd");
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<BudgetRow[]>`
      SELECT * FROM "project_budgets"
      WHERE "spaceId" = ${input.spaceId} AND "projectId" = ${input.projectId}
      FOR UPDATE`;
    const current = rows[0];
    const budget = current
      ? await tx.projectBudget.update({
          where: { id: current.id },
          data: { version: current.version + 1, limitMicroUsd: input.limitMicroUsd },
        })
      : await tx.projectBudget.create({
          data: {
            spaceId: input.spaceId,
            projectId: input.projectId,
            limitMicroUsd: input.limitMicroUsd,
          },
        });
    await tx.projectBudgetVersion.create({
      data: {
        budgetId: budget.id,
        version: budget.version,
        limitMicroUsd: input.limitMicroUsd,
        createdByUserId: input.createdByUserId ?? null,
      },
    });
    return budget;
  });
}

/**
 * Atomically reserve `amountMicroUsd` (a controllable upper bound for one call). The budget row
 * is locked FOR UPDATE, so concurrent reservations serialize and can never oversubscribe
 * limit - reserved - settled. Replaying the same callId with the same amount returns the original
 * reservation. Replaying it with a different amount, or for another budget, throws
 * BudgetCallIdConflictError and leaves the existing reservation unchanged.
 */
export function reserveBudget(
  db: PrismaClient,
  input: Parameters<typeof reserveBudgetInTransaction>[1],
): Promise<BudgetReservationResult> {
  return db.$transaction((tx) => reserveBudgetInTransaction(tx, input));
}

export async function reserveBudgetInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    spaceId: string;
    projectId: string;
    callId: string;
    amountMicroUsd: bigint;
    ttlMs?: number;
    now?: Date;
  },
): Promise<BudgetReservationResult> {
  assertPositiveMicroUsd(input.amountMicroUsd, "amountMicroUsd");
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? DEFAULT_RESERVATION_TTL_MS));
  await lockTicketSpace(tx, input.spaceId);
  const project = await tx.project.findFirst({
    where: { id: input.projectId, spaceId: input.spaceId },
    select: { archivedAt: true },
  });
  if (project?.archivedAt) throw new Error("Project is archived");
  await lockReservation(tx, input.spaceId, input.callId);
  const usage = await tx.usageRecord.findUnique({
    where: { spaceId_callId: { spaceId: input.spaceId, callId: input.callId } },
  });
  if (usage && usage.projectId !== input.projectId) {
    throw new BudgetCallIdConflictError(input.callId, "other_budget");
  }
  const rows = await tx.$queryRaw<BudgetRow[]>`
      SELECT * FROM "project_budgets"
      WHERE "spaceId" = ${input.spaceId} AND "projectId" = ${input.projectId}
      FOR UPDATE`;
  const budget = rows[0];
  if (!budget) return { ok: false, reason: "no_budget", availableMicroUsd: 0n };

  const prior = await tx.budgetReservation.findUnique({
    where: { spaceId_callId: { spaceId: input.spaceId, callId: input.callId } },
  });
  if (prior) {
    if (prior.budgetId !== budget.id) {
      throw new BudgetCallIdConflictError(input.callId, "other_budget");
    }
    if (prior.amountMicroUsd !== input.amountMicroUsd) {
      throw new BudgetCallIdConflictError(input.callId, "amount_mismatch");
    }
    // A closed reservation no longer holds funds; a retry must not look like a live hold.
    if (prior.status !== "reserved") {
      return {
        ok: false,
        reason: "reservation_closed",
        availableMicroUsd: 0n,
        status: prior.status as "settled" | "released" | "expired",
      };
    }
    return {
      ok: true,
      reservationId: prior.id,
      budgetId: prior.budgetId,
      budgetVersion: prior.budgetVersion,
      amountMicroUsd: prior.amountMicroUsd,
      replayed: true,
    };
  }

  const available = budget.limitMicroUsd - budget.reservedMicroUsd - budget.settledMicroUsd;
  if (available < input.amountMicroUsd) {
    return {
      ok: false,
      reason: "insufficient",
      availableMicroUsd: available > 0n ? available : 0n,
    };
  }

  await tx.projectBudget.update({
    where: { id: budget.id },
    data: { reservedMicroUsd: { increment: input.amountMicroUsd } },
  });
  const created = await tx.budgetReservation
    .create({
      data: {
        budgetId: budget.id,
        spaceId: input.spaceId,
        projectId: input.projectId,
        budgetVersion: budget.version,
        callId: input.callId,
        amountMicroUsd: input.amountMicroUsd,
        executionState: "not_started",
        expiresAt,
      },
    })
    .catch((error: unknown) => {
      // Same-budget callers serialize on the budget lock, so a unique violation here means
      // another budget won the race for this callId.
      if ((error as { code?: string }).code === "P2002") {
        throw new BudgetCallIdConflictError(input.callId, "other_budget");
      }
      throw error;
    });
  if (usage) await reconcileUsageInTransaction(tx, usage);
  return {
    ok: true,
    reservationId: created.id,
    budgetId: budget.id,
    budgetVersion: budget.version,
    amountMicroUsd: input.amountMicroUsd,
    replayed: false,
  };
}

/** Lock order: call advisory lock, usage, reservation, then budget. */
async function lockReservation(tx: Prisma.TransactionClient, spaceId: string, callId: string) {
  await lockBudgetCall(tx, spaceId, callId);
  await tx.$queryRaw`SELECT 1 FROM "usage_records" WHERE "spaceId" = ${spaceId} AND "callId" = ${callId} FOR UPDATE`;
  const rows = await tx.$queryRaw<ReservationRow[]>`
    SELECT * FROM "budget_reservations" WHERE "spaceId" = ${spaceId} AND "callId" = ${callId} FOR UPDATE`;
  const reservation = rows[0];
  if (!reservation) return null;
  await tx.$queryRaw`SELECT 1 FROM "project_budgets" WHERE "id" = ${reservation.budgetId} FOR UPDATE`;
  return reservation;
}

/** Deleted projects retain call identity and holdings exclusively in the ledger. */
async function settleDeletedBudget(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; callId: string; actualMicroUsd: bigint },
): Promise<BudgetSettlement | null> {
  const open = await tx.budgetSpendLedger.findUnique({
    where: {
      spaceId_callId_kind: {
        spaceId: input.spaceId,
        callId: input.callId,
        kind: "open_at_deletion",
      },
    },
  });
  if (!open) return null;
  const overrun =
    input.actualMicroUsd > open.amountMicroUsd ? input.actualMicroUsd - open.amountMicroUsd : 0n;
  const inserted = await tx.budgetSpendLedger.createMany({
    skipDuplicates: true,
    data: [
      {
        spaceId: open.spaceId,
        projectId: open.projectId,
        budgetId: open.budgetId,
        budgetVersion: open.budgetVersion,
        callId: open.callId,
        kind: "settled_after_deletion",
        amountMicroUsd: input.actualMicroUsd,
        overrunMicroUsd: overrun,
      },
    ],
  });
  const prior = await tx.budgetSpendLedger.findUniqueOrThrow({
    where: {
      spaceId_callId_kind: {
        spaceId: input.spaceId,
        callId: input.callId,
        kind: "settled_after_deletion",
      },
    },
  });
  const audit = open.auditData as { reservationId?: string } | null;
  return {
    reservationId: audit?.reservationId ?? open.id,
    status: "settled",
    settledMicroUsd: prior?.amountMicroUsd ?? input.actualMicroUsd,
    overrunMicroUsd: prior?.overrunMicroUsd ?? overrun,
    settledLate: true,
    replayed: inserted.count === 0,
  };
}

/**
 * Settle actual spend, idempotent by callId. Actual cost is always recorded, even above the
 * reservation (the excess is `overrunMicroUsd`) or after the reservation expired (`settledLate`).
 * Late actual charges settle once even after release or write-off.
 */
export function settleBudget(
  db: PrismaClient,
  input: Parameters<typeof settleBudgetInTransaction>[1],
): Promise<BudgetSettlement | null> {
  return db.$transaction((tx) => settleBudgetInTransaction(tx, input));
}

export async function settleBudgetInTransaction(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; callId: string; actualMicroUsd: bigint; now?: Date },
): Promise<BudgetSettlement | null> {
  assertMicroUsd(input.actualMicroUsd, "actualMicroUsd");
  const now = input.now ?? new Date();
  await lockTicketSpace(tx, input.spaceId);
  const reservation = await lockReservation(tx, input.spaceId, input.callId);
  if (!reservation) return settleDeletedBudget(tx, input);
  if (reservation.status === "settled") {
    return {
      reservationId: reservation.id,
      status: "settled",
      settledMicroUsd: reservation.settledMicroUsd ?? 0n,
      overrunMicroUsd: reservation.overrunMicroUsd,
      settledLate: reservation.settledLate,
      replayed: true,
    };
  }
  const hasHolding = reservation.status === "reserved" || reservation.status === "unreconciled";
  const late = reservation.status !== "reserved";
  const overrun =
    input.actualMicroUsd > reservation.amountMicroUsd
      ? input.actualMicroUsd - reservation.amountMicroUsd
      : 0n;
  // Only reserved and unreconciled reservations still hold funds.
  await tx.projectBudget.update({
    where: { id: reservation.budgetId },
    data: {
      reservedMicroUsd: hasHolding ? { decrement: reservation.amountMicroUsd } : undefined,
      settledMicroUsd: { increment: input.actualMicroUsd },
    },
  });
  await tx.budgetReservation.update({
    where: { id: reservation.id },
    data: {
      status: "settled",
      settledMicroUsd: input.actualMicroUsd,
      overrunMicroUsd: overrun,
      settledLate: late,
      chargedAfterRelease: reservation.status === "released" ? true : undefined,
      chargedAfterWriteOff: reservation.status === "written_off" ? true : undefined,
      closedAt: now,
    },
  });
  await tx.budgetSpendLedger.create({
    data: {
      spaceId: reservation.spaceId,
      projectId: reservation.projectId,
      budgetId: reservation.budgetId,
      budgetVersion: reservation.budgetVersion,
      callId: reservation.callId,
      kind: "settled",
      amountMicroUsd: input.actualMicroUsd,
      overrunMicroUsd: overrun,
    },
  });
  return {
    reservationId: reservation.id,
    status: "settled",
    settledMicroUsd: input.actualMicroUsd,
    overrunMicroUsd: overrun,
    settledLate: late,
    replayed: false,
  };
}

/** Persist intent before touching the provider; uncertain calls retain holding. */
export function startBudgetReservation(
  db: PrismaClient,
  input: { spaceId: string; callId: string },
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const reservation = await lockReservation(tx, input.spaceId, input.callId);
    const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    if (!clock) throw new Error("Database clock query returned no rows");
    if (
      reservation?.status !== "reserved" ||
      reservation.executionState !== "not_started" ||
      reservation.expiresAt <= clock.now
    )
      return false;
    await tx.budgetReservation.update({
      where: { id: reservation.id },
      data: { executionState: "started", providerStartedAt: clock.now },
    });
    return true;
  });
}

async function closeReserved(
  db: PrismaClient,
  spaceId: string,
  callId: string,
  status: "released" | "expired",
  now: Date,
) {
  return db.$transaction(async (tx) => {
    const reservation = await lockReservation(tx, spaceId, callId);
    if (reservation?.status !== "reserved" || reservation.executionState !== "not_started")
      return false;
    if (status === "expired" && reservation.expiresAt > now) return false;
    await tx.projectBudget.update({
      where: { id: reservation.budgetId },
      data: { reservedMicroUsd: { decrement: reservation.amountMicroUsd } },
    });
    await tx.budgetReservation.update({
      where: { id: reservation.id },
      data: { status, closedAt: now },
    });
    await tx.budgetSpendLedger.create({
      data: {
        spaceId: reservation.spaceId,
        projectId: reservation.projectId,
        budgetId: reservation.budgetId,
        budgetVersion: reservation.budgetVersion,
        callId: reservation.callId,
        kind: status,
        amountMicroUsd: reservation.amountMicroUsd,
      },
    });
    return true;
  });
}

/** Release an unused reservation (the call never ran). No-op unless still reserved. */
export function releaseBudgetReservation(
  db: PrismaClient,
  input: { spaceId: string; callId: string; now?: Date },
): Promise<boolean> {
  return closeReserved(db, input.spaceId, input.callId, "released", input.now ?? new Date());
}

/**
 * Free reservations whose TTL passed without settlement. Expired rows stay settleable so a
 * slow call still records its real cost. Returns the number expired.
 */
export async function expireBudgetReservations(
  db: PrismaClient,
  input: { now?: Date; limit?: number } = {},
): Promise<number> {
  const now = input.now ?? new Date();
  const due = await db.budgetReservation.findMany({
    where: { status: "reserved", executionState: "not_started", expiresAt: { lte: now } },
    select: { spaceId: true, callId: true },
    orderBy: { expiresAt: "asc" },
    take: input.limit ?? 100,
  });
  let expired = 0;
  for (const { spaceId, callId } of due) {
    if (await closeReserved(db, spaceId, callId, "expired", now)) expired += 1;
  }
  return expired;
}

/** Concurrent first calls both miss the row; the loser hits P2002 and retries through the update path. */
export async function setProjectBudget(
  db: PrismaClient,
  input: Parameters<typeof setProjectBudgetOnce>[1],
) {
  try {
    return await setProjectBudgetOnce(db, input);
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error;
    return setProjectBudgetOnce(db, input);
  }
}

/** Close an unknown-cost holding through an audited write-off. */
export async function writeOffBudgetHolding(
  db: PrismaClient,
  input: { spaceId: string; callId: string; actorUserId: string; reason: string; now?: Date },
) {
  if (!input.actorUserId.trim() || !input.reason.trim()) {
    throw new Error("Write-off requires an actor and reason");
  }
  return db.$transaction(async (tx) => {
    await lockTicketSpace(tx, input.spaceId);
    const reservation = await lockReservation(tx, input.spaceId, input.callId);
    if (!reservation) {
      const open = await tx.budgetSpendLedger.findUnique({
        where: {
          spaceId_callId_kind: {
            spaceId: input.spaceId,
            callId: input.callId,
            kind: "open_at_deletion",
          },
        },
      });
      if (!open) return null;
      const closed = await tx.budgetSpendLedger.findMany({
        where: {
          spaceId: input.spaceId,
          callId: input.callId,
          kind: { in: ["settled_after_deletion", "written_off"] },
        },
      });
      const audit = open.auditData as { reservationId?: string } | null;
      const reservationId = audit?.reservationId ?? open.id;
      if (closed.length) return { reservationId, replayed: true };
      const inserted = await tx.budgetSpendLedger.createMany({
        skipDuplicates: true,
        data: [
          {
            spaceId: open.spaceId,
            projectId: open.projectId,
            budgetId: open.budgetId,
            budgetVersion: open.budgetVersion,
            callId: open.callId,
            kind: "written_off",
            amountMicroUsd: open.amountMicroUsd,
            auditData: {
              actorUserId: input.actorUserId,
              reason: input.reason.trim(),
              writtenOffAt: (input.now ?? new Date()).toISOString(),
            },
          },
        ],
      });
      return { reservationId, replayed: inserted.count === 0 };
    }
    if (reservation.status === "written_off")
      return { reservationId: reservation.id, replayed: true };
    if (reservation.status !== "unreconciled")
      throw new Error("Only unreconciled holdings may be written off");
    const now = input.now ?? new Date();
    await tx.projectBudget.update({
      where: { id: reservation.budgetId },
      data: { reservedMicroUsd: { decrement: reservation.amountMicroUsd } },
    });
    await tx.budgetReservation.update({
      where: { id: reservation.id },
      data: {
        status: "written_off",
        writtenOffAt: now,
        writtenOffBy: input.actorUserId,
        writeOffReason: input.reason.trim(),
        closedAt: now,
      },
    });
    return { reservationId: reservation.id, replayed: false };
  });
}
