import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  expireBudgetReservations,
  releaseBudgetReservation,
  reserveBudget,
  setProjectBudget,
  settleBudget,
} from "./project-budgets.js";

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
      Array.from({ length: 6 }, () => settleBudget(prisma, { callId, actualMicroUsd: 300_000n })),
    );
    expect(results.filter((r) => r && !r.replayed)).toHaveLength(1);
    const after = await state(projectId);
    expect(after.reservedMicroUsd).toBe(0n);
    expect(after.settledMicroUsd).toBe(300_000n);
    await settleBudget(prisma, { callId, actualMicroUsd: 900_000n });
    expect((await state(projectId)).settledMicroUsd).toBe(300_000n);
  });

  it("records actual spend above the reservation as overrun", async () => {
    const projectId = await budgetFor(1_000_000n);
    const callId = `overrun-${projectId}`;
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 200_000n });
    const settled = await settleBudget(prisma, { callId, actualMicroUsd: 350_000n });
    expect(settled).toMatchObject({ overrunMicroUsd: 150_000n, settledMicroUsd: 350_000n });
    expect((await state(projectId)).settledMicroUsd).toBe(350_000n);
  });

  it("releases once and refuses to settle a released reservation", async () => {
    const projectId = await budgetFor(1_000_000n);
    const callId = `release-${projectId}`;
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 600_000n });
    const released = await Promise.all([
      releaseBudgetReservation(prisma, { callId }),
      releaseBudgetReservation(prisma, { callId }),
    ]);
    expect(released.filter(Boolean)).toHaveLength(1);
    expect((await state(projectId)).reservedMicroUsd).toBe(0n);
    expect(await settleBudget(prisma, { callId, actualMicroUsd: 1n })).toBeNull();
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
    expect(counts[0] + counts[1]).toBeGreaterThanOrEqual(1);
    expect((await state(projectId)).reservedMicroUsd).toBe(0n);
    const settled = await settleBudget(prisma, { callId, actualMicroUsd: 250_000n, now: later });
    expect(settled).toMatchObject({ settledLate: true, settledMicroUsd: 250_000n });
    const after = await state(projectId);
    expect(after.reservedMicroUsd).toBe(0n);
    expect(after.settledMicroUsd).toBe(250_000n);
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
});
