import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime } from "@rakazo/adapter-kit";
import {
  createRunExecutor,
  EncryptedSecretStore,
  FakeSandboxProvider,
  LocalAgentHomeStore,
  recordEffect,
  runCliProcess,
} from "@rakazo/adapters";
import { toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import {
  createDb,
  createThreadEvents,
  reserveBudget,
  settleBudget,
  startBudgetReservation,
} from "@rakazo/db";
import { faultWorkerChannel, requirePrivateDatabase } from "./worker-fault-harness.js";

const config = JSON.parse(process.env.RAK_FAULT_CONFIG!);
requirePrivateDatabase(config.databaseUrl);
const db = createDb(config.databaseUrl);
const dataDir = await mkdtemp(join(tmpdir(), "rak-fault-worker-"));
const identity = { ...config, attemptId: null as string | null, fence: 0 };
delete identity.databaseUrl;
let running: Promise<void> = Promise.resolve();
const channel = faultWorkerChannel(identity, async () => {
  await running;
  await db.prisma.$disconnect();
  await db.pool.end();
  await rm(dataDir, { recursive: true, force: true });
});
async function boundary(name: string) {
  const run = await db.prisma.run.findUniqueOrThrow({ where: { id: config.runId } });
  const attempt = await db.prisma.attempt.findFirst({
    where: { runId: run.id, fence: run.leaseFence },
    orderBy: { id: "desc" },
  });
  await channel.barrier(name, { fence: run.leaseFence, attemptId: attempt?.id ?? null });
}
const sandbox = new FakeSandboxProvider();
if (process.env.RAK_FAULT_LOW_DISK === "1") {
  const execute = sandbox.execute.bind(sandbox);
  sandbox.execute = async function* (computer, request, context) {
    if (request.argv[0] === "python3" && request.argv[1] === "-c") {
      yield {
        type: "stdout",
        data: JSON.stringify(
          request.argv.slice(3).map((path) => ({
            path,
            fsId: "private-low-disk",
            bavail: "1",
            frsize: "4096",
            availBytes: "4096",
            sampledAt: Date.now(),
          })),
        ),
      };
      yield { type: "exit", code: 0 };
      return;
    }
    yield* execute(computer, request, context);
  };
}
const memory = {
  describe: () => ({
    id: "fault-memory",
    contractVersion: "1",
    adapterVersion: "1",
    capabilities: { search: false, revisions: false, markdownPortable: false },
  }),
  read: async () => ({ documents: [] }),
  search: async () => [],
  importMarkdown: async () => ({
    id: "synthetic-revision",
    path: "MEMORY.md",
    revision: 1,
    content: "Synthetic fixture",
  }),
  exportMarkdown: async function* () {},
  commit: async () => {
    if (process.env.RAK_FAULT_PRE_CLAIM === "1")
      await channel.barrier("unauthorized-stale-dispatch");
    // Private simulated external receiver; the controller owns its receive log.
    const receiver = process.env.RAK_FAULT_RECEIVER;
    if (receiver) {
      const url = new URL(receiver);
      if (url.hostname !== "127.0.0.1" || !url.port || url.port === "5432")
        throw new Error("Receiver must be a private loopback fixture");
      await fetch(url, { method: "POST", body: "synthetic-effect" });
      await boundary("effect-received-before-result");
    }
    return {
      id: "synthetic-revision",
      path: "MEMORY.md",
      revision: 1,
      content: "Synthetic fixture",
    };
  },
};
const runtime: AgentRuntime = {
  describe: () => ({
    id: "fault-fixture",
    contractVersion: "1",
    adapterVersion: "1",
    capabilities: { scripted: false, streaming: true, compaction: false, tools: true },
  }),
  abort: async () => undefined,
  async *run(request) {
    if (request.runId.endsWith(":auto-review")) {
      if (request.model.provider === "openai" || process.env.RAK_FAULT_REVIEW_QUOTA === "all")
        throw Object.assign(new Error("Synthetic reviewer quota exhausted"), {
          code: "insufficient_quota",
          status: 429,
        });
      if (request.model.provider !== "anthropic") throw new Error("Unexpected reviewer identity");
      const callId = `${request.runId}:billable`;
      const scope = request.budgetScope!;
      const reserved = await reserveBudget(db.prisma, {
        ...scope,
        callId,
        amountMicroUsd: 250000n,
      });
      if (!reserved.ok) throw new Error("Synthetic reviewer budget refused");
      await startBudgetReservation(db.prisma, { ...scope, callId });
      await request.onUsage!({
        type: "usage",
        provider: "anthropic",
        model: "synthetic-review",
        callId,
        inputTokens: 10,
        outputTokens: 5,
        costUsdDecimal: "0.125",
        billingKind: "api",
      });
      await settleBudget(db.prisma, { ...scope, callId, actualMicroUsd: 125000n });
      yield {
        type: "done",
        text: JSON.stringify({ decision: "pass", reason: "Synthetic independent review" }),
      };
      return;
    }
    await boundary("runtime-entered");
    if (process.env.RAK_FAULT_DELAYED_STEERING === "1") {
      const messages = await request.claimSteering!([]);
      await request.onSteeringDelivered!(messages.map((item) => item.id));
      const applied = messages.map((message) => ({
        id: message.id,
        messageId: message.messageId,
        appliedAt: Date.now(),
      }));
      await request.onSegmentCheckpoint!(JSON.stringify(applied));
      if ((await request.claimSteering!(applied.map((item) => item.id))).length)
        throw new Error("Steering replayed after application");
      await channel.barrier("steering-applied");
      yield { type: "done", text: "Synthetic steering applied" };
      return;
    }
    if (process.env.RAK_FAULT_CLI_TIMEOUT === "1") {
      const executable = join(dataDir, "codex");
      await writeFile(
        executable,
        `#!${process.execPath}\nconsole.log("fixture-pid=" + process.pid); setInterval(() => {}, 1000);\n`,
        { mode: 0o700 },
      );
      process.env.PATH = `${dataDir}:${process.env.PATH}`;
      process.env.DATA_DIR = dataDir;
      await runCliProcess({
        provider: "codex-cli",
        profileId: randomUUID(),
        args: [],
        timeoutMs: 500,
        onOutput: async (text) => {
          const pid = text.match(/fixture-pid=(\d+)/)?.[1];
          if (pid) await request.onSegmentCheckpoint!(JSON.stringify({ cliPid: Number(pid) }));
        },
      });
      throw new Error("CLI timeout fixture unexpectedly completed");
    }
    const scenario = process.env.RAK_FAULT_STALE_CALLBACK;
    if (scenario) {
      if (scenario === "checkpoint") {
        await request.onSegmentCheckpoint!("synthetic-current-checkpoint");
      }
      const steering = scenario === "steering" ? await request.claimSteering!([]) : [];
      if (scenario === "steering" && steering.length !== 1)
        throw new Error("Expected one synthetic steering message");
      await channel.barrier("callback-ready");
      if (scenario === "steering" && (await request.claimSteering!([])).length !== 0)
        throw new Error("Stale steering claim succeeded");
      try {
        if (scenario === "checkpoint")
          await request.onSegmentCheckpoint!("synthetic-stale-checkpoint");
        else await request.onSteeringDelivered!(steering.map((item) => item.id));
        throw new Error("Stale callback succeeded");
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes("Run execution fence is no longer current")
        )
          throw error;
      }
      await channel.barrier("stale-callback-rejected");
      return;
    }
    if (!request.budgetScope) throw new Error("Fixture requires budget scope");
    const callId = `${config.runId}-${identity.fence}`;
    const scope = request.budgetScope;
    const reservation = await reserveBudget(db.prisma, {
      ...scope,
      callId,
      amountMicroUsd: 250000n,
    });
    if (!reservation.ok) throw new Error("Synthetic fixture budget refused");
    await startBudgetReservation(db.prisma, { ...scope, callId });
    await request.onUsage!({
      type: "usage",
      provider: "synthetic",
      model: "offline",
      callId,
      inputTokens: 10,
      outputTokens: 5,
      costUsdDecimal: "0.125",
      billingKind: "api",
    });
    await settleBudget(db.prisma, { ...scope, callId, actualMicroUsd: 125000n });
    if (process.env.RAK_FAULT_USAGE_BARRIER === "1") await boundary("usage-committed");
    if (process.env.RAK_FAULT_REVIEW_QUOTA) {
      await request.executeTool!(
        "forget_secret",
        { name: "synthetic-absent-credential" },
        "review-effect",
      );
    }
    if (process.env.RAK_FAULT_EFFECT === "1") {
      if (process.env.RAK_FAULT_BEFORE_DISPATCH === "1" && config.instanceId === "effect-old") {
        const run = await db.prisma.run.findUniqueOrThrow({ where: { id: config.runId } });
        const args = { path: "MEMORY.md", content: "Synthetic worker fault fixture" };
        await recordEffect(
          executorDeps,
          {
            ...run,
            executionFence: {
              runId: run.id,
              leaseOwner: config.instanceId,
              leaseFence: identity.fence,
            },
          },
          "remember",
          toolEffectIdempotencyKey(run.id, "remember", args, 0),
          args,
        );
        await boundary("intent-committed-before-dispatch");
      }
      await request.executeTool!(
        "remember",
        {
          path: "MEMORY.md",
          content: "Synthetic worker fault fixture",
        },
        "fault-effect",
      );
    }
    yield { type: "done", text: "Synthetic completion" };
  },
};
const executorDeps: Parameters<typeof createRunExecutor>[0] = {
  beforeEffectClaim:
    process.env.RAK_FAULT_PRE_CLAIM === "1"
      ? () => channel.barrier("before-effect-claim")
      : undefined,
  prisma: db.prisma,
  events: createThreadEvents(db.prisma),
  sandbox,
  home: new LocalAgentHomeStore(dataDir),
  memory,
  memoryProviders: { resolve: async () => null },
  runtime,
  secrets: [],
  secretStore: new EncryptedSecretStore("synthetic-fault-fixture-key"),
  jobs: {
    enqueue: async () => undefined,
    cancel: async () => undefined,
    close: async () => undefined,
  },
};
const executor = createRunExecutor(executorDeps);
channel.ready();
running = executor.continueRun(config.runId, config.instanceId).catch(() => {
  channel.error();
  process.exitCode = 1;
});
