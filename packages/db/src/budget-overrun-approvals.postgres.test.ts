import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decideOverrunApproval,
  expireOverrunApprovals,
  OverrunRequestConflictError,
  requestOverrunApproval,
} from "./budget-overrun-approvals.js";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { reserveBudget, setProjectBudget } from "./project-budgets.js";
import { decideProposal } from "./proposals.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("budget overrun approvals", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  const organizationId = `overrun-test-${crypto.randomUUID()}`;
  let spaceId: string;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Overrun tests",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    spaceId = (
      await prisma.space.create({
        data: { id: `overrun-space-${crypto.randomUUID()}`, organizationId, name: "Overrun tests" },
      })
    ).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      // Explicit cleanup of synthetic accounting fixtures in the disposable test database.
      const fixtureSpaces = await prisma.space.findMany({
        where: { organizationId },
        select: { id: true },
      });
      const fixtureSpaceIds = fixtureSpaces.map((space) => space.id);
      await prisma.projectBudget.deleteMany({ where: { spaceId: { in: fixtureSpaceIds } } });
      await prisma.budgetSpendLedger.deleteMany({ where: { spaceId: { in: fixtureSpaceIds } } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    } finally {
      await close();
    }
  });

  async function budgetFor(limitMicroUsd: bigint) {
    const project = await prisma.project.create({ data: { spaceId, name: "Overrun fixture" } });
    await setProjectBudget(prisma, { spaceId, projectId: project.id, limitMicroUsd });
    return project.id;
  }

  const limitOf = async (projectId: string) =>
    (
      await prisma.projectBudget.findUniqueOrThrow({
        where: { spaceId_projectId: { spaceId, projectId } },
      })
    ).limitMicroUsd;

  it("expires the linked proposal and rejects a late user decision", async () => {
    const projectId = await budgetFor(1_000_000n);
    const userId = `expiry-user-${crypto.randomUUID()}`;
    const bot = await prisma.bot.create({
      data: { spaceId, userId, name: "Expiry fixture", color: "blue" },
    });
    const proposal = await prisma.proposal.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        kind: "decision",
        title: "Budget expiry",
        summary: "Synthetic expiry fixture",
        submitKey: crypto.randomUUID(),
      },
    });
    const approval = await requestOverrunApproval(prisma, {
      spaceId,
      projectId,
      proposalId: proposal.id,
      amountMicroUsd: 500_000n,
      scope: JSON.stringify({ threadId: "not-started", runId: "not-started" }),
      requestKey: crypto.randomUUID(),
      expiresAt: new Date(0),
    });
    await Promise.all([expireOverrunApprovals(prisma), expireOverrunApprovals(prisma)]);
    expect(await prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id } })).toMatchObject({
      status: "expired",
      chosenOption: null,
    });
    expect(
      await prisma.budgetOverrunApproval.findUniqueOrThrow({ where: { id: approval.id } }),
    ).toMatchObject({ status: "expired", appliedVersion: null });
    await expect(
      decideProposal(
        prisma,
        { spaceId, userId },
        {
          proposalId: proposal.id,
          decision: "approve",
        },
      ),
    ).rejects.toThrow("already decided");
    expect(await limitOf(projectId)).toBe(1_000_000n);
  });

  it("automatically expires due approvals while racing decisions and repeated sweeps", async () => {
    const projectId = await budgetFor(1_000_000n);
    const approval = await requestOverrunApproval(prisma, {
      spaceId,
      projectId,
      amountMicroUsd: 500_000n,
      scope: "run:auto-expiry",
      requestKey: crypto.randomUUID(),
      expiresAt: new Date(0),
    });
    await Promise.all([
      expireOverrunApprovals(prisma),
      expireOverrunApprovals(prisma),
      decideOverrunApproval(prisma, { spaceId, approvalId: approval.id, decision: "approved" }),
    ]);
    const stored = await prisma.budgetOverrunApproval.findUniqueOrThrow({
      where: { id: approval.id },
    });
    expect(stored.status).toBe("expired");
    expect(stored.appliedVersion).toBeNull();
    expect(stored.decidedAt).not.toBeNull();
    expect(await limitOf(projectId)).toBe(1_000_000n);
    expect(
      await prisma.projectBudgetVersion.count({ where: { budgetId: approval.budgetId } }),
    ).toBe(1);
    expect(await expireOverrunApprovals(prisma)).toBe(0);
  });

  it("preserves the deadline across reconnect and request replay", async () => {
    const projectId = await budgetFor(1_000_000n);
    const expiresAt = new Date(0);
    const request = {
      spaceId,
      projectId,
      amountMicroUsd: 500_000n,
      scope: "run:reconnect-expiry",
      requestKey: crypto.randomUUID(),
      expiresAt,
    };
    const approval = await requestOverrunApproval(prisma, request);
    const reconnected = createDb(databaseUrl!);
    try {
      const replay = await requestOverrunApproval(reconnected.prisma, request);
      expect(replay.id).toBe(approval.id);
      expect(replay.expiresAt).toEqual(expiresAt);
      const result = await decideOverrunApproval(reconnected.prisma, {
        spaceId,
        approvalId: approval.id,
        decision: "approved",
      });
      expect(result).toMatchObject({ status: "expired", resume: false, appliedVersion: null });
      expect(await limitOf(projectId)).toBe(1_000_000n);
      expect(
        await prisma.projectBudgetVersion.count({ where: { budgetId: approval.budgetId } }),
      ).toBe(1);
    } finally {
      await reconnected.prisma.$disconnect();
      await reconnected.pool.end();
    }
  });

  it("expired approval decisions never raise the limit or resume, including concurrent replay", async () => {
    const projectId = await budgetFor(1_000_000n);
    const approval = await requestOverrunApproval(prisma, {
      spaceId,
      projectId,
      amountMicroUsd: 500_000n,
      scope: "run:expired",
      requestKey: crypto.randomUUID(),
      expiresAt: new Date(0),
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        decideOverrunApproval(prisma, { spaceId, approvalId: approval.id, decision: "approved" }),
      ),
    );
    expect(results.every((result) => result.status === "expired" && !result.resume)).toBe(true);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(await limitOf(projectId)).toBe(1_000_000n);
    const stored = await prisma.budgetOverrunApproval.findUniqueOrThrow({
      where: { id: approval.id },
    });
    expect(stored.status).toBe("expired");
    expect(stored.appliedVersion).toBeNull();
    expect(stored.decidedAt).not.toBeNull();
  });

  it("approval raises the limit by exactly the bound amount and resumes once", async () => {
    const projectId = await budgetFor(1_000_000n);
    const req = {
      spaceId,
      projectId,
      amountMicroUsd: 500_000n,
      scope: "run:a",
      requestKey: crypto.randomUUID(),
    };
    const approval = await requestOverrunApproval(prisma, req);
    expect(approval.budgetVersion).toBe(1);
    const first = await decideOverrunApproval(prisma, {
      spaceId,
      approvalId: approval.id,
      decision: "approved",
    });
    expect(first).toMatchObject({
      status: "approved",
      resume: true,
      replayed: false,
      appliedVersion: 2,
    });
    const replay = await decideOverrunApproval(prisma, {
      spaceId,
      approvalId: approval.id,
      decision: "approved",
    });
    expect(replay).toMatchObject({ status: "approved", resume: false, replayed: true });
    expect(await limitOf(projectId)).toBe(1_500_000n);
  });

  it("rejection applies nothing, never resumes, and cannot be flipped by a later approve", async () => {
    const projectId = await budgetFor(1_000_000n);
    const approval = await requestOverrunApproval(prisma, {
      spaceId,
      projectId,
      amountMicroUsd: 200_000n,
      scope: "run:b",
      requestKey: crypto.randomUUID(),
    });
    const rejected = await decideOverrunApproval(prisma, {
      spaceId,
      approvalId: approval.id,
      decision: "rejected",
    });
    expect(rejected).toMatchObject({ status: "rejected", resume: false });
    const late = await decideOverrunApproval(prisma, {
      spaceId,
      approvalId: approval.id,
      decision: "approved",
    });
    expect(late).toMatchObject({ status: "rejected", resume: false, replayed: true });
    expect(await limitOf(projectId)).toBe(1_000_000n);
  });

  it("goes stale when the budget version changed after the request", async () => {
    const projectId = await budgetFor(1_000_000n);
    const approval = await requestOverrunApproval(prisma, {
      spaceId,
      projectId,
      amountMicroUsd: 300_000n,
      scope: "run:c",
      requestKey: crypto.randomUUID(),
    });
    await setProjectBudget(prisma, { spaceId, projectId, limitMicroUsd: 2_000_000n });
    const result = await decideOverrunApproval(prisma, {
      spaceId,
      approvalId: approval.id,
      decision: "approved",
    });
    expect(result).toMatchObject({ status: "stale", resume: false });
    expect(await limitOf(projectId)).toBe(2_000_000n);
  });

  it("concurrent approvals apply the amount once", async () => {
    const projectId = await budgetFor(1_000_000n);
    const approval = await requestOverrunApproval(prisma, {
      spaceId,
      projectId,
      amountMicroUsd: 100_000n,
      scope: "run:d",
      requestKey: crypto.randomUUID(),
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        decideOverrunApproval(prisma, { spaceId, approvalId: approval.id, decision: "approved" }),
      ),
    );
    expect(results.filter((r) => r.resume)).toHaveLength(1);
    expect(await limitOf(projectId)).toBe(1_100_000n);
  });

  it("requestKey replay is idempotent and conflicting parameters are rejected", async () => {
    const projectId = await budgetFor(1_000_000n);
    const req = {
      spaceId,
      projectId,
      amountMicroUsd: 100_000n,
      scope: "run:e",
      requestKey: crypto.randomUUID(),
    };
    const a = await requestOverrunApproval(prisma, req);
    const b = await requestOverrunApproval(prisma, req);
    expect(b.id).toBe(a.id);
    await expect(
      requestOverrunApproval(prisma, { ...req, amountMicroUsd: 200_000n }),
    ).rejects.toBeInstanceOf(OverrunRequestConflictError);
    await expect(
      requestOverrunApproval(prisma, { ...req, scope: "run:other" }),
    ).rejects.toBeInstanceOf(OverrunRequestConflictError);
  });

  it("preserves accounting evidence and rejects late approval after repeated cancellation", async () => {
    const projectId = await budgetFor(1_000_000n);
    const userId = `cancel-user-${crypto.randomUUID()}`;
    const bot = await prisma.bot.create({
      data: { spaceId, userId, name: "Cancel fixture", color: "blue" },
    });
    const thread = await prisma.thread.create({ data: { spaceId, userId, botId: bot.id } });
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        threadId: thread.id,
        prompt: "fixture",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "waiting_budget",
        trigger: "user_message",
        projectId,
        leaseFence: 1,
      },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 1, status: "waiting_budget" },
    });
    const callId = `cancel-call-${crypto.randomUUID()}`;
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 100_000n });
    const proposal = await prisma.proposal.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        kind: "decision",
        title: "Budget cancellation",
        summary: "Synthetic cancellation fixture",
        submitKey: crypto.randomUUID(),
      },
    });
    const approval = await requestOverrunApproval(prisma, {
      spaceId,
      projectId,
      proposalId: proposal.id,
      amountMicroUsd: 500_000n,
      requestKey: crypto.randomUUID(),
      scope: JSON.stringify({
        threadId: thread.id,
        runId: run.id,
        botId: bot.id,
        attemptId: attempt.id,
        leaseFence: 1,
        callId,
      }),
    });
    await prisma.run.update({
      where: { id: run.id },
      data: {
        checkpoint: JSON.stringify({
          kind: "budget_pause_v1",
          approvalId: approval.id,
          proposalId: proposal.id,
          call: { spaceId, projectId, callId, amountMicroUsd: "500000" },
        }),
      },
    });
    const cancelledAt = new Date();
    for (let i = 0; i < 2; i++)
      await prisma.$transaction((tx) =>
        cancelRunsInTransaction(tx, [{ id: run.id, taskId: task.id }], cancelledAt),
      );
    await expect(
      decideProposal(prisma, { spaceId, userId }, { proposalId: proposal.id, decision: "approve" }),
    ).rejects.toThrow("no longer matches");
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "cancelled",
      completedAt: cancelledAt,
    });
    expect(await prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({
      status: "cancelled",
      finishedAt: cancelledAt,
    });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(
      await prisma.budgetReservation.findUniqueOrThrow({
        where: { spaceId_callId: { spaceId, callId } },
      }),
    ).toMatchObject({ status: "reserved", amountMicroUsd: 100_000n });
    expect(
      await prisma.budgetOverrunApproval.findUniqueOrThrow({ where: { id: approval.id } }),
    ).toMatchObject({ status: "pending" });
    expect(await limitOf(projectId)).toBe(1_000_000n);
    expect(
      (
        await prisma.projectBudget.findUniqueOrThrow({
          where: { spaceId_projectId: { spaceId, projectId } },
        })
      ).reservedMicroUsd,
    ).toBe(100_000n);
  });
  it("does not resurrect a cancelled run when approval races cancellation", async () => {
    const projectId = await budgetFor(1_000_000n);
    const userId = `cancel-user-${crypto.randomUUID()}`;
    const bot = await prisma.bot.create({
      data: { spaceId, userId, name: "Cancel fixture", color: "blue" },
    });
    const thread = await prisma.thread.create({ data: { spaceId, userId, botId: bot.id } });
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        threadId: thread.id,
        prompt: "fixture",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "waiting_budget",
        trigger: "user_message",
        projectId,
        leaseFence: 1,
      },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 1, status: "waiting_budget" },
    });
    const callId = `cancel-call-${crypto.randomUUID()}`;
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 100_000n });
    const proposal = await prisma.proposal.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        kind: "decision",
        title: "Budget cancellation",
        summary: "Synthetic cancellation fixture",
        submitKey: crypto.randomUUID(),
      },
    });
    const approval = await requestOverrunApproval(prisma, {
      spaceId,
      projectId,
      proposalId: proposal.id,
      amountMicroUsd: 500_000n,
      requestKey: crypto.randomUUID(),
      scope: JSON.stringify({
        threadId: thread.id,
        runId: run.id,
        botId: bot.id,
        attemptId: attempt.id,
        leaseFence: 1,
        callId,
      }),
    });
    await prisma.run.update({
      where: { id: run.id },
      data: {
        checkpoint: JSON.stringify({
          kind: "budget_pause_v1",
          approvalId: approval.id,
          proposalId: proposal.id,
          call: { spaceId, projectId, callId, amountMicroUsd: "500000" },
        }),
      },
    });

    await prisma.run.update({
      where: { id: run.id },
      data: {
        checkpoint: JSON.stringify({
          kind: "budget_pause_v1",
          approvalId: approval.id,
          proposalId: proposal.id,
          call: { callId, projectId, spaceId, amountMicroUsd: "500000" },
        }),
      },
    });
    const results = await Promise.allSettled([
      prisma.$transaction((tx) =>
        cancelRunsInTransaction(tx, [{ id: run.id, taskId: task.id }], new Date()),
      ),
      decideProposal(prisma, { spaceId, userId }, { proposalId: proposal.id, decision: "approve" }),
    ]);
    expect(results[0].status).toBe("fulfilled");
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(
      await prisma.budgetReservation.findUniqueOrThrow({
        where: { spaceId_callId: { spaceId, callId } },
      }),
    ).toMatchObject({ status: "reserved", amountMicroUsd: 100_000n });
    const decision = await prisma.budgetOverrunApproval.findUniqueOrThrow({
      where: { id: approval.id },
    });
    expect(decision.status).toBe(results[1].status === "fulfilled" ? "approved" : "pending");
  });

  it("closes the paused attempt when cancellation follows committed approval", async () => {
    const projectId = await budgetFor(1_000_000n);
    const userId = `cancel-user-${crypto.randomUUID()}`;
    const bot = await prisma.bot.create({
      data: { spaceId, userId, name: "Cancel fixture", color: "blue" },
    });
    const thread = await prisma.thread.create({ data: { spaceId, userId, botId: bot.id } });
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        threadId: thread.id,
        prompt: "fixture",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "waiting_budget",
        trigger: "user_message",
        projectId,
        leaseFence: 1,
      },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 1, status: "waiting_budget" },
    });
    const callId = `cancel-call-${crypto.randomUUID()}`;
    await reserveBudget(prisma, { spaceId, projectId, callId, amountMicroUsd: 100_000n });
    const proposal = await prisma.proposal.create({
      data: {
        spaceId,
        userId,
        botId: bot.id,
        kind: "decision",
        title: "Budget cancellation",
        summary: "Synthetic cancellation fixture",
        submitKey: crypto.randomUUID(),
      },
    });
    const approval = await requestOverrunApproval(prisma, {
      spaceId,
      projectId,
      proposalId: proposal.id,
      amountMicroUsd: 500_000n,
      requestKey: crypto.randomUUID(),
      scope: JSON.stringify({
        threadId: thread.id,
        runId: run.id,
        botId: bot.id,
        attemptId: attempt.id,
        leaseFence: 1,
        callId,
      }),
    });
    await prisma.run.update({
      where: { id: run.id },
      data: {
        checkpoint: JSON.stringify({
          kind: "budget_pause_v1",
          approvalId: approval.id,
          proposalId: proposal.id,
          call: { spaceId, projectId, callId, amountMicroUsd: "500000" },
        }),
      },
    });

    await prisma.run.update({
      where: { id: run.id },
      data: {
        checkpoint: JSON.stringify({
          kind: "budget_pause_v1",
          approvalId: approval.id,
          proposalId: proposal.id,
          call: { callId, projectId, spaceId, amountMicroUsd: "500000" },
        }),
      },
    });
    await decideProposal(
      prisma,
      { spaceId, userId },
      { proposalId: proposal.id, decision: "approve" },
    );
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "queued",
    });
    await prisma.$transaction((tx) =>
      cancelRunsInTransaction(tx, [{ id: run.id, taskId: task.id }], new Date()),
    );
    expect(await prisma.attempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
      status: "cancelled",
    });
    expect(
      await prisma.budgetReservation.findUniqueOrThrow({
        where: { spaceId_callId: { spaceId, callId } },
      }),
    ).toMatchObject({ status: "reserved", amountMicroUsd: 100_000n });
    const decision = await prisma.budgetOverrunApproval.findUniqueOrThrow({
      where: { id: approval.id },
    });
    expect(decision.status).toBe("approved");
  });

  it("expires an approval when waiting for the budget lock crosses its deadline", async () => {
    const projectId = await budgetFor(1_000_000n);
    const approval = await requestOverrunApproval(prisma, {
      spaceId,
      projectId,
      amountMicroUsd: 100_000n,
      scope: "lock-expiry",
      requestKey: crypto.randomUUID(),
    });
    let decision: ReturnType<typeof decideOverrunApproval> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM project_budgets WHERE "spaceId" = ${spaceId} AND "projectId" = ${projectId} FOR UPDATE`;
      await tx.$executeRaw`UPDATE budget_overrun_approvals SET "expiresAt" = clock_timestamp() + interval '2 seconds' WHERE id = ${approval.id}`;
    });
    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM project_budgets WHERE "spaceId" = ${spaceId} AND "projectId" = ${projectId} FOR UPDATE`;
        decision = decideOverrunApproval(prisma, {
          spaceId,
          approvalId: approval.id,
          decision: "approved",
        });
        // Prove the decision reached the budget lock before expiry.
        let blockedBeforeExpiry = false;
        for (let poll = 0; poll < 100; poll++) {
          await tx.$queryRaw`SELECT pg_stat_clear_snapshot()::text`;
          const [state] = await tx.$queryRaw<{ blocked: boolean; beforeExpiry: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))
              AND query LIKE '%project_budgets%'
          ) AS blocked,
          (SELECT "expiresAt" > clock_timestamp() FROM budget_overrun_approvals WHERE id = ${approval.id}) AS "beforeExpiry"`;
          if (state?.blocked) {
            blockedBeforeExpiry = state.beforeExpiry;
            break;
          }
          await tx.$queryRaw`SELECT pg_sleep(0.01)::text`;
        }
        expect(blockedBeforeExpiry).toBe(true);
        // Wait in PostgreSQL until the persisted deadline has passed, then release the lock.
        await tx.$queryRaw`SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ("expiresAt" - clock_timestamp())))::double precision + 0.1)::text FROM budget_overrun_approvals WHERE id = ${approval.id}`;
      },
      { timeout: 10_000 },
    );
    expect(await decision).toMatchObject({ status: "expired", resume: false });
    expect(await limitOf(projectId)).toBe(1_000_000n);
    expect(
      await prisma.budgetOverrunApproval.findUniqueOrThrow({ where: { id: approval.id } }),
    ).toMatchObject({ status: "expired", appliedVersion: null });
  });
});
