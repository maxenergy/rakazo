import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import {
  createDeadlineRecoveryRun,
  createResumeRun,
  deadlineRecoveryPrompt,
  resumePrompt,
} from "./run-recovery.js";
import { DEFAULT_RUN_DEADLINE_MS } from "./run-segments.js";

const input = { spaceId: "space", threadId: "thread", botId: "bot", runId: "failed-run" };

function fixture(overrides: Record<string, unknown> = {}, state = { active: false, earlier: 0 }) {
  const tx = {
    run: {
      findUnique: vi.fn(async () => ({
        trigger: "follow_up",
        userId: "user",
        projectId: "project",
        rootRunId: "root-run",
        modelPinned: false,
        modelProvider: "provider",
        modelId: "model",
        thinkingLevel: null,
        task: { prompt: "Fix the failing tests" },
        bot: { archivedAt: null },
        ...overrides,
      })),
      findFirst: vi.fn(async () => (state.active ? { id: "active-run" } : null)),
      count: vi.fn(async () => state.earlier),
      create: vi.fn(async () => ({ id: "recovery-run" })),
    },
    message: {
      findMany: vi.fn(async () => [
        { blocks: [{ kind: "text", text: "Second finding" }] },
        { blocks: [{ kind: "steps", steps: [] }] },
        { blocks: [{ kind: "text", text: "First finding" }] },
      ]),
    },
    task: { create: vi.fn(async () => ({ id: "recovery-task" })) },
  };
  return { tx, client: tx as unknown as Prisma.TransactionClient };
}

describe("createDeadlineRecoveryRun", () => {
  it("queues a shorter run in the same chain, carrying the task and the run's notes", async () => {
    const { tx, client } = fixture();
    await expect(createDeadlineRecoveryRun(client, input)).resolves.toBe("recovery-run");
    const [[created]] = tx.task.create.mock.calls as unknown as [[{ data: { prompt: string } }]];
    expect(created.data.prompt).toContain("Fix the failing tests");
    expect(created.data.prompt).toMatch(/First finding[\s\S]*Second finding/);
    expect(tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        trigger: "follow_up",
        status: "queued",
        parentRunId: "failed-run",
        rootRunId: "root-run",
        projectId: "project",
        deadlineMs: DEFAULT_RUN_DEADLINE_MS,
      }),
    });
  });

  it("starts a chain at a run that has no root and keeps a pinned model", async () => {
    const { tx, client } = fixture({ rootRunId: null, modelPinned: true });
    await createDeadlineRecoveryRun(client, input);
    expect(tx.run.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        rootRunId: "failed-run",
        modelPinned: true,
        modelProvider: "provider",
        modelId: "model",
      }),
    });
  });

  it("does not recover a second timeout of the same bot in a chain", async () => {
    const { tx, client } = fixture({}, { active: false, earlier: 1 });
    await expect(createDeadlineRecoveryRun(client, input)).resolves.toBeNull();
    expect(tx.run.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: { not: "failed-run" },
        botId: "bot",
        OR: [{ id: "root-run" }, { rootRunId: "root-run" }],
      }),
    });
    expect(tx.run.create).not.toHaveBeenCalled();
  });

  it("leaves a bot alone while it has another run", async () => {
    const { tx, client } = fixture({}, { active: true, earlier: 0 });
    await expect(createDeadlineRecoveryRun(client, input)).resolves.toBeNull();
    expect(tx.task.create).not.toHaveBeenCalled();
  });

  it.each([
    ["bot_message", {}],
    ["routine", {}],
    ["org_check_in", {}],
    ["follow_up", { bot: { archivedAt: new Date() } }],
  ])("does not recover %s work %j", async (trigger, extra) => {
    const { tx, client } = fixture({ trigger, ...extra });
    await expect(createDeadlineRecoveryRun(client, input)).resolves.toBeNull();
    expect(tx.run.create).not.toHaveBeenCalled();
  });

  it("omits the notes section when the run left none", () => {
    expect(deadlineRecoveryPrompt("Task", [])).not.toContain("last notes");
  });
});

describe("createResumeRun", () => {
  const request = { spaceId: "space", userId: "user", runId: "failed-run" };

  function resumeFixture(
    state: {
      failed?: boolean;
      superseded?: boolean;
      pinned?: boolean;
      groupId?: string;
      groupMember?: boolean;
    } = {},
  ) {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(
        state.failed === false
          ? null
          : {
              botId: "bot",
              threadId: "thread",
              createdAt: new Date("2026-11-03T00:00:00Z"),
              sourceMessageId: "source-message",
              thread: { groupId: state.groupId ?? null },
              projectId: "project",
              rootRunId: null,
              modelPinned: state.pinned ?? false,
              modelProvider: "provider",
              modelId: "model",
              thinkingLevel: null,
              task: { prompt: "Fix the failing tests" },
            },
      )
      .mockResolvedValueOnce(state.superseded ? { id: "newer-run" } : null);
    const tx = {
      $queryRaw: vi.fn(async () => []),
      chatGroup: {
        findFirst: vi.fn(async () => (state.groupMember === false ? null : { id: "group" })),
      },
      run: { findFirst, create: vi.fn(async () => ({ id: "resumed-run" })) },
      message: {
        findMany: vi.fn(async () => [{ blocks: [{ kind: "text", text: "Last finding" }] }]),
      },
      task: { create: vi.fn(async () => ({ id: "resumed-task" })) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
    return { tx, prisma };
  }

  it("queues a resume run with the task and notes under the deployment's limit", async () => {
    const { tx, prisma } = resumeFixture();

    await expect(createResumeRun(prisma, request)).resolves.toBe("resumed-run");

    const data = tx.run.create.mock.calls[0]?.[0 as never] as unknown as {
      data: Record<string, unknown>;
    };
    expect(data.data).toMatchObject({
      trigger: "resume",
      parentRunId: "failed-run",
      rootRunId: "failed-run",
      projectId: "project",
      sourceMessageId: "source-message",
    });
    expect(data.data).not.toHaveProperty("deadlineMs");
    expect(data.data).not.toHaveProperty("modelId");
    expect(tx.task.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        prompt: resumePrompt("Fix the failing tests", ["Last finding"]),
      }),
    });
  });

  it("keeps a pinned model", async () => {
    const { tx, prisma } = resumeFixture({ pinned: true });

    await createResumeRun(prisma, request);

    expect(tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ modelPinned: true, modelId: "model" }),
      }),
    );
  });

  it("starts nothing for a run that is not the requester's failed run", async () => {
    const { tx, prisma } = resumeFixture({ failed: false });

    await expect(createResumeRun(prisma, request)).resolves.toBeNull();
    expect(tx.run.create).not.toHaveBeenCalled();
  });

  it("takes the thread lock before checking for a newer run", async () => {
    const { tx, prisma } = resumeFixture();

    await createResumeRun(prisma, request);

    const lockOrder = tx.$queryRaw.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    const supersededCheckOrder = tx.run.findFirst.mock.invocationCallOrder[1] ?? 0;
    expect(lockOrder).toBeLessThan(supersededCheckOrder);
  });

  it("starts nothing for a bot that left the group", async () => {
    const { tx, prisma } = resumeFixture({ groupId: "group", groupMember: false });

    await expect(createResumeRun(prisma, request)).resolves.toBeNull();
    expect(tx.chatGroup.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "group", archivedAt: null, members: { some: { botId: "bot" } } },
      }),
    );
    expect(tx.run.create).not.toHaveBeenCalled();
  });

  it("starts nothing once a newer or active run exists", async () => {
    const { tx, prisma } = resumeFixture({ superseded: true });

    await expect(createResumeRun(prisma, request)).resolves.toBeNull();
    expect(tx.run.create).not.toHaveBeenCalled();
  });
});
