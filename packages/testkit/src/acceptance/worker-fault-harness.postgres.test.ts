import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { EncryptedSecretStore } from "@rakazo/adapters";
import { assertExecutionFence, createDb, createThreadEvents, setProjectBudget } from "@rakazo/db";
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
  for (const quota of ["first", "all"]) {
    it(`routes reviewer quota (${quota}) through independent failover or explicit pause`, async () => {
      const { run, space, bot, id } = await fixture();
      await db.prisma.user.create({
        data: { id, name: "Synthetic fixture", email: `${id}@example.invalid` },
      });
      await db.prisma.actionAutoReviewPreference.create({
        data: { spaceId: space.id, userId: id, enabled: true },
      });
      const store = new EncryptedSecretStore("synthetic-fault-fixture-key");
      for (const provider of ["openai", "anthropic"]) {
        const sealed = await store.put("synthetic-offline-placeholder", {
          operationId: "fixture",
          traceId: "fixture",
          spaceId: space.id,
          userId: id,
          signal: new AbortController().signal,
        });
        await db.prisma.secret.create({
          data: { id: sealed.id, userId: id, kind: "model", ciphertext: sealed.ciphertext! },
        });
        await db.prisma.userModelCredential.create({
          data: { userId: id, provider, label: "Synthetic reviewer", secretId: sealed.id },
        });
      }
      await db.prisma.botBackupModel.create({
        data: { botId: bot.id, provider: "anthropic", modelId: "synthetic-review", position: 0 },
      });
      const reviewing = await worker(run.id, `quota-${quota}`, {
        RAK_FAULT_REVIEW_QUOTA: quota,
        RAKAZO_AUTO_REVIEW_PROVIDER: "openai",
        RAKAZO_AUTO_REVIEW_MODEL: "synthetic-review",
      });
      const entered = await reviewing.waitFor("reached", "runtime-entered");
      await reviewing.release(entered);
      expect(await reviewing.drain()).toEqual({ code: 0, signal: null });
      const events = await db.prisma.event.findMany({
        where: { runId: run.id, type: "effect.recorded" },
        orderBy: { seq: "asc" },
      });
      const attempts = events
        .map((event) => event.payload as Record<string, unknown>)
        .filter((payload) => payload.kind === "auto_review.attempt");
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toMatchObject({
        provider: "openai",
        failureClass: "quota",
        disposition: "switch",
      });
      expect(attempts[1]).toMatchObject({
        provider: "anthropic",
        disposition: quota === "first" ? "pass" : "ask",
      });
      expect(attempts.every((item) => item.provider !== item.primaryProvider)).toBe(true);
      expect(await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: quota === "first" ? "completed" : "waiting_input",
      });
      const calls = new Map([[`${run.id}-${entered.fence}`, 125000n]]);
      if (quota === "first") calls.set(`${attempts[1]!.usageKey}:auto-review:billable`, 125000n);
      assertUniqueBilling(await ledgerSnapshot(db.prisma, space.id, [...calls.keys()]), calls);
      const effects = await db.prisma.externalEffect.findMany({ where: { runId: run.id } });
      expect(effects).toHaveLength(1);
      expect(effects[0]!.reviewDecision).toBe(quota === "first" ? "pass" : "ask");
    }, 60_000);
  }

  it("terminates a real CLI child at the turn deadline and persists failure without billing", async () => {
    const { run, space } = await fixture();
    const timed = await worker(run.id, "cli-timeout", { RAK_FAULT_CLI_TIMEOUT: "1" });
    const entered = await timed.waitFor("reached", "runtime-entered");
    await timed.release(entered);
    expect(await timed.drain()).toEqual({ code: 0, signal: null });
    const failed = await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(failed).toMatchObject({
      status: "failed",
      error: expect.stringContaining("CLI request timed out"),
    });
    const { cliPid } = JSON.parse(JSON.parse(failed.segmentCheckpoint!).runtime) as {
      cliPid: number;
    };
    expect(cliPid).toBeGreaterThan(0);
    expect(() => process.kill(cliPid, 0)).toThrow();
    expect(await db.prisma.attempt.count({ where: { runId: run.id } })).toBe(1);
    const ledger = await ledgerSnapshot(db.prisma, space.id, []);
    expect(ledger.usage).toHaveLength(0);
    expect(ledger.settlements).toHaveLength(0);
    expect(ledger.effects).toHaveLength(0);
    expect(await db.prisma.budgetReservation.count({ where: { spaceId: space.id } })).toBe(0);
  }, 60_000);

  it("applies 20 delayed steering messages once in order across crash recovery", async () => {
    const { run, space, bot, thread, id } = await fixture();
    const env = { RAK_FAULT_DELAYED_STEERING: "1" };
    const first = await worker(run.id, "steering-before", env);
    const entered = await first.waitFor("reached", "runtime-entered");
    const messageIds: string[] = [];
    for (let seq = 1; seq <= 20; seq++) {
      const message = await db.prisma.message.create({
        data: {
          threadId: thread.id,
          seq,
          role: "user",
          blocks: [{ kind: "text", text: `Synthetic instruction ${seq}` }],
        },
      });
      messageIds.push(message.id);
      await createThreadEvents(db.prisma).append({
        spaceId: space.id,
        threadId: thread.id,
        botId: bot.id,
        type: "thread.message.created",
        payload: { messageId: message.id },
      });
      await db.prisma.steeringMessage.create({
        data: {
          messageId: message.id,
          botId: bot.id,
          userId: id,
          runId: run.id,
        },
      });
    }
    await first.kill();
    await expireWorkerLease(db.prisma, run.id, entered.fence);
    const recovered = await worker(run.id, "steering-after", env);
    const resumed = await recovered.waitFor("reached", "runtime-entered");
    await recovered.release(resumed);
    const appliedBoundary = await recovered.waitFor("reached", "steering-applied");
    const saved = await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    const applied = JSON.parse(JSON.parse(saved.segmentCheckpoint!).runtime) as {
      id: string;
      messageId: string;
      appliedAt: number;
    }[];
    expect(applied.map((item) => item.messageId)).toEqual(messageIds);
    expect(new Set(applied.map((item) => item.id)).size).toBe(20);
    const delivered = await db.prisma.event.findMany({
      where: { runId: run.id, type: "steering.delivered" },
      orderBy: { seq: "asc" },
    });
    expect(delivered).toHaveLength(20);
    const samples = delivered.map((event, index) => {
      const payload = event.payload as {
        messageId: string;
        receivedAt: string;
        messageSeq: number;
      };
      expect(payload.messageId).toBe(applied[index]!.messageId);
      expect(payload.messageSeq).toBe(index + 1);
      return {
        messageId: payload.messageId,
        runId: run.id,
        sequence: payload.messageSeq,
        arrivalToDeliveryMs: event.createdAt.getTime() - Date.parse(payload.receivedAt),
        deliveryToApplicationMs: applied[index]!.appliedAt - event.createdAt.getTime(),
      };
    });
    const total = samples
      .map((sample) => sample.arrivalToDeliveryMs + sample.deliveryToApplicationMs)
      .sort((a, b) => a - b);
    expect(total[9]).toBeLessThanOrEqual(120_000);
    expect(total[18]).toBeLessThanOrEqual(600_000);
    expect(total[19]).toBeLessThanOrEqual(1_800_000);
    console.log(
      JSON.stringify({
        scenario: "delayed-steering",
        units: "ms",
        n: 20,
        p50: total[9],
        p95: total[18],
        max: total[19],
        samples,
      }),
    );
    await recovered.release(appliedBoundary);
    expect(await recovered.drain()).toEqual({ code: 0, signal: null });
    expect(await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "completed",
    });
  }, 60_000);

  it("low disk fails the claimed Run before model calls, billing or effects", async () => {
    const { run, space } = await fixture();
    const refused = await worker(run.id, "low-disk", { RAK_FAULT_LOW_DISK: "1" });
    expect(await refused.drain()).toEqual({ code: 0, signal: null });
    expect(refused.events.filter((event) => event.boundary === "runtime-entered")).toHaveLength(0);
    expect(await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "failed",
      error: expect.stringContaining("storage_low"),
    });
    expect(await db.prisma.attempt.count({ where: { runId: run.id } })).toBe(1);
    const refusal = await db.prisma.event.findMany({
      where: { runId: run.id, type: "run.storage_refused" },
    });
    expect(refusal).toHaveLength(1);
    expect(refusal[0]!.payload).toMatchObject({ reason: "storage_low", allowed: false });
    const ledger = await ledgerSnapshot(db.prisma, space.id, []);
    expect(ledger.usage).toHaveLength(0);
    expect(ledger.settlements).toHaveLength(0);
    expect(ledger.effects).toHaveLength(0);
    expect(await db.prisma.budgetReservation.count({ where: { spaceId: space.id } })).toBe(0);
  }, 60_000);

  it("orderly drain and restart preserve completed billing without replay", async () => {
    const { run, space } = await fixture();
    const first = await worker(run.id, "orderly-before");
    const entered = await first.waitFor("reached", "runtime-entered");
    await first.release(entered);
    const exit = await first.drain();
    expect(exit).toEqual({ code: 0, signal: null });
    expect(first.events.filter((event) => event.kind === "drained")).toHaveLength(1);
    expect(await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "completed",
    });
    const calls = new Map([[`${run.id}-${entered.fence}`, 125000n]]);
    const before = await ledgerSnapshot(db.prisma, space.id, [...calls.keys()]);
    assertUniqueBilling(before, calls);
    const restarted = await worker(run.id, "orderly-after");
    await restarted.drain();
    expect(restarted.events.filter((event) => event.boundary === "runtime-entered")).toHaveLength(
      0,
    );
    assertLedgerUnchanged(before, await ledgerSnapshot(db.prisma, space.id, [...calls.keys()]));
    expect(await db.prisma.attempt.count({ where: { runId: run.id } })).toBe(1);
  }, 60_000);

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
