import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureBoard } from "./board.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { addTicketDependency } from "./ticket-dependencies.js";
import { claimTicketWakes, completeTicketWake, enqueueDependentWakes } from "./ticket-wakes.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

if (process.env.VERIFY_DATABASE && !databaseUrl) {
  describe("durable ticket wakes (PostgreSQL required)", () => {
    it("has DATABASE_URL", () => {
      throw new Error("VERIFY_DATABASE is set but DATABASE_URL is not; wake tests must not skip");
    });
  });
}
describePostgres("durable ticket wakes", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  const organizationId = `wake-test-${crypto.randomUUID()}`;
  let spaceId: string;
  let boardId: string;
  let number = 0;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.organization.create({
      data: { id: organizationId, name: "Wake tests", slug: organizationId, createdAt: new Date() },
    });
    const space = await prisma.space.create({
      data: { id: `wake-space-${crypto.randomUUID()}`, organizationId, name: "Wake tests" },
    });
    spaceId = space.id;
    boardId = (await ensureBoard(prisma, spaceId)).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    } finally {
      await close();
    }
  });

  async function ticket() {
    return prisma.ticket.create({
      data: { spaceId, boardId, number: ++number, title: "Wake fixture" },
    });
  }

  async function depend(ticketId: string, prerequisiteId: string) {
    await prisma.$transaction((tx) => addTicketDependency(tx, spaceId, ticketId, prerequisiteId));
  }

  async function complete(id: string) {
    const completedAt = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.ticket.update({ where: { id }, data: { status: "done", completedAt } });
      await enqueueDependentWakes(tx, spaceId, id, completedAt);
    });
    return completedAt;
  }

  const wakesFor = (ticketId: string) => prisma.ticketWake.findMany({ where: { ticketId } });

  it("records one wake when the prerequisite completes and ignores a repeated enqueue", async () => {
    const prerequisite = await ticket();
    const dependent = await ticket();
    await depend(dependent.id, prerequisite.id);
    expect(await wakesFor(dependent.id)).toHaveLength(0);

    const completedAt = await complete(prerequisite.id);
    await prisma.$transaction((tx) =>
      enqueueDependentWakes(tx, spaceId, prerequisite.id, completedAt),
    );
    const wakes = await wakesFor(dependent.id);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.status).toBe("pending");
  });

  it("rolls the wake back with the transaction that completes the prerequisite", async () => {
    const prerequisite = await ticket();
    const dependent = await ticket();
    await depend(dependent.id, prerequisite.id);
    await expect(
      prisma.$transaction(async (tx) => {
        const completedAt = new Date();
        await tx.ticket.update({
          where: { id: prerequisite.id },
          data: { status: "done", completedAt },
        });
        await enqueueDependentWakes(tx, spaceId, prerequisite.id, completedAt);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await wakesFor(dependent.id)).toHaveLength(0);
  });

  it("wakes a dependent with two prerequisites only after both are complete", async () => {
    const first = await ticket();
    const second = await ticket();
    const dependent = await ticket();
    await depend(dependent.id, first.id);
    await depend(dependent.id, second.id);

    await complete(first.id);
    expect(await wakesFor(dependent.id)).toHaveLength(0);
    await complete(second.id);
    expect(await wakesFor(dependent.id)).toHaveLength(1);
  });

  it("keeps concurrent claimers disjoint with no lost or duplicate wakes", async () => {
    const prerequisite = await ticket();
    const dependents: string[] = [];
    for (let i = 0; i < 6; i++) {
      const dependent = await ticket();
      await depend(dependent.id, prerequisite.id);
      dependents.push(dependent.id);
    }
    await complete(prerequisite.id);

    const [a, b] = await Promise.all([
      claimTicketWakes(prisma, "claimer-a", { limit: 6 }),
      claimTicketWakes(prisma, "claimer-b", { limit: 6 }),
    ]);
    const claimed = [...a, ...b].filter((wake) => dependents.includes(wake.ticketId));
    const ids = claimed.map((wake) => wake.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(claimed.map((wake) => wake.ticketId))).toEqual(new Set(dependents));
  });

  it("re-claims a wake after its lease expires and fences the stale claimer", async () => {
    const prerequisite = await ticket();
    const dependent = await ticket();
    await depend(dependent.id, prerequisite.id);
    await complete(prerequisite.id);

    const t0 = new Date();
    const first = await claimTicketWakes(prisma, "before-restart", { now: t0, leaseMs: 1000 });
    const mine = first.find((wake) => wake.ticketId === dependent.id);
    expect(mine).toBeDefined();
    const wakeId = mine!.id;

    const early = await claimTicketWakes(prisma, "after-restart", {
      now: new Date(t0.getTime() + 500),
    });
    expect(early.map((wake) => wake.id)).not.toContain(wakeId);

    const later = await claimTicketWakes(prisma, "after-restart", {
      now: new Date(t0.getTime() + 2000),
    });
    expect(later.find((wake) => wake.id === wakeId)?.attempts).toBe(2);

    expect(await completeTicketWake(prisma, wakeId, "before-restart")).toBe(false);
    expect(await completeTicketWake(prisma, wakeId, "after-restart")).toBe(true);
    const rest = await claimTicketWakes(prisma, "after-restart", {
      now: new Date(t0.getTime() + 10_000),
    });
    expect(rest.map((wake) => wake.id)).not.toContain(wakeId);
  });
});
