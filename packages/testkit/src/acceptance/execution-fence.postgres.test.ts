import { forgetBotSecret } from "../../../adapters/src/bot-secrets.js";
import { createProposal } from "../../../db/src/proposals.js";
import { executeDependencyTool } from "../../../adapters/src/dependency-tools.js";
import { executeGoalTool } from "../../../adapters/src/goal-tools.js";
import { addScratchpadItemFromTool, updateScratchpadItemFromTool, completeScratchpadItemFromTool, removeScratchpadItemFromTool } from "../../../adapters/src/scratchpad-tools.js";
import { createScheduleFromTool, cancelScheduleFromTool } from "../../../adapters/src/schedule-tools.js";
import { createTicket, updateTicket, commentTicket } from "../../../adapters/src/ticket-tools.js";
import { MarkdownMemoryStore } from "../../../memory/src/index.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, finalizeRun as finalizeRunInDb, appendEventInTransaction, createThreadMessageInTransaction, recordUsage, settleBudget, reserveBudget, setProjectBudget, pauseRunForInput } from "@rakazo/db";
import { createRunExecutor, recoverUnfinishedEffects } from "../../../adapters/src/executor.js";
import { postgresAvailable, startDisposableCluster, type DisposableCluster } from "./disposable-postgres.js";

vi.mock("../../../adapters/src/computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "synthetic-computer", kind: "desktop" }),
}));

const available = postgresAvailable();
if (process.env.RAK_REQUIRE_PG === "1" && !available) throw new Error("RAK_REQUIRE_PG=1 but PostgreSQL binaries are unavailable");
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
  it("blocks dispatch after a real takeover at the committed claim barrier", async () => {
    const id = `dispatch-${randomUUID()}`;
    const org = await db.prisma.organization.create({ data: { id, slug: id, name: "Synthetic dispatch fixture", createdAt: new Date() } });
    const space = await db.prisma.space.create({ data: { id: `${id}-space`, organizationId: org.id, name: "Synthetic dispatch" } });
    const bot = await db.prisma.bot.create({ data: { spaceId: space.id, userId: id, name: "Fixture bot", color: "#123456" } });
    const thread = await db.prisma.thread.create({ data: { spaceId: space.id, botId: bot.id, userId: id } });
    const task = await db.prisma.task.create({ data: { spaceId: space.id, botId: bot.id, threadId: thread.id, userId: id, prompt: "Synthetic dispatch acceptance", status: "running" } });
    const run = await db.prisma.run.create({ data: { spaceId: space.id, botId: bot.id, threadId: thread.id, taskId: task.id, userId: id, trigger: "user", status: "queued" } });
    let release!: () => void;
    let claimed!: (effectId: string) => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const claimReached = new Promise<string>((resolve) => { claimed = resolve; });
    const memoryCommit = vi.fn(async () => ({ revision: "synthetic-revision" }));
    const toolResults: unknown[] = [];
    const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
    const prisma = new Proxy(db.prisma, {
      get(target, key) {
        if (key === "bot") return {
          findUniqueOrThrow: async () => ({ ...bot, computerId: "synthetic-computer", computer: { id: "synthetic-computer", scope: "dedicated" } }),
          findMany: async () => [],
        };
        if (key === "deploymentSettings") return { findUnique: async () => ({ defaultModelProvider: "scripted", defaultModelId: "scripted" }) };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const executor = createRunExecutor({
      prisma,
      afterEffectClaim: async (effectId: string) => { claimed(effectId); await barrier; },
      runtime: {
        describe: () => ({ capabilities: { scripted: false } }),
        run: async function* (request: { executeTool?: (name: string, args: Record<string, unknown>, executionId: string) => Promise<unknown> }) {
          toolResults.push(await request.executeTool!("remember", { path: "MEMORY.md", content: "synthetic dispatch" }, "dispatch-1"));
          yield { type: "done" as const, text: "Done" };
        },
      },
      connector: { discoverTools: async () => [], resolveCall: async () => undefined, execute: async function* () {} },
      sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
      memory: { describe: () => ({ capabilities: {} }), read: async () => ({ documents: [] }), search: async () => [], commit: memoryCommit, exportMarkdown: async function* () {} },
      memoryProviders: { resolve: async () => null },
      events: { append: vi.fn(async () => undefined), pauseRunForInput: vi.fn(async () => true), finalizeRun },
      jobs: { enqueue: vi.fn(async () => undefined) },
      secrets: [],
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    const oldTurn = executor.continueRun(run.id, "old-dispatch-owner");
    // Propagate setup failures instead of hanging on a barrier never reached.
    const effectId = await Promise.race([claimReached, oldTurn.then(() => { throw new Error("Executor exited before the committed claim barrier"); })]);
    try {
      expect(await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } })).toMatchObject({ status: "executing" });
      expect(memoryCommit).not.toHaveBeenCalled();
      await db.prisma.run.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(0) } });
      const stopped = new Error("test: takeover committed");
      const takeoverPrisma = new Proxy(db.prisma, {
        get(target, key) {
          if (key === "bot") return { findUniqueOrThrow: async () => { throw stopped; } };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const takeover = createRunExecutor({ prisma: takeoverPrisma, sandbox: {} } as unknown as Parameters<typeof createRunExecutor>[0]);
      await expect(takeover.continueRun(run.id, "new-dispatch-owner")).rejects.toBe(stopped);
      expect(await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } })).toMatchObject({ status: "uncertain" });
    } finally {
      release();
      await oldTurn;
    }
    expect(memoryCommit).not.toHaveBeenCalled();
    expect(toolResults).toHaveLength(0);
    expect(finalizeRun).not.toHaveBeenCalled();
    expect(await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } })).toMatchObject({ status: "uncertain" });
    expect(await db.prisma.event.count({ where: { runId: run.id, type: "effect.reconciled" } })).toBe(1);
  }, 30000);

  it("rejects update_bot at its transaction boundary after real takeover", async () => {
    const id = `dispatch-${randomUUID()}`;
    const org = await db.prisma.organization.create({ data: { id, slug: id, name: "Synthetic dispatch fixture", createdAt: new Date() } });
    const space = await db.prisma.space.create({ data: { id: `${id}-space`, organizationId: org.id, name: "Synthetic dispatch" } });
    const bot = await db.prisma.bot.create({ data: { spaceId: space.id, userId: id, name: "Fixture bot", color: "#123456" } });
    const thread = await db.prisma.thread.create({ data: { spaceId: space.id, botId: bot.id, userId: id } });
    const task = await db.prisma.task.create({ data: { spaceId: space.id, botId: bot.id, threadId: thread.id, userId: id, prompt: "Synthetic dispatch acceptance", status: "running" } });
    const run = await db.prisma.run.create({ data: { spaceId: space.id, botId: bot.id, threadId: thread.id, taskId: task.id, userId: id, trigger: "user", status: "queued" } });
    let release!: () => void;
    let claimed!: (effectId: string) => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const claimReached = new Promise<string>((resolve) => { claimed = resolve; });
    const memoryCommit = vi.fn(async () => ({ revision: "synthetic-revision" }));
    const toolResults: unknown[] = [];
    const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
    let armed = false;
    let intercepted = false;
    const prisma = new Proxy(db.prisma, {
      get(target, key) {
        if (key === "$transaction") return (callback: (tx: unknown) => Promise<unknown>, options?: unknown) => target.$transaction(async (tx) => callback(new Proxy(tx, {
          get(transaction, member) {
            if (member === "$queryRaw") return async (...args: unknown[]) => {
              if (armed && !intercepted && String(args[0]).includes("FROM bots")) {
                intercepted = true;
                const effect = await db.prisma.externalEffect.findFirstOrThrow({ where: { runId: run.id } });
                claimed(effect.id);
                await barrier;
              }
              return Reflect.apply(transaction.$queryRaw, transaction, args);
            };
            const value = Reflect.get(transaction, member);
            return typeof value === "function" ? value.bind(transaction) : value;
          },
        })), options as never);
        if (key === "bot") return {
          findUniqueOrThrow: async () => ({ ...bot, computerId: "synthetic-computer", computer: { id: "synthetic-computer", scope: "dedicated" } }),
          findMany: async () => [],
        };
        if (key === "deploymentSettings") return { findUnique: async () => ({ defaultModelProvider: "scripted", defaultModelId: "scripted" }) };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const executor = createRunExecutor({
      prisma,

      runtime: {
        describe: () => ({ capabilities: { scripted: false } }),
        run: async function* (request: { executeTool?: (name: string, args: Record<string, unknown>, executionId: string) => Promise<unknown> }) {
          armed = true;
          toolResults.push(await request.executeTool!("update_bot", { title: "stale mutation" }, "dispatch-1"));
          yield { type: "done" as const, text: "Done" };
        },
      },
      connector: { discoverTools: async () => [], resolveCall: async () => undefined, execute: async function* () {} },
      sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
      memory: { describe: () => ({ capabilities: {} }), read: async () => ({ documents: [] }), search: async () => [], commit: memoryCommit, exportMarkdown: async function* () {} },
      memoryProviders: { resolve: async () => null },
      events: { append: vi.fn(async () => undefined), pauseRunForInput: vi.fn(async () => true), finalizeRun },
      jobs: { enqueue: vi.fn(async () => undefined) },
      secrets: [],
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    const oldTurn = executor.continueRun(run.id, "old-dispatch-owner");
    // Propagate setup failures instead of hanging on a barrier never reached.
    const effectId = await Promise.race([claimReached, oldTurn.then(() => { throw new Error("Executor exited before the committed claim barrier"); })]);
    try {
      expect(await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } })).toMatchObject({ status: "executing" });
      expect(memoryCommit).not.toHaveBeenCalled();
      await db.prisma.run.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(0) } });
      const stopped = new Error("test: takeover committed");
      const takeoverPrisma = new Proxy(db.prisma, {
        get(target, key) {
          if (key === "bot") return { findUniqueOrThrow: async () => { throw stopped; } };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const takeover = createRunExecutor({ prisma: takeoverPrisma, sandbox: {} } as unknown as Parameters<typeof createRunExecutor>[0]);
      await expect(takeover.continueRun(run.id, "new-dispatch-owner")).rejects.toBe(stopped);
      expect(await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } })).toMatchObject({ status: "uncertain" });
    } finally {
      release();
      await oldTurn;
    }
    expect(memoryCommit).not.toHaveBeenCalled();
    expect(toolResults).toHaveLength(0);
    expect(intercepted).toBe(true);
    expect(await db.prisma.bot.findUniqueOrThrow({ where: { id: bot.id } })).toEqual(bot);
    expect(finalizeRun).not.toHaveBeenCalled();
    expect(await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } })).toMatchObject({ status: "uncertain" });
    expect(await db.prisma.event.count({ where: { runId: run.id, type: "effect.reconciled" } })).toBe(1);
  }, 30000);

  it("rejects a late effect result after real takeover leaves it uncertain", async () => {
    const id = `dispatch-${randomUUID()}`;
    const org = await db.prisma.organization.create({ data: { id, slug: id, name: "Synthetic dispatch fixture", createdAt: new Date() } });
    const space = await db.prisma.space.create({ data: { id: `${id}-space`, organizationId: org.id, name: "Synthetic dispatch" } });
    const bot = await db.prisma.bot.create({ data: { spaceId: space.id, userId: id, name: "Fixture bot", color: "#123456" } });
    const thread = await db.prisma.thread.create({ data: { spaceId: space.id, botId: bot.id, userId: id } });
    const task = await db.prisma.task.create({ data: { spaceId: space.id, botId: bot.id, threadId: thread.id, userId: id, prompt: "Synthetic dispatch acceptance", status: "running" } });
    const run = await db.prisma.run.create({ data: { spaceId: space.id, botId: bot.id, threadId: thread.id, taskId: task.id, userId: id, trigger: "user", status: "queued" } });
    let release!: () => void;
    let claimed!: (effectId: string) => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const claimReached = new Promise<string>((resolve) => { claimed = resolve; });
    const memoryCommit = vi.fn(async () => { claimed(claimedEffectId); await barrier; return { revision: "synthetic-revision" }; });
    let claimedEffectId = "";
    const toolResults: unknown[] = [];
    const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
    const prisma = new Proxy(db.prisma, {
      get(target, key) {
        if (key === "bot") return {
          findUniqueOrThrow: async () => ({ ...bot, computerId: "synthetic-computer", computer: { id: "synthetic-computer", scope: "dedicated" } }),
          findMany: async () => [],
        };
        if (key === "deploymentSettings") return { findUnique: async () => ({ defaultModelProvider: "scripted", defaultModelId: "scripted" }) };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const executor = createRunExecutor({
      prisma,
      afterEffectClaim: async (effectId: string) => { claimedEffectId = effectId; },
      runtime: {
        describe: () => ({ capabilities: { scripted: false } }),
        run: async function* (request: { executeTool?: (name: string, args: Record<string, unknown>, executionId: string) => Promise<unknown> }) {
          toolResults.push(await request.executeTool!("remember", { path: "MEMORY.md", content: "synthetic dispatch" }, "dispatch-1"));
          yield { type: "done" as const, text: "Done" };
        },
      },
      connector: { discoverTools: async () => [], resolveCall: async () => undefined, execute: async function* () {} },
      sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
      memory: { describe: () => ({ capabilities: {} }), read: async () => ({ documents: [] }), search: async () => [], commit: memoryCommit, exportMarkdown: async function* () {} },
      memoryProviders: { resolve: async () => null },
      events: { append: vi.fn(async () => undefined), pauseRunForInput: vi.fn(async () => true), finalizeRun },
      jobs: { enqueue: vi.fn(async () => undefined) },
      secrets: [],
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    const oldTurn = executor.continueRun(run.id, "old-dispatch-owner");
    // Propagate setup failures instead of hanging on a barrier never reached.
    const effectId = await Promise.race([claimReached, oldTurn.then(() => { throw new Error("Executor exited before the dispatched effect barrier"); })]);
    try {
      expect(await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } })).toMatchObject({ status: "executing" });
      expect(memoryCommit).toHaveBeenCalledTimes(1);
      await db.prisma.run.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(0) } });
      const stopped = new Error("test: takeover committed");
      const takeoverPrisma = new Proxy(db.prisma, {
        get(target, key) {
          if (key === "bot") return { findUniqueOrThrow: async () => { throw stopped; } };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const takeover = createRunExecutor({ prisma: takeoverPrisma, sandbox: {} } as unknown as Parameters<typeof createRunExecutor>[0]);
      await expect(takeover.continueRun(run.id, "new-dispatch-owner")).rejects.toBe(stopped);
      expect(await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } })).toMatchObject({ status: "uncertain" });
    } finally {
      release();
      await oldTurn;
    }
    expect(memoryCommit).toHaveBeenCalledTimes(1);
    expect(toolResults).toHaveLength(0);
    expect(finalizeRun).not.toHaveBeenCalled();
    expect(await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effectId } })).toMatchObject({ status: "uncertain" });
    expect(await db.prisma.event.count({ where: { runId: run.id, type: "effect.reconciled" } })).toBe(1);
  }, 30000);

  it("rejects the previous holder after takeover through continueRun", async () => {
    const id = `claim-${randomUUID()}`;
    const org = await db.prisma.organization.create({ data: { id, slug: id, name: "Synthetic claim fixture", createdAt: new Date() } });
    const space = await db.prisma.space.create({ data: { id: id + "-space", organizationId: org.id, name: "Synthetic claim" } });
    const bot = await db.prisma.bot.create({ data: { spaceId: space.id, userId: id, name: "Fixture bot", color: "#123456" } });
    const thread = await db.prisma.thread.create({ data: { spaceId: space.id, botId: bot.id, userId: id } });
    const task = await db.prisma.task.create({ data: { spaceId: space.id, botId: bot.id, threadId: thread.id, userId: id, prompt: "Synthetic claim acceptance", status: "running" } });
    const run = await db.prisma.run.create({ data: { spaceId: space.id, botId: bot.id, threadId: thread.id, taskId: task.id, userId: id, trigger: "user", status: "queued" } });
    // Stop after the real claim and recovery commit, before computer/runtime setup.
    const stopped = new Error("test: after real claim");
    const prisma = new Proxy(db.prisma, {
      get(target, key) {
        if (key === "bot") return { findUniqueOrThrow: async () => { throw stopped; } };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const executor = createRunExecutor({ prisma, sandbox: {} } as unknown as Parameters<typeof createRunExecutor>[0]);
    await expect(executor.continueRun(run.id, "old-owner")).rejects.toBe(stopped);
    const old = await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(old).toMatchObject({ status: "running", leaseOwner: "old-owner" });
    await db.prisma.run.update({ where: { id: run.id }, data: { leaseExpiresAt: new Date(0) } });
    await expect(executor.continueRun(run.id, "new-owner")).rejects.toBe(stopped);
    const current = await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(current).toMatchObject({ status: "running", leaseOwner: "new-owner", leaseFence: old.leaseFence + 1 });
    const executionFence = { runId: run.id, leaseOwner: old.leaseOwner!, leaseFence: old.leaseFence };
    const staleDeps = { prisma: db.prisma, executionFence };
    const scope = { spaceId: space.id, botId: bot.id, userId: id };
    const staleError = "Run execution fence is no longer current";
    await expect(addScratchpadItemFromTool(staleDeps, { ...scope, title: "stale" })).rejects.toThrow(staleError);
    expect(await db.prisma.scratchpadItem.count({ where: { spaceId: space.id } })).toBe(0);
    const jobs = { enqueue: vi.fn(), cancel: vi.fn() };
    await expect(createScheduleFromTool({ ...staleDeps, jobs, events: { append: vi.fn() } } as any, { ...scope, threadId: thread.id, name: "stale", prompt: "stale", schedule: { delaySeconds: 60 } })).rejects.toThrow(staleError);
    expect(await db.prisma.routine.count({ where: { spaceId: space.id } })).toBe(0);
    expect(jobs.enqueue).not.toHaveBeenCalled();
    await expect(createTicket({ ...staleDeps, ticketBoardEnabled: true }, { ...scope, title: "stale" })).rejects.toThrow(staleError);
    expect(await db.prisma.board.count({ where: { spaceId: space.id } })).toBe(0);
    expect(await db.prisma.ticket.count({ where: { spaceId: space.id } })).toBe(0);
    await expect(new MarkdownMemoryStore(db.prisma).commit({ scope: "bot", botId: bot.id, path: "MEMORY.md", content: "stale" }, { ...scope, operationId: run.id, traceId: run.id, runId: run.id, executionFence })).rejects.toThrow(staleError);
    expect(await db.prisma.memoryDocument.count({ where: { spaceId: space.id } })).toBe(0);

    const item = await db.prisma.scratchpadItem.create({ data: { ...scope, title: "original", status: "open" } });
    await expect(updateScratchpadItemFromTool(staleDeps, { ...scope, itemId: item.id, title: "stale" })).rejects.toThrow(staleError);
    await expect(completeScratchpadItemFromTool(staleDeps, { ...scope, itemId: item.id })).rejects.toThrow(staleError);
    await expect(removeScratchpadItemFromTool(staleDeps, { ...scope, itemId: item.id })).rejects.toThrow(staleError);
    expect(await db.prisma.scratchpadItem.findUniqueOrThrow({ where: { id: item.id } })).toEqual(item);
    const project = await db.prisma.project.create({ data: { spaceId: space.id, name: "Fixture project" } });
    const goalDeps = { ...staleDeps, ticketBoardEnabled: true };
    await expect(executeGoalTool(goalDeps, space.id, "goal_create", { projectId: project.id, name: "stale" })).rejects.toThrow(staleError);
    expect(await db.prisma.goal.count({ where: { spaceId: space.id } })).toBe(0);

    const goal = await db.prisma.goal.create({ data: { spaceId: space.id, projectId: project.id, name: "original" } });
    const krFields = { name: "original", measure: "count", targetValue: 1, currentValue: 0, calculationRule: "manual" };
    const kr = await db.prisma.keyResult.create({ data: { ...krFields, spaceId: space.id, projectId: project.id, goalId: goal.id } });
    await expect(executeGoalTool(goalDeps, space.id, "goal_update", { id: goal.id, name: "stale" })).rejects.toThrow(staleError);
    await expect(executeGoalTool(goalDeps, space.id, "goal_delete", { id: goal.id })).rejects.toThrow(staleError);
    await expect(executeGoalTool(goalDeps, space.id, "key_result_create", { ...krFields, goalId: goal.id })).rejects.toThrow(staleError);
    await expect(executeGoalTool(goalDeps, space.id, "key_result_update", { id: kr.id, currentValue: 1 })).rejects.toThrow(staleError);
    await expect(executeGoalTool(goalDeps, space.id, "key_result_archive", { id: kr.id })).rejects.toThrow(staleError);
    await expect(executeGoalTool(goalDeps, space.id, "key_result_delete", { id: kr.id })).rejects.toThrow(staleError);
    expect(await db.prisma.goal.findUniqueOrThrow({ where: { id: goal.id } })).toEqual(goal);
    expect(await db.prisma.keyResult.findMany({ where: { spaceId: space.id } })).toEqual([kr]);
    const ticketDeps = { ...staleDeps, ticketBoardEnabled: true };
    const board = await db.prisma.board.create({ data: { spaceId: space.id } });
    const ticket = await db.prisma.ticket.create({ data: { spaceId: space.id, boardId: board.id, number: 1, title: "original" } });
    const prerequisite = await db.prisma.ticket.create({ data: { spaceId: space.id, boardId: board.id, number: 2, title: "prerequisite" } });
    await expect(updateTicket(ticketDeps, { spaceId: space.id, botId: bot.id, id: ticket.id, title: "stale" })).rejects.toThrow(staleError);
    await expect(commentTicket(ticketDeps, { spaceId: space.id, botId: bot.id, id: ticket.id, body: "stale" })).rejects.toThrow(staleError);
    const edge = { ticketId: ticket.id, prerequisiteId: prerequisite.id };
    await expect(executeDependencyTool(ticketDeps, space.id, "ticket_dependency_add", edge)).rejects.toThrow(staleError);
    expect(await db.prisma.ticketDependency.count({ where: { spaceId: space.id } })).toBe(0);
    await db.prisma.ticketDependency.create({ data: { spaceId: space.id, ...edge } });
    await expect(executeDependencyTool(ticketDeps, space.id, "ticket_dependency_remove", edge)).rejects.toThrow(staleError);
    expect(await db.prisma.ticketDependency.count({ where: { spaceId: space.id } })).toBe(1);
    expect(await db.prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).toEqual(ticket);
    expect(await db.prisma.ticketComment.count({ where: { ticketId: ticket.id } })).toBe(0);
    const routine = await db.prisma.routine.create({ data: { ...scope, threadId: thread.id, name: "original", prompt: "fixture", crons: ["0 0 * * *"], active: true } });
    const remove = vi.fn();
    await expect(cancelScheduleFromTool({ ...staleDeps, queue: { remove } } as unknown as Parameters<typeof cancelScheduleFromTool>[0], { ...scope, routineId: routine.id })).rejects.toThrow(staleError);
    expect(remove).not.toHaveBeenCalled();
    expect(await db.prisma.routine.findUniqueOrThrow({ where: { id: routine.id } })).toEqual(routine);

    await db.prisma.user.create({ data: { id, name: "Synthetic owner", email: `${id}@example.invalid` } });
    const secret = await db.prisma.botSecret.create({ data: { ...scope, id: `${id}-secret`, name: "synthetic", origin: "https://example.invalid", auth: { type: "bearer" }, ciphertext: "synthetic-fixture" } });
    await expect(forgetBotSecret(db.prisma, scope, secret.name, executionFence)).rejects.toThrow(staleError);
    expect(await db.prisma.botSecret.findUniqueOrThrow({ where: { id: secret.id } })).toEqual(secret);
    await expect(createProposal(db.prisma, scope, { botId: bot.id, submitKey: `${id}-proposal`, kind: "plan", title: "stale", summary: "Synthetic proposal", options: [], recommendation: "" }, executionFence)).rejects.toThrow(staleError);
    expect(await db.prisma.proposal.count({ where: { spaceId: space.id } })).toBe(0);

    const before = await db.prisma.thread.findUniqueOrThrow({ where: { id: thread.id } });
    await expect(db.prisma.$transaction(tx => appendEventInTransaction(tx, {
      spaceId: space.id, threadId: thread.id, botId: bot.id, runId: run.id,
      executionFence: { runId: run.id, leaseOwner: old.leaseOwner!, leaseFence: old.leaseFence },
      type: "effect.reconciled", payload: {},
    }))).rejects.toThrow("Run execution fence is no longer current");
    expect(await db.prisma.event.count({ where: { runId: run.id } })).toBe(0);
    expect((await db.prisma.thread.findUniqueOrThrow({ where: { id: thread.id } })).nextEventSeq).toBe(before.nextEventSeq);
  }, 30000);

  it("rejects stale history writers and recovers an unfinished effect exactly once", async () => {
    const id = `fence-${randomUUID()}`;
    const org = await db.prisma.organization.create({ data: { id, slug: id, name: "Synthetic fence fixture", createdAt: new Date() } });
    const space = await db.prisma.space.create({ data: { id: id + "-space", organizationId: org.id, name: "Synthetic fence" } });
    const bot = await db.prisma.bot.create({ data: { spaceId: space.id, userId: id, name: "Fixture bot", color: "#123456" } });
    const thread = await db.prisma.thread.create({ data: { spaceId: space.id, botId: bot.id, userId: id } });
    const task = await db.prisma.task.create({ data: { spaceId: space.id, botId: bot.id, threadId: thread.id, userId: id, prompt: "Synthetic fence acceptance", status: "running" } });
    const run = await db.prisma.run.create({ data: { spaceId: space.id, botId: bot.id, threadId: thread.id, taskId: task.id, userId: id, trigger: "user", status: "running", leaseOwner: "new-owner", leaseFence: 2, leaseExpiresAt: new Date(Date.now() + 120_000) } });
    const stale = { runId: run.id, leaseOwner: "old-owner", leaseFence: 1 };
    const current = { runId: run.id, leaseOwner: "new-owner", leaseFence: 2 };
    const attribution = { spaceId: space.id, threadId: thread.id, botId: bot.id, runId: run.id };
    await expect(db.prisma.$transaction(tx => appendEventInTransaction(tx, { ...attribution, executionFence: stale, type: "effect.reconciled", payload: {} }))).rejects.toThrow("Run execution fence is no longer current");
    await expect(db.prisma.$transaction(tx => createThreadMessageInTransaction(tx, { ...attribution, executionFence: stale, role: "bot", blocks: [] }))).rejects.toThrow("Run execution fence is no longer current");
    const afterStaleHistory = await db.prisma.thread.findUniqueOrThrow({ where: { id: thread.id } });
    expect(afterStaleHistory.nextMessageSeq).toBe(thread.nextMessageSeq);
    expect(afterStaleHistory.nextEventSeq).toBe(thread.nextEventSeq);
    const usage = { type: "usage" as const, provider: "fixture", model: "test", callId: id + "-call", inputTokens: 10, outputTokens: 2 };
    await expect(recordUsage(db.prisma, usage, { ...attribution, userId: id }, { executionFence: stale })).rejects.toThrow("Run execution fence is no longer current");
    await expect(settleBudget(db.prisma, { spaceId: space.id, callId: usage.callId, actualMicroUsd: 1n, executionFence: stale })).rejects.toThrow("Run execution fence is no longer current");
    const staleAttempt = await db.prisma.attempt.create({
      data: { runId: run.id, fence: stale.leaseFence, status: "running" },
    });
    expect(await pauseRunForInput(db.prisma, { ...attribution, attemptId: staleAttempt.id, leaseOwner: stale.leaseOwner, leaseFence: stale.leaseFence, blocks: [] })).toBe(false);
    expect(await db.prisma.attempt.findUniqueOrThrow({ where: { id: staleAttempt.id } })).toMatchObject({
      status: "running", finishedAt: null, fence: stale.leaseFence,
    });
    expect(await db.prisma.message.count({ where: { runId: run.id } })).toBe(0);
    expect((await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("running");
    expect(await db.prisma.usageRecord.count({ where: { callId: usage.callId } })).toBe(0);
    expect(await db.prisma.budgetSpendLedger.count({ where: { callId: usage.callId } })).toBe(0);
    await db.prisma.run.update({ where: { id: run.id }, data: { leaseOwner: stale.leaseOwner, leaseFence: stale.leaseFence } });
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./execution-fence-crash-worker.ts", import.meta.url))], {
      env: { ...process.env, RAK_CRASH_TEST_DATABASE_URL: dbUrl, RAK_FENCE_TEST_RUN_ID: run.id },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.stderr.on("data", chunk => { errors += chunk.toString(); });
    const exited = once(child, "exit");
    try {
      await vi.waitFor(() => {
        if (child.exitCode !== null) throw new Error(`Crash worker exited: ${errors}`);
        expect(output).toContain("effectId");
      }, { timeout: 20000 });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
    expect(child.exitCode, errors).toBe(null);
    expect(child.signalCode, errors).toBe("SIGKILL");
    const artifact = JSON.parse(output.trim()) as { effectId: string };
    const effect = await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: artifact.effectId } });
    expect(effect.status).toBe("executing");
    await db.prisma.run.update({ where: { id: run.id }, data: { leaseOwner: current.leaseOwner, leaseFence: current.leaseFence } });

    const deps = { prisma: db.prisma } as Parameters<typeof recoverUnfinishedEffects>[0];
    await expect(recoverUnfinishedEffects(deps, run, stale)).rejects.toThrow("Run execution fence is no longer current");
    expect((await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } })).status).toBe("executing");
    await recoverUnfinishedEffects(deps, run, current);
    await recoverUnfinishedEffects(deps, run, current);
    expect((await db.prisma.externalEffect.findUniqueOrThrow({ where: { id: effect.id } })).status).toBe("uncertain");
    expect(await db.prisma.externalEffect.count({ where: { runId: run.id } })).toBe(1);
    expect(await db.prisma.event.count({ where: { runId: run.id, type: "effect.reconciled" } })).toBe(1);
    expect(await db.prisma.message.count({ where: { runId: run.id } })).toBe(0);
    expect(await db.prisma.usageRecord.count({ where: { callId: usage.callId } })).toBe(0);
    expect(await db.prisma.budgetSpendLedger.count({ where: { callId: usage.callId } })).toBe(0);
  }, 30000);
  it("records and settles a billable call exactly once", async () => {
    const id = `billing-${randomUUID()}`;
    const org = await db.prisma.organization.create({ data: { id, slug: id, name: "Synthetic billing fixture", createdAt: new Date() } });
    const space = await db.prisma.space.create({ data: { id: id + "-space", organizationId: org.id, name: "Synthetic billing" } });
    const bot = await db.prisma.bot.create({ data: { spaceId: space.id, userId: id, name: "Fixture bot", color: "#123456" } });
    const thread = await db.prisma.thread.create({ data: { spaceId: space.id, botId: bot.id, userId: id } });
    const task = await db.prisma.task.create({ data: { spaceId: space.id, botId: bot.id, threadId: thread.id, userId: id, prompt: "Synthetic billing acceptance", status: "running" } });
    const run = await db.prisma.run.create({ data: { spaceId: space.id, botId: bot.id, threadId: thread.id, taskId: task.id, userId: id, trigger: "user", status: "running", leaseOwner: "billing-owner", leaseFence: 1, leaseExpiresAt: new Date(Date.now() + 120_000) } });
    const executionFence = { runId: run.id, leaseOwner: "billing-owner", leaseFence: 1 };
    const project = await db.prisma.project.create({ data: { spaceId: space.id, name: "Synthetic billing project" } });
    await setProjectBudget(db.prisma, { spaceId: space.id, projectId: project.id, limitMicroUsd: 1000000n });
    const callId = `${id}-call`;
    await reserveBudget(db.prisma, { spaceId: space.id, projectId: project.id, callId, amountMicroUsd: 500000n, executionFence });
    const attribution = { spaceId: space.id, projectId: project.id, userId: id, botId: bot.id, threadId: thread.id, runId: run.id };
    const usage = { type: "usage", provider: "synthetic", model: "fixture", inputTokens: 10, outputTokens: 5, callId, billingKind: "api_metered", costUsdDecimal: "0.125" } satisfies Parameters<typeof recordUsage>[1];
    for (let replay = 0; replay < 2; replay++) {
      await recordUsage(db.prisma, usage, attribution, { executionFence });
      await settleBudget(db.prisma, { spaceId: space.id, callId, actualMicroUsd: 125000n, executionFence });
    }
    expect(await db.prisma.usageRecord.count({ where: { spaceId: space.id, callId } })).toBe(1);
    expect(await db.prisma.budgetSpendLedger.count({ where: { spaceId: space.id, callId, kind: "settled" } })).toBe(1);
    const budget = await db.prisma.projectBudget.findUniqueOrThrow({ where: { spaceId_projectId: { spaceId: space.id, projectId: project.id } } });
    expect(budget.settledMicroUsd).toBe(125000n);
  }, 30000);

  for (const competitor of ["finalize", "recover"] as const) {
    for (const first of ["mcp", "competitor"] as const) {
      it(`serializes MCP creation against ${competitor}, ${first} first`, async () => {
        function deferred() {
          let resolve!: () => void;
          const promise = new Promise<void>(r => { resolve = r; });
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
        const instrumentedPrisma = new Proxy(db.prisma, {
          get(target, key) {
            if (key === "$transaction") return (callback: (tx: any) => Promise<unknown>, options?: any) =>
              target.$transaction(async tx => callback(new Proxy(tx, {
                get(transaction, method) {
                  const value = Reflect.get(transaction, method);
                  if (method === "$queryRaw") return async (...args: any[]) => {
                    const query = String(args[0]);
                    const isThreadLock = armed && query.includes("threads") && query.includes("FOR UPDATE");
                    if (isThreadLock && ++threadLocks === 2) waiting.resolve();
                    const result = await value.apply(transaction, args);
                    if (isThreadLock && !held) {
                      held = true; locked.resolve(); await unlock.promise;
                    }
                    return result;
                  };
                  return typeof value === "function" ? value.bind(transaction) : value;
                },
              })), options);
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
    const id = `dispatch-${randomUUID()}`;
    await db.prisma.user.create({ data: { id, name: "Synthetic concurrency user", email: id + "@example.invalid" } });
    const org = await db.prisma.organization.create({ data: { id, slug: id, name: "Synthetic dispatch fixture", createdAt: new Date() } });
    const space = await db.prisma.space.create({ data: { id: `${id}-space`, organizationId: org.id, name: "Synthetic dispatch" } });
    const bot = await db.prisma.bot.create({ data: { spaceId: space.id, userId: id, name: "Fixture bot", color: "#123456" } });
    const thread = await db.prisma.thread.create({ data: { spaceId: space.id, botId: bot.id, userId: id } });
    const task = await db.prisma.task.create({ data: { spaceId: space.id, botId: bot.id, threadId: thread.id, userId: id, prompt: "Synthetic dispatch acceptance", status: "running" } });
    const run = await db.prisma.run.create({ data: { spaceId: space.id, botId: bot.id, threadId: thread.id, taskId: task.id, userId: id, trigger: "user", status: "queued" } });
    let release!: () => void;
    let claimed!: (effectId: string) => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const claimReached = new Promise<string>((resolve) => { claimed = resolve; });
    const memoryCommit = vi.fn(async () => ({ revision: "synthetic-revision" }));
    const toolResults: unknown[] = [];
    const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
    const prisma = new Proxy(instrumentedPrisma, {
      get(target, key) {
        if (key === "bot") return {
          findUniqueOrThrow: async () => ({ ...bot, computerId: "synthetic-computer", computer: { id: "synthetic-computer", scope: "dedicated" } }),
          findMany: async () => [],
        };
        if (key === "deploymentSettings") return { findUnique: async () => ({ defaultModelProvider: "scripted", defaultModelId: "scripted" }) };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const executor = createRunExecutor({
      prisma,
      secretStore: { put: vi.fn(async () => { throw new Error("Unexpected synthetic credential write"); }), load: vi.fn(async () => "") },

      runtime: {
        describe: () => ({ capabilities: { scripted: false } }),
        run: async function* (request: { executeTool?: (name: string, args: Record<string, unknown>, executionId: string) => Promise<unknown> }) {
          runtimeReached.resolve();
          await startTool.promise;
          toolResults.push(await request.executeTool!("add_mcp_server", { name: "Synthetic concurrency server", transport: "stdio", command: "synthetic-command", assign_to_self: false }, "mcp-concurrency"));
          await finishRuntime.promise;
          yield { type: "done" as const, text: "Done" };
        },
      },
      connector: { discoverTools: async () => [], resolveCall: async () => undefined, execute: async function* () {} },
      sandbox: { describe: () => ({ capabilities: { graphical: false } }) },
      memory: { describe: () => ({ capabilities: {} }), read: async () => ({ documents: [] }), search: async () => [], commit: memoryCommit, exportMarkdown: async function* () {} },
      memoryProviders: { resolve: async () => null },
      events: { append: vi.fn(async () => undefined), pauseRunForInput: vi.fn(async () => true), finalizeRun },
      jobs: { enqueue: vi.fn(async () => undefined) },
      secrets: [],
    } as unknown as Parameters<typeof createRunExecutor>[0]);

        const turn = executor.continueRun(run.id, "mcp-owner");
        await Promise.race([runtimeReached.promise, turn.then(() => { throw new Error("Runtime barrier not reached"); })]);
        const active = await db.prisma.run.findUniqueOrThrow({ where: { id: run.id } });
        const attempt = await db.prisma.attempt.findFirstOrThrow({ where: { runId: run.id, fence: active.leaseFence } });
        const fence = { runId: run.id, leaseOwner: "mcp-owner", leaseFence: active.leaseFence };
        const compete = () => competitor === "finalize"
          ? finalizeRunInDb(instrumentedPrisma, { spaceId: space.id, threadId: thread.id, botId: bot.id, runId: run.id, taskId: task.id, attemptId: attempt.id, leaseOwner: fence.leaseOwner, leaseFence: fence.leaseFence, outcome: "completed", blocks: [] })
          : recoverUnfinishedEffects({ prisma: instrumentedPrisma } as Parameters<typeof recoverUnfinishedEffects>[0], run, fence);
        armed = true;
        let other: Promise<unknown> | undefined;
        try {
          if (first === "mcp") startTool.resolve();
          else other = compete();
          await locked.promise;
          if (first === "mcp") other = compete();
          else startTool.resolve();
          await waiting.promise;
        } finally { unlock.resolve(); startTool.resolve(); }
        let competingError: unknown;
        try { await other; } catch (error) { competingError = error; } finally { finishRuntime.resolve(); }
        await turn;
        const executorFailures = finalizeRun.mock.calls.filter((args: unknown[]) => (args[0] as { outcome?: string } | undefined)?.outcome === "failed");
        expect(executorFailures, JSON.stringify(executorFailures)).toEqual([]);
        if (competingError) throw competingError;
        const count = await db.prisma.mcpServer.count({ where: { spaceId: space.id } });
        expect(count).toBe(competitor === "finalize" && first === "competitor" ? 0 : 1);
      }, 30000);
    }
  }

});
