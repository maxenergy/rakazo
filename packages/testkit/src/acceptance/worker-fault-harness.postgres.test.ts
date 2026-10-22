import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { assertExecutionFence, createDb, setProjectBudget } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completeExternalEffect } from "../../../adapters/src/approval-effect.js";
import type { DisposableCluster } from "./disposable-postgres.js";
import { postgresAvailable, startDisposableCluster } from "./disposable-postgres.js";
import {
  assertLedgerUnchanged,
  assertUniqueBilling,
  expireWorkerLease,
  ledgerSnapshot,
  spawnFaultWorker,
} from "./worker-fault-harness.js";

const available = postgresAvailable();
if (process.env.RAK_REQUIRE_PG === "1" && !available)
  throw new Error("RAK_REQUIRE_PG=1 but PostgreSQL binaries are unavailable");
describe.skipIf(!available)("full execution worker fault harness PostgreSQL", () => {
  let cluster: DisposableCluster;
  let db: ReturnType<typeof createDb>;
  let databaseUrl: string;
  const workers: Awaited<ReturnType<typeof spawnFaultWorker>>[] = [];
  beforeAll(async () => {
    cluster = await startDisposableCluster();
    expect(cluster.port).not.toBe(5432);
    const name = await cluster.createDatabase("worker_fault");
    await cluster.migrate(name);
    databaseUrl = cluster.url(name);
    db = createDb(databaseUrl);
    await db.prisma.deploymentSettings.create({
      data: { id: "default", defaultModelProvider: "scripted", defaultModelId: "scripted" },
    });
    const version = await db.prisma.$queryRaw<{ server_version: string }[]>`SHOW server_version`;
    expect(version[0]!.server_version).toMatch(/^16\./);
  }, 60_000);
  afterAll(async () => {
    for (const worker of workers)
      if (worker.child.exitCode === null && worker.child.signalCode === null) await worker.kill();
    await db?.prisma.$disconnect();
    await db?.pool.end();
    await cluster?.stop();
  });
  async function fixture() {
    const id = `fault-${randomUUID()}`;
    await db.prisma.organization.create({
      data: { id, slug: id, name: "Synthetic fault fixture", createdAt: new Date() },
    });
    const space = await db.prisma.space.create({
      data: { id: `${id}-space`, organizationId: id, name: "Synthetic fault space" },
    });
    const computer = await db.prisma.computer.create({
      data: {
        spaceId: space.id,
        userId: id,
        scope: "dedicated",
        scopeKey: id,
        homeKey: id,
        kind: "fake",
      },
    });
    const bot = await db.prisma.bot.create({
      data: {
        spaceId: space.id,
        userId: id,
        name: "Synthetic bot",
        color: "#123456",
        computerId: computer.id,
      },
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
        prompt: "Synthetic offline fault fixture",
        status: "queued",
      },
    });
    const project = await db.prisma.project.create({
      data: { spaceId: space.id, name: "Synthetic fixture budget" },
    });
    await setProjectBudget(db.prisma, {
      spaceId: space.id,
      projectId: project.id,
      limitMicroUsd: 10000000n,
    });
    const run = await db.prisma.run.create({
      data: {
        spaceId: space.id,
        botId: bot.id,
        threadId: thread.id,
        userId: id,
        taskId: task.id,
        projectId: project.id,
        status: "queued",
        trigger: "user",
      },
    });
    return { id, space, run, bot, thread };
  }
  async function worker(runId: string, instanceId: string, env: Record<string, string> = {}) {
    const handle = await spawnFaultWorker({
      entry: fileURLToPath(new URL("./fault-execution-worker.ts", import.meta.url)),
      databaseUrl,
      identity: { scenarioId: runId, instanceId, runId },
      env,
      timeoutMs: 20_000,
    });
    workers.push(handle);
    return handle;
  }
  it("uses SIGKILL without drain, then races four real workers for one newer lease", async () => {
    const { run, space } = await fixture();
    const first = await worker(run.id, "fault-a", { RAK_FAULT_USAGE_BARRIER: "1" });
    const reached = await first.waitFor("reached", "runtime-entered");
    expect(reached.attemptId).toBeTruthy();
    expect(reached.fence).toBeGreaterThan(0);
    await first.release(reached);
    await first.waitFor("reached", "usage-committed");
    const firstCall = `${run.id}-${reached.fence}`;
    const before = await ledgerSnapshot(db.prisma, space.id, [firstCall]);
    assertUniqueBilling(before, new Map([[firstCall, 125000n]]));
    await first.kill();
    await expireWorkerLease(db.prisma, run.id, reached.fence);
    const competitors = await Promise.all(
      ["b", "c", "d", "e"].map((id) => worker(run.id, `fault-${id}`)),
    );
    const winner = await Promise.any(
      competitors.map(async (handle) => ({
        handle,
        event: await handle.waitFor("reached", "runtime-entered"),
      })),
    );
    expect(winner.event.fence).toBeGreaterThan(reached.fence);
    const persisted = await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(persisted.leaseOwner).toBe(winner.event.instanceId);
    expect(persisted.leaseFence).toBe(winner.event.fence);
    expect(await db.prisma.attempt.count({ where: { runId: run.id } })).toBe(2);
    assertLedgerUnchanged(before, await ledgerSnapshot(db.prisma, space.id, [firstCall]));
    await winner.handle.release(winner.event);
    await Promise.all(competitors.map((handle) => handle.drain()));
    const allCalls = new Map([
      [firstCall, 125000n],
      [`${run.id}-${winner.event.fence}`, 125000n],
    ]);
    assertUniqueBilling(await ledgerSnapshot(db.prisma, space.id, [...allCalls.keys()]), allCalls);
    expect(await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "completed",
    });
    expect(
      competitors
        .flatMap((handle) => handle.events)
        .filter((event) => event.boundary === "runtime-entered"),
    ).toHaveLength(1);
  }, 60_000);

  for (const scenario of ["checkpoint", "steering"]) {
    it(`rejects stale ${scenario} callbacks after a real worker takeover`, async () => {
      const { run, space, bot, thread, id } = await fixture();
      if (scenario === "steering") {
        const message = await db.prisma.message.create({
          data: {
            threadId: thread.id,
            seq: 1,
            role: "user",
            blocks: [{ kind: "text", text: "Synthetic steering" }],
          },
        });
        await db.prisma.steeringMessage.create({
          data: { messageId: message.id, botId: bot.id, userId: id, runId: run.id },
        });
      }
      const first = await worker(run.id, "callback-old", { RAK_FAULT_STALE_CALLBACK: scenario });
      const entered = await first.waitFor("reached", "runtime-entered");
      await first.release(entered);
      const ready = await first.waitFor("reached", "callback-ready");
      const checkpoint = (await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } }))
        .segmentCheckpoint;
      if (scenario === "checkpoint")
        expect(JSON.parse(checkpoint!).runtime).toBe("synthetic-current-checkpoint");
      await expireWorkerLease(db.prisma, run.id, ready.fence);
      const recovered = await worker(run.id, "callback-new");
      const resumed = await recovered.waitFor("reached", "runtime-entered");
      expect(resumed.fence).toBeGreaterThan(ready.fence);
      const before = await ledgerSnapshot(db.prisma, space.id, []);
      const steeringBefore = await db.prisma.steeringMessage.findMany({ where: { botId: bot.id } });
      const eventsBefore = await db.prisma.event.findMany({ where: { runId: run.id } });
      const messagesBefore = await db.prisma.message.findMany({ where: { threadId: thread.id } });
      await first.release(ready);
      const rejected = await first.waitFor("reached", "stale-callback-rejected");
      expect(rejected.fence).toBe(ready.fence);
      expect(await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: "running",
        leaseOwner: "callback-new",
        leaseFence: resumed.fence,
        segmentCheckpoint: checkpoint,
      });
      expect(await db.prisma.steeringMessage.findMany({ where: { botId: bot.id } })).toEqual(
        steeringBefore,
      );
      expect(await db.prisma.event.findMany({ where: { runId: run.id } })).toEqual(eventsBefore);
      expect(await db.prisma.message.findMany({ where: { threadId: thread.id } })).toEqual(
        messagesBefore,
      );
      assertLedgerUnchanged(before, await ledgerSnapshot(db.prisma, space.id, []));
      await first.release(rejected);
      await first.drain();
      await recovered.release(resumed);
      await recovered.drain();
      expect(await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: "completed",
      });
    }, 60_000);
  }

  it("fences an old worker held immediately before the intended-effect claim", async () => {
    const { run, space } = await fixture();
    const first = await worker(run.id, "claim-old", {
      RAK_FAULT_EFFECT: "1",
      RAK_FAULT_PRE_CLAIM: "1",
    });
    const entered = await first.waitFor("reached", "runtime-entered");
    await first.release(entered);
    const ready = await first.waitFor("reached", "before-effect-claim");
    const effects = await db.prisma.externalEffect.findMany({ where: { runId: run.id } });
    expect(effects).toHaveLength(1);
    expect(effects[0]!.status).toBe("intended");
    await expireWorkerLease(db.prisma, run.id, ready.fence);
    const recovered = await worker(run.id, "claim-new", { RAK_FAULT_EFFECT: "1" });
    const resumed = await recovered.waitFor("reached", "runtime-entered");
    expect(resumed.fence).toBeGreaterThan(ready.fence);
    const calls = [`${run.id}-${ready.fence}`];
    const before = await ledgerSnapshot(db.prisma, space.id, calls);
    await first.release(ready);
    await first.drain();
    assertLedgerUnchanged(before, await ledgerSnapshot(db.prisma, space.id, calls));
    expect(await db.prisma.externalEffect.findMany({ where: { runId: run.id } })).toEqual(effects);
    expect(await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "running",
      leaseOwner: "claim-new",
      leaseFence: resumed.fence,
    });
    await recovered.release(resumed);
    await recovered.drain();
    expect(await db.prisma.externalEffect.findMany({ where: { runId: run.id } })).toEqual(effects);
    expect(await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "waiting_input",
    });
  }, 60_000);

  for (const dispatched of [false, true]) {
    it(`prevents replay of ${dispatched ? "received" : "undispatched"} effects after real worker death`, async () => {
      const { run, space } = await fixture();
      let receives = 0;
      const receiver = createServer((request, response) => {
        request.resume();
        request.on("end", () => {
          receives++;
          response.end("ok");
        });
      });
      await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
      const address = receiver.address();
      if (!address || typeof address === "string") throw new Error("Missing receiver address");
      const env = {
        RAK_FAULT_EFFECT: "1",
        RAK_FAULT_BEFORE_DISPATCH: dispatched ? "0" : "1",
        RAK_FAULT_RECEIVER: `http://127.0.0.1:${address.port}`,
      };
      try {
        const first = await worker(run.id, "effect-old", env);
        const entered = await first.waitFor("reached", "runtime-entered");
        await first.release(entered);
        const boundary = await first.waitFor(
          "reached",
          dispatched ? "effect-received-before-result" : "intent-committed-before-dispatch",
        );
        expect(receives).toBe(dispatched ? 1 : 0);
        await first.kill();
        await expireWorkerLease(db.prisma, run.id, boundary.fence);
        const recovered = await worker(run.id, "effect-new", env);
        const resumed = await recovered.waitFor("reached", "runtime-entered");
        expect(resumed.fence).toBeGreaterThan(boundary.fence);
        const baseline = await ledgerSnapshot(db.prisma, space.id, []);
        expect(baseline.effects).toHaveLength(1);
        expect(baseline.effects[0]!.status).toBe(dispatched ? "uncertain" : "intended");
        await expect(
          db.prisma.$transaction(async (tx) => {
            await assertExecutionFence(tx, {
              runId: run.id,
              leaseOwner: "effect-old",
              leaseFence: boundary.fence,
            });
            return completeExternalEffect(tx, baseline.effects[0]!.id, "executing", { late: true });
          }),
        ).rejects.toThrow("Run execution fence is no longer current");
        assertLedgerUnchanged(baseline, await ledgerSnapshot(db.prisma, space.id, []));
        await recovered.release(resumed);
        const drained = recovered.drain();
        if (!dispatched) {
          const outcome = await Promise.race([
            drained.then(() => "drained"),
            recovered.waitFor("reached", "effect-received-before-result").then(
              () => "unauthorized-dispatch",
              () => drained.then(() => "drained"),
            ),
          ]);
          expect(outcome, "An intended effect requires approval before recovery dispatch").toBe(
            "drained",
          );
          expect(receives).toBe(0);
          expect(await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
            status: "waiting_input",
          });
        }
        await drained;
        const after = await ledgerSnapshot(db.prisma, space.id, []);
        expect(after.effects).toHaveLength(1);
        expect(after.effects[0]!.status).toBe(dispatched ? "uncertain" : "intended");
        expect(receives).toBe(dispatched ? 1 : 0);
        const calls = new Map([
          [`${run.id}-${boundary.fence}`, 125000n],
          [`${run.id}-${resumed.fence}`, 125000n],
        ]);
        assertUniqueBilling(await ledgerSnapshot(db.prisma, space.id, [...calls.keys()]), calls);
        expect(after.usage).toHaveLength(0);
        expect(after.settlements).toHaveLength(0);
        expect(
          await db.prisma.event.count({
            where: { runId: run.id, type: "effect.reconciled" },
          }),
        ).toBeGreaterThan(0);
      } finally {
        await new Promise<void>((resolve, reject) =>
          receiver.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }, 60_000);
  }
});
