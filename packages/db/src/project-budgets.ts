import type { Prisma, PrismaClient } from "./client.js";

/** All amounts are integer micro-USD (1 USD = 1_000_000) held as bigint. */
export const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1000;

export type BudgetReservationResult =
  | {
      ok: true;
      reservationId: string;
      budgetId: string;
      budgetVersion: number;
      amountMicroUsd: bigint;
      replayed: boolean;
    }
  | { ok: false; reason: "no_budget" | "insufficient"; availableMicroUsd: bigint };

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
  id: string;
  budgetId: string;
  amountMicroUsd: bigint;
  settledMicroUsd: bigint | null;
  overrunMicroUsd: bigint;
  status: string;
  settledLate: boolean;
}

function assertMicroUsd(value: bigint, label: string) {
  if (typeof value !== "bigint" || value < 0n) {
    throw new Error(`${label} must be a non-negative integer micro-USD bigint`);
  }
}

/** Create the budget or change its limit; every change bumps the version and is kept. */
export async function setProjectBudget(
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
 * limit - reserved - settled. Replaying the same callId returns the original reservation.
 */
export async function reserveBudget(
  db: PrismaClient,
  input: {
    spaceId: string;
    projectId: string;
    callId: string;
    amountMicroUsd: bigint;
    ttlMs?: number;
    now?: Date;
  },
): Promise<BudgetReservationResult> {
  assertMicroUsd(input.amountMicroUsd, "amountMicroUsd");
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? DEFAULT_RESERVATION_TTL_MS));
  return db.$transaction(async (tx): Promise<BudgetReservationResult> => {
    const rows = await tx.$queryRaw<BudgetRow[]>`
      SELECT * FROM "project_budgets"
      WHERE "spaceId" = ${input.spaceId} AND "projectId" = ${input.projectId}
      FOR UPDATE`;
    const budget = rows[0];
    if (!budget) return { ok: false, reason: "no_budget", availableMicroUsd: 0n };

    const prior = await tx.budgetReservation.findUnique({ where: { callId: input.callId } });
    if (prior) {
      if (prior.budgetId !== budget.id) throw new Error("callId already used for another budget");
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
    const created = await tx.budgetReservation.create({
      data: {
        budgetId: budget.id,
        spaceId: input.spaceId,
        projectId: input.projectId,
        budgetVersion: budget.version,
        callId: input.callId,
        amountMicroUsd: input.amountMicroUsd,
        expiresAt,
      },
    });
    return {
      ok: true,
      reservationId: created.id,
      budgetId: budget.id,
      budgetVersion: budget.version,
      amountMicroUsd: input.amountMicroUsd,
      replayed: false,
    };
  });
}

/** Lock order is reservation, then budget, everywhere both are taken. */
async function lockReservation(tx: Prisma.TransactionClient, callId: string) {
  const rows = await tx.$queryRaw<ReservationRow[]>`
    SELECT * FROM "budget_reservations" WHERE "callId" = ${callId} FOR UPDATE`;
  const reservation = rows[0];
  if (!reservation) return null;
  await tx.$queryRaw`SELECT 1 FROM "project_budgets" WHERE "id" = ${reservation.budgetId} FOR UPDATE`;
  return reservation;
}

/**
 * Settle actual spend, idempotent by callId. Actual cost is always recorded, even above the
 * reservation (the excess is `overrunMicroUsd`) or after the reservation expired (`settledLate`).
 * A released reservation cannot be settled: the call never ran, so return null.
 */
export async function settleBudget(
  db: PrismaClient,
  input: { callId: string; actualMicroUsd: bigint; now?: Date },
): Promise<BudgetSettlement | null> {
  assertMicroUsd(input.actualMicroUsd, "actualMicroUsd");
  const now = input.now ?? new Date();
  return db.$transaction(async (tx): Promise<BudgetSettlement | null> => {
    const reservation = await lockReservation(tx, input.callId);
    if (!reservation || reservation.status === "released") return null;
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
    const late = reservation.status === "expired";
    const overrun =
      input.actualMicroUsd > reservation.amountMicroUsd
        ? input.actualMicroUsd - reservation.amountMicroUsd
        : 0n;
    // An expired reservation was already subtracted from reservedMicroUsd.
    await tx.projectBudget.update({
      where: { id: reservation.budgetId },
      data: {
        reservedMicroUsd: late ? undefined : { decrement: reservation.amountMicroUsd },
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
        closedAt: now,
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
  });
}

async function closeReserved(
  db: PrismaClient,
  callId: string,
  status: "released" | "expired",
  now: Date,
) {
  return db.$transaction(async (tx) => {
    const reservation = await lockReservation(tx, callId);
    if (reservation?.status !== "reserved") return false;
    await tx.projectBudget.update({
      where: { id: reservation.budgetId },
      data: { reservedMicroUsd: { decrement: reservation.amountMicroUsd } },
    });
    await tx.budgetReservation.update({
      where: { id: reservation.id },
      data: { status, closedAt: now },
    });
    return true;
  });
}

/** Release an unused reservation (the call never ran). No-op unless still reserved. */
export function releaseBudgetReservation(
  db: PrismaClient,
  input: { callId: string; now?: Date },
): Promise<boolean> {
  return closeReserved(db, input.callId, "released", input.now ?? new Date());
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
    where: { status: "reserved", expiresAt: { lte: now } },
    select: { callId: true },
    orderBy: { expiresAt: "asc" },
    take: input.limit ?? 100,
  });
  let expired = 0;
  for (const { callId } of due) {
    if (await closeReserved(db, callId, "expired", now)) expired += 1;
  }
  return expired;
}
