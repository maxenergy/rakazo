import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  BudgetCallIdConflictError,
  expireBudgetReservations,
  releaseBudgetReservation,
  reserveBudget,
  setProjectBudget,
  settleBudget,
  writeOffBudgetHolding,
} from "./project-budgets.js";
import { getProjectCostSummaries } from "./project-costs.js";
import { recordUsage, UsageReplayConflictError } from "./usage.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("project budget reservations", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  const organizationId = `budget-test-${crypto.randomUUID()}`;
  let spaceId: string;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Budget tests",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    spaceId = (
      await prisma.space.create({
        data: {
          id: `budget-space-${crypto.randomUUID()}`,
          organizationId,
          name: "Budget tests",
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    } finally {
      await close();
    }
  });

  async function budgetFor(limitMicroUsd: bigint) {
    const project = await prisma.project.create({ data: { spaceId, name: "Budget fixture" } });
    await setProjectBudget(prisma, { spaceId, projectId: project.id, limitMicroUsd });
    return project.id;
  }

  const state = (projectId: string) =>
    prisma.projectBudget.findUniqueOrThrow({
      where: { spaceId_projectId: { spaceId, projectId } },
    });

  it("never oversubscribes under concurrent reservations", async () => {
    const projectId = await budgetFor(1_000_000n);
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        reserveBudget(prisma, {
          spaceId,
          projectId,
          callId: `race-${projectId}-${i}`,
          amountMicroUsd: 100_000n,
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect(results.filter((r) => !r.ok && r.reason === "insufficient")).toHaveLength(20);
    expect((await state(projectId)).reservedMicroUsd).toBe(1_000_000n);
  });

  it("returns the original reservation when a callId is replayed concurrently", async () => {
    const projectId = await budgetFor(1_000_000n);
    const callId = `replay-${projectId}`;
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 400_000n }),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(results.map((r) => r.ok && r.reservationId)).size).toBe(1);
    expect(results.filter((r) => r.ok && !r.replayed)).toHaveLength(1);
    expect((await state(projectId)).reservedMicroUsd).toBe(400_000n);
  });

  it("rejects reservations when no budget exists", async () => {
    const project = await prisma.project.create({ data: { spaceId, name: "No budget" } });
    const result = await reserveBudget(prisma, {
      spaceId,
      projectId: project.id,
      callId: `none-${project.id}`,
      amountMicroUsd: 1n,
    });
    expect(result).toMatchObject({ ok: false, reason: "no_budget" });
  });

  it("settles idempotently and counts concurrent settlements once", async () => {
    const projectId = await budgetFor(1_000_000n);
    const callId = `settle-${projectId}`;
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 500_000n });
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        settleBudget(prisma, { spaceId, callId, actualMicroUsd: 300_000n }),
      ),
    );
    expect(results.filter((r) => r && !r.replayed)).toHaveLength(1);
    const after = await state(projectId);
    expect(after.reservedMicroUsd).toBe(0n);
    expect(after.settledMicroUsd).toBe(300_000n);
    await settleBudget(prisma, { spaceId, callId, actualMicroUsd: 900_000n });
    expect((await state(projectId)).settledMicroUsd).toBe(300_000n);
  });

  it("records actual spend above the reservation as overrun", async () => {
    const projectId = await budgetFor(1_000_000n);
    const callId = `overrun-${projectId}`;
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 200_000n });
    const settled = await settleBudget(prisma, { spaceId, callId, actualMicroUsd: 350_000n });
    expect(settled).toMatchObject({ overrunMicroUsd: 150_000n, settledMicroUsd: 350_000n });
    expect((await state(projectId)).settledMicroUsd).toBe(350_000n);
  });

  it("releases once and settles a late charge exactly once", async () => {
    const projectId = await budgetFor(1_000_000n);
    const callId = `release-${projectId}`;
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 600_000n });
    const released = await Promise.all([
      releaseBudgetReservation(prisma, { spaceId, callId }),
      releaseBudgetReservation(prisma, { spaceId, callId }),
    ]);
    expect(released.filter(Boolean)).toHaveLength(1);
    expect((await state(projectId)).reservedMicroUsd).toBe(0n);
    expect(await settleBudget(prisma, { spaceId, callId, actualMicroUsd: 1n })).toMatchObject({
      settledMicroUsd: 1n,
      settledLate: true,
      replayed: false,
    });
    expect(await settleBudget(prisma, { spaceId, callId, actualMicroUsd: 1n })).toMatchObject({
      settledMicroUsd: 1n,
      replayed: true,
    });
    expect(await state(projectId)).toMatchObject({ reservedMicroUsd: 0n, settledMicroUsd: 1n });
    expect(
      await prisma.budgetReservation.findUniqueOrThrow({
        where: { spaceId_callId: { spaceId, callId } },
      }),
    ).toMatchObject({ chargedAfterRelease: true, status: "settled" });
  });

  it("expires stale reservations and still records a late settlement", async () => {
    const projectId = await budgetFor(1_000_000n);
    const callId = `expire-${projectId}`;
    const start = new Date("2026-01-01T00:00:00Z");
    await reserveBudget(prisma, {
      spaceId,
      projectId,
      callId,
      amountMicroUsd: 700_000n,
      ttlMs: 1000,
      now: start,
    });
    const later = new Date(start.getTime() + 5000);
    const counts = await Promise.all([
      expireBudgetReservations(prisma, { now: later }),
      expireBudgetReservations(prisma, { now: later }),
    ]);
    expect(counts[0] + counts[1]).toBe(1);
    expect((await state(projectId)).reservedMicroUsd).toBe(0n);
    const settled = await settleBudget(prisma, {
      spaceId,
      callId,
      actualMicroUsd: 250_000n,
      now: later,
    });
    expect(settled).toMatchObject({ settledLate: true, settledMicroUsd: 250_000n });
    const after = await state(projectId);
    expect(after.reservedMicroUsd).toBe(0n);
    expect(after.settledMicroUsd).toBe(250_000n);
  });

  it("does not revive a closed reservation when its callId is retried", async () => {
    const projectId = await budgetFor(1_000_000n);
    const retry = (callId: string) =>
      reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 100_000n });
    const start = new Date("2026-01-01T00:00:00Z");

    const settledId = `retry-settled-${projectId}`;
    await retry(settledId);
    await settleBudget(prisma, { spaceId, callId: settledId, actualMicroUsd: 40_000n });

    const releasedId = `retry-released-${projectId}`;
    await retry(releasedId);
    await releaseBudgetReservation(prisma, { spaceId, callId: releasedId });

    const expiredId = `retry-expired-${projectId}`;
    await reserveBudget(prisma, {
      spaceId,
      projectId,
      callId: expiredId,
      amountMicroUsd: 100_000n,
      ttlMs: 1000,
      now: start,
    });
    await expireBudgetReservations(prisma, { now: new Date(start.getTime() + 5000) });

    for (const [callId, status] of [
      [settledId, "settled"],
      [releasedId, "released"],
      [expiredId, "expired"],
    ] as const) {
      expect(await retry(callId)).toMatchObject({
        ok: false,
        reason: "reservation_closed",
        status,
      });
    }
    const after = await state(projectId);
    expect(after.reservedMicroUsd).toBe(0n);
    expect(after.settledMicroUsd).toBe(40_000n);
  });

  it("throws on a replayed callId with a different amount and keeps the reservation", async () => {
    const projectId = await budgetFor(1_000_000n);
    const callId = `amount-${projectId}`;
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 100_000n });
    await expect(
      reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 200_000n }),
    ).rejects.toBeInstanceOf(BudgetCallIdConflictError);
    expect((await state(projectId)).reservedMicroUsd).toBe(100_000n);
    const stored = await prisma.budgetReservation.findUnique({
      where: { spaceId_callId: { spaceId, callId } },
    });
    expect(stored).toMatchObject({ amountMicroUsd: 100_000n, status: "reserved" });
  });

  it("throws on a replayed callId for another project and keeps both budgets unchanged", async () => {
    const a = await budgetFor(1_000_000n);
    const b = await budgetFor(1_000_000n);
    const callId = `scope-${a}`;
    await reserveBudget(prisma, { spaceId, projectId: a, callId, amountMicroUsd: 100_000n });
    await expect(
      reserveBudget(prisma, { spaceId, projectId: b, callId, amountMicroUsd: 100_000n }),
    ).rejects.toBeInstanceOf(BudgetCallIdConflictError);
    expect((await state(a)).reservedMicroUsd).toBe(100_000n);
    expect((await state(b)).reservedMicroUsd).toBe(0n);
    const stored = await prisma.budgetReservation.findUnique({
      where: { spaceId_callId: { spaceId, callId } },
    });
    expect(stored).toMatchObject({ amountMicroUsd: 100_000n, status: "reserved" });
  });

  it("lets only one budget win a concurrent callId collision", async () => {
    const a = await budgetFor(1_000_000n);
    const b = await budgetFor(1_000_000n);
    const callId = `collide-${a}`;
    const results = await Promise.allSettled(
      [a, b, a, b].map((projectId) =>
        reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 100_000n }),
      ),
    );
    const budgetIds = new Set<string>();
    let rejected = 0;
    for (const r of results) {
      if (r.status === "rejected") {
        rejected += 1;
        expect(String(r.reason)).toMatch(/another budget/);
      } else if (r.value.ok) {
        budgetIds.add(r.value.budgetId);
      }
    }
    expect(budgetIds.size).toBe(1);
    expect(rejected).toBeGreaterThanOrEqual(1);
    const reserved = (await state(a)).reservedMicroUsd + (await state(b)).reservedMicroUsd;
    expect(reserved).toBe(100_000n);
  });

  it("keeps a version history when the limit changes", async () => {
    const projectId = await budgetFor(100n);
    const updated = await setProjectBudget(prisma, { spaceId, projectId, limitMicroUsd: 200n });
    expect(updated.version).toBe(2);
    const versions = await prisma.projectBudgetVersion.findMany({
      where: { budgetId: updated.id },
      orderBy: { version: "asc" },
    });
    expect(versions.map((v) => v.limitMicroUsd)).toEqual([100n, 200n]);
  });

  it("scopes callIds to their space", async () => {
    const otherSpaceId = (
      await prisma.space.create({
        data: { id: `budget-space-${crypto.randomUUID()}`, organizationId, name: "Other space" },
      })
    ).id;
    const projectA = await budgetFor(1_000_000n);
    const projectB = (
      await prisma.project.create({ data: { spaceId: otherSpaceId, name: "Other" } })
    ).id;
    await setProjectBudget(prisma, {
      spaceId: otherSpaceId,
      projectId: projectB,
      limitMicroUsd: 1_000_000n,
    });
    const stateB = () =>
      prisma.projectBudget.findUniqueOrThrow({
        where: { spaceId_projectId: { spaceId: otherSpaceId, projectId: projectB } },
      });
    const callId = `shared-${projectA}`;

    const a = await reserveBudget(prisma, {
      spaceId,
      projectId: projectA,
      callId,
      amountMicroUsd: 100_000n,
    });
    expect(a).toMatchObject({ ok: true, replayed: false });

    // Another space cannot see, settle or release this call.
    expect(
      await settleBudget(prisma, { spaceId: otherSpaceId, callId, actualMicroUsd: 1n }),
    ).toBeNull();
    expect(await releaseBudgetReservation(prisma, { spaceId: otherSpaceId, callId })).toBe(false);
    expect((await state(projectA)).reservedMicroUsd).toBe(100_000n);

    // The same callId in another space is an independent reservation.
    const b = await reserveBudget(prisma, {
      spaceId: otherSpaceId,
      projectId: projectB,
      callId,
      amountMicroUsd: 200_000n,
    });
    expect(b).toMatchObject({ ok: true, replayed: false, amountMicroUsd: 200_000n });
    expect(a.ok && b.ok && a.reservationId !== b.reservationId).toBe(true);
    expect((await stateB()).reservedMicroUsd).toBe(200_000n);

    await settleBudget(prisma, { spaceId, callId, actualMicroUsd: 70_000n });
    expect((await state(projectA)).settledMicroUsd).toBe(70_000n);
    expect((await stateB()).reservedMicroUsd).toBe(200_000n);

    expect(await releaseBudgetReservation(prisma, { spaceId: otherSpaceId, callId })).toBe(true);
    expect((await stateB()).reservedMicroUsd).toBe(0n);
    expect((await state(projectA)).settledMicroUsd).toBe(70_000n);
  });

  it("treats a never-reserved callId like a wrong-space callId", async () => {
    const otherSpaceId = (
      await prisma.space.create({
        data: { id: `budget-space-${crypto.randomUUID()}`, organizationId, name: "Other space" },
      })
    ).id;
    const projectA = await budgetFor(1_000_000n);
    const projectB = (
      await prisma.project.create({ data: { spaceId: otherSpaceId, name: "Other" } })
    ).id;
    await setProjectBudget(prisma, {
      spaceId: otherSpaceId,
      projectId: projectB,
      limitMicroUsd: 1_000_000n,
    });
    const stateB = () =>
      prisma.projectBudget.findUniqueOrThrow({
        where: { spaceId_projectId: { spaceId: otherSpaceId, projectId: projectB } },
      });
    const reserved = await reserveBudget(prisma, {
      spaceId,
      projectId: projectA,
      callId: `reserved-${projectA}`,
      amountMicroUsd: 100_000n,
    });
    expect(reserved).toMatchObject({ ok: true, replayed: false });
    const beforeA = await state(projectA);
    const beforeB = await stateB();
    const callId = `never-reserved-${projectA}`;

    for (const id of [spaceId, otherSpaceId]) {
      expect(await settleBudget(prisma, { spaceId: id, callId, actualMicroUsd: 1n })).toBeNull();
      expect(await releaseBudgetReservation(prisma, { spaceId: id, callId })).toBe(false);
    }

    const afterA = await state(projectA);
    const afterB = await stateB();
    expect(afterA.reservedMicroUsd).toBe(beforeA.reservedMicroUsd);
    expect(afterA.settledMicroUsd).toBe(beforeA.settledMicroUsd);
    expect(afterB.reservedMicroUsd).toBe(beforeB.reservedMicroUsd);
    expect(afterB.settledMicroUsd).toBe(beforeB.settledMicroUsd);
  });

  it("replays an active reservation with the same amount without changing state", async () => {
    const projectId = await budgetFor(1_000_000n);
    const callId = `active-${projectId}`;
    const input = { spaceId, projectId, callId, amountMicroUsd: 100_000n };
    const first = await reserveBudget(prisma, input);
    const again = await reserveBudget(prisma, input);
    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect((await state(projectId)).reservedMicroUsd).toBe(100_000n);
  });

  it("rejects non-positive reservation amounts", async () => {
    const projectId = await budgetFor(1_000_000n);
    for (const amountMicroUsd of [0n, -1n]) {
      await expect(
        reserveBudget(prisma, {
          spaceId,
          projectId,
          callId: `bad-${amountMicroUsd}-${projectId}`,
          amountMicroUsd,
        }),
      ).rejects.toThrow(/amountMicroUsd/);
    }
    expect((await state(projectId)).reservedMicroUsd).toBe(0n);
  });

  it("handles concurrent first setProjectBudget calls with one budget row", async () => {
    const project = await prisma.project.create({ data: { spaceId, name: "First set race" } });
    const results = await Promise.all([
      setProjectBudget(prisma, { spaceId, projectId: project.id, limitMicroUsd: 100n }),
      setProjectBudget(prisma, { spaceId, projectId: project.id, limitMicroUsd: 200n }),
    ]);
    expect(results).toHaveLength(2);
    const rows = await prisma.projectBudget.findMany({ where: { spaceId, projectId: project.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(2);
  });

  it("restores a released holding once and settles concurrent known usage once", async () => {
    const projectId = await budgetFor(1_000_000n);
    const callId = `usage-recovery-${projectId}`;
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 600_000n });
    await releaseBudgetReservation(prisma, { spaceId, callId });
    const attribution = { spaceId, projectId, userId: `fixture-${projectId}` };
    const event = {
      type: "usage" as const,
      provider: "fixture",
      model: "fixture",
      callId,
      inputTokens: 10,
      outputTokens: 2,
      billingKind: "api" as const,
    };
    await Promise.all(Array.from({ length: 6 }, () => recordUsage(prisma, event, attribution)));
    expect(await state(projectId)).toMatchObject({
      reservedMicroUsd: 600_000n,
      settledMicroUsd: 0n,
    });
    expect(
      await prisma.budgetReservation.findUniqueOrThrow({
        where: { spaceId_callId: { spaceId, callId } },
      }),
    ).toMatchObject({ status: "unreconciled", chargedAfterRelease: true });
    const known = { ...event, costUsdDecimal: "0.25", costSource: "provider_reported" };
    await Promise.all(Array.from({ length: 6 }, () => recordUsage(prisma, known, attribution)));
    expect(await state(projectId)).toMatchObject({
      reservedMicroUsd: 0n,
      settledMicroUsd: 250_000n,
    });
    expect(await prisma.usageRecord.count({ where: { spaceId, callId } })).toBe(1);
    expect(
      await prisma.budgetReservation.findUniqueOrThrow({
        where: { spaceId_callId: { spaceId, callId } },
      }),
    ).toMatchObject({ status: "settled", chargedAfterRelease: true, settledMicroUsd: 250_000n });
  });

  it("preserves write-off audit and settles concurrent late usage once", async () => {
    const projectId = await budgetFor(1_000_000n);
    const callId = `writeoff-usage-${projectId}`;
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 100_000n });
    const attribution = { spaceId, projectId, userId: `fixture-${projectId}` };
    const event = {
      type: "usage" as const,
      provider: "fixture",
      model: "fixture",
      callId,
      inputTokens: 10,
      outputTokens: 2,
      billingKind: "api" as const,
    };
    await recordUsage(prisma, event, attribution);
    const writeOff = {
      spaceId,
      callId,
      actorUserId: "fixture-auditor",
      reason: " unresolved provider charge ",
    };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => writeOffBudgetHolding(prisma, writeOff)),
    );
    expect(results.filter((result) => result && !result.replayed)).toHaveLength(1);
    expect(await state(projectId)).toMatchObject({ reservedMicroUsd: 0n, settledMicroUsd: 0n });
    await recordUsage(prisma, event, attribution);
    expect(await state(projectId)).toMatchObject({ reservedMicroUsd: 0n, settledMicroUsd: 0n });
    const known = { ...event, costUsdDecimal: "0.125", costSource: "provider_reported" };
    await Promise.all(Array.from({ length: 6 }, () => recordUsage(prisma, known, attribution)));
    expect(await state(projectId)).toMatchObject({
      reservedMicroUsd: 0n,
      settledMicroUsd: 125_000n,
    });
    expect(await prisma.usageRecord.count({ where: { spaceId, callId } })).toBe(1);
    expect(
      await prisma.budgetReservation.findUniqueOrThrow({
        where: { spaceId_callId: { spaceId, callId } },
      }),
    ).toMatchObject({
      status: "settled",
      writtenOffBy: "fixture-auditor",
      writeOffReason: "unresolved provider charge",
      writtenOffAt: expect.any(Date),
      chargedAfterWriteOff: true,
      settledMicroUsd: 125_000n,
      overrunMicroUsd: 25_000n,
    });
  });

  it("rolls back caller transactions and rejects conflicting usage without balance changes", async () => {
    const projectId = await budgetFor(1_000_000n);
    const callId = `usage-rollback-${projectId}`;
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 600_000n });
    const attribution = { spaceId, projectId, userId: `fixture-${projectId}` };
    const event = {
      type: "usage" as const,
      provider: "fixture",
      model: "fixture",
      callId,
      inputTokens: 10,
      outputTokens: 2,
      billingKind: "api" as const,
      costUsdDecimal: "0.25",
      costSource: "provider_reported",
    };
    await expect(
      prisma.$transaction(async (tx) => {
        await recordUsage(prisma, event, attribution, { tx });
        throw new Error("rollback-fixture");
      }),
    ).rejects.toThrow("rollback-fixture");
    expect(await prisma.usageRecord.count({ where: { spaceId, callId } })).toBe(0);
    expect(await state(projectId)).toMatchObject({
      reservedMicroUsd: 600_000n,
      settledMicroUsd: 0n,
    });
    await recordUsage(prisma, event, attribution);
    const original = await prisma.usageRecord.findUniqueOrThrow({
      where: { spaceId_callId: { spaceId, callId } },
    });
    await expect(
      recordUsage(prisma, { ...event, costUsdDecimal: "0.30" }, attribution),
    ).rejects.toBeInstanceOf(UsageReplayConflictError);
    await expect(
      recordUsage(prisma, event, { ...attribution, projectId: null }),
    ).rejects.toBeInstanceOf(UsageReplayConflictError);
    expect(
      await prisma.usageRecord.findUniqueOrThrow({
        where: { spaceId_callId: { spaceId, callId } },
      }),
    ).toEqual(original);
    expect(await state(projectId)).toMatchObject({
      reservedMicroUsd: 0n,
      settledMicroUsd: 250_000n,
    });
  });

  it("reports deduplicated totals, unknown calls and holding age", async () => {
    const projectId = await budgetFor(1_000_000n);
    const attribution = { spaceId, projectId, userId: `summary-${projectId}` };
    const event = {
      type: "usage" as const,
      provider: "fixture",
      model: "fixture",
      inputTokens: 10,
      outputTokens: 2,
      billingKind: "api" as const,
    };
    const callId = `summary-unknown-${projectId}`;
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 600_000n });
    await recordUsage(prisma, { ...event, callId }, attribution);
    const since = new Date("2026-10-01T00:00:00Z");
    await prisma.budgetReservation.update({
      where: { spaceId_callId: { spaceId, callId } },
      data: { unreconciledAt: since },
    });
    const known = {
      ...event,
      callId: `summary-known-${projectId}`,
      costUsdDecimal: "0.25",
      costSource: "provider_reported",
    };
    await recordUsage(prisma, known, attribution);
    await recordUsage(prisma, known, attribution);
    await recordUsage(
      prisma,
      {
        ...event,
        callId: `summary-subscription-${projectId}`,
        billingKind: "subscription_included" as const,
      },
      attribution,
    );
    const summaries = await prisma.$transaction((tx) => getProjectCostSummaries(tx, spaceId));
    expect(summaries.find((row) => row.projectId === projectId)).toMatchObject({
      knownMarginalMicroUsd: "250000",
      unknownCostCalls: 1,
      subscriptionIncludedCalls: 1,
      unreconciledMicroUsd: "600000",
      oldestHoldingAt: since,
      complete: false,
    });
    expect(summaries.some((row) => row.projectId === null)).toBe(true);
  });

  it("converges first delivery, reserve and replay without duplicate settlement", async () => {
    for (const order of ["usage-first", "reserve-first", "concurrent"]) {
      const projectId = await budgetFor(1_000_000n);
      const callId = `first-delivery-${order}-${projectId}`;
      const attribution = { spaceId, projectId, userId: `first-${projectId}` };
      const event = {
        type: "usage" as const,
        provider: "fixture",
        model: "fixture",
        inputTokens: 10,
        outputTokens: 2,
        billingKind: "api" as const,
        callId,
        costUsdDecimal: "0.25",
        costSource: "provider_reported",
      };
      const reserve = () =>
        reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 600_000n });
      const deliver = () => recordUsage(prisma, event, attribution);
      if (order === "usage-first") {
        await deliver();
        await reserve();
      } else if (order === "reserve-first") {
        await reserve();
        await deliver();
      } else await Promise.all([reserve(), deliver(), deliver()]);
      await Promise.all([deliver(), deliver(), reserve()]);
      expect(await prisma.usageRecord.count({ where: { spaceId, callId } })).toBe(1);
      expect(await state(projectId)).toMatchObject({
        reservedMicroUsd: 0n,
        settledMicroUsd: 250_000n,
      });
      expect(
        await prisma.budgetReservation.findUniqueOrThrow({
          where: { spaceId_callId: { spaceId, callId } },
        }),
      ).toMatchObject({ status: "settled", settledMicroUsd: 250_000n });
    }
  });

  it("retains one unknown holding when delivery races expiry", async () => {
    const projectId = await budgetFor(1_000_000n);
    const callId = `expiry-race-${projectId}`;
    const now = new Date();
    await reserveBudget(prisma, {
      spaceId,
      projectId,
      callId,
      amountMicroUsd: 600_000n,
      ttlMs: 1,
      now: new Date(now.getTime() - 1000),
    });
    const attribution = { spaceId, projectId, userId: `expiry-${projectId}` };
    const event = {
      type: "usage" as const,
      provider: "fixture",
      model: "fixture",
      callId,
      inputTokens: 10,
      outputTokens: 2,
      billingKind: "api" as const,
    };
    await Promise.all([
      expireBudgetReservations(prisma, { now }),
      recordUsage(prisma, event, attribution),
    ]);
    await recordUsage(prisma, event, attribution);
    await expireBudgetReservations(prisma, { now: new Date(now.getTime() + 1000) });
    expect(await state(projectId)).toMatchObject({
      reservedMicroUsd: 600_000n,
      settledMicroUsd: 0n,
    });
    expect(
      await prisma.budgetReservation.findUniqueOrThrow({
        where: { spaceId_callId: { spaceId, callId } },
      }),
    ).toMatchObject({ status: "unreconciled", amountMicroUsd: 600_000n });
    expect(await prisma.usageRecord.count({ where: { spaceId, callId } })).toBe(1);
  });

  it("restores exposure above limit and blocks ordinary reservations", async () => {
    const projectId = await budgetFor(1_000_000n);
    const callId = `overlimit-recovery-${projectId}`;
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 600_000n });
    await releaseBudgetReservation(prisma, { spaceId, callId });
    await setProjectBudget(prisma, { spaceId, projectId, limitMicroUsd: 100_000n });
    const attribution = { spaceId, projectId, userId: `overlimit-${projectId}` };
    const event = {
      type: "usage" as const,
      provider: "fixture",
      model: "fixture",
      callId,
      inputTokens: 10,
      outputTokens: 2,
      billingKind: "api" as const,
    };
    await Promise.all(Array.from({ length: 4 }, () => recordUsage(prisma, event, attribution)));
    expect(await state(projectId)).toMatchObject({
      limitMicroUsd: 100_000n,
      reservedMicroUsd: 600_000n,
      settledMicroUsd: 0n,
    });
    expect(
      await reserveBudget(prisma, {
        spaceId,
        projectId,
        callId: `blocked-${projectId}`,
        amountMicroUsd: 1n,
      }),
    ).toMatchObject({ ok: false, reason: "insufficient" });
    expect(
      await prisma.budgetReservation.findUniqueOrThrow({
        where: { spaceId_callId: { spaceId, callId } },
      }),
    ).toMatchObject({ status: "unreconciled", chargedAfterRelease: true });
    await recordUsage(
      prisma,
      { ...event, costUsdDecimal: "0.7", costSource: "provider_reported" },
      attribution,
    );
    expect(await state(projectId)).toMatchObject({
      reservedMicroUsd: 0n,
      settledMicroUsd: 700_000n,
    });
  });
});
