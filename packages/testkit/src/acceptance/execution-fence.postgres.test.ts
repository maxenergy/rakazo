import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  appendEventInTransaction,
  clearThread,
  createDb,
  createThreadMessageInTransaction,
  finalizeRun as finalizeRunInDb,
  pauseRunForBudget,
  pauseRunForInput,
  recordUsage,
  reserveBudget,
  setProjectBudget,
  settleBudget,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { messageBot } from "../../../adapters/src/bot-messages.js";
import { forgetBotSecret } from "../../../adapters/src/bot-secrets.js";
import { spawnBot } from "../../../adapters/src/child-bots.js";
import { executeDependencyTool } from "../../../adapters/src/dependency-tools.js";
import { createRunExecutor, recoverUnfinishedEffects } from "../../../adapters/src/executor.js";
import { executeGoalTool } from "../../../adapters/src/goal-tools.js";
import {
  cancelScheduleFromTool,
  createScheduleFromTool,
} from "../../../adapters/src/schedule-tools.js";
import {
  addScratchpadItemFromTool,
  completeScratchpadItemFromTool,
  removeScratchpadItemFromTool,
  updateScratchpadItemFromTool,
} from "../../../adapters/src/scratchpad-tools.js";
import {
  commentTicket,
  createTicket,
  getTicket,
  listBoardTickets,
  updateTicket,
} from "../../../adapters/src/ticket-tools.js";
import { requestOverrunApproval } from "../../../db/src/budget-overrun-approvals.js";
import { createGroupRepos } from "../../../db/src/groups.js";
import { createProposal, decideProposal } from "../../../db/src/proposals.js";
import { MarkdownMemoryStore } from "../../../memory/src/index.js";
import {
  type DisposableCluster,
  postgresAvailable,
  startDisposableCluster,
} from "./disposable-postgres.js";

vi.mock("../../../adapters/src/computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "synthetic-computer", kind: "desktop" }),
}));

async function waitForConfirmedBlocking(
  prisma: any,
  holderPid: number,
  expectedWaiter: () => number,
) {
  expect(holderPid).toBeGreaterThan(0);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT pid, wait_event_type, pg_blocking_pids(pid) AS blockers
       FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND $1::integer = ANY(pg_blocking_pids(pid)) AND pid = $2::integer`,
      holderPid,
      expectedWaiter(),
    );
    if (rows.length) {
      expect(rows[0].pid).toBe(expectedWaiter());
      expect(rows[0].pid).not.toBe(holderPid);
      expect(rows[0].blockers).toContain(holderPid);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`PostgreSQL did not confirm a lock waiter blocked by PID ${holderPid}`);
}

const available = postgresAvailable();
if (process.env.RAK_REQUIRE_PG === "1" && !available)
  throw new Error("RAK_REQUIRE_PG=1 but PostgreSQL binaries are unavailable");
describe.skipIf(!available)("execution fence PostgreSQL acceptance", () => {
  let cluster: DisposableCluster;
  let db: ReturnType<typeof createDb>;
  let dbUrl: string;
  beforeAll(async () => {
    cluster = await startDisposableCluster();
    const database = await cluster.createDatabase("execution_fence");
    await cluster.migrate(database);
    dbUrl = cluster.url(database);
    db = createDb(dbUrl);
  }, 60_000);
  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.pool.end();
    await cluster?.stop();
  });
  it("fences artifact metadata and cleans rejected stored bytes in PostgreSQL", async () => {
    const id = `dispatch-${randomUUID()}`;
    const org = await db.prisma.organization.create({
      data: { id, slug: id, name: "Synthetic dispatch fixture", createdAt: new Date() },
    });
    const space = await db.prisma.space.create({
      data: { id: `${id}-space`, organizationId: org.id, name: "Synthetic dispatch" },
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
        prompt: "Synthetic dispatch acceptance",
        status: "running",
      },
    });
    const run = await db.prisma.run.create({
      data: {
        spaceId: space.id,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: id,
        trigger: "user",
        status: "queued",
      },
    });
    await db.prisma.user.create({
      data: { id, name: "Synthetic owner", email: `${id}@example.invalid` },
    });
    await db.prisma.member.create({
      data: {
        id: `${id}-member`,
        organizationId: org.id,
        userId: id,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await db.prisma.spaceMember.create({
      data: {
        id: `${id}-space-member`,
        spaceId: space.id,
        organizationId: org.id,
        userId: id,
        createdAt: new Date(),
      },
    });

    const { attachWorkspaceFileToThread } = await import(
      "../../../adapters/src/thread-artifacts.js"
    );
    await db.prisma.run.update({
      where: { id: run.id },
      data: {
        status: "running",
        leaseOwner: "artifact-owner",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60000),
      },
    });
    const executionFence = { runId: run.id, leaseOwner: "artifact-owner", leaseFence: 1 };
    const remove = vi.fn(async () => undefined);
    let stored = 0;
    const artifacts = {
      put: vi.fn(async () => ({
        id: `artifact-storage-${id}-${++stored}`,
        hash: "synthetic-hash",
      })),
      remove,
    } as any;
    const input = {
      spaceId: space.id,
      userId: id,
      botId: bot.id,
      runId: run.id,
      filePath: "report.txt",
      bytes: new Uint8Array([65]),
      operationId: `${id}-attach`,
      executionFence,
    };
    await attachWorkspaceFileToThread({ prisma: db.prisma, artifacts }, input);
    const before = await db.prisma.artifact.findMany({ where: { spaceId: space.id } });
    expect(before).toHaveLength(1);
    const stopped = new Error("artifact: after real claim");
    const claimPrisma = new Proxy(db.prisma, {
      get(target, key) {
        if (key === "bot")
          return {
            findUniqueOrThrow: async () => {
              throw stopped;
            },
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const executor = createRunExecutor({ prisma: claimPrisma } as unknown as Parameters<
      typeof createRunExecutor
    >[0]);
    await db.prisma.run.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(0) } });
    await expect(executor.continueRun(run.id, "replacement-owner")).rejects.toBe(stopped);
    expect(await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "running",
      leaseOwner: "replacement-owner",
      leaseFence: executionFence.leaseFence + 1,
    });
    await expect(
      attachWorkspaceFileToThread({ prisma: db.prisma, artifacts }, input),
    ).rejects.toThrow("Run execution fence is no longer current");
    expect(await db.prisma.artifact.findMany({ where: { spaceId: space.id } })).toEqual(before);
    expect(remove).toHaveBeenCalledWith(
      `artifact-storage-${id}-2`,
      expect.objectContaining({ spaceId: space.id }),
    );
  }, 30000);

  it("executes a child once after a stale extra enqueue races with takeover", async () => {
    const id = `dispatch-${randomUUID()}`;
    const org = await db.prisma.organization.create({
      data: { id, slug: id, name: "Synthetic dispatch fixture", createdAt: new Date() },
    });
    const space = await db.prisma.space.create({
      data: { id: `${id}-space`, organizationId: org.id, name: "Synthetic dispatch" },
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
        prompt: "Synthetic dispatch acceptance",
        status: "running",
      },
    });
    const run = await db.prisma.run.create({
      data: {
        spaceId: space.id,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: id,
        trigger: "user",
        status: "queued",
      },
    });
    await db.prisma.user.create({
      data: { id, name: "Synthetic owner", email: `${id}@example.invalid` },
    });
    await db.prisma.member.create({
      data: {
        id: `${id}-member`,
        organizationId: org.id,
        userId: id,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await db.prisma.spaceMember.create({
      data: {
        id: `${id}-space-member`,
        spaceId: space.id,
        organizationId: org.id,
        userId: id,
        createdAt: new Date(),
      },
    });
    const stop = new Error("claimed source");
    const claimPrisma = new Proxy(db.prisma, {
      get(target, key) {
        if (key === "bot")
          return {
            findUniqueOrThrow: async () => {
              throw stop;
            },
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const sourceExecutor = createRunExecutor({ prisma: claimPrisma } as unknown as Parameters<
      typeof createRunExecutor
    >[0]);
    await expect(sourceExecutor.continueRun(run.id, "source-old")).rejects.toBe(stop);
    const source = await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    const executionFence = {
      runId: run.id,
      leaseOwner: source.leaseOwner!,
      leaseFence: source.leaseFence,
    };
    let enqueueReached!: () => void;
    let releaseEnqueue!: () => void;
    const reachedEnqueue = new Promise<void>((resolve) => {
      enqueueReached = resolve;
    });
    const enqueueBarrier = new Promise<void>((resolve) => {
      releaseEnqueue = resolve;
    });
    const wakeups: string[] = [];
    const spawning = spawnBot(
      {
        prisma: db.prisma,
        jobs: {
          enqueue: async () => {
            enqueueReached();
            await enqueueBarrier;
            wakeups.push("wake");
          },
        } as any,
      },
      {
        spawnedBy: { id: bot.id, name: bot.name, spaceId: space.id, userId: id },
        runId: run.id,
        executionFence,
        spawnKey: `${id}-child`,
        name: "Race child",
        prompt: "Synthetic race",
      },
    );
    await Promise.race([
      reachedEnqueue,
      spawning.then(() => {
        throw new Error("Missing enqueue barrier");
      }),
    ]);
    try {
      await db.prisma.run.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(0) } });
      await expect(sourceExecutor.continueRun(run.id, "source-new")).rejects.toBe(stop);
    } finally {
      releaseEnqueue();
    }
    const child = await spawning;
    if (!("botId" in child)) throw new Error("Expected child");
    const childBot = await db.prisma.bot.findUniqueOrThrow({ where: { id: child.botId } });
    const childRun = await db.prisma.run.findFirstOrThrow({ where: { botId: child.botId } });
    expect(wakeups).toHaveLength(1);
    let release!: () => void;
    let claimed!: (effectId: string) => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const claimReached = new Promise<string>((resolve) => {
      claimed = resolve;
    });
    const memoryCommit = vi.fn(async () => ({ revision: "synthetic-revision" }));
    const toolResults: unknown[] = [];
    const finalizeRun = vi.fn(async (input: Parameters<typeof finalizeRunInDb>[1]) =>
      finalizeRunInDb(db.prisma, input),
    );
    const prisma = new Proxy(db.prisma, {
      get(target, key) {
        if (key === "bot")
          return {
            findUniqueOrThrow: async () => ({
              ...childBot,
              computerId: "synthetic-computer",
              computer: { id: "synthetic-computer", scope: "dedicated" },
            }),
            findMany: async () => [],
          };
        if (key === "deploymentSettings")
          return {
            findUnique: async () => ({
              defaultModelProvider: "scripted",
              defaultModelId: "scripted",
            }),
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const executor = createRunExecutor({
      prisma,
      afterEffectClaim: async (effectId: string) => {
        claimed(effectId);
        await barrier;
      },
      runtime: {
        describe: () => ({ capabilities: { scripted: false } }),
        run: async function* (request: {
          executeTool?: (
            name: string,
            args: Record<string, unknown>,
            executionId: string,
          ) => Promise<unknown>;
        }) {
          toolResults.push(
            await request.executeTool!(
              "remember",
              { path: "MEMORY.md", content: "synthetic dispatch" },
              "dispatch-1",
            ),
          );
          yield { type: "done" as const, text: "Done" };
        },
      },
      connector: {
        discoverTools: async () => [],
        resolveCall: async () => undefined,
        execute: async function* () {},
      },
      sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
      memory: {
        describe: () => ({ capabilities: {} }),
        read: async () => ({ documents: [] }),
        search: async () => [],
        commit: memoryCommit,
        exportMarkdown: async function* () {},
      },
      memoryProviders: { resolve: async () => null },
      events: {
        append: vi.fn(async () => undefined),
        pauseRunForInput: vi.fn(async () => true),
        finalizeRun,
      },
      jobs: { enqueue: vi.fn(async () => undefined) },
      secrets: [],
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    const first = executor.continueRun(childRun.id, "child-first");
    await Promise.race([
      claimReached,
      first.then(() => {
        throw new Error("Missing child claim barrier");
      }),
    ]);
    const snapshot = async () => ({
      run: await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } }),
      thread: await db.prisma.thread.findUniqueOrThrow({ where: { id: thread.id } }),
      messages: await db.prisma.message.findMany({
        where: { threadId: thread.id },
        orderBy: { id: "asc" },
      }),
      events: await db.prisma.event.findMany({ where: { runId: run.id }, orderBy: { id: "asc" } }),
    });
    try {
      const before = await snapshot();
      await executor.continueRun(childRun.id, "child-duplicate");
      await expect(
        addScratchpadItemFromTool(
          { prisma: db.prisma, executionFence },
          { spaceId: space.id, botId: bot.id, title: "stale race write" },
        ),
      ).rejects.toThrow("Run execution fence is no longer current");
      expect(await snapshot()).toEqual(before);
      expect(await db.prisma.scratchpadItem.count({ where: { spaceId: space.id } })).toBe(0);
    } finally {
      release();
      await first;
    }
    expect(memoryCommit).toHaveBeenCalledTimes(1);
    expect(finalizeRun).toHaveBeenCalledTimes(1);
    expect(await db.prisma.run.findUniqueOrThrow({ where: { id: childRun.id } })).toMatchObject({
      status: "completed",
    });
    const completed = await db.prisma.run.findUniqueOrThrow({ where: { id: childRun.id } });
    await executor.continueRun(childRun.id, "child-terminal-duplicate");
    expect(await db.prisma.run.findUniqueOrThrow({ where: { id: childRun.id } })).toEqual(
      completed,
    );
    expect(memoryCommit).toHaveBeenCalledTimes(1);
  }, 30000);

  it("blocks dispatch after a real takeover at the committed claim barrier", async () => {
    const id = `dispatch-${randomUUID()}`;
    const org = await db.prisma.organization.create({
      data: { id, slug: id, name: "Synthetic dispatch fixture", createdAt: new Date() },
    });
    const space = await db.prisma.space.create({
      data: { id: `${id}-space`, organizationId: org.id, name: "Synthetic dispatch" },
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
        prompt: "Synthetic dispatch acceptance",
        status: "running",
      },
    });
    const run = await db.prisma.run.create({
      data: {
        spaceId: space.id,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: id,
        trigger: "user",
        status: "queued",
      },
    });
    let release!: () => void;
    let claimed!: (effectId: string) => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const claimReached = new Promise<string>((resolve) => {
      claimed = resolve;
    });
    const memoryCommit = vi.fn(async () => ({ revision: "synthetic-revision" }));
    const toolResults: unknown[] = [];
    const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
    const prisma = new Proxy(db.prisma, {
      get(target, key) {
        if (key === "bot")
          return {
            findUniqueOrThrow: async () => ({
              ...bot,
              computerId: "synthetic-computer",
              computer: { id: "synthetic-computer", scope: "dedicated" },
            }),
            findMany: async () => [],
          };
        if (key === "deploymentSettings")
          return {
            findUnique: async () => ({
              defaultModelProvider: "scripted",
              defaultModelId: "scripted",
            }),
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const executor = createRunExecutor({
      prisma,
      afterEffectClaim: async (effectId: string) => {
        claimed(effectId);
        await barrier;
      },
      runtime: {
        describe: () => ({ capabilities: { scripted: false } }),
        run: async function* (request: {
          executeTool?: (
            name: string,
            args: Record<string, unknown>,
            executionId: string,
          ) => Promise<unknown>;
        }) {
          toolResults.push(
            await request.executeTool!(
              "remember",
              { path: "MEMORY.md", content: "synthetic dispatch" },
              "dispatch-1",
            ),
          );
          yield { type: "done" as const, text: "Done" };
        },
      },
      connector: {
        discoverTools: async () => [],
        resolveCall: async () => undefined,
        execute: async function* () {},
      },
      sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
      memory: {
        describe: () => ({ capabilities: {} }),
        read: async () => ({ documents: [] }),
        search: async () => [],
        commit: memoryCommit,
        exportMarkdown: async function* () {},
      },
      memoryProviders: { resolve: async () => null },
      events: {
        append: vi.fn(async () => undefined),
        pauseRunForInput: vi.fn(async () => true),
        finalizeRun,
      },
      jobs: { enqueue: vi.fn(async () => undefined) },
      secrets: [],
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    const oldTurn = executor.continueRun(run.id, "old-dispatch-owner");
    // Propagate setup failures instead of hanging on a barrier never reached.
    const effectId = await Promise.race([
      claimReached,
      oldTurn.then(() => {
        throw new Error("Executor exited before the committed claim barrier");
      }),
    ]);
    try {
      expect(
        await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } }),
      ).toMatchObject({ status: "executing" });
      expect(memoryCommit).not.toHaveBeenCalled();
      await db.prisma.run.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(0) } });
      const stopped = new Error("test: takeover committed");
      const takeoverPrisma = new Proxy(db.prisma, {
        get(target, key) {
          if (key === "bot")
            return {
              findUniqueOrThrow: async () => {
                throw stopped;
              },
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const takeover = createRunExecutor({
        prisma: takeoverPrisma,
        sandbox: {},
      } as unknown as Parameters<typeof createRunExecutor>[0]);
      await expect(takeover.continueRun(run.id, "new-dispatch-owner")).rejects.toBe(stopped);
      expect(
        await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } }),
      ).toMatchObject({ status: "uncertain" });
    } finally {
      release();
      await oldTurn;
    }
    expect(memoryCommit).not.toHaveBeenCalled();
    expect(toolResults).toHaveLength(0);
    expect(finalizeRun).not.toHaveBeenCalled();
    expect(
      await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } }),
    ).toMatchObject({ status: "uncertain" });
    expect(
      await db.prisma.event.count({ where: { runId: run.id, type: "effect.reconciled" } }),
    ).toBe(1);
  }, 30000);

  it("rejects update_bot at its transaction boundary after real takeover", async () => {
    const id = `dispatch-${randomUUID()}`;
    const org = await db.prisma.organization.create({
      data: { id, slug: id, name: "Synthetic dispatch fixture", createdAt: new Date() },
    });
    const space = await db.prisma.space.create({
      data: { id: `${id}-space`, organizationId: org.id, name: "Synthetic dispatch" },
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
        prompt: "Synthetic dispatch acceptance",
        status: "running",
      },
    });
    const run = await db.prisma.run.create({
      data: {
        spaceId: space.id,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: id,
        trigger: "user",
        status: "queued",
      },
    });
    let release!: () => void;
    let claimed!: (effectId: string) => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const claimReached = new Promise<string>((resolve) => {
      claimed = resolve;
    });
    const memoryCommit = vi.fn(async () => ({ revision: "synthetic-revision" }));
    const toolResults: unknown[] = [];
    const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
    let armed = false;
    let intercepted = false;
    const prisma = new Proxy(db.prisma, {
      get(target, key) {
        if (key === "$transaction")
          return (callback: (tx: unknown) => Promise<unknown>, options?: unknown) =>
            target.$transaction(
              async (tx) =>
                callback(
                  new Proxy(tx, {
                    get(transaction, member) {
                      if (member === "$queryRaw")
                        return async (...args: unknown[]) => {
                          if (armed && !intercepted && String(args[0]).includes("FROM bots")) {
                            intercepted = true;
                            const effect = await db.prisma.externalEffect.findFirstOrThrow({
                              where: { runId: run.id },
                            });
                            claimed(effect.id);
                            await barrier;
                          }
                          return Reflect.apply(transaction.$queryRaw, transaction, args);
                        };
                      const value = Reflect.get(transaction, member);
                      return typeof value === "function" ? value.bind(transaction) : value;
                    },
                  }),
                ),
              options as never,
            );
        if (key === "bot")
          return {
            findUniqueOrThrow: async () => ({
              ...bot,
              computerId: "synthetic-computer",
              computer: { id: "synthetic-computer", scope: "dedicated" },
            }),
            findMany: async () => [],
          };
        if (key === "deploymentSettings")
          return {
            findUnique: async () => ({
              defaultModelProvider: "scripted",
              defaultModelId: "scripted",
            }),
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const executor = createRunExecutor({
      prisma,

      runtime: {
        describe: () => ({ capabilities: { scripted: false } }),
        run: async function* (request: {
          executeTool?: (
            name: string,
            args: Record<string, unknown>,
            executionId: string,
          ) => Promise<unknown>;
        }) {
          armed = true;
          toolResults.push(
            await request.executeTool!("update_bot", { title: "stale mutation" }, "dispatch-1"),
          );
          yield { type: "done" as const, text: "Done" };
        },
      },
      connector: {
        discoverTools: async () => [],
        resolveCall: async () => undefined,
        execute: async function* () {},
      },
      sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
      memory: {
        describe: () => ({ capabilities: {} }),
        read: async () => ({ documents: [] }),
        search: async () => [],
        commit: memoryCommit,
        exportMarkdown: async function* () {},
      },
      memoryProviders: { resolve: async () => null },
      events: {
        append: vi.fn(async () => undefined),
        pauseRunForInput: vi.fn(async () => true),
        finalizeRun,
      },
      jobs: { enqueue: vi.fn(async () => undefined) },
      secrets: [],
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    const oldTurn = executor.continueRun(run.id, "old-dispatch-owner");
    // Propagate setup failures instead of hanging on a barrier never reached.
    const effectId = await Promise.race([
      claimReached,
      oldTurn.then(() => {
        throw new Error("Executor exited before the committed claim barrier");
      }),
    ]);
    try {
      expect(
        await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } }),
      ).toMatchObject({ status: "executing" });
      expect(memoryCommit).not.toHaveBeenCalled();
      await db.prisma.run.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(0) } });
      const stopped = new Error("test: takeover committed");
      const takeoverPrisma = new Proxy(db.prisma, {
        get(target, key) {
          if (key === "bot")
            return {
              findUniqueOrThrow: async () => {
                throw stopped;
              },
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const takeover = createRunExecutor({
        prisma: takeoverPrisma,
        sandbox: {},
      } as unknown as Parameters<typeof createRunExecutor>[0]);
      await expect(takeover.continueRun(run.id, "new-dispatch-owner")).rejects.toBe(stopped);
      expect(
        await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } }),
      ).toMatchObject({ status: "uncertain" });
    } finally {
      release();
      await oldTurn;
    }
    expect(memoryCommit).not.toHaveBeenCalled();
    expect(toolResults).toHaveLength(0);
    expect(intercepted).toBe(true);
    expect(await db.prisma.bot.findUniqueOrThrow({ where: { id: bot.id } })).toEqual(bot);
    expect(finalizeRun).not.toHaveBeenCalled();
    expect(
      await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } }),
    ).toMatchObject({ status: "uncertain" });
    expect(
      await db.prisma.event.count({ where: { runId: run.id, type: "effect.reconciled" } }),
    ).toBe(1);
  }, 30000);

  it("rejects a late effect result after real takeover leaves it uncertain", async () => {
    const id = `dispatch-${randomUUID()}`;
    const org = await db.prisma.organization.create({
      data: { id, slug: id, name: "Synthetic dispatch fixture", createdAt: new Date() },
    });
    const space = await db.prisma.space.create({
      data: { id: `${id}-space`, organizationId: org.id, name: "Synthetic dispatch" },
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
        prompt: "Synthetic dispatch acceptance",
        status: "running",
      },
    });
    const run = await db.prisma.run.create({
      data: {
        spaceId: space.id,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: id,
        trigger: "user",
        status: "queued",
      },
    });
    let release!: () => void;
    let claimed!: (effectId: string) => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const claimReached = new Promise<string>((resolve) => {
      claimed = resolve;
    });
    const memoryCommit = vi.fn(async () => {
      claimed(claimedEffectId);
      await barrier;
      return { revision: "synthetic-revision" };
    });
    let claimedEffectId = "";
    const toolResults: unknown[] = [];
    const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
    const prisma = new Proxy(db.prisma, {
      get(target, key) {
        if (key === "bot")
          return {
            findUniqueOrThrow: async () => ({
              ...bot,
              computerId: "synthetic-computer",
              computer: { id: "synthetic-computer", scope: "dedicated" },
            }),
            findMany: async () => [],
          };
        if (key === "deploymentSettings")
          return {
            findUnique: async () => ({
              defaultModelProvider: "scripted",
              defaultModelId: "scripted",
            }),
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const executor = createRunExecutor({
      prisma,
      afterEffectClaim: async (effectId: string) => {
        claimedEffectId = effectId;
      },
      runtime: {
        describe: () => ({ capabilities: { scripted: false } }),
        run: async function* (request: {
          executeTool?: (
            name: string,
            args: Record<string, unknown>,
            executionId: string,
          ) => Promise<unknown>;
        }) {
          toolResults.push(
            await request.executeTool!(
              "remember",
              { path: "MEMORY.md", content: "synthetic dispatch" },
              "dispatch-1",
            ),
          );
          yield { type: "done" as const, text: "Done" };
        },
      },
      connector: {
        discoverTools: async () => [],
        resolveCall: async () => undefined,
        execute: async function* () {},
      },
      sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
      memory: {
        describe: () => ({ capabilities: {} }),
        read: async () => ({ documents: [] }),
        search: async () => [],
        commit: memoryCommit,
        exportMarkdown: async function* () {},
      },
      memoryProviders: { resolve: async () => null },
      events: {
        append: vi.fn(async () => undefined),
        pauseRunForInput: vi.fn(async () => true),
        finalizeRun,
      },
      jobs: { enqueue: vi.fn(async () => undefined) },
      secrets: [],
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    const oldTurn = executor.continueRun(run.id, "old-dispatch-owner");
    // Propagate setup failures instead of hanging on a barrier never reached.
    const effectId = await Promise.race([
      claimReached,
      oldTurn.then(() => {
        throw new Error("Executor exited before the dispatched effect barrier");
      }),
    ]);
    try {
      expect(
        await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } }),
      ).toMatchObject({ status: "executing" });
      expect(memoryCommit).toHaveBeenCalledTimes(1);
      await db.prisma.run.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(0) } });
      const stopped = new Error("test: takeover committed");
      const takeoverPrisma = new Proxy(db.prisma, {
        get(target, key) {
          if (key === "bot")
            return {
              findUniqueOrThrow: async () => {
                throw stopped;
              },
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const takeover = createRunExecutor({
        prisma: takeoverPrisma,
        sandbox: {},
      } as unknown as Parameters<typeof createRunExecutor>[0]);
      await expect(takeover.continueRun(run.id, "new-dispatch-owner")).rejects.toBe(stopped);
      expect(
        await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } }),
      ).toMatchObject({ status: "uncertain" });
    } finally {
      release();
      await oldTurn;
    }
    expect(memoryCommit).toHaveBeenCalledTimes(1);
    expect(toolResults).toHaveLength(0);
    expect(finalizeRun).not.toHaveBeenCalled();
    expect(
      await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } }),
    ).toMatchObject({ status: "uncertain" });
    expect(
      await db.prisma.event.count({ where: { runId: run.id, type: "effect.reconciled" } }),
    ).toBe(1);
  }, 30000);

  it("rejects the previous holder after takeover through continueRun", async () => {
    const id = `claim-${randomUUID()}`;
    const org = await db.prisma.organization.create({
      data: { id, slug: id, name: "Synthetic claim fixture", createdAt: new Date() },
    });
    const space = await db.prisma.space.create({
      data: { id: `${id}-space`, organizationId: org.id, name: "Synthetic claim" },
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
        prompt: "Synthetic claim acceptance",
        status: "running",
      },
    });
    const run = await db.prisma.run.create({
      data: {
        spaceId: space.id,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: id,
        trigger: "user",
        status: "queued",
      },
    });
    // Stop after the real claim and recovery commit, before computer/runtime setup.
    const stopped = new Error("test: after real claim");
    const prisma = new Proxy(db.prisma, {
      get(target, key) {
        if (key === "bot")
          return {
            findUniqueOrThrow: async () => {
              throw stopped;
            },
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const executor = createRunExecutor({ prisma, sandbox: {} } as unknown as Parameters<
      typeof createRunExecutor
    >[0]);
    await expect(executor.continueRun(run.id, "old-owner")).rejects.toBe(stopped);
    const old = await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(old).toMatchObject({ status: "running", leaseOwner: "old-owner" });
    await db.prisma.run.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(0) } });
    await expect(executor.continueRun(run.id, "new-owner")).rejects.toBe(stopped);
    const current = await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(current).toMatchObject({
      status: "running",
      leaseOwner: "new-owner",
      leaseFence: old.leaseFence + 1,
    });
    const executionFence = {
      runId: run.id,
      leaseOwner: old.leaseOwner!,
      leaseFence: old.leaseFence,
    };
    const staleDeps = { prisma: db.prisma, executionFence };
    const scope = { spaceId: space.id, botId: bot.id, userId: id };
    const staleError = "Run execution fence is no longer current";
    await expect(
      addScratchpadItemFromTool(staleDeps, { ...scope, title: "stale" }),
    ).rejects.toThrow(staleError);
    expect(await db.prisma.scratchpadItem.count({ where: { spaceId: space.id } })).toBe(0);
    const jobs = { enqueue: vi.fn(), cancel: vi.fn() };
    await expect(
      createScheduleFromTool({ ...staleDeps, jobs, events: { append: vi.fn() } } as any, {
        ...scope,
        threadId: thread.id,
        name: "stale",
        prompt: "stale",
        schedule: { delaySeconds: 60 },
      }),
    ).rejects.toThrow(staleError);
    expect(await db.prisma.routine.count({ where: { spaceId: space.id } })).toBe(0);
    expect(jobs.enqueue).not.toHaveBeenCalled();
    await expect(
      listBoardTickets({ ...staleDeps, ticketBoardEnabled: true }, { spaceId: space.id }),
    ).rejects.toThrow(staleError);
    expect(await db.prisma.board.count({ where: { spaceId: space.id } })).toBe(0);
    await expect(
      getTicket({ ...staleDeps, ticketBoardEnabled: true }, { spaceId: space.id, ref: "RAK-1" }),
    ).rejects.toThrow(staleError);
    expect(await db.prisma.board.count({ where: { spaceId: space.id } })).toBe(0);
    await expect(
      createTicket({ ...staleDeps, ticketBoardEnabled: true }, { ...scope, title: "stale" }),
    ).rejects.toThrow(staleError);
    expect(await db.prisma.board.count({ where: { spaceId: space.id } })).toBe(0);
    expect(await db.prisma.ticket.count({ where: { spaceId: space.id } })).toBe(0);
    await expect(
      new MarkdownMemoryStore(db.prisma).commit(
        { scope: "bot", botId: bot.id, path: "MEMORY.md", content: "stale" },
        { ...scope, operationId: run.id, traceId: run.id, runId: run.id, executionFence },
      ),
    ).rejects.toThrow(staleError);
    expect(await db.prisma.memoryDocument.count({ where: { spaceId: space.id } })).toBe(0);

    const item = await db.prisma.scratchpadItem.create({
      data: { ...scope, title: "original", status: "open" },
    });
    await expect(
      updateScratchpadItemFromTool(staleDeps, { ...scope, itemId: item.id, title: "stale" }),
    ).rejects.toThrow(staleError);
    await expect(
      completeScratchpadItemFromTool(staleDeps, { ...scope, itemId: item.id }),
    ).rejects.toThrow(staleError);
    await expect(
      removeScratchpadItemFromTool(staleDeps, { ...scope, itemId: item.id }),
    ).rejects.toThrow(staleError);
    expect(await db.prisma.scratchpadItem.findUniqueOrThrow({ where: { id: item.id } })).toEqual(
      item,
    );
    const project = await db.prisma.project.create({
      data: { spaceId: space.id, name: "Fixture project" },
    });
    const goalDeps = { ...staleDeps, ticketBoardEnabled: true };
    await expect(
      executeGoalTool(goalDeps, space.id, "goal_create", { projectId: project.id, name: "stale" }),
    ).rejects.toThrow(staleError);
    expect(await db.prisma.goal.count({ where: { spaceId: space.id } })).toBe(0);

    const goal = await db.prisma.goal.create({
      data: { spaceId: space.id, projectId: project.id, name: "original" },
    });
    const krFields = {
      name: "original",
      measure: "count",
      targetValue: 1,
      currentValue: 0,
      calculationRule: "manual",
    };
    const kr = await db.prisma.keyResult.create({
      data: { ...krFields, spaceId: space.id, projectId: project.id, goalId: goal.id },
    });
    await expect(
      executeGoalTool(goalDeps, space.id, "goal_update", { id: goal.id, name: "stale" }),
    ).rejects.toThrow(staleError);
    await expect(
      executeGoalTool(goalDeps, space.id, "goal_delete", { id: goal.id }),
    ).rejects.toThrow(staleError);
    await expect(
      executeGoalTool(goalDeps, space.id, "key_result_create", { ...krFields, goalId: goal.id }),
    ).rejects.toThrow(staleError);
    await expect(
      executeGoalTool(goalDeps, space.id, "key_result_update", { id: kr.id, currentValue: 1 }),
    ).rejects.toThrow(staleError);
    await expect(
      executeGoalTool(goalDeps, space.id, "key_result_archive", { id: kr.id }),
    ).rejects.toThrow(staleError);
    await expect(
      executeGoalTool(goalDeps, space.id, "key_result_delete", { id: kr.id }),
    ).rejects.toThrow(staleError);
    expect(await db.prisma.goal.findUniqueOrThrow({ where: { id: goal.id } })).toEqual(goal);
    expect(await db.prisma.keyResult.findMany({ where: { spaceId: space.id } })).toEqual([kr]);
    const ticketDeps = { ...staleDeps, ticketBoardEnabled: true };
    const board = await db.prisma.board.create({ data: { spaceId: space.id } });
    const ticket = await db.prisma.ticket.create({
      data: { spaceId: space.id, boardId: board.id, number: 1, title: "original" },
    });
    const prerequisite = await db.prisma.ticket.create({
      data: { spaceId: space.id, boardId: board.id, number: 2, title: "prerequisite" },
    });
    await expect(
      updateTicket(ticketDeps, { spaceId: space.id, botId: bot.id, id: ticket.id, title: "stale" }),
    ).rejects.toThrow(staleError);
    await expect(
      commentTicket(ticketDeps, { spaceId: space.id, botId: bot.id, id: ticket.id, body: "stale" }),
    ).rejects.toThrow(staleError);
    const edge = { ticketId: ticket.id, prerequisiteId: prerequisite.id };
    await expect(
      executeDependencyTool(ticketDeps, space.id, "ticket_dependency_add", edge),
    ).rejects.toThrow(staleError);
    expect(await db.prisma.ticketDependency.count({ where: { spaceId: space.id } })).toBe(0);
    await db.prisma.ticketDependency.create({ data: { spaceId: space.id, ...edge } });
    await expect(
      executeDependencyTool(ticketDeps, space.id, "ticket_dependency_remove", edge),
    ).rejects.toThrow(staleError);
    expect(await db.prisma.ticketDependency.count({ where: { spaceId: space.id } })).toBe(1);
    expect(await db.prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).toEqual(ticket);
    expect(await db.prisma.ticketComment.count({ where: { ticketId: ticket.id } })).toBe(0);
    const routine = await db.prisma.routine.create({
      data: {
        ...scope,
        threadId: thread.id,
        name: "original",
        prompt: "fixture",
        crons: ["0 0 * * *"],
        active: true,
      },
    });
    const remove = vi.fn();
    await expect(
      cancelScheduleFromTool(
        { ...staleDeps, queue: { remove } } as unknown as Parameters<
          typeof cancelScheduleFromTool
        >[0],
        { ...scope, routineId: routine.id },
      ),
    ).rejects.toThrow(staleError);
    expect(remove).not.toHaveBeenCalled();
    expect(await db.prisma.routine.findUniqueOrThrow({ where: { id: routine.id } })).toEqual(
      routine,
    );

    await db.prisma.user.create({
      data: { id, name: "Synthetic owner", email: `${id}@example.invalid` },
    });
    await db.prisma.member.create({
      data: {
        id: `${id}-member`,
        organizationId: org.id,
        userId: id,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await db.prisma.spaceMember.create({
      data: {
        id: `${id}-space-member`,
        spaceId: space.id,
        organizationId: org.id,
        userId: id,
        createdAt: new Date(),
      },
    });
    const spawnCounts = async () => ({
      bots: await db.prisma.bot.count({ where: { spaceId: space.id } }),
      threads: await db.prisma.thread.count({ where: { spaceId: space.id } }),
      runs: await db.prisma.run.count({ where: { spaceId: space.id } }),
      memories: await db.prisma.memoryDocument.count({ where: { spaceId: space.id } }),
      profiles: await db.prisma.browserProfile.count({ where: { spaceId: space.id } }),
      computers: await db.prisma.computer.count({ where: { spaceId: space.id } }),
    });
    const beforeSpawn = await spawnCounts();
    const spawnJobs = { enqueue: vi.fn(async () => undefined) };
    await expect(
      spawnBot(
        { prisma: db.prisma, jobs: spawnJobs as any },
        {
          spawnedBy: { id: bot.id, name: bot.name, spaceId: space.id, userId: id },
          runId: run.id,
          executionFence,
          spawnKey: `${id}-stale-spawn`,
          name: "Stale child",
          prompt: "Synthetic prompt",
        },
      ),
    ).rejects.toThrow(staleError);
    expect(await spawnCounts()).toEqual(beforeSpawn);
    expect(spawnJobs.enqueue).not.toHaveBeenCalled();

    const existingChildKey = `${id}-existing-child`;
    const existingChild = await spawnBot(
      { prisma: db.prisma, jobs: spawnJobs as any },
      {
        spawnedBy: { id: bot.id, name: bot.name, spaceId: space.id, userId: id },
        runId: run.id,
        spawnKey: existingChildKey,
        name: "Existing child",
      },
    );
    if (!("botId" in existingChild)) throw new Error("Expected synthetic child");
    const childThreadBefore = await db.prisma.thread.findUniqueOrThrow({
      where: { id: existingChild.threadId },
    });
    const beforeInitialRun = await spawnCounts();
    const tasksBefore = await db.prisma.task.count({ where: { spaceId: space.id } });
    const messagesBefore = await db.prisma.message.count({
      where: { threadId: existingChild.threadId },
    });
    await expect(
      spawnBot(
        { prisma: db.prisma, jobs: spawnJobs as any },
        {
          spawnedBy: { id: bot.id, name: bot.name, spaceId: space.id, userId: id },
          runId: run.id,
          executionFence,
          spawnKey: existingChildKey,
          name: "Existing child",
          prompt: "Stale initial run",
        },
      ),
    ).rejects.toThrow(staleError);
    expect(await spawnCounts()).toEqual(beforeInitialRun);
    expect(await db.prisma.task.count({ where: { spaceId: space.id } })).toBe(tasksBefore);
    expect(
      await db.prisma.message.count({
        where: { threadId: existingChild.threadId },
      }),
    ).toBe(messagesBefore);
    expect(
      await db.prisma.thread.findUniqueOrThrow({
        where: { id: existingChild.threadId },
      }),
    ).toEqual(childThreadBefore);
    expect(spawnJobs.enqueue).not.toHaveBeenCalled();

    await spawnBot(
      { prisma: db.prisma, jobs: spawnJobs as any },
      {
        spawnedBy: { id: bot.id, name: bot.name, spaceId: space.id, userId: id },
        runId: run.id,
        spawnKey: existingChildKey,
        name: "Existing child",
        prompt: "Synthetic existing run",
      },
    );
    spawnJobs.enqueue.mockClear();
    const replaySnapshot = async () => ({
      runs: await db.prisma.run.findMany({
        where: { botId: existingChild.botId },
        orderBy: { id: "asc" },
      }),
      tasks: await db.prisma.task.findMany({
        where: { botId: existingChild.botId },
        orderBy: { id: "asc" },
      }),
      messages: await db.prisma.message.findMany({
        where: { threadId: existingChild.threadId },
        orderBy: { id: "asc" },
      }),
      thread: await db.prisma.thread.findUniqueOrThrow({ where: { id: existingChild.threadId } }),
    });
    const beforeExistingRunReplay = await replaySnapshot();
    await expect(
      spawnBot(
        { prisma: db.prisma, jobs: spawnJobs as any },
        {
          spawnedBy: { id: bot.id, name: bot.name, spaceId: space.id, userId: id },
          runId: run.id,
          executionFence,
          spawnKey: existingChildKey,
          name: "Existing child",
          prompt: "Synthetic existing run",
        },
      ),
    ).rejects.toThrow(staleError);
    expect(await replaySnapshot()).toEqual(beforeExistingRunReplay);
    expect(spawnJobs.enqueue).not.toHaveBeenCalled();

    await db.prisma.bot.update({
      where: { id: existingChild.botId },
      data: { archivedAt: new Date() },
    });
    const archivedChildBefore = await db.prisma.bot.findUniqueOrThrow({
      where: { id: existingChild.botId },
    });
    const beforeArchivedReplay = await spawnCounts();
    await expect(
      spawnBot(
        { prisma: db.prisma, jobs: spawnJobs as any },
        {
          spawnedBy: { id: bot.id, name: bot.name, spaceId: space.id, userId: id },
          runId: run.id,
          executionFence,
          spawnKey: existingChildKey,
          name: "Archived stale replacement",
          prompt: "Synthetic prompt",
        },
      ),
    ).rejects.toThrow(staleError);
    expect(await db.prisma.bot.findUniqueOrThrow({ where: { id: existingChild.botId } })).toEqual(
      archivedChildBefore,
    );
    expect(await spawnCounts()).toEqual(beforeArchivedReplay);
    expect(spawnJobs.enqueue).not.toHaveBeenCalled();

    const secret = await db.prisma.botSecret.create({
      data: {
        ...scope,
        id: `${id}-secret`,
        name: "synthetic",
        origin: "https://example.invalid",
        auth: { type: "bearer" },
        ciphertext: "synthetic-fixture",
      },
    });
    await expect(forgetBotSecret(db.prisma, scope, secret.name, executionFence)).rejects.toThrow(
      staleError,
    );
    expect(await db.prisma.botSecret.findUniqueOrThrow({ where: { id: secret.id } })).toEqual(
      secret,
    );
    await expect(
      createProposal(
        db.prisma,
        scope,
        {
          botId: bot.id,
          submitKey: `${id}-proposal`,
          kind: "plan",
          title: "stale",
          summary: "Synthetic proposal",
          options: [],
          recommendation: "",
        },
        executionFence,
      ),
    ).rejects.toThrow(staleError);
    expect(await db.prisma.proposal.count({ where: { spaceId: space.id } })).toBe(0);

    const replayInput = {
      botId: bot.id,
      submitKey: `${id}-proposal-replay`,
      kind: "plan" as const,
      title: "original",
      summary: "Synthetic replay fixture",
      options: [],
      recommendation: "",
    };
    const originalProposal = await createProposal(db.prisma, scope, replayInput);
    const proposalBeforeReplay = await db.prisma.proposal.findUniqueOrThrow({
      where: { id: originalProposal.proposal.id },
    });
    await expect(
      createProposal(db.prisma, scope, { ...replayInput, title: "stale replay" }, executionFence),
    ).rejects.toThrow(staleError);
    expect(
      await db.prisma.proposal.findUniqueOrThrow({
        where: { id: originalProposal.proposal.id },
      }),
    ).toEqual(proposalBeforeReplay);
    expect(await db.prisma.proposal.count({ where: { spaceId: space.id } })).toBe(1);

    const before = await db.prisma.thread.findUniqueOrThrow({ where: { id: thread.id } });
    await expect(
      db.prisma.$transaction((tx) =>
        appendEventInTransaction(tx, {
          spaceId: space.id,
          threadId: thread.id,
          botId: bot.id,
          runId: run.id,
          executionFence: {
            runId: run.id,
            leaseOwner: old.leaseOwner!,
            leaseFence: old.leaseFence,
          },
          type: "effect.reconciled",
          payload: {},
        }),
      ),
    ).rejects.toThrow("Run execution fence is no longer current");
    expect(await db.prisma.event.count({ where: { runId: run.id } })).toBe(0);
    expect(
      (await db.prisma.thread.findUniqueOrThrow({ where: { id: thread.id } })).nextEventSeq,
    ).toBe(before.nextEventSeq);
  }, 30000);

  it("rejects stale history writers and recovers an unfinished effect exactly once", async () => {
    const id = `fence-${randomUUID()}`;
    const org = await db.prisma.organization.create({
      data: { id, slug: id, name: "Synthetic fence fixture", createdAt: new Date() },
    });
    const space = await db.prisma.space.create({
      data: { id: `${id}-space`, organizationId: org.id, name: "Synthetic fence" },
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
        prompt: "Synthetic fence acceptance",
        status: "running",
      },
    });
    const run = await db.prisma.run.create({
      data: {
        spaceId: space.id,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: id,
        trigger: "user",
        status: "running",
        leaseOwner: "new-owner",
        leaseFence: 2,
        leaseExpiresAt: new Date(Date.now() + 120_000),
      },
    });
    const stale = { runId: run.id, leaseOwner: "old-owner", leaseFence: 1 };
    const current = { runId: run.id, leaseOwner: "new-owner", leaseFence: 2 };
    const attribution = { spaceId: space.id, threadId: thread.id, botId: bot.id, runId: run.id };
    await expect(
      db.prisma.$transaction((tx) =>
        appendEventInTransaction(tx, {
          ...attribution,
          executionFence: stale,
          type: "effect.reconciled",
          payload: {},
        }),
      ),
    ).rejects.toThrow("Run execution fence is no longer current");
    await expect(
      db.prisma.$transaction((tx) =>
        createThreadMessageInTransaction(tx, {
          ...attribution,
          executionFence: stale,
          role: "bot",
          blocks: [],
        }),
      ),
    ).rejects.toThrow("Run execution fence is no longer current");
    const afterStaleHistory = await db.prisma.thread.findUniqueOrThrow({
      where: { id: thread.id },
    });
    expect(afterStaleHistory.nextMessageSeq).toBe(thread.nextMessageSeq);
    expect(afterStaleHistory.nextEventSeq).toBe(thread.nextEventSeq);
    const usage = {
      type: "usage" as const,
      provider: "fixture",
      model: "test",
      callId: `${id}-call`,
      inputTokens: 10,
      outputTokens: 2,
    };
    await expect(
      recordUsage(db.prisma, usage, { ...attribution, userId: id }, { executionFence: stale }),
    ).rejects.toThrow("Run execution fence is no longer current");
    await expect(
      settleBudget(db.prisma, {
        spaceId: space.id,
        callId: usage.callId,
        actualMicroUsd: 1n,
        executionFence: stale,
      }),
    ).rejects.toThrow("Run execution fence is no longer current");
    const staleAttempt = await db.prisma.attempt.create({
      data: { runId: run.id, fence: stale.leaseFence, status: "running" },
    });
    expect(
      await pauseRunForInput(db.prisma, {
        ...attribution,
        attemptId: staleAttempt.id,
        leaseOwner: stale.leaseOwner,
        leaseFence: stale.leaseFence,
        blocks: [],
      }),
    ).toBe(false);
    expect(
      await db.prisma.attempt.findUniqueOrThrow({ where: { id: staleAttempt.id } }),
    ).toMatchObject({
      status: "running",
      finishedAt: null,
      fence: stale.leaseFence,
    });
    expect(await db.prisma.message.count({ where: { runId: run.id } })).toBe(0);
    expect((await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
      "running",
    );
    expect(await db.prisma.usageRecord.count({ where: { callId: usage.callId } })).toBe(0);
    expect(await db.prisma.budgetSpendLedger.count({ where: { callId: usage.callId } })).toBe(0);
    await db.prisma.run.update({
      where: { id: run.id },
      data: { leaseOwner: stale.leaseOwner, leaseFence: stale.leaseFence },
    });
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./execution-fence-crash-worker.ts", import.meta.url)),
      ],
      {
        env: { ...process.env, RAK_CRASH_TEST_DATABASE_URL: dbUrl, RAK_FENCE_TEST_RUN_ID: run.id },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk.toString();
    });
    const exited = once(child, "exit");
    try {
      await vi.waitFor(
        () => {
          if (child.exitCode !== null) throw new Error(`Crash worker exited: ${errors}`);
          expect(output).toContain("effectId");
        },
        { timeout: 20000 },
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
    expect(child.exitCode, errors).toBe(null);
    expect(child.signalCode, errors).toBe("SIGKILL");
    const artifact = JSON.parse(output.trim()) as { effectId: string };
    const effect = await db.prisma.externalEffect.findUniqueOrThrow({
      where: { id: artifact.effectId },
    });
    expect(effect.status).toBe("executing");
    await db.prisma.run.update({
      where: { id: run.id },
      data: { leaseOwner: current.leaseOwner, leaseFence: current.leaseFence },
    });

    const deps = { prisma: db.prisma } as Parameters<typeof recoverUnfinishedEffects>[0];
    await expect(recoverUnfinishedEffects(deps, run, stale)).rejects.toThrow(
      "Run execution fence is no longer current",
    );
    expect(
      (await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } })).status,
    ).toBe("executing");
    await recoverUnfinishedEffects(deps, run, current);
    await recoverUnfinishedEffects(deps, run, current);
    expect(
      (await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } })).status,
    ).toBe("uncertain");
    expect(await db.prisma.externalEffect.count({ where: { runId: run.id } })).toBe(1);
    expect(
      await db.prisma.event.count({ where: { runId: run.id, type: "effect.reconciled" } }),
    ).toBe(1);
    expect(await db.prisma.message.count({ where: { runId: run.id } })).toBe(0);
    expect(await db.prisma.usageRecord.count({ where: { callId: usage.callId } })).toBe(0);
    expect(await db.prisma.budgetSpendLedger.count({ where: { callId: usage.callId } })).toBe(0);
  }, 30000);
  it("records and settles a billable call exactly once", async () => {
    const id = `billing-${randomUUID()}`;
    const org = await db.prisma.organization.create({
      data: { id, slug: id, name: "Synthetic billing fixture", createdAt: new Date() },
    });
    const space = await db.prisma.space.create({
      data: { id: `${id}-space`, organizationId: org.id, name: "Synthetic billing" },
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
        prompt: "Synthetic billing acceptance",
        status: "running",
      },
    });
    const run = await db.prisma.run.create({
      data: {
        spaceId: space.id,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        userId: id,
        trigger: "user",
        status: "running",
        leaseOwner: "billing-owner",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 120_000),
      },
    });
    const executionFence = { runId: run.id, leaseOwner: "billing-owner", leaseFence: 1 };
    const project = await db.prisma.project.create({
      data: { spaceId: space.id, name: "Synthetic billing project" },
    });
    await setProjectBudget(db.prisma, {
      spaceId: space.id,
      projectId: project.id,
      limitMicroUsd: 1000000n,
    });
    const callId = `${id}-call`;
    await reserveBudget(db.prisma, {
      spaceId: space.id,
      projectId: project.id,
      callId,
      amountMicroUsd: 500000n,
      executionFence,
    });
    const attribution = {
      spaceId: space.id,
      projectId: project.id,
      userId: id,
      botId: bot.id,
      threadId: thread.id,
      runId: run.id,
    };
    const usage = {
      type: "usage",
      provider: "synthetic",
      model: "fixture",
      inputTokens: 10,
      outputTokens: 5,
      callId,
      billingKind: "api_metered",
      costUsdDecimal: "0.125",
    } satisfies Parameters<typeof recordUsage>[1];
    for (let replay = 0; replay < 2; replay++) {
      await recordUsage(db.prisma, usage, attribution, { executionFence });
      await settleBudget(db.prisma, {
        spaceId: space.id,
        callId,
        actualMicroUsd: 125000n,
        executionFence,
      });
    }
    expect(await db.prisma.usageRecord.count({ where: { spaceId: space.id, callId } })).toBe(1);
    expect(
      await db.prisma.budgetSpendLedger.count({
        where: { spaceId: space.id, callId, kind: "settled" },
      }),
    ).toBe(1);
    const budget = await db.prisma.projectBudget.findUniqueOrThrow({
      where: { spaceId_projectId: { spaceId: space.id, projectId: project.id } },
    });
    expect(budget.settledMicroUsd).toBe(125000n);
  }, 30000);

  for (const tool of [
    "add_mcp_server",
    "update_bot",
    "forget_secret",
    "submit_proposal",
    "archive_bot",
  ] as const) {
    for (const competitor of ["finalize", "recover", "budget_pause"] as const) {
      if (
        tool !== "add_mcp_server" &&
        competitor !== "finalize" &&
        !(tool === "update_bot" && competitor === "budget_pause")
      )
        continue;
      for (const first of ["mcp", "competitor"] as const) {
        it(`serializes ${tool} against ${competitor}, ${first} first`, async () => {
          function deferred() {
            let resolve!: () => void;
            const promise = new Promise<void>((r) => {
              resolve = r;
            });
            return { promise, resolve };
          }
          const runtimeReached = deferred();
          const startTool = deferred();
          const finishRuntime = deferred();
          const locked = deferred();
          const unlock = deferred();
          const waiting = deferred();
          let armed = false;
          let held = false;
          let threadLocks = 0;
          let holderPid = 0;
          let waiterPid = 0;
          const instrumentedPrisma = new Proxy(db.prisma, {
            get(target, key) {
              if (key === "$transaction")
                return (callback: (tx: any) => Promise<unknown>, options?: any) =>
                  target.$transaction(
                    async (tx) =>
                      callback(
                        new Proxy(tx, {
                          get(transaction, method) {
                            const value = Reflect.get(transaction, method);
                            if (method === "$queryRaw")
                              return async (...args: any[]) => {
                                const query = String(args[0]);
                                const isThreadLock =
                                  armed &&
                                  query.includes(tool === "add_mcp_server" ? "threads" : "bots") &&
                                  (query.includes("FOR UPDATE") || query.includes("FOR KEY SHARE"));
                                // The competitor can block on Space before reaching Bot.
                                if (
                                  armed &&
                                  held &&
                                  query.includes("spaces") &&
                                  (query.includes("FOR UPDATE") || query.includes("FOR KEY SHARE"))
                                ) {
                                  waiting.resolve();
                                }
                                if (isThreadLock && ++threadLocks === 2) waiting.resolve();
                                const currentPid = (
                                  await transaction.$queryRawUnsafe(
                                    "SELECT pg_backend_pid() AS pid",
                                  )
                                )[0].pid;
                                if (holderPid && currentPid !== holderPid) waiterPid = currentPid;
                                const result = await value.apply(transaction, args);
                                if (isThreadLock && !held) {
                                  held = true;
                                  const identity = await transaction.$queryRawUnsafe(
                                    "SELECT pg_backend_pid() AS pid",
                                  );
                                  holderPid = identity[0].pid;
                                  locked.resolve();
                                  await unlock.promise;
                                }
                                return result;
                              };
                            return typeof value === "function" ? value.bind(transaction) : value;
                          },
                        }),
                      ),
                    options,
                  );
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          const id = `dispatch-${randomUUID()}`;
          await db.prisma.user.create({
            data: { id, name: "Synthetic concurrency user", email: `${id}@example.invalid` },
          });
          const org = await db.prisma.organization.create({
            data: { id, slug: id, name: "Synthetic dispatch fixture", createdAt: new Date() },
          });
          const space = await db.prisma.space.create({
            data: { id: `${id}-space`, organizationId: org.id, name: "Synthetic dispatch" },
          });
          const bot = await db.prisma.bot.create({
            data: { spaceId: space.id, userId: id, name: "Fixture bot", color: "#123456" },
          });
          const archiveTarget =
            tool === "archive_bot"
              ? await db.prisma.bot.create({
                  data: {
                    spaceId: space.id,
                    userId: id,
                    name: "Synthetic child",
                    color: "#123456",
                    parentBotId: bot.id,
                  },
                })
              : null;
          if (tool === "forget_secret") {
            await db.prisma.botSecret.create({
              data: {
                id: `${id}-secret`,
                spaceId: space.id,
                botId: bot.id,
                userId: id,
                name: "synthetic",
                origin: "https://example.invalid",
                auth: { type: "bearer" },
                ciphertext: "synthetic-fixture",
              },
            });
          }
          const thread = await db.prisma.thread.create({
            data: { spaceId: space.id, botId: bot.id, userId: id },
          });
          const task = await db.prisma.task.create({
            data: {
              spaceId: space.id,
              botId: bot.id,
              threadId: thread.id,
              userId: id,
              prompt: "Synthetic dispatch acceptance",
              status: "running",
            },
          });
          const run = await db.prisma.run.create({
            data: {
              spaceId: space.id,
              botId: bot.id,
              threadId: thread.id,
              taskId: task.id,
              userId: id,
              trigger: "user",
              status: "queued",
            },
          });
          const memoryCommit = vi.fn(async () => ({ revision: "synthetic-revision" }));
          const toolResults: unknown[] = [];
          const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
          const prisma = new Proxy(instrumentedPrisma, {
            get(target, key) {
              if (key === "bot")
                return {
                  findUniqueOrThrow: async () => ({
                    ...bot,
                    computerId: "synthetic-computer",
                    computer: { id: "synthetic-computer", scope: "dedicated" },
                  }),
                  findMany: target.bot.findMany.bind(target.bot),
                };
              if (key === "deploymentSettings")
                return {
                  findUnique: async () => ({
                    defaultModelProvider: "scripted",
                    defaultModelId: "scripted",
                  }),
                };
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          const executor = createRunExecutor({
            prisma,
            secretStore: {
              put: vi.fn(async () => {
                throw new Error("Unexpected synthetic credential write");
              }),
              load: vi.fn(async () => ""),
            },

            runtime: {
              describe: () => ({ capabilities: { scripted: false } }),
              run: async function* (request: {
                executeTool?: (
                  name: string,
                  args: Record<string, unknown>,
                  executionId: string,
                ) => Promise<unknown>;
              }) {
                runtimeReached.resolve();
                await startTool.promise;
                toolResults.push(
                  await request.executeTool!(
                    tool,
                    tool === "add_mcp_server"
                      ? {
                          name: "Synthetic concurrency server",
                          transport: "stdio",
                          command: "synthetic-command",
                          assign_to_self: false,
                        }
                      : tool === "archive_bot"
                        ? { bot_id: archiveTarget!.id, confirm_name: archiveTarget!.name }
                        : tool === "update_bot"
                          ? { title: "Synthetic concurrency title" }
                          : tool === "forget_secret"
                            ? { name: "synthetic" }
                            : {
                                kind: "plan",
                                title: "Synthetic proposal",
                                summary: "Synthetic concurrency proposal",
                                options: [],
                              },
                    "mcp-concurrency",
                  ),
                );
                await finishRuntime.promise;
                yield { type: "done" as const, text: "Done" };
              },
            },
            connector: {
              discoverTools: async () => [],
              resolveCall: async () => undefined,
              execute: async function* () {},
            },
            sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
            memory: {
              describe: () => ({ capabilities: {} }),
              read: async () => ({ documents: [] }),
              search: async () => [],
              commit: memoryCommit,
              exportMarkdown: async function* () {},
            },
            memoryProviders: { resolve: async () => null },
            events: {
              append: vi.fn(async () => undefined),
              pauseRunForInput: vi.fn(async () => true),
              finalizeRun,
            },
            jobs: { enqueue: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) },
            secrets: [],
          } as unknown as Parameters<typeof createRunExecutor>[0]);

          const turn = executor.continueRun(run.id, "mcp-owner");
          await Promise.race([
            runtimeReached.promise,
            turn.then(() => {
              throw new Error("Runtime barrier not reached");
            }),
          ]);
          const active = await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
          const attempt = await db.prisma.attempt.findFirstOrThrow({
            where: { runId: run.id, fence: active.leaseFence },
          });
          const fence = { runId: run.id, leaseOwner: "mcp-owner", leaseFence: active.leaseFence };
          const compete = () =>
            competitor === "finalize"
              ? finalizeRunInDb(instrumentedPrisma, {
                  spaceId: space.id,
                  threadId: thread.id,
                  botId: bot.id,
                  runId: run.id,
                  taskId: task.id,
                  attemptId: attempt.id,
                  leaseOwner: fence.leaseOwner,
                  leaseFence: fence.leaseFence,
                  outcome: "completed",
                  blocks: [],
                })
              : competitor === "budget_pause"
                ? pauseRunForBudget(instrumentedPrisma, {
                    spaceId: space.id,
                    threadId: thread.id,
                    botId: bot.id,
                    runId: run.id,
                    attemptId: attempt.id,
                    leaseOwner: fence.leaseOwner,
                    leaseFence: fence.leaseFence,
                    blocks: [],
                    checkpoint: JSON.stringify({ kind: "budget_pause_v1", reason: "synthetic" }),
                  })
                : recoverUnfinishedEffects(
                    { prisma: instrumentedPrisma } as Parameters<
                      typeof recoverUnfinishedEffects
                    >[0],
                    run,
                    fence,
                  );
          armed = true;
          let other: Promise<unknown> | undefined;
          try {
            if (first === "mcp") startTool.resolve();
            else other = compete();
            await locked.promise;
            if (first === "mcp") other = compete();
            else startTool.resolve();
            await waiting.promise;
            await waitForConfirmedBlocking(db.prisma, holderPid, () => waiterPid);
          } finally {
            unlock.resolve();
            startTool.resolve();
          }
          let competingError: unknown;
          try {
            await other;
          } catch (error) {
            competingError = error;
          } finally {
            finishRuntime.resolve();
          }
          await turn;
          const executorFailures = finalizeRun.mock.calls.filter(
            (args: unknown[]) =>
              (args[0] as { outcome?: string } | undefined)?.outcome === "failed",
          );
          expect(executorFailures, JSON.stringify(executorFailures)).toEqual([]);
          if (competingError) throw competingError;
          const shouldWrite = !(competitor !== "recover" && first === "competitor");
          if (tool === "add_mcp_server") {
            expect(await db.prisma.mcpServer.count({ where: { spaceId: space.id } })).toBe(
              shouldWrite ? 1 : 0,
            );
          } else if (tool === "update_bot") {
            const current = await db.prisma.bot.findUniqueOrThrow({ where: { id: bot.id } });
            expect(current.title).toBe(shouldWrite ? "Synthetic concurrency title" : bot.title);
          } else if (tool === "archive_bot") {
            const child = await db.prisma.bot.findUniqueOrThrow({
              where: { id: archiveTarget!.id },
            });
            expect(child.archivedAt !== null).toBe(shouldWrite);
          } else if (tool === "forget_secret") {
            expect(
              await db.prisma.botSecret.count({ where: { botId: bot.id, name: "synthetic" } }),
            ).toBe(shouldWrite ? 0 : 1);
          } else {
            expect(await db.prisma.proposal.count({ where: { botId: bot.id } })).toBe(
              shouldWrite ? 1 : 0,
            );
          }
        }, 30000);
      }
    }
  }

  it("rejects peer delivery after a persisted lease takeover without durable writes", async () => {
    const id = `peer-${randomUUID()}`;
    await db.prisma.user.create({
      data: { id, name: "Synthetic peer user", email: `${id}@example.invalid` },
    });
    await db.prisma.organization.create({
      data: { id, slug: id, name: "Synthetic peer org", createdAt: new Date() },
    });
    const space = await db.prisma.space.create({
      data: { id: `${id}-space`, organizationId: id, name: "Synthetic peer space" },
    });
    const sender = await db.prisma.bot.create({
      data: { spaceId: space.id, userId: id, name: "Sender", color: "#123456" },
    });
    const target = await db.prisma.bot.create({
      data: { spaceId: space.id, userId: id, name: "Target", color: "#123456" },
    });
    const thread = await db.prisma.thread.create({
      data: { spaceId: space.id, userId: id, botId: sender.id },
    });
    const targetThread = await db.prisma.thread.create({
      data: { spaceId: space.id, userId: id, botId: target.id },
    });
    const task = await db.prisma.task.create({
      data: {
        spaceId: space.id,
        botId: sender.id,
        threadId: thread.id,
        userId: id,
        prompt: "Synthetic",
        status: "running",
      },
    });
    const run = await db.prisma.run.create({
      data: {
        spaceId: space.id,
        botId: sender.id,
        threadId: thread.id,
        taskId: task.id,
        userId: id,
        trigger: "user",
        status: "running",
        leaseOwner: id,
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 120000),
      },
    });
    const stale = { ...run, executionFence: { runId: run.id, leaseOwner: id, leaseFence: 1 } };
    await db.prisma.run.update({
      where: { id: run.id },
      data: { leaseOwner: `${id}-replacement`, leaseFence: 2 },
    });
    const enqueue = vi.fn();
    const notify = vi.fn();
    await expect(
      messageBot(
        { prisma: db.prisma, jobs: { enqueue }, events: { notify } } as any,
        stale,
        sender,
        { bot_id: target.id, message: "stale delivery", deliveryKey: id },
      ),
    ).rejects.toMatchObject({ name: "StaleExecutionFenceError" });
    expect(
      await db.prisma.message.count({ where: { threadId: { in: [thread.id, targetThread.id] } } }),
    ).toBe(0);
    expect(await db.prisma.task.count({ where: { botId: target.id } })).toBe(0);
    expect(await db.prisma.run.count({ where: { botId: target.id } })).toBe(0);
    expect(
      await db.prisma.event.count({ where: { threadId: { in: [thread.id, targetThread.id] } } }),
    ).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  for (const clearFirst of [false, true]) {
    it(`serializes peer delivery against sender cleanup, clear first=${clearFirst}`, async () => {
      const id = `peer-${randomUUID()}`;
      await db.prisma.user.create({
        data: { id, name: "Synthetic peer user", email: `${id}@example.invalid` },
      });
      await db.prisma.organization.create({
        data: { id, slug: id, name: "Synthetic peer org", createdAt: new Date() },
      });
      const space = await db.prisma.space.create({
        data: { id: `${id}-space`, organizationId: id, name: "Synthetic peer space" },
      });
      const sender = await db.prisma.bot.create({
        data: { spaceId: space.id, userId: id, name: "Sender", color: "#123456" },
      });
      const target = await db.prisma.bot.create({
        data: { spaceId: space.id, userId: id, name: "Target", color: "#123456" },
      });
      const thread = await db.prisma.thread.create({
        data: { spaceId: space.id, userId: id, botId: sender.id },
      });
      const targetThread = await db.prisma.thread.create({
        data: { spaceId: space.id, userId: id, botId: target.id },
      });
      const task = await db.prisma.task.create({
        data: {
          spaceId: space.id,
          botId: sender.id,
          threadId: thread.id,
          userId: id,
          prompt: "Synthetic",
          status: "running",
        },
      });
      const run = await db.prisma.run.create({
        data: {
          spaceId: space.id,
          botId: sender.id,
          threadId: thread.id,
          taskId: task.id,
          userId: id,
          trigger: "user",
          status: "running",
          leaseOwner: id,
          leaseFence: 1,
          leaseExpiresAt: new Date(Date.now() + 120000),
        },
      });

      function deferred() {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
          resolve = r;
        });
        return { promise, resolve };
      }
      const locked = deferred();
      const waiting = deferred();
      const release = deferred();
      let seen = 0;
      let holderPid = 0;
      let waiterPid = 0;
      const instrumented = new Proxy(db.prisma, {
        get(target, key) {
          if (key === "$transaction")
            return (callback: (tx: any) => Promise<unknown>, options?: any) =>
              target.$transaction(
                (tx) =>
                  callback(
                    new Proxy(tx, {
                      get(transaction, method) {
                        const value = Reflect.get(transaction, method);
                        if (method === "$queryRaw")
                          return async (...args: any[]) => {
                            const query = String(args[0]);
                            const parentLock = query.includes("FROM bots") && args[1] === sender.id;
                            const ordinal = parentLock ? ++seen : 0;
                            if (ordinal === 2) waiting.resolve();
                            const currentPid = (
                              await transaction.$queryRawUnsafe("SELECT pg_backend_pid() AS pid")
                            )[0].pid;
                            if (holderPid && currentPid !== holderPid) waiterPid = currentPid;
                            const result = await value.apply(transaction, args);
                            if (ordinal === 1) {
                              const identity = await transaction.$queryRawUnsafe(
                                "SELECT pg_backend_pid() AS pid",
                              );
                              holderPid = identity[0].pid;
                              locked.resolve();
                              await release.promise;
                            }
                            return result;
                          };
                        return typeof value === "function" ? value.bind(transaction) : value;
                      },
                    }),
                  ),
                options,
              );
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      const enqueue = vi.fn().mockResolvedValue(undefined);
      const notify = vi.fn().mockResolvedValue(undefined);
      const delivery = () =>
        messageBot(
          { prisma: instrumented, jobs: { enqueue }, events: { notify } } as any,
          { ...run, executionFence: { runId: run.id, leaseOwner: id, leaseFence: 1 } },
          sender,
          { bot_id: target.id, message: "concurrent delivery", deliveryKey: id },
        );
      const cleanup = () =>
        clearThread(instrumented, { spaceId: space.id, threadId: thread.id, botId: sender.id });
      const first = (clearFirst ? cleanup() : delivery()).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await locked.promise;
      const second = (clearFirst ? delivery() : cleanup()).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await waiting.promise;
        await waitForConfirmedBlocking(db.prisma, holderPid, () => waiterPid);
      } finally {
        release.resolve();
      }
      const outcomes = await Promise.all([first, second]);
      const deliveryOutcome = outcomes[clearFirst ? 1 : 0];
      const cleanupOutcome = outcomes[clearFirst ? 0 : 1];
      expect(cleanupOutcome).not.toHaveProperty("error");
      if (clearFirst) {
        expect(deliveryOutcome).toHaveProperty("error.name", "StaleExecutionFenceError");
      } else {
        if ("error" in deliveryOutcome) throw deliveryOutcome.error;
        expect(deliveryOutcome).toHaveProperty("value.ok", true);
      }
      expect(await db.prisma.task.count({ where: { botId: target.id } })).toBe(clearFirst ? 0 : 1);
      expect(await db.prisma.run.count({ where: { botId: target.id } })).toBe(clearFirst ? 0 : 1);
      expect(await db.prisma.message.count({ where: { threadId: targetThread.id } })).toBe(
        clearFirst ? 0 : 1,
      );
      expect((await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
        "cancelled",
      );
      if (clearFirst) {
        expect(enqueue).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
      }
    }, 30000);
  }

  for (const grouped of [false, true]) {
    for (const clearFirst of [false, true]) {
      it(`serializes clearThread against ${grouped ? "archiveGroup" : "finalize"}, clear first=${clearFirst}`, async () => {
        const id = `clear-${randomUUID()}`;
        await db.prisma.user.create({
          data: { id, name: "Synthetic clear user", email: `${id}@example.invalid` },
        });
        await db.prisma.organization.create({
          data: { id, slug: id, name: "Synthetic clear org", createdAt: new Date() },
        });
        const space = await db.prisma.space.create({
          data: { id: `${id}-space`, organizationId: id, name: "Synthetic clear space" },
        });
        const bot = await db.prisma.bot.create({
          data: { spaceId: space.id, userId: id, name: "Synthetic clear bot", color: "#123456" },
        });
        const group = grouped
          ? await db.prisma.chatGroup.create({
              data: { spaceId: space.id, userId: id, name: "Synthetic group" },
            })
          : null;
        const thread = await db.prisma.thread.create({
          data: {
            spaceId: space.id,
            userId: id,
            ...(group ? { groupId: group.id } : { botId: bot.id }),
          },
        });
        const task = await db.prisma.task.create({
          data: {
            spaceId: space.id,
            botId: bot.id,
            threadId: thread.id,
            userId: id,
            prompt: "Synthetic",
            status: "running",
          },
        });
        const run = await db.prisma.run.create({
          data: {
            spaceId: space.id,
            botId: bot.id,
            threadId: thread.id,
            taskId: task.id,
            userId: id,
            trigger: "user",
            status: "running",
            leaseOwner: id,
            leaseFence: 1,
            leaseExpiresAt: new Date(Date.now() + 120000),
          },
        });
        const attempt = await db.prisma.attempt.create({
          data: { runId: run.id, fence: 1, status: "running" },
        });
        function deferred() {
          let resolve!: () => void;
          const promise = new Promise<void>((r) => {
            resolve = r;
          });
          return { promise, resolve };
        }
        const locked = deferred();
        const waiting = deferred();
        const release = deferred();
        let seen = 0;
        let holderPid = 0;
        let waiterPid = 0;
        const instrumented = new Proxy(db.prisma, {
          get(target, key) {
            if (key === "$transaction")
              return (callback: (tx: any) => Promise<unknown>, options?: any) =>
                target.$transaction(
                  (tx) =>
                    callback(
                      new Proxy(tx, {
                        get(transaction, method) {
                          const value = Reflect.get(transaction, method);
                          if (method === "$queryRaw")
                            return async (...args: any[]) => {
                              const query = String(args[0]);
                              const parentLock =
                                query.includes(grouped ? "FROM chat_groups" : "FROM bots") &&
                                query.includes("FOR UPDATE");
                              const ordinal = parentLock ? ++seen : 0;
                              if (ordinal === 2) waiting.resolve();
                              const currentPid = (
                                await transaction.$queryRawUnsafe("SELECT pg_backend_pid() AS pid")
                              )[0].pid;
                              if (holderPid && currentPid !== holderPid) waiterPid = currentPid;
                              const result = await value.apply(transaction, args);
                              if (ordinal === 1) {
                                const identity = await transaction.$queryRawUnsafe(
                                  "SELECT pg_backend_pid() AS pid",
                                );
                                holderPid = identity[0].pid;
                                locked.resolve();
                                await release.promise;
                              }
                              return result;
                            };
                          return typeof value === "function" ? value.bind(transaction) : value;
                        },
                      }),
                    ),
                  options,
                );
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const clear = () =>
          clearThread(instrumented, {
            spaceId: space.id,
            threadId: thread.id,
            botId: bot.id,
            ...(group ? { groupId: group.id } : {}),
          });
        const compete = () =>
          group
            ? createGroupRepos(instrumented).archiveGroup(
                {
                  userId: id,
                  spaceId: space.id,
                  email: `${id}@example.invalid`,
                  isDeploymentOwner: false,
                },
                group.id,
              )
            : finalizeRunInDb(instrumented, {
                spaceId: space.id,
                threadId: thread.id,
                botId: bot.id,
                runId: run.id,
                taskId: task.id,
                attemptId: attempt.id,
                leaseOwner: id,
                leaseFence: 1,
                outcome: "completed",
                blocks: [],
              });
        const first = (clearFirst ? clear : compete)();
        // Attach rejection handlers immediately while the barrier is held.
        const firstResult = first.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        let secondResult: Promise<any> | undefined;
        try {
          await locked.promise;
          secondResult = (clearFirst ? compete : clear)().then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
          await waiting.promise;
          await waitForConfirmedBlocking(db.prisma, holderPid, () => waiterPid);
        } finally {
          release.resolve();
        }
        const results = await Promise.all([firstResult, secondResult]);
        for (const result of results) if (result && "error" in result) throw result.error;
        const finalRun = await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
        expect(finalRun.status).toBe(grouped || clearFirst ? "cancelled" : "completed");
        expect(await db.prisma.message.count({ where: { threadId: thread.id } })).toBe(0);
        expect(
          await db.prisma.event.count({ where: { threadId: thread.id, type: "thread.cleared" } }),
        ).toBe(1);
        if (group)
          expect(
            (await db.prisma.chatGroup.findUniqueOrThrow({ where: { id: group.id } })).archivedAt,
          ).not.toBeNull();
      }, 30000);
    }
  }
  for (const pauseFirst of [true, false]) {
    it(`serializes budget pause against fenced reserve, pause first=${pauseFirst}`, async () => {
      const id = `budget-pair-${randomUUID()}`;
      await db.prisma.user.create({
        data: { id, name: "Synthetic clear user", email: `${id}@example.invalid` },
      });
      await db.prisma.organization.create({
        data: { id, slug: id, name: "Synthetic clear org", createdAt: new Date() },
      });
      const space = await db.prisma.space.create({
        data: { id: `${id}-space`, organizationId: id, name: "Synthetic clear space" },
      });
      const bot = await db.prisma.bot.create({
        data: { spaceId: space.id, userId: id, name: "Synthetic clear bot", color: "#123456" },
      });
      const thread = await db.prisma.thread.create({
        data: { spaceId: space.id, userId: id, botId: bot.id },
      });
      const task = await db.prisma.task.create({
        data: {
          spaceId: space.id,
          botId: bot.id,
          threadId: thread.id,
          userId: id,
          prompt: "Synthetic",
          status: "running",
        },
      });
      const run = await db.prisma.run.create({
        data: {
          spaceId: space.id,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          userId: id,
          trigger: "user",
          status: "running",
          leaseOwner: id,
          leaseFence: 1,
          leaseExpiresAt: new Date(Date.now() + 120000),
        },
      });
      const attempt = await db.prisma.attempt.create({
        data: { runId: run.id, fence: 1, status: "running" },
      });

      const project = await db.prisma.project.create({
        data: { spaceId: space.id, name: "Synthetic budget pair" },
      });
      await setProjectBudget(db.prisma, {
        spaceId: space.id,
        projectId: project.id,
        limitMicroUsd: 1000000n,
      });
      let release!: () => void;
      let acquired!: () => void;
      const held = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let holderPid = 0;
      let waiterPid = 0;
      let intercepted = false;
      const instrumented = new Proxy(db.prisma, {
        get(target, key) {
          if (key === "$transaction")
            return (callback: any, options: any) =>
              target.$transaction(
                (tx: any) =>
                  callback(
                    new Proxy(tx, {
                      get(transaction, method) {
                        const value = Reflect.get(transaction, method);
                        if (method === "$executeRaw" || method === "$queryRaw")
                          return async (...args: any[]) => {
                            const currentPid = (
                              await transaction.$queryRawUnsafe("SELECT pg_backend_pid() AS pid")
                            )[0].pid;
                            if (holderPid && currentPid !== holderPid) waiterPid = currentPid;
                            const result = await value.apply(transaction, args);
                            if (
                              method === "$executeRaw" &&
                              !intercepted &&
                              String(args[0]).includes("UPDATE spaces")
                            ) {
                              intercepted = true;
                              holderPid = (
                                await transaction.$queryRawUnsafe("SELECT pg_backend_pid() AS pid")
                              )[0].pid;
                              acquired();
                              await gate;
                            }
                            return result;
                          };
                        return typeof value === "function" ? value.bind(transaction) : value;
                      },
                    }),
                  ),
                options,
              );
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const fence = { runId: run.id, leaseOwner: id, leaseFence: 1 };
      const pause = () =>
        pauseRunForBudget(instrumented, {
          spaceId: space.id,
          botId: bot.id,
          threadId: thread.id,
          runId: run.id,
          taskId: task.id,
          attemptId: attempt.id,
          leaseOwner: id,
          leaseFence: 1,
          blocks: [],
          checkpoint: JSON.stringify({ kind: "budget_pause_v1", reason: "insufficient" }),
        });
      const reserve = () =>
        reserveBudget(instrumented, {
          spaceId: space.id,
          projectId: project.id,
          callId: `${id}-call`,
          amountMicroUsd: 500000n,
          executionFence: fence,
        });
      const settle = (promise: Promise<any>) =>
        promise.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      const first = settle((pauseFirst ? pause : reserve)());
      let second: ReturnType<typeof settle> | undefined;
      try {
        await Promise.race([
          held,
          first.then(() => {
            throw new Error("Budget parent lock barrier was not reached");
          }),
        ]);
        second = settle((pauseFirst ? reserve : pause)());
        await waitForConfirmedBlocking(db.prisma, holderPid, () => waiterPid);
      } finally {
        release();
      }
      const firstResult = await first;
      const secondResult = await second!;
      expect(firstResult).not.toHaveProperty("error");
      if (pauseFirst) expect((secondResult as any).error?.name).toBe("StaleExecutionFenceError");
      else expect(secondResult).not.toHaveProperty("error");
      expect((await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
        "waiting_budget",
      );
      const budget = await db.prisma.projectBudget.findFirstOrThrow({
        where: { spaceId: space.id, projectId: project.id },
      });
      expect(budget.reservedMicroUsd).toBe(pauseFirst ? 0n : 500000n);
      expect(budget.settledMicroUsd).toBe(0n);
      const reservations = await db.prisma.budgetReservation.findMany({
        where: { spaceId: space.id, callId: `${id}-call` },
      });
      expect(reservations).toHaveLength(pauseFirst ? 0 : 1);
      if (!pauseFirst) expect(reservations[0].status).toBe("reserved");
    }, 30000);
  }
  for (const pauseFirst of [true, false]) {
    it(`serializes budget pause against proposal rejection, pause first=${pauseFirst}`, async () => {
      const id = `proposal-pair-${randomUUID()}`;
      await db.prisma.user.create({
        data: { id, name: "Synthetic clear user", email: `${id}@example.invalid` },
      });
      await db.prisma.organization.create({
        data: { id, slug: id, name: "Synthetic clear org", createdAt: new Date() },
      });
      const space = await db.prisma.space.create({
        data: { id: `${id}-space`, organizationId: id, name: "Synthetic clear space" },
      });
      const bot = await db.prisma.bot.create({
        data: { spaceId: space.id, userId: id, name: "Synthetic clear bot", color: "#123456" },
      });
      const thread = await db.prisma.thread.create({
        data: { spaceId: space.id, userId: id, botId: bot.id },
      });
      const task = await db.prisma.task.create({
        data: {
          spaceId: space.id,
          botId: bot.id,
          threadId: thread.id,
          userId: id,
          prompt: "Synthetic",
          status: "running",
        },
      });
      const run = await db.prisma.run.create({
        data: {
          spaceId: space.id,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          userId: id,
          trigger: "user",
          status: "running",
          leaseOwner: id,
          leaseFence: 1,
          leaseExpiresAt: new Date(Date.now() + 120000),
        },
      });
      const attempt = await db.prisma.attempt.create({
        data: { runId: run.id, fence: 1, status: "running" },
      });

      const project = await db.prisma.project.create({
        data: { spaceId: space.id, name: "Synthetic budget pair" },
      });
      await setProjectBudget(db.prisma, {
        spaceId: space.id,
        projectId: project.id,
        limitMicroUsd: 1000000n,
      });
      const { proposal } = await createProposal(
        db.prisma,
        { spaceId: space.id, userId: id },
        {
          botId: bot.id,
          submitKey: id,
          kind: "decision",
          title: "Synthetic budget decision",
          summary: "Synthetic concurrency fixture",
          options: [],
          recommendation: "",
        },
      );
      await requestOverrunApproval(db.prisma, {
        spaceId: space.id,
        projectId: project.id,
        amountMicroUsd: 500000n,
        scope: JSON.stringify({
          runId: run.id,
          threadId: thread.id,
          botId: bot.id,
          attemptId: attempt.id,
          leaseFence: 1,
          callId: `${id}-call`,
        }),
        requestKey: id,
        proposalId: proposal.id,
      });
      let release!: () => void;
      let acquired!: () => void;
      const held = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let holderPid = 0;
      let waiterPid = 0;
      let intercepted = false;
      const instrumented = new Proxy(db.prisma, {
        get(target, key) {
          if (key === "$transaction")
            return (callback: any, options: any) =>
              target.$transaction(
                (tx: any) =>
                  callback(
                    new Proxy(tx, {
                      get(transaction, method) {
                        const value = Reflect.get(transaction, method);
                        if (method === "$executeRaw" || method === "$queryRaw")
                          return async (...args: any[]) => {
                            const currentPid = (
                              await transaction.$queryRawUnsafe("SELECT pg_backend_pid() AS pid")
                            )[0].pid;
                            if (holderPid && currentPid !== holderPid) waiterPid = currentPid;
                            const result = await value.apply(transaction, args);
                            if (
                              method === "$executeRaw" &&
                              !intercepted &&
                              String(args[0]).includes("UPDATE spaces")
                            ) {
                              intercepted = true;
                              holderPid = (
                                await transaction.$queryRawUnsafe("SELECT pg_backend_pid() AS pid")
                              )[0].pid;
                              acquired();
                              await gate;
                            }
                            return result;
                          };
                        return typeof value === "function" ? value.bind(transaction) : value;
                      },
                    }),
                  ),
                options,
              );
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const pause = () =>
        pauseRunForBudget(instrumented, {
          spaceId: space.id,
          botId: bot.id,
          threadId: thread.id,
          runId: run.id,
          taskId: task.id,
          attemptId: attempt.id,
          leaseOwner: id,
          leaseFence: 1,
          blocks: [],
          checkpoint: JSON.stringify({ kind: "budget_pause_v1", reason: "insufficient" }),
        });
      const reserve = () =>
        decideProposal(
          instrumented,
          { spaceId: space.id, userId: id },
          { proposalId: proposal.id, decision: "reject" },
        );
      const settle = (promise: Promise<any>) =>
        promise.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      const first = settle((pauseFirst ? pause : reserve)());
      let second: ReturnType<typeof settle> | undefined;
      try {
        await Promise.race([
          held,
          first.then(() => {
            throw new Error("Budget parent lock barrier was not reached");
          }),
        ]);
        second = settle((pauseFirst ? reserve : pause)());
        await waitForConfirmedBlocking(db.prisma, holderPid, () => waiterPid);
      } finally {
        release();
      }
      const firstResult = await first;
      const secondResult = await second!;
      expect(firstResult).not.toHaveProperty("error");
      expect(secondResult).not.toHaveProperty("error");
      expect((await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
        "waiting_budget",
      );
      const budget = await db.prisma.projectBudget.findFirstOrThrow({
        where: { spaceId: space.id, projectId: project.id },
      });
      expect(budget.reservedMicroUsd).toBe(0n);
      expect(
        (await db.prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id } })).status,
      ).toBe("rejected");
      expect(
        (
          await db.prisma.budgetOverrunApproval.findFirstOrThrow({
            where: { proposalId: proposal.id },
          })
        ).status,
      ).toBe("rejected");
      expect(budget.settledMicroUsd).toBe(0n);
    }, 30000);
  }

  for (const kind of ["schedule", "scratchpad", "memory", "board"] as const) {
    const parents =
      kind === "board"
        ? ["spaces"]
        : kind === "schedule"
          ? ["spaces", "bots", "threads"]
          : ["spaces", "bots"];
    for (const parent of parents)
      for (const parentFirst of [true, false]) {
        it(`first-create ${kind} locks ${parent} before fence, parent first=${parentFirst}`, async () => {
          const id = `clear-${randomUUID()}`;
          await db.prisma.user.create({
            data: { id, name: "Synthetic clear user", email: `${id}@example.invalid` },
          });
          await db.prisma.organization.create({
            data: { id, slug: id, name: "Synthetic clear org", createdAt: new Date() },
          });
          const space = await db.prisma.space.create({
            data: { id: `${id}-space`, organizationId: id, name: "Synthetic clear space" },
          });
          const bot = await db.prisma.bot.create({
            data: { spaceId: space.id, userId: id, name: "Synthetic clear bot", color: "#123456" },
          });
          const thread = await db.prisma.thread.create({
            data: { spaceId: space.id, userId: id, botId: bot.id },
          });
          const task = await db.prisma.task.create({
            data: {
              spaceId: space.id,
              botId: bot.id,
              threadId: thread.id,
              userId: id,
              prompt: "Synthetic",
              status: "running",
            },
          });
          const run = await db.prisma.run.create({
            data: {
              spaceId: space.id,
              botId: bot.id,
              threadId: thread.id,
              taskId: task.id,
              userId: id,
              trigger: "user",
              status: "running",
              leaseOwner: id,
              leaseFence: 1,
              leaseExpiresAt: new Date(Date.now() + 120000),
            },
          });
          await db.prisma.attempt.create({
            data: { runId: run.id, fence: 1, status: "running" },
          });
          const fence = { runId: run.id, leaseOwner: id, leaseFence: 1 };
          const scope = { spaceId: space.id, botId: bot.id, userId: id };
          const parentId = parent === "spaces" ? space.id : parent === "bots" ? bot.id : thread.id;
          const deferred = () => {
            let resolve!: () => void;
            const promise = new Promise<void>((r) => {
              resolve = r;
            });
            return { promise, resolve };
          };
          const held = deferred();
          const release = deferred();
          let holderPid = 0;
          let waiterPid = 0;
          const instrumented = new Proxy(db.prisma, {
            get(target, key) {
              if (key === "$transaction")
                return (callback: any, options: any) =>
                  target.$transaction(
                    (tx: any) =>
                      callback(
                        new Proxy(tx, {
                          get(transaction, method) {
                            const value = Reflect.get(transaction, method);
                            if (method === "$queryRaw")
                              return async (...args: any[]) => {
                                const currentPid = (
                                  await transaction.$queryRawUnsafe(
                                    "SELECT pg_backend_pid() AS pid",
                                  )
                                )[0].pid;
                                if (holderPid && currentPid !== holderPid) waiterPid = currentPid;
                                const result = await value.apply(transaction, args);
                                if (
                                  !parentFirst &&
                                  String(args[0]).includes(`FROM ${parent} WHERE`) &&
                                  String(args[0]).includes("FOR KEY SHARE")
                                ) {
                                  holderPid = (
                                    await transaction.$queryRawUnsafe(
                                      "SELECT pg_backend_pid() AS pid",
                                    )
                                  )[0].pid;
                                  held.resolve();
                                  await release.promise;
                                }
                                return result;
                              };
                            return typeof value === "function" ? value.bind(transaction) : value;
                          },
                        }),
                      ),
                    options,
                  );
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          const jobs = { enqueue: vi.fn(), cancel: vi.fn() };
          const events = { append: vi.fn() };
          const create = () => {
            const deps = { prisma: instrumented, executionFence: fence };
            if (kind === "schedule")
              return createScheduleFromTool({ ...deps, jobs, events } as any, {
                ...scope,
                threadId: thread.id,
                name: "first",
                prompt: "synthetic",
                schedule: { delaySeconds: 60 },
              });
            if (kind === "scratchpad")
              return addScratchpadItemFromTool(deps, { ...scope, title: "first" });
            if (kind === "board")
              return createTicket(
                { ...deps, ticketBoardEnabled: true },
                { ...scope, title: "first" },
              );
            return new MarkdownMemoryStore(instrumented).commit(
              { scope: "bot", botId: bot.id, path: "MEMORY.md", content: "first" },
              {
                ...scope,
                operationId: run.id,
                traceId: run.id,
                runId: run.id,
                executionFence: fence,
              },
            );
          };
          const lockParent = () =>
            db.prisma.$transaction(async (tx) => {
              const currentPid = (
                await tx.$queryRawUnsafe<any[]>("SELECT pg_backend_pid() AS pid")
              )[0].pid;
              if (!parentFirst) waiterPid = currentPid;
              await tx.$queryRawUnsafe(
                `SELECT id FROM ${parent} WHERE id = $1 FOR UPDATE`,
                parentId,
              );
              if (parentFirst) {
                holderPid = (await tx.$queryRawUnsafe<any[]>("SELECT pg_backend_pid() AS pid"))[0]
                  .pid;
                held.resolve();
                await release.promise;
                await tx.run.update({ where: { id: run.id }, data: { leaseFence: 2 } });
              }
            });
          const settle = (promise: Promise<any>) =>
            promise.then(
              (value) => ({ value }),
              (error) => ({ error }),
            );
          const first = settle(parentFirst ? lockParent() : create());
          let second: ReturnType<typeof settle> | undefined;
          try {
            await Promise.race([
              held.promise,
              first.then(() => {
                throw new Error("First-create parent lock barrier was not reached");
              }),
            ]);
            second = settle(parentFirst ? create() : lockParent());
            await waitForConfirmedBlocking(db.prisma, holderPid, () => waiterPid);
          } finally {
            release.resolve();
          }
          const results = await Promise.all([first, second!]);
          const creation = results[parentFirst ? 1 : 0];
          const locking = results[parentFirst ? 0 : 1];
          expect(locking).not.toHaveProperty("error");
          if (parentFirst) expect((creation as any).error?.name).toBe("StaleExecutionFenceError");
          else expect(creation).not.toHaveProperty("error");
          const expected = parentFirst ? 0 : 1;
          const model =
            kind === "schedule"
              ? db.prisma.routine
              : kind === "scratchpad"
                ? db.prisma.scratchpadItem
                : kind === "board"
                  ? db.prisma.board
                  : db.prisma.memoryDocument;
          expect(await (model as any).count({ where: { spaceId: space.id } })).toBe(expected);
          if (kind === "board")
            expect(await db.prisma.ticket.count({ where: { spaceId: space.id } })).toBe(expected);
          if (parentFirst) {
            expect(jobs.enqueue).not.toHaveBeenCalled();
            expect(events.append).not.toHaveBeenCalled();
          }
        }, 30000);
      }
  }
});
