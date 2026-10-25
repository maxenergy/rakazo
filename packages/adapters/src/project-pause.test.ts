import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";
import { reconcileTicketWakes, wakeTicketAssignee } from "./ticket-wake.js";

function ticketDeps() {
  const projects: Record<string, string> = { paused: "paused", other: "active" };
  let projectId = "paused";
  const taskCreate = vi.fn(async () => ({ id: "task" }));
  const runCreate = vi.fn(async ({ data }) => ({ id: "run", ...data }));
  const tx = {
    project: { findFirst: vi.fn(async ({ where }) => ({ status: projects[where.id] })) },
    ticket: {
      findFirst: vi.fn(async () => ({
        id: "ticket",
        status: "doing",
        projectId,
        assigneeBotId: "shared",
        board: { ticketPrefix: "TEST" },
        number: 1,
      })),
    },
    bot: {
      findFirst: vi.fn(async () => ({ id: "shared", userId: "user", thread: { id: "thread" } })),
    },
    task: { create: taskCreate },
    run: { findFirst: vi.fn(async () => null), create: runCreate },
    ticketWake: { update: vi.fn() },
    $executeRaw: vi.fn(async () => 1),
  };
  const prisma = {
    $transaction: vi.fn(async (fn) => fn(tx)),
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => [{ id: "wake", spaceId: "space", ticketId: "ticket" }]),
  } as unknown as PrismaClient;
  return {
    deps: {
      prisma,
      ticketBoardEnabled: true,
      jobs: {
        enqueue: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
    } as Parameters<typeof wakeTicketAssignee>[0],
    projects,
    tx,
    taskCreate,
    runCreate,
    setProject: (value: string) => {
      projectId = value;
    },
  };
}

describe("项目暂停入口", () => {
  it("手动派工拒绝暂停项目，恢复后可执行，共享员工仍可执行其他项目", async () => {
    const f = ticketDeps();
    const input = { spaceId: "space", ticketId: "ticket", botId: "shared" };
    await expect(wakeTicketAssignee(f.deps, input)).rejects.toThrow("Project is paused.");
    expect(f.taskCreate).not.toHaveBeenCalled();
    expect(f.deps.jobs.enqueue).not.toHaveBeenCalled();
    f.setProject("other");
    await wakeTicketAssignee(f.deps, input);
    expect(f.runCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ projectId: "other", botId: "shared" }),
      }),
    );
    f.projects.paused = "active";
    f.setProject("paused");
    await wakeTicketAssignee(f.deps, input);
    expect(f.runCreate).toHaveBeenCalledTimes(2);
  });

  it("自动依赖派工拒绝暂停项目并记录原因", async () => {
    const f = ticketDeps();
    expect(await reconcileTicketWakes(f.deps, { claimer: "worker" })).toBe(0);
    expect(f.taskCreate).not.toHaveBeenCalled();
    expect(f.tx.ticketWake.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "skipped",
          outcomeReason: expect.stringContaining("paused"),
        }),
      }),
    );
  });

  it("带 projectId 的新运行在启动前被拒绝", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const executor = createRunExecutor({
      prisma: {
        task: { updateMany: vi.fn(async () => ({ count: 1 })) },
        run: {
          findUnique: vi.fn(async () => ({
            id: "run",
            spaceId: "space",
            projectId: "paused",
            status: "queued",
            startedAt: null,
          })),
          updateMany,
        },
        project: { findFirst: vi.fn(async () => ({ status: "paused" })) },
      },
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    await executor.continueRun("run", "worker");
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "failed",
          error: expect.stringContaining("paused"),
        }),
      }),
    );
  });

  it("定时触发拒绝暂停项目、保持启用并安排下一次，恢复后照常", async () => {
    let paused = true;
    const scheduledAt = new Date(Date.now() - 1_000);
    const routine = {
      id: "routine",
      projectId: "project",
      spaceId: "space",
      botId: "shared",
      userId: "user",
      prompt: "test",
      crons: ["* * * * *"],
      timezone: "UTC",
      active: true,
      nextRunAt: scheduledAt,
      lastRunAt: null,
    };
    const create = vi.fn(async ({ data }) => ({ id: "run", ...data }));
    const append = vi.fn();
    const enqueue = vi.fn();
    const update = vi.fn();
    const tx = {
      project: { findFirst: vi.fn(async () => ({ status: paused ? "paused" : "active" })) },
      routine: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        update,
        findUnique: vi.fn(async () => ({
          modelProvider: null,
          modelId: null,
          thinkingLevel: null,
        })),
      },
      task: { create: vi.fn(async () => ({ id: "task" })) },
      run: { create },
    };
    const executor = createRunExecutor({
      prisma: {
        routine: { findUnique: vi.fn(async () => routine) },
        bot: { findUnique: vi.fn(async () => ({ id: "shared", thread: { id: "thread" } })) },
        agentSkill: { findMany: vi.fn(async () => []) },
        $transaction: vi.fn(async (fn) => fn(tx)),
      },
      events: { append },
      jobs: { enqueue },
    } as unknown as Parameters<typeof createRunExecutor>[0]);
    await executor.wakeRoutine("routine", scheduledAt.toISOString());
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ active: true }) }),
    );
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "routine.skipped",
        payload: expect.objectContaining({ reason: expect.stringContaining("paused") }),
      }),
    );
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "routine.wakeup" }));
    paused = false;
    await executor.wakeRoutine("routine", scheduledAt.toISOString());
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ projectId: "project" }) }),
    );
  });
});
