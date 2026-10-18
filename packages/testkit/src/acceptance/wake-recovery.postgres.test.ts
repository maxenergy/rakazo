import {
  addTicketDependency,
  claimTicketWakes,
  completeTicketWake,
  createDb,
  enqueueDependentWakes,
  ensureBoard,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DisposableCluster } from "./disposable-postgres.js";
import { postgresAvailable, startDisposableCluster } from "./disposable-postgres.js";
import { startRestartableRuntime } from "./runtime-restart.js";

// Needs RAK_PG_BIN_DIR; skipped otherwise, unless RAK_REQUIRE_PG=1 (set in CI), where
// missing binaries fail instead of skipping.
const describeCluster = postgresAvailable() ? describe.sequential : describe.skip;

if (process.env.RAK_REQUIRE_PG === "1" && !postgresAvailable()) {
  describe("wake recovery (PostgreSQL required)", () => {
    it("has PostgreSQL 16 binaries", () => {
      throw new Error(
        "RAK_REQUIRE_PG=1 but RAK_PG_BIN_DIR is not set; recovery tests must not skip",
      );
    });
  });
}

describeCluster("durable ticket wakes survive a runtime restart", () => {
  let cluster: DisposableCluster;
  beforeAll(async () => {
    cluster = await startDisposableCluster();
  }, 60_000);
  afterAll(async () => {
    await cluster?.stop();
  });

  it("re-claims a wake after a crash and Postgres restart, once and without duplicates", async () => {
    const database = await cluster.createDatabase("wake_recovery");
    await cluster.migrate(database);
    const runtime = await startRestartableRuntime({
      start: async () => createDb(cluster.url(database)),
      stop: async (db) => {
        await db.prisma.$disconnect();
        await db.pool.end();
      },
    });
    try {
      const prisma = () => runtime.current().prisma;
      const organizationId = `wake-recovery-${crypto.randomUUID()}`;
      await prisma().organization.create({
        data: {
          id: organizationId,
          name: "Wake recovery",
          slug: organizationId,
          createdAt: new Date(),
        },
      });
      const space = await prisma().space.create({
        data: { id: `wake-space-${crypto.randomUUID()}`, organizationId, name: "Wake recovery" },
      });
      const spaceId = space.id;
      const boardId = (await ensureBoard(prisma(), spaceId)).id;
      const prerequisite = await prisma().ticket.create({
        data: { spaceId, boardId, number: 1, title: "Prerequisite" },
      });
      const dependent = await prisma().ticket.create({
        data: { spaceId, boardId, number: 2, title: "Dependent" },
      });
      await prisma().$transaction((tx) =>
        addTicketDependency(tx, spaceId, dependent.id, prerequisite.id),
      );

      const completedAt = new Date();
      await prisma().$transaction(async (tx) => {
        await tx.ticket.update({
          where: { id: prerequisite.id },
          data: { status: "done", completedAt },
        });
        await enqueueDependentWakes(tx, spaceId, prerequisite.id, completedAt);
      });

      const t0 = new Date();
      const first = await claimTicketWakes(prisma(), "runtime-1", { leaseMs: 1_000, now: t0 });
      expect(first).toHaveLength(1);
      expect(first[0]?.attempts).toBe(1);

      await runtime.restart("crash", () => cluster.restartServer());
      expect(runtime.generation).toBe(2);

      const early = new Date(t0.getTime() + 500);
      expect(await claimTicketWakes(prisma(), "runtime-2", { leaseMs: 1_000, now: early })).toEqual(
        [],
      );

      const late = new Date(t0.getTime() + 1_500);
      const second = await claimTicketWakes(prisma(), "runtime-2", { leaseMs: 1_000, now: late });
      expect(second).toHaveLength(1);
      expect(second[0]?.id).toBe(first[0]?.id);
      expect(second[0]?.attempts).toBe(2);

      expect(
        await completeTicketWake(prisma(), first[0]!.id, first[0]!.spaceId, "runtime-1", late),
      ).toBe(false);
      expect(
        await completeTicketWake(prisma(), second[0]!.id, second[0]!.spaceId, "runtime-2", late),
      ).toBe(true);

      const wakes = await prisma().ticketWake.findMany({ where: { ticketId: dependent.id } });
      expect(wakes).toHaveLength(1);
      expect(wakes[0]?.status).toBe("woken");
      const afterDone = new Date(late.getTime() + 60_000);
      expect(await claimTicketWakes(prisma(), "runtime-2", { now: afterDone })).toEqual([]);
    } finally {
      await runtime.shutdown();
    }
  }, 120_000);
});
