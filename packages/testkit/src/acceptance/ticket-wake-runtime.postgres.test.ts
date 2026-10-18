import type { JobPublisher } from "@rakazo/adapter-kit";
import { reconcileTicketWakes } from "@rakazo/adapters";
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
import type { TrackedPool } from "./pool-lifecycle.js";
import { endPool, trackPool } from "./pool-lifecycle.js";
import { startRestartableRuntime } from "./runtime-restart.js";

// Needs RAK_PG_BIN_DIR; skipped otherwise, unless RAK_REQUIRE_PG=1 (set in CI), where
// missing binaries fail instead of skipping.
const describeCluster = postgresAvailable() ? describe.sequential : describe.skip;

if (process.env.RAK_REQUIRE_PG === "1" && !postgresAvailable()) {
  describe("ticket wake runtime wiring (PostgreSQL required)", () => {
    it("has PostgreSQL 16 binaries", () => {
      throw new Error(
        "RAK_REQUIRE_PG=1 but RAK_PG_BIN_DIR is not set; recovery tests must not skip",
      );
    });
  });
}

function recordingJobs() {
  const enqueued: unknown[] = [];
  const jobs = {
    enqueue: async (job: unknown) => {
      enqueued.push(job);
    },
  } as unknown as JobPublisher;
  return { jobs, enqueued };
}

describeCluster("ticket wake runtime wiring", () => {
  let cluster: DisposableCluster;
  beforeAll(async () => {
    cluster = await startDisposableCluster();
  }, 60_000);
  afterAll(async () => {
    await cluster?.stop();
  });

  it("delivers a crashed runtime's claimed wake exactly once and fences the stale owner", async () => {
    const database = await cluster.createDatabase("wake_runtime");
    await cluster.migrate(database);
    const pools: TrackedPool[] = [];
    const runtime = await startRestartableRuntime({
      start: async () => {
        const db = createDb(cluster.url(database));
        pools.push(trackPool(db.pool));
        return db;
      },
      stop: async (db) => {
        await db.prisma.$disconnect();
        await endPool(db.pool);
      },
    });
    try {
      const prisma = () => runtime.current().prisma;
      const suffix = crypto.randomUUID();
      const organizationId = `wake-runtime-${suffix}`;
      await prisma().organization.create({
        data: {
          id: organizationId,
          name: "Wake runtime",
          slug: organizationId,
          createdAt: new Date(),
        },
      });
      const space = await prisma().space.create({
        data: { id: `wake-space-${suffix}`, organizationId, name: "Wake runtime" },
      });
      const spaceId = space.id;
      const user = await prisma().user.create({
        data: { id: `wake-user-${suffix}`, name: "Wake", email: `wake-${suffix}@example.test` },
      });
      const bot = await prisma().bot.create({
        data: { spaceId, userId: user.id, name: "Dependent owner", color: "#000000" },
      });
      await prisma().thread.create({ data: { spaceId, botId: bot.id, userId: user.id } });
      const boardId = (await ensureBoard(prisma(), spaceId)).id;
      const prerequisite = await prisma().ticket.create({
        data: { spaceId, boardId, number: 1, title: "Prerequisite" },
      });
      const dependent = await prisma().ticket.create({
        data: { spaceId, boardId, number: 2, title: "Dependent", assigneeBotId: bot.id },
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

      // runtime-1 claims the wake and dies before delivering it.
      const t0 = new Date();
      const claimed = await claimTicketWakes(prisma(), "runtime-1", { leaseMs: 1_000, now: t0 });
      expect(claimed).toHaveLength(1);
      await runtime.restart("crash");

      // While the lease is live, another runtime delivers nothing.
      const { jobs, enqueued } = recordingJobs();
      const deps = () => ({ prisma: prisma(), jobs, ticketBoardEnabled: true });
      expect(await reconcileTicketWakes(deps(), { claimer: "runtime-2", now: t0 })).toBe(0);
      expect(await prisma().run.count({ where: { botId: bot.id } })).toBe(0);

      // runtime-2 reclaims the expired wake and holds a live claim; stale runtime-1 cannot complete it.
      const late = new Date(t0.getTime() + 5_000);
      const reclaimed = await claimTicketWakes(prisma(), "runtime-2", {
        leaseMs: 1_000,
        now: late,
      });
      expect(reclaimed).toHaveLength(1);
      expect(
        await completeTicketWake(
          prisma(),
          claimed[0]?.id ?? "",
          claimed[0]?.spaceId ?? "",
          "runtime-1",
          late,
        ),
      ).toBe(false);
      const liveRow = await prisma().ticketWake.findUniqueOrThrow({
        where: { id: claimed[0]?.id ?? "" },
      });
      expect(liveRow.status).toBe("claimed");
      expect(liveRow.claimedBy).toBe("runtime-2");
      expect(await prisma().run.count({ where: { botId: bot.id } })).toBe(0);

      // After runtime-2's lease expires it delivers exactly one run.
      const delivered = new Date(late.getTime() + 5_000);
      expect(await reconcileTicketWakes(deps(), { claimer: "runtime-2", now: delivered })).toBe(1);
      expect(await prisma().run.count({ where: { botId: bot.id, trigger: "tickets" } })).toBe(1);
      expect(await prisma().task.count({ where: { botId: bot.id } })).toBe(1);
      expect(enqueued).toHaveLength(1);
      const wakes = await prisma().ticketWake.findMany({ where: { ticketId: dependent.id } });
      expect(wakes).toHaveLength(1);
      expect(wakes[0]?.status).toBe("woken");

      // The stale owner cannot complete, leaves the row untouched, and further reconciliation adds nothing.
      const before = await prisma().ticketWake.findUniqueOrThrow({
        where: { id: claimed[0]?.id ?? "" },
      });
      expect(
        await completeTicketWake(
          prisma(),
          claimed[0]?.id ?? "",
          claimed[0]?.spaceId ?? "",
          "runtime-1",
        ),
      ).toBe(false);
      const after = await prisma().ticketWake.findUniqueOrThrow({
        where: { id: claimed[0]?.id ?? "" },
      });
      expect(after.status).toBe(before.status);
      expect(after.claimedBy).toBe(before.claimedBy);
      expect(after.wokenAt).toEqual(before.wokenAt);
      expect(after.leaseExpiresAt).toEqual(before.leaseExpiresAt);
      expect(after.attempts).toBe(before.attempts);
      const afterDone = new Date(delivered.getTime() + 60_000);
      expect(await reconcileTicketWakes(deps(), { claimer: "runtime-3", now: afterDone })).toBe(0);
      expect(await prisma().run.count({ where: { botId: bot.id } })).toBe(1);
      expect(enqueued).toHaveLength(1);
    } finally {
      await runtime.shutdown();
      for (const pool of pools) {
        for (const error of pool.errors) {
          expect(error).toHaveProperty("code", "57P01");
        }
      }
    }
  }, 120_000);
});
