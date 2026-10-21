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
  startBudgetReservation,
  writeOffBudgetHolding,
} from "./project-budgets.js";
import { getProjectCostSummaries } from "./project-costs.js";
import { archiveProject, deleteProject } from "./project-links.js";
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
      // Explicit cleanup of synthetic accounting fixtures in the disposable test database.
      const fixtureSpaces = await prisma.space.findMany({
        where: { organizationId },
        select: { id: true },
      });
      const fixtureSpaceIds = fixtureSpaces.map((space) => space.id);
      await prisma.projectBudget.deleteMany({ where: { spaceId: { in: fixtureSpaceIds } } });
      await prisma.budgetSpendLedger.deleteMany({ where: { spaceId: { in: fixtureSpaceIds } } });
      await prisma.budgetApprovalDeletionAudit.deleteMany({
        where: { spaceId: { in: fixtureSpaceIds } },
      });
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

  const ledger = (callId: string) =>
    prisma.budgetSpendLedger.findMany({ where: { spaceId, callId }, orderBy: { kind: "asc" } });

  for (const closure of ["expiry", "write-off"] as const) {
    it(`settles a late call against its original project after reassignment and ${closure}`, async () => {
      const projectA = await budgetFor(1_000_000n);
      const projectB = await budgetFor(1_000_000n);
      const userId = `reassignment-${projectA}`;
      const bot = await prisma.bot.create({
        data: { spaceId, userId, name: "Synthetic reassignment fixture", color: "blue" },
      });
      const thread = await prisma.thread.create({ data: { spaceId, userId, botId: bot.id } });
      const task = await prisma.task.create({
        data: {
          spaceId,
          userId,
          botId: bot.id,
          threadId: thread.id,
          prompt: "fixture",
          status: "running",
        },
      });
      const run = await prisma.run.create({
        data: {
          spaceId,
          userId,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          projectId: projectA,
          status: "running",
          trigger: "manual",
        },
      });
      const callId = `late-reassignment-${run.id}`;
      const now = new Date();
      expect(
        (
          await reserveBudget(prisma, {
            spaceId,
            projectId: projectA,
            callId,
            amountMicroUsd: 600_000n,
            now,
            ttlMs: 1_000,
          })
        ).ok,
      ).toBe(true);
      await prisma.run.update({ where: { id: run.id }, data: { projectId: projectB } });
      const bBefore = await state(projectB);
      const bLedgerBefore = await prisma.budgetSpendLedger.findMany({
        where: { spaceId, projectId: projectB },
      });
      if (closure === "expiry") {
        await expireBudgetReservations(prisma, { now: new Date(now.getTime() + 2_000) });
      } else {
        expect(await startBudgetReservation(prisma, { spaceId, callId })).toBe(true);
        await recordUsage(
          prisma,
          {
            type: "usage",
            provider: "fixture",
            model: "fixture",
            callId,
            inputTokens: 10,
            outputTokens: 2,
            billingKind: "api",
          },
          { spaceId, projectId: projectA, userId },
        );
        await writeOffBudgetHolding(prisma, {
          spaceId,
          callId,
          actorUserId: userId,
          reason: "Synthetic test reconciliation",
        });
      }
      const settlement = { spaceId, callId, actualMicroUsd: 125_000n };
      await Promise.all([settleBudget(prisma, settlement), settleBudget(prisma, settlement)]);
      const first = await ledger(callId);
      await settleBudget(prisma, settlement);
      expect(await ledger(callId)).toEqual(first);
      expect(first.length).toBeGreaterThan(0);
      expect(first.every((entry) => entry.projectId === projectA)).toBe(true);
      expect((await state(projectA)).settledMicroUsd).toBe(125_000n);
      expect((await state(projectA)).reservedMicroUsd).toBe(0n);
      expect(await state(projectB)).toEqual(bBefore);
      expect(
        await prisma.budgetSpendLedger.findMany({ where: { spaceId, projectId: projectB } }),
      ).toEqual(bLedgerBefore);
      expect((await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).projectId).toBe(
        projectB,
      );
    });
  }

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
    const rows = await ledger(callId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId,
      kind: "settled",
      amountMicroUsd: 300_000n,
      overrunMicroUsd: 0n,
    });
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
    const rows = await ledger(callId);
    expect(rows.map((r) => r.kind)).toEqual(["released", "settled"]);
    expect(rows.find((r) => r.kind === "released")!.amountMicroUsd).toBe(600_000n);
    expect(rows.find((r) => r.kind === "settled")!.amountMicroUsd).toBe(1n);
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
    const rows = await ledger(callId);
    expect(rows.map((r) => r.kind)).toEqual(["expired", "settled"]);
    expect(rows[0]!.amountMicroUsd).toBe(700_000n);
    expect(rows[1]!.amountMicroUsd).toBe(250_000n);
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

  it.each(["released", "expired"] as const)(
    "restores a %s holding once and preserves settlement on unknown replay",
    async (origin) => {
      const projectId = await budgetFor(1_000_000n);
      const callId = `usage-recovery-${projectId}`;
      await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 600_000n });
      if (origin === "released") {
        await releaseBudgetReservation(prisma, { spaceId, callId });
      } else {
        await prisma.budgetReservation.update({
          where: { spaceId_callId: { spaceId, callId } },
          data: { expiresAt: new Date(0) },
        });
        await expireBudgetReservations(prisma, { now: new Date() });
      }
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
      ).toMatchObject({ status: "unreconciled", chargedAfterRelease: origin === "released" });
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
      ).toMatchObject({
        status: "settled",
        chargedAfterRelease: origin === "released",
        settledMicroUsd: 250_000n,
      });
      const beforeReplay = await prisma.usageRecord.findUniqueOrThrow({
        where: { spaceId_callId: { spaceId, callId } },
      });
      const summariesBefore = await getProjectCostSummaries(prisma, spaceId);
      await Promise.all(Array.from({ length: 6 }, () => recordUsage(prisma, event, attribution)));
      expect(
        await prisma.usageRecord.findUniqueOrThrow({
          where: { spaceId_callId: { spaceId, callId } },
        }),
      ).toEqual(beforeReplay);
      expect(await state(projectId)).toMatchObject({
        reservedMicroUsd: 0n,
        settledMicroUsd: 250_000n,
      });
      const summariesAfter = await getProjectCostSummaries(prisma, spaceId);
      expect(summariesAfter.find((row) => row.projectId === projectId)).toEqual(
        summariesBefore.find((row) => row.projectId === projectId),
      );
    },
  );

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

  it("preserves one winning charge across concurrent conflicting deliveries", async () => {
    const projectId = await budgetFor(1_000_000n);
    const callId = `concurrent-conflict-${projectId}`;
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 600_000n });
    const attribution = { spaceId, projectId, userId: `conflict-${projectId}` };
    const event = {
      type: "usage" as const,
      provider: "fixture",
      model: "fixture",
      callId,
      inputTokens: 10,
      outputTokens: 2,
      billingKind: "api" as const,
      costSource: "provider_reported",
    };
    const amounts = ["0.25", "0.30"];
    const deliveries = await Promise.allSettled(
      amounts.map((costUsdDecimal) =>
        recordUsage(prisma, { ...event, costUsdDecimal }, attribution),
      ),
    );
    expect(deliveries.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = deliveries.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    for (const result of rejected) {
      if (result.status === "rejected")
        expect(result.reason).toBeInstanceOf(UsageReplayConflictError);
    }
    const original = await prisma.usageRecord.findUniqueOrThrow({
      where: { spaceId_callId: { spaceId, callId } },
    });
    expect([250_000n, 300_000n]).toContain(original.costMicroUsd);
    const winningAmount = original.costMicroUsd === 250_000n ? "0.25" : "0.30";
    const conflicts = [
      { provider: "other-provider" },
      { model: "other-model" },
      { billingKind: "unknown" as const },
      { costUsdDecimal: winningAmount === "0.25" ? "0.30" : "0.25" },
    ];
    const replays = await Promise.allSettled([
      ...[
        { runId: `conflicting-run-${projectId}` },
        { parentRunId: `conflicting-parent-${projectId}` },
        { rootRunId: `conflicting-root-${projectId}` },
      ].map((change) =>
        recordUsage(
          prisma,
          { ...event, costUsdDecimal: winningAmount },
          { ...attribution, ...change },
        ),
      ),
      ...conflicts.map((change) =>
        recordUsage(prisma, { ...event, costUsdDecimal: winningAmount, ...change }, attribution),
      ),
      recordUsage(
        prisma,
        { ...event, costUsdDecimal: winningAmount },
        { ...attribution, projectId: null },
      ),
    ]);
    for (const result of replays) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected")
        expect(result.reason).toBeInstanceOf(UsageReplayConflictError);
    }
    expect(await prisma.usageRecord.count({ where: { spaceId, callId } })).toBe(1);
    expect(
      await prisma.usageRecord.findUniqueOrThrow({
        where: { spaceId_callId: { spaceId, callId } },
      }),
    ).toEqual(original);
    expect(await state(projectId)).toMatchObject({
      reservedMicroUsd: 0n,
      settledMicroUsd: original.costMicroUsd,
    });
    expect(
      await prisma.budgetReservation.findUniqueOrThrow({
        where: { spaceId_callId: { spaceId, callId } },
      }),
    ).toMatchObject({ status: "settled", settledMicroUsd: original.costMicroUsd });
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

  it("conserves covered balances while keeping uncovered usage separate", async () => {
    const projectId = await budgetFor(2_000_000n);
    const attribution = { spaceId, projectId, userId: `conservation-${projectId}` };
    const event = {
      type: "usage" as const,
      provider: "fixture",
      model: "fixture",
      inputTokens: 10,
      outputTokens: 2,
      billingKind: "api" as const,
    };
    const active = `active-${projectId}`;
    const unknown = `unknown-${projectId}`;
    const settled = `settled-${projectId}`;
    for (const [callId, amountMicroUsd] of [
      [active, 100_000n],
      [unknown, 200_000n],
      [settled, 300_000n],
    ] as const) {
      await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd });
    }
    await recordUsage(prisma, { ...event, callId: unknown }, attribution);
    const known = {
      ...event,
      callId: settled,
      costUsdDecimal: "0.25",
      costSource: "provider_reported",
    };
    await Promise.all(Array.from({ length: 4 }, () => recordUsage(prisma, known, attribution)));
    await recordUsage(
      prisma,
      { ...event, callId: `uncovered-known-${projectId}`, costUsdDecimal: "0.05" },
      attribution,
    );
    await recordUsage(prisma, { ...event, callId: `uncovered-unknown-${projectId}` }, attribution);
    const reservations = await prisma.budgetReservation.findMany({
      where: { spaceId, budget: { projectId } },
    });
    const held = reservations
      .filter((row) => ["reserved", "unreconciled"].includes(row.status))
      .reduce((sum, row) => sum + row.amountMicroUsd, 0n);
    const charged = reservations
      .filter((row) => row.status === "settled")
      .reduce((sum, row) => sum + (row.settledMicroUsd ?? 0n), 0n);
    expect(held).toBe(300_000n);
    expect(charged).toBe(250_000n);
    expect(await state(projectId)).toMatchObject({
      reservedMicroUsd: held,
      settledMicroUsd: charged,
    });
    expect(reservations).toHaveLength(3);
    expect(await prisma.usageRecord.count({ where: { spaceId, projectId } })).toBe(4);
    const summaries = await prisma.$transaction((tx) => getProjectCostSummaries(tx, spaceId));
    expect(summaries.find((row) => row.projectId === projectId)).toMatchObject({
      knownMarginalMicroUsd: "300000",
      unknownCostCalls: 2,
      unreconciledMicroUsd: "200000",
      complete: false,
    });
  });

  it("keeps mixed billing totals incomplete and charges separate API calls", async () => {
    const projectId = await budgetFor(1_000_000n);
    const attribution = { spaceId, projectId, userId: `mixed-${projectId}` };
    const event = {
      type: "usage" as const,
      provider: "fixture",
      model: "fixture",
      inputTokens: 10,
      outputTokens: 2,
      billingKind: "api" as const,
    };
    const summary = async () => {
      const rows = await prisma.$transaction((tx) => getProjectCostSummaries(tx, spaceId));
      return rows.find((row) => row.projectId === projectId);
    };
    await recordUsage(
      prisma,
      {
        ...event,
        callId: `mixed-known-${projectId}`,
        costUsdDecimal: "0.000007",
        costSource: "provider_reported",
      },
      attribution,
    );
    await recordUsage(prisma, { ...event, callId: `mixed-unknown-${projectId}` }, attribution);
    expect(await summary()).toMatchObject({
      knownMarginalMicroUsd: "7",
      unknownCostCalls: 1,
      complete: false,
    });
    const subscription = {
      ...event,
      callId: `mixed-subscription-${projectId}`,
      billingKind: "subscription_included" as const,
      costUsdDecimal: "0",
      costSource: "provider_reported",
    };
    await recordUsage(prisma, subscription, attribution);
    await recordUsage(prisma, subscription, attribution);
    expect(await summary()).toMatchObject({
      knownMarginalMicroUsd: "7",
      unknownCostCalls: 1,
      subscriptionIncludedCalls: 1,
      complete: false,
    });
    const callId = `mixed-api-${projectId}`;
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 100n });
    const api = { ...event, callId, costUsdDecimal: "0.000011", costSource: "provider_reported" };
    await Promise.all(Array.from({ length: 6 }, () => recordUsage(prisma, api, attribution)));
    expect(await summary()).toMatchObject({
      knownMarginalMicroUsd: "18",
      unknownCostCalls: 1,
      subscriptionIncludedCalls: 1,
      complete: false,
    });
    expect(await state(projectId)).toMatchObject({ reservedMicroUsd: 0n, settledMicroUsd: 11n });
    expect(await prisma.usageRecord.count({ where: { spaceId, projectId } })).toBe(4);
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

  it("settles known usage once when delivery races expiry", async () => {
    const projectId = await budgetFor(1_000_000n);
    const callId = `known-expiry-race-${projectId}`;
    const now = new Date();
    await reserveBudget(prisma, {
      spaceId,
      projectId,
      callId,
      amountMicroUsd: 600_000n,
      ttlMs: 1,
      now: new Date(now.getTime() - 1000),
    });
    const attribution = { spaceId, projectId, userId: `known-expiry-${projectId}` };
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
    await Promise.all([
      expireBudgetReservations(prisma, { now }),
      ...Array.from({ length: 6 }, () => recordUsage(prisma, event, attribution)),
    ]);
    await expireBudgetReservations(prisma, { now: new Date(now.getTime() + 1000) });
    await recordUsage(prisma, event, attribution);
    expect(await state(projectId)).toMatchObject({
      reservedMicroUsd: 0n,
      settledMicroUsd: 250_000n,
    });
    expect(await prisma.usageRecord.count({ where: { spaceId, callId } })).toBe(1);
    expect(
      await prisma.budgetReservation.findUniqueOrThrow({
        where: { spaceId_callId: { spaceId, callId } },
      }),
    ).toMatchObject({ status: "settled", settledMicroUsd: 250_000n });
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

  it("preserves settled cost and provenance across both source arrival orders", async () => {
    for (const [firstSource, laterSource] of [
      ["pricing_estimate", "provider_reported"],
      ["provider_reported", "pricing_estimate"],
    ]) {
      const projectId = await budgetFor(1_000_000n);
      const callId = `source-order-${firstSource}-${projectId}`;
      const attribution = { spaceId, projectId, userId: `source-${projectId}` };
      const event = {
        type: "usage" as const,
        provider: "fixture",
        model: "fixture",
        inputTokens: 10,
        outputTokens: 2,
        billingKind: "api" as const,
        callId,
        costUsdDecimal: "0.1",
        costSource: firstSource,
      };
      await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 600_000n });
      await recordUsage(prisma, event, attribution);
      const deliver = () =>
        recordUsage(
          prisma,
          { ...event, costUsdDecimal: "0.125", costSource: laterSource },
          attribution,
        );
      await Promise.all(Array.from({ length: 6 }, deliver));
      const row = await prisma.usageRecord.findUniqueOrThrow({
        where: { spaceId_callId: { spaceId, callId } },
      });
      expect(row).toMatchObject({ costMicroUsd: 100_000n, costSource: firstSource });
      expect(row.costAnomalies).toEqual([
        { kind: "amount_source_conflict", costMicroUsd: "125000", costSource: laterSource },
      ]);
      expect(await prisma.usageRecord.count({ where: { spaceId, callId } })).toBe(1);
      expect(await state(projectId)).toMatchObject({
        reservedMicroUsd: 0n,
        settledMicroUsd: 100_000n,
      });
      expect(
        await prisma.budgetReservation.findUniqueOrThrow({
          where: { spaceId_callId: { spaceId, callId } },
        }),
      ).toMatchObject({ status: "settled", settledMicroUsd: 100_000n });
    }
  });

  it("releases an unreconciled holding once under concurrent audited write-offs", async () => {
    const projectId = await budgetFor(1_000_000n);
    const callId = `writeoff-${projectId}`;
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 400_000n });
    await prisma.$executeRaw`UPDATE "budget_reservations" SET "status" = 'unreconciled' WHERE "spaceId" = ${spaceId} AND "callId" = ${callId}`;
    const input = {
      spaceId,
      callId,
      actorUserId: "test-operator",
      reason: "Provider charge cannot be reconciled",
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => writeOffBudgetHolding(prisma, input)),
    );
    expect(results.filter((result) => result && !result.replayed)).toHaveLength(1);
    expect((await state(projectId)).reservedMicroUsd).toBe(0n);
    expect((await state(projectId)).settledMicroUsd).toBe(0n);
    const rows = await prisma.$queryRaw<
      Array<{
        status: string;
        writtenOffBy: string;
        writeOffReason: string;
        writtenOffAt: Date;
        settledMicroUsd: bigint | null;
      }>
    >`SELECT * FROM "budget_reservations" WHERE "spaceId" = ${spaceId} AND "callId" = ${callId}`;
    expect(rows[0]).toMatchObject({
      status: "written_off",
      writtenOffBy: input.actorUserId,
      writeOffReason: input.reason,
      settledMicroUsd: null,
    });
    expect(rows[0]?.writtenOffAt).toBeInstanceOf(Date);
    expect(
      await writeOffBudgetHolding(prisma, {
        ...input,
        actorUserId: "another-operator",
        reason: "Replay",
      }),
    ).toMatchObject({ replayed: true });
    await expect(writeOffBudgetHolding(prisma, { ...input, reason: " " })).rejects.toThrow(
      "actor and reason",
    );
  });

  it("settles a late charge after write-off once", async () => {
    const projectId = await budgetFor(1_000_000n);
    const callId = `writeoff-late-${projectId}`;
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 400_000n });
    await prisma.budgetReservation.updateMany({
      where: { spaceId, callId },
      data: { status: "unreconciled" },
    });
    const audit = {
      spaceId,
      callId,
      actorUserId: "test-operator",
      reason: "Unknown charge reviewed",
    };
    expect(await writeOffBudgetHolding(prisma, audit)).toMatchObject({ replayed: false });
    await Promise.all(
      Array.from({ length: 6 }, () =>
        settleBudget(prisma, { spaceId, callId, actualMicroUsd: 250_000n }),
      ),
    );
    expect(await state(projectId)).toMatchObject({
      reservedMicroUsd: 0n,
      settledMicroUsd: 250_000n,
    });
    const rows = await prisma.$queryRaw<
      Array<{
        status: string;
        writtenOffBy: string;
        writeOffReason: string;
        chargedAfterWriteOff: boolean;
      }>
    >`SELECT * FROM "budget_reservations" WHERE "spaceId" = ${spaceId} AND "callId" = ${callId}`;
    expect(rows[0]).toMatchObject({
      status: "settled",
      writtenOffBy: audit.actorUserId,
      writeOffReason: audit.reason,
      chargedAfterWriteOff: true,
    });
    await expect(writeOffBudgetHolding(prisma, audit)).rejects.toThrow(
      "Only unreconciled holdings",
    );
  });

  it("releases the holding once when write-off races settlement", async () => {
    const projectId = await budgetFor(1_000_000n);
    const callId = `writeoff-race-${projectId}`;
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 400_000n });
    await prisma.budgetReservation.updateMany({
      where: { spaceId, callId },
      data: { status: "unreconciled" },
    });
    const race = await Promise.allSettled([
      writeOffBudgetHolding(prisma, {
        spaceId,
        callId,
        actorUserId: "test-operator",
        reason: "Race review",
      }),
      settleBudget(prisma, { spaceId, callId, actualMicroUsd: 250_000n }),
    ]);
    expect(await state(projectId)).toMatchObject({
      reservedMicroUsd: 0n,
      settledMicroUsd: 250_000n,
    });
    for (const result of race) {
      if (result.status === "rejected")
        expect(String(result.reason)).toContain("Only unreconciled holdings");
    }
    const replay = await settleBudget(prisma, { spaceId, callId, actualMicroUsd: 250_000n });
    expect(replay).toMatchObject({ replayed: true });
    expect(await state(projectId)).toMatchObject({
      reservedMicroUsd: 0n,
      settledMicroUsd: 250_000n,
    });
  });

  it("serializes provider start against release", async () => {
    const projectId = await budgetFor(1_000_000n);
    const callId = `start-release-${crypto.randomUUID()}`;
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 400_000n });
    const [started, released] = await Promise.all([
      startBudgetReservation(prisma, { spaceId, callId }),
      releaseBudgetReservation(prisma, { spaceId, callId }),
    ]);
    expect(Number(started) + Number(released)).toBe(1);
    const reservation = await prisma.budgetReservation.findFirstOrThrow({
      where: { spaceId, callId },
    });
    expect(reservation.status).toBe(started ? "reserved" : "released");
    expect((await state(projectId)).reservedMicroUsd).toBe(started ? 400_000n : 0n);
    expect(await startBudgetReservation(prisma, { spaceId, callId })).toBe(false);
    if (started) {
      expect(reservation.providerStartedAt).not.toBeNull();
      expect(await releaseBudgetReservation(prisma, { spaceId, callId })).toBe(false);
    }
  });

  it("retains unknown execution holding until settlement", async () => {
    const projectId = await budgetFor(1_000_000n);
    const callId = `unknown-execution-${crypto.randomUUID()}`;
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 400_000n });
    await prisma.budgetReservation.updateMany({
      where: { spaceId, callId },
      data: { executionState: "unknown", expiresAt: new Date(0) },
    });
    expect(await releaseBudgetReservation(prisma, { spaceId, callId })).toBe(false);
    await expireBudgetReservations(prisma);
    expect(
      await prisma.budgetReservation.findFirstOrThrow({ where: { spaceId, callId } }),
    ).toMatchObject({ status: "reserved", executionState: "unknown" });
    expect((await state(projectId)).reservedMicroUsd).toBe(400_000n);
    await settleBudget(prisma, { spaceId, callId, actualMicroUsd: 250_000n });
    expect(await state(projectId)).toMatchObject({
      reservedMicroUsd: 0n,
      settledMicroUsd: 250_000n,
    });
    expect(await ledger(callId)).toHaveLength(1);
  });

  it("preserves accounting evidence and settles after archival", async () => {
    const projectId = await budgetFor(1_000_000n);
    const callId = `archive-late-${crypto.randomUUID()}`;
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 400_000n });
    expect(await startBudgetReservation(prisma, { spaceId, callId })).toBe(true);
    expect(await prisma.project.findUnique({ where: { id: projectId } })).not.toBeNull();
    expect((await state(projectId)).reservedMicroUsd).toBe(400_000n);
    await prisma.$transaction((tx) => archiveProject(tx, spaceId, projectId));
    await expect(
      reserveBudget(prisma, {
        spaceId,
        projectId,
        callId: crypto.randomUUID(),
        amountMicroUsd: 1n,
      }),
    ).rejects.toThrow("Project is archived");
    await settleBudget(prisma, { spaceId, callId, actualMicroUsd: 250_000n });
    await settleBudget(prisma, { spaceId, callId, actualMicroUsd: 250_000n });
    expect(await state(projectId)).toMatchObject({
      reservedMicroUsd: 0n,
      settledMicroUsd: 250_000n,
    });
    expect(await ledger(callId)).toHaveLength(1);
    expect(
      await prisma.budgetReservation.findFirstOrThrow({ where: { spaceId, callId } }),
    ).toMatchObject({ status: "settled" });
  });
  it("retains deleted holdings and approval audits and settles concurrent replays once", async () => {
    const projectId = await budgetFor(1_000_000n);
    const callId = crypto.randomUUID();
    const unused = crypto.randomUUID();
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 400_000n });
    await startBudgetReservation(prisma, { spaceId, callId });
    await reserveBudget(prisma, { spaceId, projectId, callId: unused, amountMicroUsd: 100_000n });
    const budget = await state(projectId);
    const approval = await prisma.budgetOverrunApproval.create({
      data: {
        spaceId,
        projectId,
        budgetId: budget.id,
        budgetVersion: budget.version,
        amountMicroUsd: 100_000n,
        scope: "project",
        requestKey: crypto.randomUUID(),
      },
    });
    await prisma.$transaction((tx) => deleteProject(tx, spaceId, projectId));
    expect(await prisma.project.findUnique({ where: { id: projectId } })).toBeNull();
    expect(await prisma.budgetReservation.count({ where: { spaceId, projectId } })).toBe(0);
    expect(await ledger(callId)).toEqual([
      expect.objectContaining({ kind: "open_at_deletion", amountMicroUsd: 400_000n }),
    ]);
    expect(await ledger(unused)).toEqual([expect.objectContaining({ kind: "released" })]);
    expect(
      await prisma.budgetApprovalDeletionAudit.findMany({
        where: { spaceId, approvalId: approval.id },
      }),
    ).toEqual([
      expect.objectContaining({
        state: "pending",
        decision: "project_deleted",
        amountMicroUsd: 100_000n,
        scope: "project",
      }),
    ]);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        settleBudget(prisma, { spaceId, callId, actualMicroUsd: 500_000n }),
      ),
    );
    expect(results.filter((result) => result && !result.replayed)).toHaveLength(1);
    expect(await ledger(callId)).toHaveLength(2);
    expect(
      (await ledger(callId)).find((row) => row.kind === "settled_after_deletion"),
    ).toMatchObject({ amountMicroUsd: 500_000n, overrunMicroUsd: 100_000n });
  });

  it("writes off deleted holdings once and still records a later actual charge", async () => {
    const projectId = await budgetFor(1_000_000n);
    const callId = crypto.randomUUID();
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 400_000n });
    await startBudgetReservation(prisma, { spaceId, callId });
    await prisma.$transaction((tx) => deleteProject(tx, spaceId, projectId));
    const input = {
      spaceId,
      callId,
      actorUserId: "synthetic-reviewer",
      reason: "Unknown provider outcome",
    };
    expect(await writeOffBudgetHolding(prisma, input)).toMatchObject({ replayed: false });
    expect(await writeOffBudgetHolding(prisma, input)).toMatchObject({ replayed: true });
    await settleBudget(prisma, { spaceId, callId, actualMicroUsd: 250_000n });
    await settleBudget(prisma, { spaceId, callId, actualMicroUsd: 250_000n });
    expect((await ledger(callId)).map((row) => row.kind)).toEqual([
      "open_at_deletion",
      "settled_after_deletion",
      "written_off",
    ]);
  });

  it("rolls back deletion snapshots and reservation changes when deletion fails", async () => {
    const projectId = await budgetFor(1_000_000n);
    const callId = crypto.randomUUID();
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 400_000n });
    const budget = await state(projectId);
    const approval = await prisma.budgetOverrunApproval.create({
      data: {
        spaceId,
        projectId,
        budgetId: budget.id,
        budgetVersion: budget.version,
        amountMicroUsd: 100_000n,
        scope: "project",
        requestKey: crypto.randomUUID(),
      },
    });
    await expect(
      prisma.$transaction(async (tx) => {
        await deleteProject(tx, spaceId, projectId);
        throw new Error("synthetic rollback");
      }),
    ).rejects.toThrow("synthetic rollback");
    expect(await prisma.project.findUnique({ where: { id: projectId } })).not.toBeNull();
    expect((await state(projectId)).reservedMicroUsd).toBe(400_000n);
    expect(await ledger(callId)).toHaveLength(0);
    expect(await prisma.budgetApprovalDeletionAudit.count({ where: { spaceId, projectId } })).toBe(
      0,
    );
    expect(
      await prisma.budgetOverrunApproval.findUnique({ where: { id: approval.id } }),
    ).toMatchObject({ status: "pending" });
    expect(
      await prisma.budgetReservation.findFirstOrThrow({ where: { spaceId, callId } }),
    ).toMatchObject({ status: "reserved" });
  });

  it("deletes projects without budgets without creating ledger entries", async () => {
    const project = await prisma.project.create({ data: { spaceId, name: "No budget fixture" } });
    await prisma.$transaction((tx) => deleteProject(tx, spaceId, project.id));
    expect(await prisma.project.findUnique({ where: { id: project.id } })).toBeNull();
    expect(
      await prisma.budgetSpendLedger.count({ where: { spaceId, projectId: project.id } }),
    ).toBe(0);
  });

  it("settles late usage delivery through the ledger after project deletion", async () => {
    const projectId = await budgetFor(1_000_000n);
    const callId = `deleted-usage-${crypto.randomUUID()}`;
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 100_000n });
    await startBudgetReservation(prisma, { spaceId, callId });
    await prisma.$transaction((tx) => deleteProject(tx, spaceId, projectId));
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
    const attribution = { spaceId, projectId: null, userId: `late-${projectId}` };
    await Promise.all(Array.from({ length: 4 }, () => recordUsage(prisma, event, attribution)));
    const rows = await ledger(callId);
    expect(rows.filter((row) => row.kind === "settled_after_deletion")).toHaveLength(1);
    expect(rows.find((row) => row.kind === "settled_after_deletion")).toMatchObject({
      projectId,
      amountMicroUsd: 250_000n,
      overrunMicroUsd: 150_000n,
    });
  });
});
