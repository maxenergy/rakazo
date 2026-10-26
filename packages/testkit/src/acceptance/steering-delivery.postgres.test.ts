import { randomUUID } from "node:crypto";
import { SteeringDeliveredPayload } from "@rakazo/contracts";
import { claimSteering, createDb, deliverSteering, sendUserMessage } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DisposableCluster,
  postgresAvailable,
  startDisposableCluster,
} from "./disposable-postgres.js";

const available = postgresAvailable();
if (process.env.RAK_REQUIRE_PG === "1" && !available) {
  throw new Error("RAK_REQUIRE_PG=1 but PostgreSQL binaries are unavailable");
}
describe.skipIf(!available)("ordered durable steering delivery", () => {
  let cluster: DisposableCluster;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    cluster = await startDisposableCluster();
    const database = await cluster.createDatabase("steering_delivery");
    await cluster.migrate(database);
    db = createDb(cluster.url(database));
  }, 60_000);
  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.pool.end();
    await cluster?.stop();
  });

  async function seed() {
    const id = randomUUID();
    const org = await db.prisma.organization.create({
      data: { id, slug: id, name: "Synthetic steering fixture", createdAt: new Date() },
    });
    const space = await db.prisma.space.create({
      data: { id: randomUUID(), organizationId: org.id, name: "Synthetic steering" },
    });
    const bot = await db.prisma.bot.create({
      data: { spaceId: space.id, userId: id, name: "Fixture bot", color: "#123456" },
    });
    const thread = await db.prisma.thread.create({
      data: { spaceId: space.id, botId: bot.id, userId: id },
    });
    const task = await db.prisma.task.create({
      data: {
        spaceId: space.id,
        botId: bot.id,
        threadId: thread.id,
        userId: id,
        prompt: "Synthetic steering",
        status: "running",
      },
    });
    const run = await db.prisma.run.create({
      data: {
        spaceId: space.id,
        botId: bot.id,
        threadId: thread.id,
        userId: id,
        taskId: task.id,
        trigger: "user",
        status: "running",
        leaseOwner: "worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 600_000),
      },
    });
    const input = {
      threadId: thread.id,
      botId: bot.id,
      runId: run.id,
      leaseOwner: "worker",
      leaseFence: 1,
    };
    async function send(text: string) {
      return sendUserMessage(db.prisma, {
        spaceId: space.id,
        threadId: thread.id,
        botId: bot.id,
        userId: id,
        trigger: "user",
        prompt: text,
        blocks: [{ kind: "text", text }],
      });
    }
    return { input, send, thread, run };
  }

  it.each(["initial", "between-tools"] as const)(
    "records ordered receipts and event timestamp latency for %s steering (n=20)",
    async (fixture) => {
      const { input, send } = await seed();
      const messages = [];
      for (let index = 0; index < 20; index++) messages.push(await send(`Context ${index}`));
      // Controlled backlog timestamps exercise latency calculation without wall-clock sleeps.
      const receivedAt = new Date(Date.now() - (fixture === "initial" ? 5_000 : 30_000));
      await db.prisma.event.updateMany({
        where: { threadId: input.threadId, type: "thread.message.created" },
        data: { createdAt: receivedAt },
      });
      if (fixture === "initial") {
        await db.prisma.steeringMessage.updateMany({
          where: { runId: input.runId },
          data: { runId: null, claimedAt: null },
        });
      }
      const claimed = await claimSteering(db.prisma, { ...input, seenIds: [] });
      expect(claimed.map((item) => item.messageId)).toEqual(messages.map((item) => item.messageId));
      expect(
        await db.prisma.event.count({
          where: { threadId: input.threadId, type: "steering.delivered" },
        }),
      ).toBe(0); // Claiming alone is not delivery.
      const ids = claimed.map((item) => item.id);
      await deliverSteering(db.prisma, { ...input, ids });
      await deliverSteering(db.prisma, { ...input, ids }); // Retry is a durable no-op.
      const events = await db.prisma.event.findMany({
        where: { threadId: input.threadId, type: "steering.delivered" },
        orderBy: { seq: "asc" },
      });
      expect(events).toHaveLength(20);
      const payloads = events.map((event) => SteeringDeliveredPayload.parse(event.payload));
      const received = await db.prisma.event.findMany({
        where: { threadId: input.threadId, type: "thread.message.created" },
        orderBy: { seq: "asc" },
      });
      expect(payloads.map((item) => item.receivedEventId)).toEqual(
        received.map((event) => event.id),
      );
      expect(payloads.map((item) => item.receivedAt)).toEqual(
        received.map((event) => event.createdAt.toISOString()),
      );
      expect(payloads.map((item) => item.messageId)).toEqual(
        messages.map((item) => item.messageId),
      );
      expect(payloads.map((item) => item.messageSeq)).toEqual(messages.map((item) => item.seq));
      const samples = events
        .map((event, index) => event.createdAt.getTime() - Date.parse(payloads[index]!.receivedAt))
        .sort((a, b) => a - b);
      expect(samples).toHaveLength(20);
      expect(samples[0]).toBeGreaterThanOrEqual(0);
      expect(samples[Math.ceil(samples.length * 0.5) - 1]).toBeLessThanOrEqual(120_000);
      expect(samples[Math.ceil(samples.length * 0.95) - 1]).toBeLessThanOrEqual(600_000);
      console.info(fixture, { n: samples.length, p50: samples[9], p95: samples[18] });
      expect(await claimSteering(db.prisma, { ...input, seenIds: ids })).toEqual([]);

      // Recovery restores context but retains the first receipt and its original timestamp.
      await db.prisma.run.update({
        where: { id: input.runId },
        data: { leaseOwner: "recovered", leaseFence: 2 },
      });
      const recovered = { ...input, leaseOwner: "recovered", leaseFence: 2 };
      expect(await claimSteering(db.prisma, { ...recovered, seenIds: [] })).toHaveLength(20);
      await expect(deliverSteering(db.prisma, { ...input, ids })).rejects.toThrow("fence");
      await deliverSteering(db.prisma, { ...recovered, ids });
      expect(
        await db.prisma.event.findMany({
          where: { threadId: input.threadId, type: "steering.delivered" },
          orderBy: { seq: "asc" },
        }),
      ).toEqual(events);
    },
  );

  it("rejects unclaimed and cross-thread acknowledgements without a receipt", async () => {
    const a = await seed();
    const b = await seed();
    await a.send("Private A");
    await b.send("Private B");
    const unclaimed = await db.prisma.steeringMessage.findFirstOrThrow({
      where: { runId: a.run.id },
    });
    await expect(deliverSteering(db.prisma, { ...a.input, ids: [unclaimed.id] })).rejects.toThrow(
      "claimed",
    );
    const foreign = await claimSteering(db.prisma, { ...b.input, seenIds: [] });
    await expect(
      deliverSteering(db.prisma, { ...a.input, ids: foreign.map((item) => item.id) }),
    ).rejects.toThrow("claimed");
    expect(await db.prisma.event.count({ where: { type: "steering.delivered" } })).toBe(40);
  });
});
