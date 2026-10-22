import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime } from "@rakazo/adapter-kit";
import {
  createRunExecutor,
  EncryptedSecretStore,
  FakeSandboxProvider,
  LocalAgentHomeStore,
  recordEffect,
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
    await boundary("runtime-entered");
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
